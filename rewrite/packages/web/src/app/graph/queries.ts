import { getAuthoredCatalog, asColumnId, fieldsFor, metricsFor, fieldValueLabel, isNoneValue, NONE_FILTER_VALUE,
  type ClipMode, type ColumnId, type DistributionResult, type Density2dResult, type Filter, type QueryKey, type Selection,
  type BinnedSummaryQuery, type BinnedSummaryResult } from '@mriqc/shared';
import { queryKey, type Query } from '../api/api';
import { exportCountQuery } from '../chrome/export-view';
import { asDistributionResult, clipBounds } from '../panels/specs';
import { cohortById, currentCohort } from './cohorts';
import { axisType, panelForms } from './panel-shapes';
import { seriesKey, seriesLabel, type Series } from './series';
import { CURRENT_COHORT, DENSITY_BINS, groupCohortId, type Cohort, type Panel, type State } from './state';
import { correlationMetrics } from './correlation-options';
import { timeGroups } from './time-groups';

export const CATALOG_KEY: QueryKey = queryKey({ source: 'population', proc: 'catalog' });
export function effectiveSelection(state: State, panel: Panel): readonly Selection[] {
  return panel.options.useSelection ? state.selections.filter(selection => selection.from !== panel.id).map(({ metric, range }) => ({ metric, range })) : [];
}
export function studyReady(state: State): boolean { return typeof state.study === 'object' && state.study.status === 'ready'; }
export function studyFormReason(panel: Panel, state: State): string | null {
  const study = state.study;
  if (typeof study !== 'object' || study.status !== 'ready') return null;
  const columns = study.columns ?? study.metrics;
  if (panel.form === 'matrix') {
    const metrics = correlationMetrics(panel, state.global.modality);
    const available = metrics.filter(metric => study.metrics.includes(metric));
    if (panel.options.family === 'custom' && available.length !== metrics.length) return 'your file is missing a selected metric';
    return available.length < 2 ? 'your file needs at least two metrics in this set' : null;
  }
  if ((panel.x === 'created_at' || panel.y === 'created_at') && !columns.includes('created_at')) return 'your file has no upload time';
  for (const column of [panel.x, panel.y]) {
    if (column && !columns.includes(column)) return `your file has no ${column} column`;
  }
  return null;
}
export function panelCohort(state: State, panel: Panel): Cohort {
  return { ...currentCohort(state), selections: effectiveSelection(state, panel) };
}
export type ResolvedSeries = Cohort & { descriptorKey?: string };
export function groupingSeries(panel: Panel) { return panel.series.find(series => series.kind === 'field' || series.kind === 'values'); }

