import { asColumnId, fieldValueLabel, queryKey, fieldsFor, type ColumnId, type CoverageResult, type GroupedSummaryResult, type QueryKey, type SampleResult, type SampleRow } from '@mriqc/shared';
import type { TopLevelSpec } from 'vega-lite';
import { axisType, panelForms } from '../graph/panel-shapes';
import { axisEvidence } from '../graph/axis-options';
import { withChipLegend } from '../panels/specs/chip-legend';
import { LIGHT_THEME, OTHER_COLOR, type ChartTheme, type CohortResult, type MetricAxis } from '../panels/specs';
import { comparisonChart, distributionChart, type ChartInput, type ChartOutput } from '../panels/specs/select';
import { stackedHistogram, COHORTS_DATA } from '../panels/specs/comparison';
import { categoryChart } from '../panels/specs/categories';
import { baseConfig } from '../panels/specs/palette';
import { timePanelView } from './time-view';
import { analysisPanelView, type AnalysisRow } from './analysis-view';
import type { CohortChip } from '../graph/cohorts';
import { cohortQuery, cohortResults, panelCohort, distributionResult, panelCohorts, panelKeys, panelSharedRange, resultOf, sampleColumns, samplePages, scopedQuery, studyFormReason } from '../graph/queries';
import type { CohortId, Panel, PanelId, State } from '../graph/state';
import { comparisonStats, outsideRangeNotes, panelStats, type ComparisonStats, type PanelStat } from './stats';
import { activeView, clipChip, countAxisTitle, countLabel, fieldDef, metricDef, panelMeaning, panelNotes, unitNoun } from './text';

export type PanelStatus =
  | { kind: 'empty'; message: string }
  | { kind: 'loading' }
  /**
   * `message` is the server's own words, verbatim: the reader can only act on
   * what actually failed. `retryKeys` is every key of this panel that is in
   * error, which "Try again" forgets so `needed` asks for them again.
   */
  | { kind: 'error'; message: string; retryKeys: readonly QueryKey[] }
  | {
      kind: 'ready';
      stale: boolean;
      /**
       * Keys that failed but which the panel can draw without -- a comparison
       * panel's shared-range histograms. The card reports them beside the chart
       * rather than instead of it.
       */
      failedExtra?: readonly QueryKey[];
    };

/** What a sample panel hands the scrolling table. */
export interface PanelTable {
  columns: readonly ColumnId[];
  headers: readonly string[];
  rows: readonly SampleRow[];
  nextCursor: string | null;
}

/**
 * What the info popover beside a metric select says: the catalog's own
 * description of the metric, and the taxonomy path it sits at. Null for a panel
 * with no metric.
 */
export interface MetricHelp {
  label: string;
  /** "Motion / Framewise displacement", or just the family when there is no subfamily. */
  taxonomy: string;
  description: string | null;
  /** The unit the stat row and the axes print, or null. */
  unit: string | null;
}

/** One cohort of a comparison panel, as the card's legend and count line read it. */
export interface CohortLegendEntry {
  id: CohortId;
  name: string;
  /** The palette hex this cohort is drawn in. */
  color: string;
  /** How many scans of this cohort carried a value, or null while it is loading. */
  n: number | null;
  /** False for `current` and `all`, which follow the top bar and cannot be edited. */
  editable: boolean;
  descriptorKey?: string;
}

