import { validSelections } from './selections';
import { axisType, validForm } from './panel-shapes';
import { normalizeSeries } from './series';
import { reconcileLayout, type DashboardLayout } from './layout';
/** Shareable dashboard state. The only wire format is the versioned six-bit stream. */

import {
  asColumnId,
  canonicalViewFor,
  fieldsFor,
  isValidField,
  isValidMetric,
  metricsFor,
  viewsFor,
  type FieldKind,
  type Filter,
  type FilterValue,
  type Modality,
  type View,
} from '@mriqc/shared';

import { normalizedOptions, validColumn } from './panels';
import {
  ALL_COHORT,
  CURRENT_COHORT,
  MAX_COHORTS,
  isDerivedCohort,
  parseGroupCohortId,
  type Cohort,
  type CohortId,
  type GlobalState,
  type Panel,
  type SelectionState,
  type State,
} from './state';
import { readUrlRecord, writeUrlRecord } from './url-fields';
import {
  MAX_FILTER_VALUES,
  MAX_PANELS,
  MAX_PARAM_LENGTH,
  URL_VERSION,
  isWellFormed,
  normalizeSelection,
  uniqueIds,
} from './url-tokens';

/** The slice of state the URL carries. A panel here has no page chain. */
export interface UrlState {
  layout?: DashboardLayout | null;
  maximizedPanel?: string | null;
  global: GlobalState;
  /**
   * The user's cohorts. `current` and `all` are derived and never serialized;
   * a `study` cohort never leaves the browser either, because its rows do not
   * (`docs/comparison-design.md`, "Cohort").
   */
  cohorts: readonly Cohort[];
  panels: readonly Omit<Panel, 'cursors'>[];
  selections: readonly SelectionState[];
}

/** The query parameter the whole dashboard lives in. */
export const URL_PARAM = 's';

/**
 * The shareable slice of state: global controls, cohorts, panels without their
 * page chains, and the brush.
 *
 * A projection like any other (`docs/dashboard-graph.md`, "Outputs"), kept here
 * beside the codec that writes it so the two cannot disagree about what a link
 * carries.
 */
export function urlState(state: State): UrlState {
  return {
    global: state.global,
    cohorts: state.cohorts,
    panels: state.panels.map(({ cursors: _cursors, ...rest }) => rest),
    selections: state.selections,
    ...(state.layout ? { layout: state.layout } : {}),
    ...(state.maximizedPanel ? { maximizedPanel: state.maximizedPanel } : {}),
  };
}

/* ------------------------------------------------------------------- public */

/** Serialize a URL state into the value of the `s` query parameter. */
export function encodeUrlState(url: UrlState): string {
  const stream = writeUrlRecord(url);
  return stream ? URL_VERSION + stream : '';
}

/** Unknown versions and undecodable streams use the router's default fallback. */
export function decodeUrlState(param: string | null | undefined): UrlState | null {
  if (!param) return null;
  if (param.length > MAX_PARAM_LENGTH || param[0] !== URL_VERSION || param.length < 3) return null;
  return readUrlRecord(param.slice(1));
}

/* --------------------------------------------------------------- validation */

/**
 * The op/value shapes the server's `filterSchema` and the SQL behind it accept,
 * mirrored here so a link cannot send the server something it will reject -- or
 * worse, something it will run. `between` on a date column needs two parseable
 * instants, because the form layer turns those bounds back into `Date`s.
 */
function allowsFilter(kind: FieldKind, filter: Filter): boolean {
  switch (filter.op) {
    case 'in':
      return (
        kind !== 'date' &&
        filter.values.length > 0 &&
        filter.values.length <= MAX_FILTER_VALUES &&
        filter.values.every(isFilterValue)
      );
    case 'between':
      return kind === 'date'
        ? isDateBound(filter.lo) && isDateBound(filter.hi)
        : kind === 'numeric' && typeof filter.lo === 'number' && typeof filter.hi === 'number';
    default:
      return true;
  }
}

function isFilterValue(value: unknown): value is FilterValue {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return isWellFormed(value);
  return typeof value === 'boolean';
}

