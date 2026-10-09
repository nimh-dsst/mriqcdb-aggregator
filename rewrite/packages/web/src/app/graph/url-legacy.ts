/**
 * The previous URL format: compact JSON in base64url, no version character.
 *
 * Kept whole and read-only. Links written before the token format exist in
 * chats, bookmarks and papers, and the one thing a shared dashboard must do is
 * open. Nothing writes this shape any more (`encodeUrlState` writes the
 * versioned one), so this file only ever shrinks -- and may go when the last of
 * those links has.
 *
 * Hostile input throughout: every element is shape-checked and the whole decode
 * is wrapped by the caller, so no crafted-but-JSON-valid payload can throw out
 * of here and error `state$`.
 */

import {
  asColumnId,
  canonicalViewFor,
  viewsFor,
  VIEWS,
  type ClipMode,
  type Filter,
  type FilterValue,
  type Granularity,
  type Modality,
  type PanelKind,
  type View,
} from '@mriqc/shared';
import { CHARTS_BY_KIND, chartForKind } from './panel-shapes';
import {
  ALL_COHORT,
  CURRENT_COHORT,
  MAX_COHORTS,
  defaultPanelOptions,
  parseGroupCohortId,
  type Cohort,
  type CohortId,
  type Panel,
  type PanelChart,
  type SelectionState,
} from './state';
import {
  MAX_COHORT_FILTERS,
  MAX_COHORT_ID_LENGTH,
  MAX_COHORT_NAME,
  MAX_FILTER_VALUES,
  MAX_ID_LENGTH,
  MAX_PANELS,
  clampBins,
  fromBase64Url,
  isWellFormed,
  normalizeSelection,
  uniqueIds,
} from './url-tokens';
import type { UrlState } from './url';

const LOG_SCALE = 1;
const USE_SELECTION = 2;

function isFilterValue(value: unknown): value is FilterValue {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return isWellFormed(value);
  return typeof value === 'boolean';
}

function isBound(value: unknown): value is number | string {
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string' && isWellFormed(value);
}

function isClip(value: unknown): value is ClipMode {
  return value === 'p01p99' || value === 'p05p95' || value === 'none';
}

function isGranularity(value: unknown): value is Granularity {
  return value === 'day' || value === 'week' || value === 'month' || value === 'year';
}

function columnFromWire(value: unknown): Filter['field'] | null {
  return typeof value === 'string' && value.length > 0 && isWellFormed(value)
    ? asColumnId(value)
    : null;
}

function flagsFromWire(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function filterFromWire(wire: unknown): Filter | null {
  if (!Array.isArray(wire)) return null;
  const field = columnFromWire(wire[0]);
  if (field === null) return null;
  switch (wire[1]) {
    case 'in': {
      if (!Array.isArray(wire[2])) return null;
      const values = wire[2].filter(isFilterValue);
      return values.length > 0 && values.length <= MAX_FILTER_VALUES
        ? { field, op: 'in', values }
        : null;
    }
    case 'bt':
      return isBound(wire[2]) && isBound(wire[3])
        ? { field, op: 'between', lo: wire[2], hi: wire[3] }
        : null;
    case 'nu':
      return { field, op: 'isNull' };
    case 'nn':
      return { field, op: 'notNull' };
    default:
      return null;
  }
}

/** A cohort id a panel references: a bounded, well-formed string and nothing else. */
function cohortIdFromWire(value: unknown): CohortId | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_COHORT_ID_LENGTH &&
    isWellFormed(value)
    ? value
    : null;
}