/** One expansion for every form. A grouping partitions the dashboard curve; its aggregate still supplies stats. */
export function panelCohorts(state: State, panel: Panel): readonly ResolvedSeries[] {
  const base = panelCohort(state, panel);
  const grouped = groupingSeries(panel);
  const out: ResolvedSeries[] = grouped ? [] : [base];
  for (const descriptor of panel.series) {
    if (descriptor.kind === 'study' && studyFormReason(panel, state)) continue;
    const descriptorKey = seriesKey(descriptor);
    if (descriptor.kind === 'field' || descriptor.kind === 'values') {
      const entries = state.catalog?.fieldValues?.[descriptor.field]?.[state.global.modality]?.[state.global.view] ?? [];
      const wire = (value: string | number | boolean | null) => isNoneValue(value) ? NONE_FILTER_VALUE : value!;
      const ranked = [...entries].sort((a, b) => b.n - a.n || String(a.value).localeCompare(String(b.value)));
      const selected = descriptor.kind === 'values' ? descriptor.values.map(value =>
        entries.find(entry => String(wire(entry.value)) === value) ?? { value, n: 0 }) : ranked.slice(0, 5);
      for (const entry of selected) {
        const value = wire(entry.value);
        out.push({ ...base, id: groupCohortId(descriptor.field, String(value)),
          name: fieldValueLabel(String(descriptor.field), entry.value), color: out.length,
          filters: [...base.filters, { field: descriptor.field, op: 'in', values: [value] }], descriptorKey });
      }
      if (descriptor.kind === 'field' && ranked.length > 5) {
        const values = ranked.slice(5).map(entry => wire(entry.value));
        out.push({ ...base, id: groupCohortId(descriptor.field, 'other:' + JSON.stringify(values)), name: 'Other', color: 6,
          filters: [...base.filters, { field: descriptor.field, op: 'in', values }], descriptorKey });
      }
      continue;
    }
    if (descriptor.kind === 'span') {
      out.push({ ...base, id: descriptorKey, name: seriesLabel(descriptor), color: out.length, descriptorKey,
        filters: [...base.filters.filter(filter => filter.field !== 'created_at'),
          { field: asColumnId('created_at'), op: 'between', lo: descriptor.from, hi: descriptor.to }] });
      continue;
    }
    const id = descriptor.kind === 'population' ? 'all' : descriptor.kind === 'study' ? 'study' : descriptor.id;
    const cohort = cohortById(state, id);
    if (cohort) out.push({ ...cohort, color: out.length, descriptorKey });
  }
  return out;
}
export function splitDistributionCohorts(state: State, panel: Panel): readonly Cohort[] {
  return groupingSeries(panel) ? panelCohorts(state, panel).filter(cohort => cohort.descriptorKey === seriesKey(groupingSeries(panel)!)) : [];
}
export function sampleColumns(state: State, view = state.global.view): readonly ColumnId[] {
  return fieldsFor(state.global.modality, view, 'export').map(field => field.id);
}
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
  const withAxisRange = (base: readonly Filter[]): readonly Filter[] => {
    const range = panel.options.xRange;
    return panel.x === 'created_at' && range !== 'auto'
      ? [...base, { field: asColumnId('created_at'), op: 'between', lo: new Date(range[0]).toISOString(), hi: new Date(range[1]).toISOString() }]
      : base;
  };
  if (window === 'all') return withAxisRange(filters);
  const rest = filters.filter((filter) => filter.field !== 'created_at');
  let range = panel.options.coverageCustom;
  if (window === '12m' || window === '5y') {
    const end = new Date(now);
    const start = new Date(now);
    start.setUTCFullYear(start.getUTCFullYear() - (window === '12m' ? 1 : 5));
    range = [dateOnly(start), dateOnly(end)];
  }
  return range === null || range.some((date) => date === '' || Number.isNaN(Date.parse(date)))
    ? withAxisRange(rest)
    : withAxisRange([...rest, { field: 'created_at' as ColumnId, op: 'between', lo: range[0], hi: range[1] }]);
}


export function cohortQuery(state: State, panel: Panel, cohort: Cohort, range?: readonly [number, number]): Extract<Query, { proc: 'distribution' }> {
  if (!panel.series.length && panel.options.xRange !== 'auto') range ??= panel.options.xRange;
  return { source: cohort.source, proc: 'distribution', metric: panel.x as ColumnId,
    bins: panel.form === 'density' ? DENSITY_BINS : panel.options.bins, clip: panel.options.clip,
    modality: state.global.modality, view: cohort.view, filters: cohort.filters, selections: cohort.selections,
    ...(range ? { range: [range[0], range[1]] } : {}) };
}
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


export function panelSharedRange(state: State, panel: Panel, cohorts: readonly Cohort[]): readonly [number, number] | null {
  if (panel.options.xRange !== 'auto') return panel.options.xRange;
  if (groupingSeries(panel) && panel.options.layout !== 'overlaid') {
    const result = distributionResult(state, queryKey(cohortQuery(state, panel, panelCohort(state, panel))));
    return result?.histogram ? [result.histogram.lo, result.histogram.hi] : null;
  }
  return sharedRange(cohorts.map(cohort => {
    const result = distributionResult(state, queryKey(cohortQuery(state, panel, cohort)));
    return result ? cohortRange(result, panel.options.clip) : null;
  }));
}
export function cohortResults(state: State, panel: Panel, cohorts: readonly Cohort[]) {
  const range = panelSharedRange(state, panel, cohorts);
  return cohorts.map(cohort => ({ id: cohort.id, name: cohort.name,
    base: distributionResult(state, queryKey(cohortQuery(state, panel, cohort))),
    ranged: range ? distributionResult(state, queryKey(cohortQuery(state, panel, cohort, range))) : null }));
}
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