/** A `between` on a date column is only meaningful when both ends parse. */
export function isDateBound(value: number | string): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  return isWellFormed(value) && !Number.isNaN(Date.parse(value));
}

/**
 * True when a panel's cohort reference names something that exists after
 * validation: a stored cohort, a built-in, or a group of a column this
 * `(modality, view)` can filter on.
 *
 * A group cohort has nothing stored -- its id is its whole definition -- so what
 * makes it valid is the catalog, exactly as for the filter it compiles into.
 */
function isKnownUrlCohort(
  id: CohortId,
  known: ReadonlySet<CohortId>,
  modality: Modality,
  view: View,
): boolean {
  if (known.has(id)) return true;
  const group = parseGroupCohortId(id);
  return group !== null && isValidField(modality, view, asColumnId(group.field), 'filter');
}

/**
 * Drop anything the catalog says does not exist for the decoded modality and
 * view, and anything whose shape the interactive paths would never produce.
 * Called by the reducer's `hydrate`, so an old or crafted link cannot put the
 * dashboard into a state the server, or the form layer, would choke on.
 */
export function validateUrlState(url: UrlState): UrlState {
  const { modality, view } = url.global;
  const filters = keepValidFilters(url.global.filters, modality, view);
  const cohorts = uniqueIds(
    url.cohorts
      .slice(0, MAX_COHORTS)
      // A stored cohort may not answer to a derived id: `cohortById` would
      // resolve it to the derived one, so nothing could ever edit or delete it.
      .filter((cohort) => cohort.source !== 'study' && !isDerivedCohort(cohort.id))
      .map((cohort) => {
        // Each cohort carries its own view, so its filters are checked against
        // *that* view and not against the one the top bar is on.
        const cohortView = viewsFor(modality).some((v) => v.id === cohort.view)
          ? cohort.view
          : canonicalViewFor(modality);
        return {
          ...cohort,
          view: cohortView,
          filters: keepValidFilters(cohort.filters, modality, cohortView),
          selections: validSelections(cohort.selections, modality),
        };
      }),
    'c',
  );
  const panels = uniqueIds(
    url.panels.slice(0, MAX_PANELS).map((panel) => {
      const x =
        panel.x && validColumn(panel.x, modality, view) ? panel.x : metricsFor(modality)[0].id;
      const y =
        axisType(x) !== 'categorical' &&
        panel.y !== x &&
        panel.y &&
        isValidMetric(modality, panel.y)
          ? panel.y
          : null;
      const series = normalizeSeries(panel.series, {
        cohortIds: cohorts.map((cohort) => cohort.id),
        fieldCount: () => 0,
      }).filter((item) => !('field' in item) || isValidField(modality, view, item.field, 'group'));
      const candidate: Panel = { ...panel, x, y, series, cursors: [null] };
      const validated = validForm({
        ...candidate,
        options: normalizedOptions(candidate, {}, modality),
      });
      const { cursors: _, ...result } = validated;
      return result;
    }),
  );
  const selections = validSelections(url.selections, modality).filter((selection) =>
    panels.some(
      (panel) => panel.id === selection.from && [panel.x, panel.y].includes(selection.metric),
    ),
  );
  return {
    global: { modality, view, filters },
    cohorts,
    panels,
    selections,
    ...(url.layout ? { layout: reconcileLayout(url.layout, panels, 3) } : {}),
    ...(url.maximizedPanel && panels.some((panel) => panel.id === url.maximizedPanel)
      ? { maximizedPanel: url.maximizedPanel }
      : {}),
  };
}

/** The filters the catalog marks filterable in this `(modality, view)` and whose shape the server accepts. */
function keepValidFilters(
  filters: readonly Filter[],
  modality: Modality,
  view: View,
): readonly Filter[] {
  const fields = fieldsFor(modality, view, 'filter');
  return filters.filter((f) => {
    const field = fields.find((def) => def.id === f.field);
    return field !== undefined && allowsFilter(field.kind, f);
  });
}