/** Spec and data from the same state, so no panel renders a mismatched pair. */
export interface PanelView {
  xPositive?: boolean;
  yPositive?: boolean;
  analysisHeaders?: readonly string[];
  analysisRows?: readonly AnalysisRow[];
  analysisNote?: string;
  correlationPairs?: readonly { x: string; y: string; label: string }[];
  id: PanelId;
  panel: Panel;
  title: string;
  /**
   * One sentence saying what this card shows, about this data: what is counted,
   * of what, over how many of what.
   */
  meaning: string;
  /** "Showing 100 of 778,075 scans" on a sample panel; empty everywhere else. */
  subtitle: string;
  /**
   * The qualifiers that follow the count: "filtered by brush", "brush source".
   * Separate from `meaning` because they come and go with state the sentence
   * knows nothing about.
   */
  notes: readonly string[];
  /**
   * The non-default value range, as a chip ("p05–p95", "Full range"), or null
   * when the panel is clipped the way every panel is clipped by default.
   */
  clipChip: string | null;
  /** The metric's catalog prose, for the card's info button. */
  metricHelp: MetricHelp | null;
  /**
   * Identity of the spec's shape. The spec object is rebuilt on every
   * derivation, so the Vega directive compares this instead: it changes when
   * the chart type, axis or grouping changes, and never when only data does.
   */
  specKey: string;
  spec: TopLevelSpec | null;
  datasets: Readonly<Record<string, readonly unknown[]>>;
  table: PanelTable | null;
  status: PanelStatus;
  /** True when this panel's chart carries the `brush` parameter. */
  brushable: boolean;
  /** False when the query succeeded but matched nothing, which is its own empty state. */
  hasRows: boolean;
  /**
   * True when every key this panel reads has a result. The Vega directive only
   * renders live tuples, so a panel keeps its last chart while the next one is
   * in flight instead of blinking through an empty axis.
   */
  live: boolean;
  /** Row count behind the chart, for the card's caption. */
  n: number | null;
  /** What `n` counts, in the corpus's own noun. */
  countLabel: string;
  /**
   * The summary under an ungrouped distribution chart, straight out of the
   * result the chart is already drawing. Null for every other panel.
   */
  stats: readonly PanelStat[] | null;
  /**
   * A comparison panel's cohorts, in the order they are drawn, with the hue each
   * one wears and how many scans it had a value for. Null for every other kind.
   *
   * It is the count line of a comparison card -- a single `n` would be the sum
   * of cohorts that overlap, which is not a count of anything -- and the chip
   * row that says which cohorts this panel holds.
   */
  cohorts: readonly CohortLegendEntry[] | null;
  /** A comparison panel's statistics table. Null for every other kind. */
  comparison: ComparisonStats | null;
  /**
   * The groups of this panel's split field, as cohorts the reader can tick and
   * compare. Empty for a panel that is not split.
   */
  splitCohorts: readonly CohortChip[];
  /**
   * What a comparison panel's shared range left out, per cohort, already
   * worded: "3.3% above range".
   */
  outsideNotes: readonly string[];
  /**
   * True when the panel is drawing everything it has while more is still in
   * flight: a comparison panel with its statistics and ECDF but not yet its
   * shared-range bars.
   */
  partial: boolean;
}

function ownSelection(state: State, panel: Panel): readonly [number, number] | null {
  const selection = state.selections.find(selection => selection.from === panel.id && selection.metric === panel.x);
  if (!selection || selection.from !== panel.id || selection.metric !== panel.x) return null;
  return selection.range;
}


function corpusTotal(state: State): number | null {
  for (const panel of state.panels) {
    if (panel.x !== 'created_at') continue;
    const query = scopedQuery(state, panel, panelCohort(state, panel), 'coverage');
    const result = query ? resultOf<CoverageResult>(state, queryKey(query)) : null;
    if (result) return result.buckets.reduce((sum, bucket) => sum + bucket.n, 0);
  }
  return null;
}
function axisFor(state: State, panel: Panel): MetricAxis {
  const metric = metricDef(state, panel.x);
  const evidence = axisEvidence(state, panel);
  return {
    label: metric?.label ?? String(panel.x ?? 'value'),
    unit: metric?.unit,
    logScale: panel.options.xScale === 'log' && evidence.positive,
    xScale: panel.options.xScale === 'log' && !evidence.positive ? 'symlog' : panel.options.xScale,
    xRange: panel.options.xRange,
    constant: evidence.constant,
    yMode: panel.options.yMode,
    countTitle: countAxisTitle(activeView(state)),
  };
}

/**
 * Why a panel is or is not drawing.
 *
 * `keys` is every key the panel reads, which is what errors and staleness are
 * judged over. `required` is the subset the panel cannot draw *anything*
 * without, which is the same list for every kind but one: a comparison panel's
 * shared-range histograms are a second step, and waiting for them would hide a
 * complete statistics table and three-quarters of a chart behind a spinner.
 */
