import { timeGroups } from './time-groups';
import { exportCountQuery } from '../chrome/export-view';
import { getAuthoredCatalog, type TimeSummaryQuery, type TimeSummaryResult } from '@mriqc/shared';
import type { Query } from '../api/api';
import { shapeOf } from './panel-shapes';
/**
 * Query planning: which procedures the panels on screen need, with which
 * parameters, and which of those the datasets map does not already answer.
 *
 * `needed` is the effects contract (`docs/dashboard-graph.md`, "Outputs"): the
 * runner diffs successive emissions, starts a fetch for a key that enters the
 * set and cancels one whose key left. Nothing here renders anything; the view
 * layer reads the same keys back out of state.
 *
 * Which queries a kind asks for is a lookup in `PANEL_KINDS`, so adding a kind
 * is a row in that table and not a case in this file.
 */

import {
  NONE_FILTER_VALUE,
  fieldValueLabel,
  fieldsFor,
  isNoneValue,
  queryKey,
  type ClipMode,
  type ColumnId,
  type DistributionResult,
  type Density2dResult,
  type Filter,
  QueryKey,
  type Selection,
} from '@mriqc/shared';
import {
  MAX_OVERLAY_GROUPS,
  asDistributionResult,
  clipBounds,
  groupColorIndex,
} from '../panels/specs';
import { cohortById, currentCohort } from './cohorts';
import { PANEL_KINDS, type PlanContext, type ProcName } from './panel-shapes';
import {
  CURRENT_COHORT,
  DENSITY_BINS,
  MIN_COMPARISON_COHORTS,
  type Cohort,
  type Panel,
  type State,
} from './state';
import { groupCohortId } from './state';

/** The one key that is needed before anything else can be. */
export const CATALOG_KEY: QueryKey = queryKey({ source: 'population', proc: 'catalog' });

/**
 * The selections this panel actually applies. The originating panel never
 * filters itself, so its brush stays visible while every other opted-in panel
 * narrows (`dashboard-graph.md`, "Brushing").
 */
export function effectiveSelection(state: State, panel: Panel): readonly Selection[] {
  return panel.options.useSelection ? state.selections.filter(selections => selections.from !== panel.id)
    .map(({ metric, range }) => ({ metric, range })) : [];
}

/**
 * True when an uploaded study is loaded and can answer a `study` query.
 *
 * Nothing reads it yet. A comparison is between cohorts now, and a study will be
 * one more of them (`source: 'study'`, `comparison-design.md`, "Study upload"),
 * so what this will gate is whether a `study` cohort is offered at all.
 */
export function studyReady(state: State): boolean {
  return typeof state.study === 'object' && state.study.status === 'ready';
}

/**
 * The cohorts one comparison panel draws, in panel order, with the dashboard's
 * brush applied where it belongs.
 *
 * `current` is the only cohort the brush touches, and only as
 * `effectiveSelection` allows: the panel that drew the brush is not filtered by
 * it, and a panel with "Follow the brushed range" off is not filtered by it
 * either. A user cohort carries its own metric range and nothing else -- a
 * cohort is a fixed reference by construction, which is exactly what makes
 * "this brushed subset against that cohort" a meaningful comparison rather than
 * two differently-brushed halves.
 */
export function panelCohorts(state: State, panel: Panel): readonly Cohort[] {
  const ids = panel.cohorts ?? [];
  const brush = effectiveSelection(state, panel);
  const out: Cohort[] = [];
  for (const id of ids) {
    const cohort = cohortById(state, id);
    if (cohort === null) continue;
    out.push(id === CURRENT_COHORT ? { ...cohort, selections: brush } : cohort);
  }
  return out;
}

/**
 * The single scope a non-comparison card follows.  It deliberately reuses the
 * cohort resolver used by comparisons: a saved card scope therefore has the
 * same view, filters and optional metric range as when it appears as one curve
 * in a comparison, rather than acquiring a second query path with subtly
 * different semantics.
 */
