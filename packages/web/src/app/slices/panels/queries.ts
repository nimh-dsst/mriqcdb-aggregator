import {
asColumnId,fieldsFor,
getAuthoredCatalog,
isNoneValue,NONE_FILTER_VALUE,
type BinnedSummaryQuery,type BinnedSummaryResult,
type ClipMode,type ColumnId,
type Density2dResult,
type DistributionResult,
type Filter,type QueryKey
} from '@mriqc/shared';
import { queryKey,type Query } from '../../api/api';
import { formDef } from '../../forms/registry';
import { type Cohort,type Panel,type State } from '../../graph/state';
import { clipBounds } from '../../panels/specs';
import { panelCohort } from "../cohorts/queries";
import { distributionResult,resultOf } from "../history/results";
import { groupingSeries,panelCohorts } from "../series/queries";
import { timeGroups } from '../series/time-groups';
import { studyFormReason } from "../study/queries";
import { correlationMetrics } from './correlation-options';
import { fineGranularity } from './count-band';
import { axisType,panelForms } from './shapes';

export function sampleColumns(state: State, view = state.global.view): readonly ColumnId[] {
  return fieldsFor(state.global.modality, view, 'export').map(field => field.id);
}

export function dateOnly(date: Date): string {
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
    bins: formDef(panel.form).distributionBins(panel), clip: panel.options.clip,
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
    case 'density2d': return panel.y ? { ...scoped, proc, x: panel.x as ColumnId, y: panel.y, grid: panel.options.cells ?? 60, bins: 120, clip: panel.options.clip,
      sampleSize: formDef(panel.form).densitySampleSize(panel), seed: panel.options.seed ?? 42 } : null;
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


/** Coverage counted per fine period, for a count band (see count-band.ts). */
export function countBandQuery(state: State, panel: Panel, cohort: Cohort): Query | null {
  const query = scopedQuery(state, panel, cohort, 'coverage');
  return query?.proc === 'coverage' ? { ...query, granularity: fineGranularity(panel.options.granularity) } : null;
}

export function isCountBand(panel: Panel): boolean {
  return formDef(panel.form).countBand && panel.y === null && axisType(panel.x) === 'time';
}


export function panelQueries(state: State, panel: Panel): readonly Query[] {
  if (!panelForms(panel).includes(panel.form)) return [];
  return formDef(panel.form).queries(state, panel, { panelCohorts, panelCohort, scopedQuery, samplePages, groupingSeries, countBandQuery, cohortQuery, panelSharedRange, binnedQueries, densityQueries });
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
  return formDef(panel.form).localKey?.(state, panel, index, { panelCohorts, panelCohort, scopedQuery, samplePages, groupingSeries, countBandQuery, cohortQuery, panelSharedRange, binnedQueries, densityQueries }) ?? null;
}

export function clusterKeys(state: State, panel: Panel): readonly string[] {
  return formDef(panel.form).localKey ? panelCohorts(state, panel).flatMap((_, index) => {
    const key = clusterKey(state, panel, index); return key ? [key] : [];
  }) : [];
}


/** The keys one panel reads, in the order `panelQueries` produced them. */
export function panelKeys(state: State, panel: Panel): readonly QueryKey[] {
  return panelQueries(state, panel).map(queryKey);
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