function statusOf(
  state: State,
  keys: readonly QueryKey[],
  required: readonly QueryKey[] = keys,
): PanelStatus {
  const retryKeys: QueryKey[] = [];
  let message = '';
  let requiredFailed = false;
  for (const key of keys) {
    const entry = state.datasets[key];
    if (entry?.status === 'error' && entry.version === state.dataVersion) {
      retryKeys.push(key);
      if (message === '') message = entry.error;
      if (required.includes(key)) requiredFailed = true;
    }
  }
  // Only a failure the panel cannot draw without replaces the card. A
  // comparison panel whose *shared-range* histograms failed still has its
  // statistics table and its ECDF, both correct, and hiding them behind an
  // error page is the same lie the `required` split exists to prevent -- the
  // card keeps them and says so beside the chart instead. "Try again" still
  // collects every failed key, so the offer is unchanged.
  if (requiredFailed) return { kind: 'error', message, retryKeys };
  for (const key of required) {
    const entry = state.datasets[key];
    if (!entry || entry.status !== 'ready') return { kind: 'loading' };
  }
  const stale = required.some((key) => state.datasets[key]?.version !== state.dataVersion);
  return { kind: 'ready', stale, failedExtra: retryKeys.length > 0 ? retryKeys : undefined };
}

/**
 * The count line of a sample panel, which is the one kind whose count is a
 * fraction rather than a total. Every other kind leaves this empty and says
 * what it counts in `countLabel`.
 */
function panelSubtitle(
  state: State,
  panel: Panel,
  table: PanelTable | null,
  total: number | null,
): string {
  if (table === null) return '';
  const shown = table.rows.length;
  const of = total ?? shown;
  const unit = unitNoun(activeView(state));
  return `Showing ${shown.toLocaleString('en-US')} of ${of.toLocaleString('en-US')} ${unit}`;
}

/**
 * The loaded pages, concatenated in chain order. The run stops at the first
 * page still in flight, so the table never shows a gap, and `nextCursor` is the
 * one the last loaded page handed back.
 */
function tableFor(state: State, panel: Panel, keys: readonly QueryKey[]): PanelTable {
  const view = panelCohort(state, panel).view;
  const columns = [...(panel.series.length ? [asColumnId('__series')] : []), ...sampleColumns(state, view)];
  const fields = fieldsFor(state.global.modality, view, 'export');
  const rows: SampleRow[] = [];
  let nextCursor: string | null = null;
  const nextBySeries: Record<string, string | null> = {};
  for (const { query, cohort } of samplePages(state, panel)) {
    const page = resultOf<SampleResult>(state, queryKey(query));
    if (!page) break;
    for (const row of page.rows) rows.push(panel.series.length ? { ...row, __series: cohort.name } : row);
    nextCursor = page.nextCursor ?? null;
    nextBySeries[cohort.id] = nextCursor;
  }
  if (panel.series.length) nextCursor = Object.values(nextBySeries).some(Boolean) ? JSON.stringify(nextBySeries) : null;
  return {
    columns,
    headers: columns.map((id) => id === '__series' ? 'Series' : fields.find((f) => f.id === id)?.label ?? String(id)),
    rows,
    nextCursor,
  };
}


interface Memo {
  deps: readonly unknown[];
  view: PanelView;
}

/**
 * One memo slot per panel id. `panelView` must return the same reference when
 * the slice it reads has not changed, otherwise `distinctUntilChanged` in
 * `graph.ts` would let every unrelated command re-embed every chart.
 */
const memos = new Map<PanelId, Memo>();

/** Drop the memo table. Tests call it so one test's states cannot answer another's. */
export function resetPanelViewMemo(): void {
  memos.clear();
}

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
}


function titleFor(state: State, panel: Panel): string {
  if (panel.form === 'matrix') return 'Metric correlations';
  if (panel.x === 'created_at') return 'Uploads over time';
  if (axisType(panel.x) === 'categorical') return 'Scans per ' + (fieldDef(state, panel.x)?.label ?? panel.x);
  const x = metricDef(state, panel.x), y = metricDef(state, panel.y);
  return panel.y ? (x?.shortLabel ?? x?.label ?? panel.x) + ' vs ' + (y?.shortLabel ?? y?.label ?? panel.y) : x?.label ?? String(panel.x);
}