export function panelCohort(state: State, panel: Panel): Cohort {
  return panel.cohorts[0] === undefined
    ? currentCohort(state)
    : (cohortById(state, panel.cohorts[0]) ?? currentCohort(state));
}

/**
 * The series a split distribution draws: the five largest catalog groups and
 * one real tail cohort whose `in` predicate contains every remaining value.
 * Querying that predicate is what makes Other's `n` the count of the remaining
 * groups rather than an estimate assembled from fixed-bin summaries. A list at
 * the catalog's 200-value cap may be truncated, so it deliberately falls back
 * to groupedSummary instead of drawing an incomplete Other.
 */
export function splitDistributionCohorts(state: State, panel: Panel): readonly Cohort[] {
  if (panel.split === null || panel.x === null || panel.chart === 'box') return [];
  const base = panelCohort(state, panel);
  // Uploaded studies expose metrics for comparison, not population catalog
  // group values. Box plots use groupedSummary directly and validate a real
  // uploaded group column in the study runner.
  if (base.source === 'study') return [];
  const entries =
    state.catalog?.fieldValues?.[String(panel.split)]?.[state.global.modality]?.[base.view] ?? [];
  if (entries.length >= 200) return [];
  const ranked = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.n - a.entry.n || a.index - b.index)
    .map(({ entry }) => entry);
  const selections =
    (panel.cohorts[0] ?? CURRENT_COHORT) === CURRENT_COHORT
      ? effectiveSelection(state, panel)
      : base.selections;
  const wireValue = (value: string | number | boolean | null): string | number | boolean => {
    if (isNoneValue(value)) return NONE_FILTER_VALUE;
    return value as string | number | boolean;
  };
  const make = (
    values: readonly (string | number | boolean)[],
    name: string,
    idValue: string,
  ): Cohort => ({
    id: groupCohortId(panel.split as ColumnId, idValue),
    name,
    color: groupColorIndex(name),
    source: base.source,
    view: base.view,
    filters: [...base.filters, { field: panel.split as ColumnId, op: 'in', values }],
    selections,
  });
  const named = ranked.slice(0, MAX_OVERLAY_GROUPS).map((entry) => {
    const value = wireValue(entry.value);
    const name = fieldValueLabel(String(panel.split), entry.value);
    return make([value], name === 'other' ? 'Other' : name, String(value));
  });
  const tail = ranked.slice(MAX_OVERLAY_GROUPS).map((entry) => wireValue(entry.value));
  return tail.length === 0
    ? named
    : [...named, make(tail, 'Other', `other:${JSON.stringify(tail)}`)];
}

/** The columns a sample panel asks for: every exportable field of the view. */
export function sampleColumns(state: State, view = state.global.view): readonly ColumnId[] {
  return fieldsFor(state.global.modality, view, 'export').map((f) => f.id);
}

/** ISO date only, so card-local coverage filters use the same values as the picker. */
function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Replace only a cohort's time predicate with the card's coverage window.  A
 * saved cohort can still contribute every other filter; choosing "last year"
 * must not silently turn it back into the top-bar dashboard.
 */
export function coverageFilters(
  filters: readonly Filter[],
  panel: Panel,
  now = new Date(),
): readonly Filter[] {
  const window = panel.options.coverageWindow;
  if (window === 'all') return filters;
  const rest = filters.filter((filter) => filter.field !== 'created_at');
  let range = panel.options.coverageCustom;
  if (window === '12m' || window === '5y') {
    const end = new Date(now);
    const start = new Date(now);
    start.setUTCFullYear(start.getUTCFullYear() - (window === '12m' ? 1 : 5));
    range = [dateOnly(start), dateOnly(end)];
  }
  return range === null || range.some((date) => date === '' || Number.isNaN(Date.parse(date)))
    ? rest
    : [...rest, { field: 'created_at' as ColumnId, op: 'between', lo: range[0], hi: range[1] }];
}