export function scopedQuery(state: State, panel: Panel, cohort: Cohort, proc: Query['proc']): Query | null {
  if (cohort.source === 'study' && studyFormReason(panel, state)) return null;
  const scoped = { source: cohort.source, modality: state.global.modality, view: cohort.view, filters: cohort.filters, selections: cohort.selections };
  switch (proc) {
    case 'distribution': return cohortQuery(state, panel, cohort, panel.options.xRange === 'auto' ? undefined : panel.options.xRange);
    case 'groupedSummary': return cohort.source === 'study' ? null : { ...scoped, proc, metric: asColumnId('size_x'), group: panel.x as ColumnId };
    case 'coverage': {
      if (cohort.source === 'study') return { ...scoped, source: 'study', proc,
        group: axisType(panel.x) === 'categorical' ? panel.x as ColumnId : asColumnId('created_at'),
        countsOnly: axisType(panel.x) === 'categorical', granularity: panel.options.granularity,
        filters: panel.x === 'created_at' ? coverageFilters(cohort.filters, panel) : cohort.filters };
      const group = axisType(panel.x) === 'categorical' ? panel.x as ColumnId :
        fieldsFor(state.global.modality, cohort.view, 'group').find(field => field.kind === 'categorical')?.id;
      return group ? { ...scoped, source: 'population', proc, group, granularity: panel.options.granularity,
        filters: coverageFilters(cohort.filters, panel) } : null;
    }
    case 'binnedSummary': return panel.y ? { ...scoped, proc, x: panel.x, y: panel.y,
      bins: panel.x === 'created_at' ? panel.options.granularity : panel.options.bins,
      ...(panel.options.xRange !== 'auto' ? { range: [...panel.options.xRange] as [number, number] } : {}),
      filters: panel.x === 'created_at' ? coverageFilters(cohort.filters, panel) : cohort.filters } : null;
    case 'sample': return cohort.source === 'population' ? { ...scoped, source: 'population', proc, columns: sampleColumns(state, cohort.view), cursor: null,
      filters: panel.x === 'created_at' ? coverageFilters(cohort.filters, panel) : cohort.filters } :
      typeof state.study === 'object' && state.study.status === 'ready' ? {
        ...scoped, source: 'study', proc, cursor: null,
        columns: (state.study.columns ?? state.study.metrics).map(asColumnId),
        filters: panel.x === 'created_at' ? coverageFilters(cohort.filters, panel) : cohort.filters,
      } : null;
    case 'density2d': return panel.y ? { ...scoped, proc, x: panel.x as ColumnId, y: panel.y, bins: 120, clip: panel.options.clip,
      sampleSize: panel.form === 'clusters' ? panel.options.sampleSize ?? 20000 : 2000, seed: panel.options.seed ?? 42 } : null;
    case 'correlation': {
      let metrics = correlationMetrics(panel, state.global.modality);
      if (cohort.source === 'study' && typeof state.study === 'object' && state.study.status === 'ready' && panel.options.family !== 'custom') {
        const available = state.study.metrics;
        metrics = metrics.filter(metric => available.includes(metric));
      }
      return metrics.length > 1 ? { ...scoped, proc, metrics: metrics.slice(0, 24), method: 'both' } : null;
    }
    case 'catalog': return { source: 'population', proc };
  }
}

export function panelQueries(state: State, panel: Panel): readonly Query[] {
  if (!panelForms(panel).includes(panel.form)) return [];
  const cohorts = panelCohorts(state, panel);
  const query = (cohort: Cohort, proc: Query['proc']) => scopedQuery(state, panel, cohort, proc);
  if (panel.form === 'table') {
    return [
      ...samplePages(state, panel).map(page => page.query),
      ...[...cohorts, ...(groupingSeries(panel) ? [panelCohort(state, panel)] : [])].flatMap(cohort => {
        const q = query(cohort, axisType(panel.x) === 'numeric' ? 'distribution' : 'coverage');
        return q ? [q] : [];
      }),
    ];
  }
  if (panel.form === 'matrix') return cohorts.flatMap(cohort => { const q = query(cohort, 'correlation'); return q ? [q] : []; });
  if (panel.y) return [
    ...(panel.form === 'band' || panel.form === 'lines' ? binnedQueries(state, panel) : densityQueries(state, panel)),
    ...(axisType(panel.x) === 'numeric' ? [cohortQuery(state, panel, panelCohort(state, panel))] : []),
  ];
  if (axisType(panel.x) === 'time' || axisType(panel.x) === 'categorical') {
    const proc = axisType(panel.x) === 'categorical' ? 'groupedSummary' : 'coverage';
    const results = cohorts.flatMap(cohort => { const q = query(cohort, proc); return q ? [q] : []; });
    // groupedSummary counts finite metric values. Coverage supplies exact row counts, including missing metrics.
    if (axisType(panel.x) === 'categorical') results.push(...cohorts.flatMap(cohort => { const q = query(cohort, 'coverage'); return q ? [q] : []; }));
    if (groupingSeries(panel)) {
      const aggregate = query(panelCohort(state, panel), proc);
      if (aggregate) results.push(aggregate);
      if (axisType(panel.x) === 'categorical') {
        const count = query(panelCohort(state, panel), 'coverage');
        if (count) results.push(count);
      }
    }
    return results;
  }
  if (!panel.series.length) return [cohortQuery(state, panel, panelCohort(state, panel))];
  const base = cohorts.map(cohort => cohortQuery(state, panel, cohort));
  const range = panelSharedRange(state, panel, cohorts);
  const queries: Query[] = range ? [...base, ...cohorts.map(cohort => cohortQuery(state, panel, cohort, range))] : [...base];
  if (groupingSeries(panel)) queries.push(cohortQuery(state, panel, panelCohort(state, panel)));
  return queries;
}

