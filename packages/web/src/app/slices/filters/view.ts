import { historyView } from '../history/view';
import { studyView } from '../study/view';
/**
 * The chrome projection: everything the top bar, the filter bar and the status
 * line read, as one value.
 *
 * Which controls exist is derived from the catalog here, not listed in the
 * template: every categorical filterable field of the current `(modality,
 * view)` in catalog order, the numeric ones with the bounds their column spans,
 * and the active view's quarantine counts. A new filterable field is therefore a
 * catalog entry and nothing else.
 */

import {
  fieldsFor,
  viewsFor,
  type ColumnId,
  type CompletedCatalog,
  type DateRange,
  type FieldDef,
  type FieldValueCount,
  type Filter,
  type NumericRange,
  type QuarantineCounts,
  type ViewDef,
} from '@mriqc/shared';
import type { ExportState, PanelId, State, StudyState } from '../../graph/state';
import { metricDef, significant } from '../panels/text';

/**
 * How many distinct values a multi-select stays usable with. Past it the top
 * bar renders a search box inside the panel instead of one option per value.
 */
export const FILTER_SEARCH_THRESHOLD = 60;

/** One filterable field with the values the catalog found for it. */
export interface FilterFieldView {
  field: FieldDef;
  values: readonly FieldValueCount[];
  /** True when the list is long enough to need a search box rather than a plain list. */
  searchable: boolean;
}

/**
 * One numeric filterable field with the bounds its column actually spans, which
 * the top bar's range control shows as placeholders. Null before the catalog
 * arrives, or for a `(modality, view)` where the column holds no finite value.
 */
export interface NumericFieldView {
  field: FieldDef;
  range: NumericRange | null;
}

/**
 * The brushed interval, ready to print: which panel drew it, on what, and the
 * two bounds already rounded the way the stat row rounds.
 *
 * The top bar renders it as an amber chip with a clear button, because until
 * it did the only way to undo a brush was a bare click on the chart that drew
 * it -- undiscoverable, and gone the moment that panel was removed.
 */
export interface BrushChip {
  from: PanelId;
  metric: ColumnId;
  label: string;
  lo: string;
  hi: string;
}

/** Everything the top bar and the status line read. */
export interface Chrome {
  catalogReady: boolean;
  /**
   * Why the catalog is missing, or null. Non-null is a dead dashboard: no
   * filter list, no metric labels, no panel can be configured -- so the status
   * line says that instead of claiming to still be loading it.
   */
  catalogError: string | null;
  /** The brushed interval, or null when nothing is selected. */
  brushes: readonly BrushChip[];
  modality: State['global']['modality'];
  view: State['global']['view'];
  views: readonly ViewDef[];
  /**
   * The primary filter row: every categorical filterable field of this
   * `(modality, view)` that is *not* flagged `secondary`.
   */
  filterFields: readonly FilterFieldView[];
  /**
   * The same derivation for the fields that are, which live in "More filters"
   * beside the ranges. A rule off `FieldDef.secondary` and not a list of ids
   * here: which fields are long-tail is a fact about the field.
   */
  secondaryFields: readonly FilterFieldView[];
  /** The numeric filterable fields of this modality and view, with their bounds. */
  numericFields: readonly NumericFieldView[];
  /** The filters in force, so the top bar can show which options are selected. */
  filters: readonly Filter[];
  /**
   * What the active view's policy refused, or null when the figures on screen
   * are not a policy's canonical corpus.
   *
   * Non-null only on a canonical-only view: there the counts are what the
   * numbers on screen leave out, which is worth a line of chrome. On `raw`
   * there is no policy, and on a `_all` view the quarantined rows are already
   * in every figure, so neither has anything to leave out.
   */
  quarantine: QuarantineCounts | null;
  dateRange: DateRange | null;
  /**
   * How current the whole corpus is: the latest `created_at` any modality
   * reports, as an ISO string, or null before the catalog arrives.
   *
   * Across modalities and not just the one on screen, because the status line
   * it feeds -- "Data from 6 Aug 2026" -- is a statement about the ingest, not
   * about the slice the user happens to be looking at. `dateRange` above is the
   * per-modality pair the picker's bounds come from and stays as it was.
   */
  dataDate: string | null;
  dataVersion: string | null;
  study: StudyState;
  notice: string | null;
  export: ExportState;
  panelCount: number;
  pendingCount: number;
  errorCount: number;
}

/** Shared empty list, so a missing value list does not break `chromeEquals`. */
const NO_VALUES: readonly FieldValueCount[] = [];

/**
 * The newest upload the catalog knows about, over every modality. Pure, and a
 * plain string compare: the bounds are ISO-8601 in UTC, which sorts
 * lexicographically. Null when no modality has a dated row.
 */