/** One cohort's distribution query, with or without the panel's shared range. */
function cohortQuery(
  state: State,
  panel: Panel,
  cohort: Cohort,
  range?: readonly [number, number],
): Query {
  const query: Query = {
    source: cohort.source,
    proc: 'distribution',
    metric: panel.x as ColumnId,
    // A smoothed curve is computed from a fine histogram, so it asks for one:
    // the kernel's job is to remove the binning, and it can only do that if the
    // bins are finer than the structure being smoothed. 200 is the server's cap
    // and the resolution the "approximate at 200 bins" note refers to.
    bins: panel.chart === 'density' ? DENSITY_BINS : panel.options.bins,
    clip: panel.options.clip,
    modality: state.global.modality,
    view: cohort.view,
    filters: cohort.filters,
    selections: cohort.selections,
  };
  return range === undefined ? query : { ...query, range: [range[0], range[1]] };
}

/**
 * What one cohort contributes to the shared range: an interval, or `'empty'`
 * when its result is here and names no interval at all.
 *
 * The distinction matters because the two cases want opposite treatment --
 * `null` (not yet known) must postpone the range, `'empty'` must be skipped --
 * and collapsing them into one `null` is what blanked a whole panel's bars
 * whenever any cohort matched nothing.
 */
export type CohortExtent = readonly [number, number] | 'empty';

/**
 * The x range one cohort would have binned itself over: the clip's two
 * quantiles, or the finite min and max when the clip is `none`.
 */
export function cohortRange(result: DistributionResult, clip: ClipMode): CohortExtent {
  const clipped = clipBounds(result, clip);
  if (clipped !== null) return clipped;
  const { min, max } = result;
  if (min === null || max === null) return 'empty';
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return 'empty';
  return [min, max];
}

/**
 * The range every cohort of one panel is binned over: the union of what each
 * would have chosen for itself.
 *
 * The union and not the intersection, because a shared grid that cut off one
 * cohort's bulk would be a chart that lies about which cohort is wider --
 * exactly the failure overlaid histograms with independent edges have.
 */
export function sharedRange(
  ranges: readonly (CohortExtent | null)[],
): readonly [number, number] | null {
  // `null` is "this cohort's result has not arrived": the range has to be
  // computed from all of them or not at all, because one derived from half the
  // cohorts would change the moment the other half landed and refetch every
  // histogram.
  if (ranges.length === 0 || ranges.some((range) => range === null)) return null;
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const range of ranges as readonly CohortExtent[]) {
    // `'empty'` is a different thing: the result is here and the cohort has no
    // extent -- it matched nothing, or the metric is constant in it. Such a
    // cohort is *left out of the union* rather than collapsing it, which is what
    // lets the other cohorts still be drawn.
    if (range === 'empty') continue;
    lo = Math.min(lo, range[0]);
    hi = Math.max(hi, range[1]);
  }
  return Number.isFinite(lo) && Number.isFinite(hi) && hi > lo ? [lo, hi] : null;
}

/** The shared range of one comparison panel, or null while step one is incomplete. */
export function panelSharedRange(
  state: State,
  panel: Panel,
  cohorts: readonly Cohort[],
): readonly [number, number] | null {
  if (panel.options.xRange !== 'auto') return panel.options.xRange;
  if (panel.split && panel.options.layout !== 'overlaid') {
    // A stack partitions this panel's population, so use the unsplit clip
    // rather than the wider union of each manufacturer's tail quantiles.
    const result = distributionResult(state, queryKey(cohortQuery(state, panel, panelCohort(state, panel))));
    return result?.histogram ? [result.histogram.lo, result.histogram.hi] : null;
  }
  const clip = panel.options.clip;
  const ranges = cohorts.map((cohort) => {
    const result = distributionResult(state, queryKey(cohortQuery(state, panel, cohort)));
    return result === null ? null : cohortRange(result, clip);
  });
  return sharedRange(ranges);
}

/**
 * Each cohort paired with both of its results: its own distribution and, once
 * the shared range is known and the fetch has landed, the one over that range.
 *
 * The two-step fetch, read back. The keys are rebuilt rather than sliced off
 * `panelKeys`, so this cannot silently pair a cohort with another cohort's
 * result when the panel's cohort list changes under a stale memo.
 */