/** A panel's cohort list, repeats dropped; the reducer checks the ids exist. */
function cohortListFromWire(value: unknown): readonly CohortId[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: CohortId[] = [];
  for (const entry of value.slice(0, MAX_COHORTS + 2)) {
    const id = cohortIdFromWire(entry);
    if (id !== null && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * A cohort out of a link. Null for anything whose identity cannot be trusted --
 * no id, no name, a reserved id -- and otherwise a cohort whose view and filters
 * `validateUrlState` still has to check against the catalog.
 */
function cohortFromWire(wire: unknown): Cohort | null {
  if (!Array.isArray(wire)) return null;
  const [id, name, color, source, view, filters, selection] = wire as readonly unknown[];
  const cohortId = cohortIdFromWire(id);
  // The two derived cohorts are not stored, so a link claiming one of their ids
  // is claiming to redefine the top bar.
  if (cohortId === null || cohortId === CURRENT_COHORT || cohortId === ALL_COHORT) return null;
  // A group cohort is derived from its id; a stored one would be a second,
  // driftable definition of the same thing.
  if (parseGroupCohortId(cohortId) !== null) return null;
  if (typeof name !== 'string' || !isWellFormed(name)) return null;
  const wireFilters = Array.isArray(filters) ? filters : [];
  const kept = wireFilters
    .slice(0, MAX_COHORT_FILTERS)
    .map(filterFromWire)
    .filter((f): f is Filter => f !== null);
  // The same rule panels and filters get: a list that survived nothing was not
  // written by the encoder, so the cohort is not a cohort.
  if (allRejected(wireFilters, kept)) return null;
  return {
    id: cohortId,
    name: name.trim() === '' ? 'Cohort' : name.slice(0, MAX_COHORT_NAME),
    color: typeof color === 'number' && Number.isFinite(color) ? Math.trunc(color) : 0,
    source: source === 's' ? 'study' : 'population',
    view:
      typeof view === 'string' && (VIEWS as readonly string[]).includes(view)
        ? (view as View)
        : 'raw',
    filters: kept,
    selections: cohortSelectionFromWire(selection) ? [cohortSelectionFromWire(selection)!] : [],
  };
}

function cohortSelectionFromWire(wire: unknown): Cohort['selections'][number] | null {
  if (!Array.isArray(wire) || wire.length !== 3) return null;
  const [metric, lo, hi] = wire as readonly unknown[];
  const column = columnFromWire(metric);
  if (column === null) return null;
  if (typeof lo !== 'number' || typeof hi !== 'number') return null;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  return { metric: column, range: lo <= hi ? [lo, hi] : [hi, lo] };
}

function panelFromWire(wire: unknown): Omit<Panel, 'cursors'> | null {
  if (!Array.isArray(wire)) return null;
  const [id, kind, metric, chart, group, bins, clip, flags, granularity, cohorts, reference] =
    wire as readonly unknown[];
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LENGTH) return null;
  if (!isWellFormed(id)) return null;
  // `Object.hasOwn`, not `in`: `kind: 'constructor'` walks the prototype chain.
  if (typeof kind !== 'string' || !Object.hasOwn(CHARTS_BY_KIND, kind)) return null;
  const charts = CHARTS_BY_KIND[kind as PanelKind];
  if (typeof chart !== 'string' || !charts.includes(chartForKind(kind as PanelKind, chart as PanelChart))) return null;
  const panel: Omit<Panel, 'cursors'> = {
    id,
    x: kind === 'coverage' ? 'created_at' : columnFromWire(metric) ?? asColumnId('fd_mean'),
    y: null,
    chart: chartForKind(kind as PanelKind, chart as PanelChart),
    split: columnFromWire(group),
    cohorts: [CURRENT_COHORT],
    options: {
      ...defaultPanelOptions(),
      bins: clampBins(bins),
      clip: isClip(clip) ? clip : 'p01p99',
      xScale: (flagsFromWire(flags) & LOG_SCALE) !== 0 ? 'log' : 'linear',
      useSelection: (flagsFromWire(flags) & USE_SELECTION) !== 0,
      granularity: isGranularity(granularity) ? granularity : 'month',
    },
  };
  if (kind !== 'comparison') return panel;
  const anchor = cohortIdFromWire(reference);
  return {
    ...panel,
    cohorts: cohortListFromWire(cohorts) ?? [],
    ...(anchor === null ? {} : { reference: anchor }),
  };
}

/**
 * True when a list the payload carried survived nothing.
 *
 * Dropping one element of many is how an old link ages: a chart a kind no
 * longer allows, a panel kind that went away. Dropping every one of them means
 * the payload was not written by the encoder at all, and the honest reading is
 * "no URL state" -- the default dashboard -- rather than a dashboard stripped to
 * nothing.
 */
function allRejected(wire: readonly unknown[] | undefined, kept: readonly unknown[]): boolean {
  return wire !== undefined && wire.length > 0 && kept.length === 0;
}

function selectionFromWire(wire: unknown): SelectionState | null {
  if (!Array.isArray(wire) || wire.length !== 4) return null;
  const [from, metric, lo, hi] = wire as readonly unknown[];
  if (typeof from !== 'string' || from.length === 0 || from.length > MAX_ID_LENGTH) return null;
  if (!isWellFormed(from)) return null;
  const column = columnFromWire(metric);
  if (column === null) return null;
  if (typeof lo !== 'number' || typeof hi !== 'number') return null;
  return normalizeSelection({ from, metric: column, range: [lo, hi] });
}

/**
 * Parse a pre-token `s` parameter. Null for anything unparseable, which the
 * caller treats as "no URL state" rather than as an error.
 */
export function decodeLegacyUrlState(param: string): UrlState | null {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(fromBase64Url(param)));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const wire = parsed as Record<string, unknown>;
  const modality = wire['m'];
  if (modality !== 'bold' && modality !== 'T1w' && modality !== 'T2w') return null;
  const views: readonly string[] = viewsFor(modality).map((v) => v.id);
  const wireView = wire['v'];
  // A view the modality does not have degrades to that modality's canonical
  // one, which is also what an empty URL opens on, so an old or hand-edited
  // link lands on the same dashboard a cold load would.
  const view: View =
    typeof wireView === 'string' && views.includes(wireView)
      ? (wireView as View)
      : canonicalViewFor(modality as Modality);
  const wireFilters = wire['f'];
  if (wireFilters !== undefined && !Array.isArray(wireFilters)) return null;
  const filters = (wireFilters ?? []).map(filterFromWire).filter((f): f is Filter => f !== null);
  if (allRejected(wireFilters, filters)) return null;
  const wirePanels = wire['p'];
  if (wirePanels !== undefined && !Array.isArray(wirePanels)) return null;
  const decodedPanels = (wirePanels ?? [])
    .slice(0, MAX_PANELS)
    .map(panelFromWire)
    .filter((p): p is Omit<Panel, 'cursors'> => p !== null);
  if (allRejected(wirePanels, decodedPanels)) return null;
  const wireCohorts = wire['c'];
  if (wireCohorts !== undefined && !Array.isArray(wireCohorts)) return null;
  const decodedCohorts = (wireCohorts ?? [])
    .slice(0, MAX_COHORTS)
    .map(cohortFromWire)
    .filter((c): c is Cohort => c !== null);
  if (allRejected(wireCohorts, decodedCohorts)) return null;
  return {
    global: { modality, view, filters },
    // A repeated cohort id would make two cohorts one in every lookup, so the
    // second occurrence is re-named rather than dropped: the cohort was asked
    // for, only its id was unusable.
    cohorts: uniqueIds(decodedCohorts, 'c'),
    panels: uniqueIds(decodedPanels),
    selections: selectionFromWire(wire['s']) ? [selectionFromWire(wire['s'])!] : [],
  };
}