export function latestUpload(catalog: CompletedCatalog | null): string | null {
  if (catalog === null) return null;
  let latest: string | null = null;
  for (const range of Object.values(catalog.dateRange)) {
    if (!range) continue;
    if (latest === null || range.max > latest) latest = range.max;
  }
  return latest;
}

/** Toolbar, filter bar, status line. */
export function chrome(state: State): Chrome {
  const { modality, view } = state.global;
  const catalog = state.catalog;
  // Every filterable field of this modality *and* view, in catalog order, so a
  // field that only one view carries -- `canonical_hmc_mode` on K4+ -- appears
  // exactly where the catalog says it exists and nowhere else.
  //
  // Categorical only. `created_at` is the date field and the range picker owns
  // it; the numeric filterable fields have their own two-ended controls, below,
  // because the catalog computes no value list for them.
  //
  // Split on `FieldDef.secondary`: the primary row is the handful a reader
  // reaches for, and the long-tail and diagnostic fields -- "Manufacturer (as
  // uploaded)", Institution, Protocol name -- go in "More filters" with the
  // ranges. The rule is the flag, so adding a field decides this once, beside
  // the field, and not in a list of ids in the top bar.
  const categorical = fieldsFor(modality, view, 'filter').flatMap((field) => {
    if (field.kind !== 'categorical') return [];
    const values = catalog?.fieldValues[field.id]?.[modality]?.[view] ?? NO_VALUES;
    return [{ field, values, searchable: values.length > FILTER_SEARCH_THRESHOLD }];
  });
  const filterFields = categorical.filter((entry) => entry.field.secondary !== true);
  const secondaryFields = categorical.filter((entry) => entry.field.secondary === true);
  // The same derivation for the numeric half, so `canonical_diameter` and
  // `canonical_group_rows` appear on the canonical views and nowhere else.
  const numericFields = fieldsFor(modality, view, 'filter').flatMap((field) => {
    if (field.kind !== 'numeric') return [];
    return [{ field, range: catalog?.numericRange?.[field.id]?.[modality]?.[view] ?? null }];
  });
  const activeView = viewsFor(modality).find((v) => v.id === view);
  const quarantine =
    activeView?.policy !== undefined && activeView.includesQuarantined !== true
      ? (catalog?.quarantine?.[modality] ?? null)
      : null;
  // No version comparison: "the catalog fetch failed and we have no catalog"
  // is the whole condition, and it is true whether or not the ingest version
  // has moved since.
  const brushes: BrushChip[] = state.selections.map(selection => {
    const metric = metricDef(state, selection.metric);
    return { from: selection.from, metric: selection.metric,
      label: metric?.shortLabel ?? metric?.label ?? String(selection.metric),
      lo: significant(selection.range[0]), hi: significant(selection.range[1]) };
  });
  return {
    ...historyView(state),
    ...studyView(state),
    catalogReady: catalog !== null,
    brushes,
    modality,
    view,
    views: viewsFor(modality),
    filterFields,
    secondaryFields,
    numericFields,
    filters: state.global.filters,
    quarantine,
    dateRange: catalog?.dateRange[modality] ?? null,
    dataDate: latestUpload(catalog),
    panelCount: state.panels.length,
  };
}

/** Shallow equality for `chrome`, so `distinctUntilChanged` does not re-render on identity. */
export function chromeEquals(a: Chrome, b: Chrome): boolean {
  const sameFields = (x: readonly FilterFieldView[], y: readonly FilterFieldView[]) =>
    x.length === y.length && x.every((f, i) => f.field === y[i].field && f.values === y[i].values);
  const sameBrush = (x: BrushChip | null, y: BrushChip | null) =>
    x === y ||
    (x !== null &&
      y !== null &&
      x.from === y.from &&
      x.metric === y.metric &&
      x.lo === y.lo &&
      x.hi === y.hi);
  return (
    a.catalogReady === b.catalogReady &&
    a.catalogError === b.catalogError &&
    a.brushes.length === b.brushes.length && a.brushes.every((brush, i) => sameBrush(brush, b.brushes[i])) &&
    a.modality === b.modality &&
    a.view === b.view &&
    a.views === b.views &&
    sameFields(a.filterFields, b.filterFields) &&
    sameFields(a.secondaryFields, b.secondaryFields) &&
    a.numericFields.length === b.numericFields.length &&
    a.numericFields.every(
      (f, i) => f.field === b.numericFields[i].field && f.range === b.numericFields[i].range,
    ) &&
    a.filters === b.filters &&
    a.quarantine === b.quarantine &&
    a.dateRange === b.dateRange &&
    a.dataDate === b.dataDate &&
    a.dataVersion === b.dataVersion &&
    a.study === b.study &&
    a.notice === b.notice &&
    a.export === b.export &&
    a.panelCount === b.panelCount &&
    a.pendingCount === b.pendingCount &&
    a.errorCount === b.errorCount
  );
}