/** Each pagination round carries an independent cursor for every displayed series. */
export function samplePages(state: State, panel: Panel) {
  const cohorts = panelCohorts(state, panel);
  return panel.cursors.flatMap(cursor => cohorts.flatMap(cohort => {
    let next = cursor;
    if (panel.series.length && cursor !== null) {
      try { next = (JSON.parse(cursor) as Record<string, string | null>)[cohort.id] ?? null; }
      catch { return []; }
      if (next === null) return [];
    }
    const query = scopedQuery(state, panel, cohort, 'sample');
    return query?.proc === 'sample' ? [{ cohort, query: { ...query, cursor: next } }] : [];
  }));
}

export function binnedQueries(state: State, panel: Panel): readonly BinnedSummaryQuery[] {
  const cohorts = [...panelCohorts(state, panel), ...(groupingSeries(panel) ? [panelCohort(state, panel)] : [])];
  const base = cohorts.flatMap(cohort => {
    const query = scopedQuery(state, panel, cohort, 'binnedSummary');
    return query?.proc === 'binnedSummary' ? [query] : [];
  });
  if (panel.x === 'created_at' || base.length < 2 || panel.options.xRange !== 'auto') return base;
  const results = base.map(query => resultOf<BinnedSummaryResult>(state, queryKey(query)));
  if (results.some(result => !result)) return base;
  const occupied = results.filter(result => result && result.buckets.length) as BinnedSummaryResult[];
  if (!occupied.length) return base;
  const range: [number, number] = [Math.min(...occupied.map(result => result.range[0])), Math.max(...occupied.map(result => result.range[1]))];
  return [...base, ...base.map(query => ({ ...query, range }))];
}

export function densityQueries(state: State, panel: Panel): readonly Extract<Query, { proc: 'density2d' }>[] {
  const base = panelCohorts(state, panel).flatMap(cohort => {
    const query = scopedQuery(state, panel, cohort, 'density2d');
    return query?.proc === 'density2d' ? [query] : [];
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
  return range.x[1] <= range.x[0] || range.y[1] <= range.y[0] ? base : [...base, ...base.map(query => ({ ...query, range }))];
}
export function clusterKey(state: State, panel: Panel, index = 0): string | null {
  if (panel.form !== 'clusters') return null;
  const query = densityQueries(state, panel)[index];
  return query ? `clusters/${queryKey(query)}/k=${panel.options.k ?? 3}/seed=${panel.options.seed ?? 42}` : null;
}

export function clusterKeys(state: State, panel: Panel): readonly string[] {
  return panel.form === 'clusters' ? panelCohorts(state, panel).flatMap((_, index) => {
    const key = clusterKey(state, panel, index); return key ? [key] : [];
  }) : [];
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
    for (const local of clusterKeys(state, panel)) keys.add(local);
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


export function timeTailQuery(query: BinnedSummaryQuery, result: BinnedSummaryResult): BinnedSummaryQuery | null {
  if (!query.groups || getAuthoredCatalog().fields.find(field => field.id === query.groups)?.kind !== 'categorical') return null;
  const groups = timeGroups(result);
  const named = groups.filter(group => group.id !== 'other');
  if (named.length <= 6 || groups.some(group => group.id === 'other')) return null;
  const values = named.slice(6).map(group => isNoneValue(group.buckets[0].group) ? NONE_FILTER_VALUE : group.buckets[0].group!);
  const { groups: group, ...rest } = query;
  return { ...rest, filters: [...query.filters, { field: group, op: 'in', values }] };
}
