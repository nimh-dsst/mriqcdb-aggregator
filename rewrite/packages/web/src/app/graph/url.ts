import { validSelections } from './selections';
import { shapeOf } from './panel-shapes';
import { reconcileLayout, type DashboardLayout } from './layout';
/**
 * URL serialization: the shareable half of the dashboard, in one `s` parameter.
 *
 * Four layers, outermost first:
 *
 * 1. a version character, so a payload this build cannot read is refused rather
 *    than misread (`url-tokens.ts`, `TOKEN_VERSION`);
 * 2. base64url of
 * 3. a deflate stream (fflate, synchronous -- the first hydrate has to be
 *    synchronous or a shared link would flash the default dashboard) of
 * 4. the field-table text (`url-fields.ts`): every field equal to its default
 *    omitted, every catalog identifier a one- or two-character token, dates as
 *    digits, brush bounds at three significant figures.
 *
 * A link written before the version character existed is compact JSON in
 * base64url, and `url-legacy.ts` still reads it: links live in chats and
 * papers, and the one thing a shared dashboard must do is open.
 *
 * Everything here treats the parameter as hostile input. `decodeUrlState` never
 * throws: a link that is truncated, hand-edited or crafted degrades to null, and
 * the router edge opens the default dashboard. `validateUrlState` then drops
 * anything the catalog or the server's own schemas would reject, so no value
 * that arrived from a URL can reach a query key or a procedure unchecked.
 *
 * Pure. No Angular, no router; the router edge lives in `graph.ts`.
 */

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
import { deflateSync, inflateSync } from 'fflate';
import { PANEL_KINDS } from './panel-shapes';
import { validChart } from './panel-shapes';
import { normalizedOptions } from './panels';
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
import { decodeLegacyUrlState } from './url-legacy';
import {
  MAX_FILTER_VALUES,
  MAX_PANELS,
  MAX_PARAM_LENGTH,
  MAX_PAYLOAD_BYTES,
  TOKEN_VERSION,
  RAW_TOKEN_VERSION,
  URL_DICTIONARY,
  fromBase64Url,
  isWellFormed,
  normalizeSelection,
  toBase64Url,
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
  // A study cohort's rows live only in this browser, so a link carrying one
  // would promise its recipient a comparison they cannot have.
  const shareable = url.cohorts.filter((cohort) => cohort.source !== 'study');
  const text = writeUrlRecord({ ...url, cohorts: shareable });
  const bytes = deflateSync(new TextEncoder().encode(text), { level: 9, dictionary: URL_DICTIONARY });
  const compressed = toBase64Url(bytes);
  return text.length < compressed.length ? RAW_TOKEN_VERSION + text : TOKEN_VERSION + compressed;
}

/**
 * Parse the `s` parameter. Returns null for anything unparseable, which the
 * router edge treats as "no URL state" rather than as an error: a truncated
 * link should open the default dashboard, not a broken one.
 *
 * The whole decode sits in one try/catch and every element is shape-checked, so
 * no crafted payload can throw out of here and error `state$`.
 */
export function decodeUrlState(param: string | null | undefined): UrlState | null {
  if (!param) return null;
  try {
    // A deflate stream expands by up to a thousand to one, and the first
    // hydrate is synchronous, so an uncapped one is a link that freezes the tab
    // it is pasted into. Both ends are bounded: ten panels with three cohorts
    // and a brush is 316 characters, and the caps leave an order of magnitude
    // over the longest link the validation limits can produce.
    if (param.length > MAX_PARAM_LENGTH) return null;
    const version = param[0];
    if (version === RAW_TOKEN_VERSION) return readUrlRecord(param.slice(1));
    if (version >= '0' && version <= '9') {
      // A version this build does not know is refused outright: a link that
      // decodes to the *wrong* metric is worse than one that does not decode.
      if (version !== TOKEN_VERSION) return null;
      const bytes = inflateSync(fromBase64Url(param.slice(1)), {
        dictionary: URL_DICTIONARY,
        out: new Uint8Array(MAX_PAYLOAD_BYTES),
      });
      return readUrlRecord(new TextDecoder().decode(bytes));
    }
    // Written before the version character: compact JSON in base64url.
    return decodeLegacyUrlState(param);
  } catch {
    return null;
  }
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
  const known = new Set<CohortId>([CURRENT_COHORT, ALL_COHORT, ...cohorts.map((c) => c.id)]);
  const panels = uniqueIds(
    url.panels.slice(0, MAX_PANELS).map((panel) => {
      const next = {
        ...panel,
        x: panel.x === 'created_at' ? 'created_at' as const : panel.x && isValidMetric(modality, panel.x) ? panel.x : metricsFor(modality)[0].id,
        y: panel.y !== panel.x && panel.y && isValidMetric(modality, panel.y) ? panel.y : null,
        split:
          panel.split && isValidField(modality, view, panel.split, 'group') ? panel.split : null,
        options: normalizedOptions({ ...panel, cursors: [null] }, {}, modality),
      };
      // Ids a cohort no longer answers to go, and the reducer's `pruneCohortRefs`
      // turns a list that fell below two into a distribution panel. Validation
      // reports what exists; the reducer decides what that makes the panel.
      const ids = (panel.cohorts ?? []).filter(
        (id, i, all) => isKnownUrlCohort(id, known, modality, view) && all.indexOf(id) === i,
      );
      // A reference the panel no longer draws is not a reference; the reducer's
      // prune settles the rest.
      const anchor =
        panel.reference !== undefined && ids.includes(panel.reference)
          ? { reference: panel.reference }
          : {};
      const cohorts = ids.length ? ids : [CURRENT_COHORT];
      const validated = validChart({ ...next, cohorts, ...anchor, cursors: [null],
        split: (next.x !== 'created_at' && next.y !== null) || cohorts.length > 1 ? null : next.split });
      const { cursors: _, ...result } = validated;
      return result;
    }),
  );
  const selections = validSelections(url.selections, modality).filter(selection =>
    panels.some(panel => panel.id === selection.from && [panel.x, panel.y].includes(selection.metric)));
  return { global: { modality, view, filters }, cohorts, panels, selections,
    ...(url.layout ? { layout: reconcileLayout(url.layout, panels, 3) } : {}),
    ...(url.maximizedPanel && panels.some(panel => panel.id === url.maximizedPanel) ? { maximizedPanel: url.maximizedPanel } : {}),
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