export function cohortResults(state: State, panel: Panel, cohorts: readonly Cohort[]) {
  const range = panelSharedRange(state, panel, cohorts);
  return cohorts.map((cohort) => ({
    id: cohort.id,
    name: cohort.name,
    base: distributionResult(state, queryKey(cohortQuery(state, panel, cohort))),
    ranged:
      range === null
        ? null
        : distributionResult(state, queryKey(cohortQuery(state, panel, cohort, range))),
  }));
}

/** A ready entry's result, or null while the key has no ready entry. */
export function resultOf<T>(state: State, key: QueryKey | undefined): T | null {
  if (key === undefined) return null;
  const entry = state.datasets[key];
  return entry?.status === 'ready' ? (entry.result as T) : null;
}

/** The same, shape-checked: `asDistributionResult` says why that matters. */
export function distributionResult(
  state: State,
  key: QueryKey | undefined,
): DistributionResult | null {
  return asDistributionResult(resultOf<unknown>(state, key));
}

/**
 * One query of this procedure for this panel, or null when a parameter it needs
 * is not set yet -- which is how an unconfigured panel fetches nothing.
 *
 * The one switch in the planner, and it is over *procedures* rather than panel
 * kinds: each procedure has its own parameter set, and the table says which
 * procedure a kind asks for.
 */
function queryFor(state: State, panel: Panel, proc: ProcName): Query | null {
  const cohort = panelCohort(state, panel);
  const scoped = {
    modality: state.global.modality,
    view: cohort.view,
    filters: cohort.filters,
    // The live dashboard scope follows a brush exactly as it did before;
    // saved/all/group cohorts keep the range that is part of their definition.
    selections:
      (panel.cohorts[0] ?? CURRENT_COHORT) === CURRENT_COHORT
        ? effectiveSelection(state, panel)
        : cohort.selections,
  };
  switch (proc) {
    case 'distribution':
      if (!panel.x || panel.x === 'created_at') return null;
      return {
        source: cohort.source,
        proc,
        metric: panel.x,
        bins: panel.options.bins,
        clip: panel.options.clip,
        ...(panel.options.xRange === 'auto' ? {} : { range: [...panel.options.xRange] as [number, number] }),
        ...scoped,
      };
    case 'groupedSummary':
      if (!panel.x || panel.x === 'created_at' || !panel.split) return null;
      return { source: cohort.source, proc, metric: panel.x, group: panel.split, ...scoped };
    case 'timeSummary':
      if (!panel.y) return null;
      return { source: cohort.source, proc, metric: panel.y, granularity: panel.options.granularity,
        ...(panel.split ? { group: panel.split } : {}), ...scoped,
        filters: coverageFilters(cohort.filters, panel) };
    case 'coverage':
      if (!panel.split || cohort.source === 'study') return null;
      return {
        source: 'population',
        proc,
        group: panel.split,
        granularity: panel.options.granularity,
        ...scoped,
        filters: coverageFilters(cohort.filters, panel),
      };
    case 'sample':
      if (cohort.source === 'study') return null;
      return {
        source: 'population',
        proc,
        columns: sampleColumns(state, cohort.view),
        cursor: null,
        ...scoped,
      };
    case 'catalog':
      return { source: 'population', proc };
    case 'density2d':
      if (!panel.x || panel.x === 'created_at' || !panel.y) return null;
      return { source: cohort.source, proc, ...scoped, x: panel.x, y: panel.y,
        bins: 120, clip: panel.options.clip, sampleSize: panel.options.sampleSize ?? 2000,
        seed: panel.options.seed ?? 42 };
    case 'correlation': {
      if (!panel.x) return null;
      let metrics = correlationMetrics(panel, state.global.modality);
      if (cohort.source === 'study' && !panel.options.metrics && typeof state.study === 'object' && state.study.status === 'ready') {
        const available = state.study.metrics;
        metrics = metrics.filter(metric => available.includes(metric));
      }
      return metrics.length < 2 ? null : {
        source: cohort.source, proc, ...scoped, metrics: metrics.slice(0, 24), method: 'both',
      };
    }
  }
}