/** A card is one quantity, its resolved series, and a valid form. */
export function panelView(state: State, id: PanelId, theme: ChartTheme = LIGHT_THEME): PanelView | null {
  const panel = state.panels.find(panel => panel.id === id);
  if (!panel) { memos.delete(id); return null; }
  const keys = panelKeys(state, panel), total = panel.form === 'table' ? corpusTotal(state) : null;
  const deps = [theme, panel, state.global, state.catalog, state.dataVersion, state.selections, state.cohorts, state.study, total, ...keys.map(key => state.datasets[key])];
  const memo = memos.get(id);
  if (memo && sameDeps(memo.deps, deps)) return memo.view;
  if ((axisType(panel.x) === 'time' && panel.y !== null) || (axisType(panel.x) === 'numeric' && panel.y !== null) || panel.form === 'matrix') {
    const view = (axisType(panel.x) === 'time' && panel.y !== null) ? timePanelView(state, panel, theme) : analysisPanelView(state, panel, theme);
    const quantityKey = queryKey(cohortQuery(state, panel, panelCohort(state, panel)));
    const numericStats = axisType(panel.x) === 'numeric' && panel.form !== 'matrix' ? panelStats(state, panel, [quantityKey]) : null;
    const derived = { ...view, title: titleFor(state, panel), stats: numericStats ?? view.stats,
      spec: view.spec ? withChipLegend(view.spec) : null };
    if (panel.form !== 'clusters') memos.set(id, { deps, view: derived });
    return derived;
  }
  const cohorts = panelCohorts(state, panel);
  const colors = cohorts.map((cohort, index) => cohort.name === 'Other' ? OTHER_COLOR : theme.categories[index % 6]);
  const series = cohorts.map((cohort, index) => ({ id: cohort.id, label: cohort.name, color: colors[index] }));
  const metric = metricDef(state, panel.x), category = fieldDef(state, panel.x as ColumnId);
  const axis = { ...axisFor(state, panel), theme };
  const numeric = axisType(panel.x) === 'numeric';
  const results = numeric ? cohortResults(state, panel, cohorts) : [];
  const required = numeric && panel.form !== 'table' ? cohorts.map(cohort => queryKey(cohortQuery(state, panel, cohort))) : keys;
  const status: PanelStatus = keys.length && panelForms(panel).includes(panel.form) ? statusOf(state, keys, required) : { kind: 'empty', message: 'Choose a column and an available form.' };
  const aggregateKey = numeric ? queryKey(cohortQuery(state, panel, panelCohort(state, panel))) : undefined;
  const aggregate = distributionResult(state, aggregateKey);
  const table = panel.form === 'table' ? tableFor(state, panel, keys) : null;
  let chart: ChartOutput = { spec: null, datasets: {}, brushable: false, n: aggregate?.n ?? null };
  let stats = numeric ? panelStats(state, panel, aggregateKey ? [aggregateKey] : []) : null;
  let counts: (number | null)[] = results.map(result => result.base?.n ?? null);
  let analysisHeaders: string[] = [], analysisRows: AnalysisRow[] = [];
  if (numeric && panel.form !== 'table') {
    const input: ChartInput = { form: panel.form, axis, clip: panel.options.clip, brush: ownSelection(state, panel), groupLabel: 'Series', groupField: null,
      groupOrdered: false, cohortLabel: 'This dashboard', granularity: panel.options.granularity, options: panel.options,
      result: aggregate, cohorts: series, cohortResults: results };
    chart = panel.series.length ? comparisonChart(input) : distributionChart(input);
    if (panel.options.layout !== 'overlaid' && panel.series.length) {
      const stacked = stackedHistogram(axis, series, results, panel.options.layout === 'stacked100');
      chart = { ...chart, spec: stacked.spec, datasets: { [COHORTS_DATA]: stacked.rows } };
    }
    chart.n = aggregate?.n ?? null;
  } else if (panel.form !== 'table') {
    const coverage = (cohort: typeof cohorts[number]) => {
      const query = scopedQuery(state, panel, cohort, 'coverage');
      return query ? resultOf<CoverageResult>(state, queryKey(query)) : null;
    };
    const aggregateCoverage = coverage(panelCohort(state, panel));
    counts = cohorts.map(cohort => coverage(cohort)?.buckets.reduce((sum, bucket) => sum + bucket.n, 0) ?? null);
    const n = aggregateCoverage?.buckets.reduce((sum, bucket) => sum + bucket.n, 0) ?? counts[0] ?? null;
    stats = [{ label: 'Total', value: n?.toLocaleString('en-US') ?? '—', title: 'Records in this dashboard, before adding comparison references.' }];
    if (axisType(panel.x) === 'categorical') {
      const categorySeries = cohorts.map((cohort, index) => {
        const countMap = new Map<string, number>();
        const exact = coverage(cohort);
        if (exact) for (const bucket of exact.buckets) {
          const category = fieldValueLabel(String(panel.x), bucket.group);
          countMap.set(category, (countMap.get(category) ?? 0) + bucket.n);
        } else {
          const query = scopedQuery(state, panel, cohort, 'groupedSummary');
          const result = query ? resultOf<GroupedSummaryResult>(state, queryKey(query)) : null;
          for (const group of [...result?.groups ?? [], ...result?.other ? [result.other] : []]) countMap.set(fieldValueLabel(String(panel.x), group.value), group.n);
        }
        return { id: cohort.id, name: cohort.name, color: colors[index], counts: [...countMap].map(([category, n]) => ({ category, n })) };
      });
      const rendered = categoryChart(categorySeries, category?.label ?? String(panel.x), panel.form === 'share', countAxisTitle(activeView(state)), theme);
      chart = { ...rendered, brushable: false, n };
    } else {
      const rows = cohorts.flatMap((cohort, index) => {
        const buckets = new Map<string, { start: string; n: number }>();
        for (const bucket of coverage(cohort)?.buckets ?? []) {
          const prior = buckets.get(bucket.start);
          buckets.set(bucket.start, { start: bucket.start, n: (prior?.n ?? 0) + bucket.n });
        }
        let cumulative = 0;
        return [...buckets.values()].sort((a,b) => a.start.localeCompare(b.start)).map(bucket => {
          cumulative += bucket.n;
          return { ...bucket, n: panel.options.cumulative ? cumulative : bucket.n, series: cohort.id, label: cohort.name };
        });
      });
      const line = panel.form === 'line';
      const grouped = panel.series.length === 1 && (panel.series[0].kind === 'field' || panel.series[0].kind === 'values');
      if (panel.options.share && !grouped) {
        for (const row of rows) {
          const denominator = counts[cohorts.findIndex(cohort => cohort.id === row.series)] ?? 0;
          row.n = denominator ? row.n / denominator : 0;
        }
      }
      chart = { n, brushable: false, datasets: { coverage: rows }, spec: {
        $schema: 'https://vega.github.io/schema/vega-lite/v6.json', ...baseConfig(theme), width: 'container', height: 'container', data: { name: 'coverage' },
        mark: line ? { type: 'line' } : { type: 'bar' },
        encoding: { x: { field: 'start', type: 'temporal', title: 'Upload time', timeUnit: ({day:'yearmonthdate',week:'yearweek',month:'yearmonth',year:'year'} as const)[panel.options.granularity] },
          y: { field: 'n', type: 'quantitative', title: panel.options.share ? 'Share' : countAxisTitle(activeView(state)),
            stack: grouped && !line ? panel.options.share ? 'normalize' : 'zero' : null,
            axis: { format: panel.options.share ? '.0%' : undefined },
            scale: { type: panel.options.coverageLogY && !panel.options.share ? 'log' : 'linear' } },
          color: { field: 'series', type: 'nominal', scale: { domain: cohorts.map(cohort => cohort.id), range: colors }, legend: null },
          tooltip: [{ field: 'label', title: 'Series' }, { field: 'start', type: 'temporal', title: 'Upload time' }, { field: 'n', type: 'quantitative', title: 'Count' }] },
      } as TopLevelSpec };
    }
    if (panel.series.length) {
      const dashboard = panelCohort(state, panel);
      analysisHeaders = ['n', 'Difference from dashboard'];
      analysisRows = [{ id: dashboard.id, name: 'This dashboard', color: colors[cohorts.findIndex(cohort => cohort.id === dashboard.id)] ?? OTHER_COLOR,
        cells: [n?.toLocaleString('en-US') ?? '—', '—'] },
        ...cohorts.flatMap((cohort, index) => cohort.id === dashboard.id ? [] : [{ id: cohort.id, name: cohort.name, color: colors[index],
          cells: [counts[index]?.toLocaleString('en-US') ?? '—', counts[index] !== null && n !== null ? (counts[index]! - n).toLocaleString('en-US') : '—'] }])];
    }
  }
  const dashboard = { ...panelCohort(state, panel), name: 'This dashboard' };
  const statsCohorts = [dashboard, ...cohorts.filter(cohort => cohort.id !== dashboard.id)];
  const sharedRange = numeric ? panelSharedRange(state, panel, cohorts) : null;
  const statsResults = numeric ? statsCohorts.map(cohort => results.find(result => result.id === cohort.id) ?? {
    id: cohort.id, name: cohort.name, base: aggregate,
    ranged: sharedRange ? distributionResult(state, queryKey(cohortQuery(state, panel, cohort, sharedRange))) : null,
  }) : [];
  const comparison = numeric && panel.series.length ? comparisonStats(state, panel, statsCohorts, statsResults) : null;
  if (comparison) {
    comparison.rows = comparison.rows.map(row => ({ ...row, color: colors[cohorts.findIndex(cohort => cohort.id === row.id)] ?? OTHER_COLOR }));
  }
  if (panel.series.length) stats = null;
  const view: PanelView = {
    id, panel, title: titleFor(state, panel), meaning: panelMeaning({ x: panel.x, form: panel.form, modality: state.global.modality,
      view: activeView(state), metricLabel: metric?.label ?? null, metricDescription: metric?.description ?? null, metricUnit: metric?.unit ?? null,
      groupLabel: category?.label ?? null, granularity: panel.options.granularity, cohortCount: cohorts.length }),
    subtitle: panelSubtitle(state, panel, table, total), notes: [...panelNotes(state, panel), ...chart.degenerateNote ? [chart.degenerateNote] : [],
      ...(cohorts.some(cohort => cohort.source === 'study') && studyFormReason(panel) ? [studyFormReason(panel)!] : [])],
    clipChip: clipChip(panel.options.clip, metric, panel), metricHelp: metric ? { label: metric.label, taxonomy: [metric.family, metric.subfamily].filter(Boolean).join(' / '), description: metric.description ?? null, unit: metric.unit ?? null } : null,
    specKey: JSON.stringify([theme.mode, panel.x, panel.y, panel.form, panel.options, series, chart.spec]),
    spec: chart.spec ? withChipLegend(chart.spec) : null, datasets: chart.datasets, table, status, brushable: chart.brushable,
    hasRows: table ? table.rows.length > 0 : Object.values(chart.datasets).some(rows => rows.length > 0), live: status.kind === 'ready',
    n: chart.n, countLabel: countLabel(state, panel), stats, xPositive: axisEvidence(state,panel).positive,
    cohorts: panel.series.length ? cohorts.map((cohort, index) => ({ id: cohort.id, name: cohort.name, color: colors[index], n: counts[index] ?? null, editable: false, descriptorKey: cohort.descriptorKey })) : null,
    comparison, splitCohorts: [], outsideNotes: numeric ? outsideRangeNotes(cohorts, results) : [],
    partial: numeric && panel.form !== 'table' && panel.series.length > 0 && status.kind === 'ready' && results.some(result => result.ranged === null),
    analysisHeaders, analysisRows,
  };
  memos.set(id, { deps, view });
  return view;
}