/** The plan helpers, bound to one state and one panel. */
function planContext(state: State, panel: Panel): PlanContext {
  const steps = (cohorts: readonly Cohort[], minimum: number): readonly Query[] => {
    if (!panel.x || cohorts.length < minimum) return [];
    const base = cohorts.map((cohort) => cohortQuery(state, panel, cohort));
    const range = panelSharedRange(state, panel, cohorts);
    return range === null
      ? base
      : [...base, ...cohorts.map((cohort) => cohortQuery(state, panel, cohort, range))];
  };
  return {
    panel,
    query: (proc) => queryFor(state, panel, proc),
    pages: () => {
      const base = queryFor(state, panel, 'sample');
      if (base === null || base.proc !== 'sample') return [];
      return panel.cursors.map((cursor) => ({ ...base, cursor }));
    },
    cohortSteps: () => {
      const cohorts = panelCohorts(state, panel);
      return steps(cohorts, MIN_COMPARISON_COHORTS);
    },
    splitSteps: () => {
      const cohorts = splitDistributionCohorts(state, panel);
      if (cohorts.length > 0) {
        const queries = steps(cohorts, 1);
        return panel.options.layout !== 'overlaid' && panel.options.xRange === 'auto'
          ? [...queries, cohortQuery(state, panel, panelCohort(state, panel))]
          : queries;
      }
      // Numeric/date grouping has no categorical value catalog from which to
      // mint exact filter cohorts. Preserve its grouped-summary path; the
      // cohort route above is the categorical split this plan is for.
      const query = queryFor(state, panel, 'groupedSummary');
      return query === null ? [] : [query];
    },
  };
}

/**
 * Every query one panel needs. Empty when the panel is not configured yet (no
 * metric, no group), which is how an unconfigured panel avoids fetching.
 */
export function panelQueries(state: State, panel: Panel): readonly Query[] {
  if (panel.chart === 'medianBand') {
    const base = panelCohorts(state, panel).flatMap(cohort => {
      const query = queryFor(state, { ...panel, cohorts: [cohort.id] }, 'timeSummary');
      return query?.proc === 'timeSummary' ? [query] : [];
    });
    if (!panel.split || !base[0]) return base;
    const result = resultOf<TimeSummaryResult>(state, queryKey(base[0]));
    const tail = result ? timeTailQuery(base[0], result) : null;
    return tail ? [...base, tail] : base;
  }
  if (panel.chart === 'correlation') {
    return panelCohorts(state, panel).flatMap(cohort => {
      const query = queryFor(state, { ...panel, cohorts: [cohort.id] }, 'correlation');
      return query ? [query] : [];
    });
  }
  if (shapeOf(panel) === 'bivariate') return densityQueries(state, panel);
  const def = PANEL_KINDS[shapeOf(panel)];
  const ctx = planContext(state, panel);
  if (def.plan !== undefined) return def.plan(ctx);
  const query = ctx.query(def.procedures[0]);
  return query === null ? [] : [query];
}

export function densityQueries(state: State, panel: Panel): readonly Extract<Query, { proc: 'density2d' }>[] {
  const base = panelCohorts(state, panel).flatMap(cohort => {
    const query = queryFor(state, { ...panel, cohorts: [cohort.id] }, 'density2d');
    return query?.proc === 'density2d' ? [{ ...query, sampleSize: panel.chart === 'clusters' ? panel.options.sampleSize ?? 20000 : 2000 }] : [];
  });
  if (base.length < 2 && panel.options.xRange === 'auto' && panel.options.yRange === 'auto') return base;
  const results = base.map(query => resultOf<Density2dResult>(state, queryKey(query)));
  if (results.some(result => !result)) return base;
  const finite = results.filter((result): result is Density2dResult => !!result && result.n > 0);
  if (!finite.length) return base;
  const bounds = (axis: 'x' | 'y'): [number, number] => [
    Math.min(...finite.map(result => result[axis].lo)),
    Math.max(...finite.map(result => result[axis].lo + result[axis].width * result[axis].bins)),
  ];
  const range = { x: panel.options.xRange === 'auto' ? bounds('x') : [...panel.options.xRange] as [number, number],
    y: panel.options.yRange === 'auto' ? bounds('y') : [...panel.options.yRange] as [number, number] };
  if (range.x[1] <= range.x[0] || range.y[1] <= range.y[0]) return base;
  return [...base, ...base.map(query => ({ ...query, range }))];
}

export function clusterKey(state: State, panel: Panel): string | null {
  if (panel.chart !== 'clusters') return null;
  const query = densityQueries(state, panel)[0];
  return query ? `clusters/${queryKey(query)}/k=${panel.options.k ?? 3}/seed=${panel.options.seed ?? 42}` : null;
}

/** The keys one panel reads, in the order `panelQueries` produced them. */
export function panelKeys(state: State, panel: Panel): readonly QueryKey[] {
  return panelQueries(state, panel).map(queryKey);
}

/** Every key any panel references, plus the catalog. Eviction spares these. */
export function referencedKeys(state: State): Set<QueryKey> {
  const keys = new Set<QueryKey>([CATALOG_KEY]);
  if (state.exportDialogOpen) keys.add(queryKey(exportCountQuery(state)));
  for (const panel of state.panels) {
    for (const key of panelKeys(state, panel)) keys.add(key);
    const local = clusterKey(state, panel); if (local) keys.add(local);
  }
  return keys;
}

/** True when the datasets map already answers this key at the current version. */
function satisfied(state: State, key: QueryKey): boolean {
  const entry = state.datasets[key];
  return entry !== undefined && entry.version === state.dataVersion;
}

/**
 * The effects contract, as a map so the runner has the query and not only its
 * key. `needed` is the documented set; this is the same thing with the
 * parameters still attached, which saves parsing a key back into a query.
 */
export function neededQueries(state: State): ReadonlyMap<QueryKey, Query> {
  const out = new Map<QueryKey, Query>();
  const count = exportCountQuery(state);
  if (state.exportDialogOpen && !satisfied(state, queryKey(count))) out.set(queryKey(count), count);
  // Membership is "has no entry at the current version", for the catalog
  // exactly as for every panel key: its value lists, date range and metric
  // counts are computed per ingest, so a version change makes it needed again.
  //
  // Deliberately *not* "or while the catalog is null". A failed catalog fetch
  // leaves an error entry and no catalog, and keeping the key needed forever on
  // that account retried nothing -- the runner starts a fetch for a key that
  // *enters* the set, and this one never left -- while holding `pendingCount`
  // above zero, which is what pinned the status line on "Loading the metric
  // catalogue". An error entry satisfies its key; `retryKey` deletes the entry,
  // and that re-entry is what restarts the fetch.
  if (!satisfied(state, CATALOG_KEY)) {
    out.set(CATALOG_KEY, { source: 'population', proc: 'catalog' });
  }
  for (const panel of state.panels) {
    for (const query of panelQueries(state, panel)) {
      const key = queryKey(query);
      if (!satisfied(state, key) && !out.has(key)) out.set(key, query);
    }
  }
  return out;
}

/** The set of query keys for which no entry exists at the current `dataVersion`. */
export function needed(state: State): Set<QueryKey> {
  return new Set(neededQueries(state).keys());
}

/** An exact quantile query for the categorical tail, rather than pooled medians. */
export function timeTailQuery(query: TimeSummaryQuery, result: TimeSummaryResult): TimeSummaryQuery | null {
  if (!query.group || getAuthoredCatalog().fields.find(field => field.id === query.group)?.kind !== 'categorical') return null;
  const groups = timeGroups(result);
  const named = groups.filter(group => group.id !== 'other');
  if (named.length <= 6 || groups.some(group => group.id === 'other')) return null;
  const values = named.slice(6).map(group => isNoneValue(group.buckets[0].group) ? NONE_FILTER_VALUE : group.buckets[0].group!);
  const { group, ...rest } = query;
  return { ...rest, filters: [...query.filters, { field: group, op: 'in', values }] };
}
import { correlationMetrics } from './correlation-options';
