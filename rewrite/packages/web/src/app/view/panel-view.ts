import { shapeOf } from '../graph/panel-shapes';
import { axisEvidence } from '../graph/axis-options';
import { withChipLegend } from '../panels/specs/chip-legend';
/**
 * One panel's view: the spec, the named datasets, and why it is or is not
 * drawing -- all from the same state value, so no card ever renders a spec from
 * one state beside data from another (`docs/dashboard-graph.md`, "Outputs").
 *
 * Everything per-kind is a lookup in `PANEL_KINDS`: which spec builder draws
 * it, what its heading says, whether it carries a cohort list, a split or a
 * stat row.
 */

import {
  fieldsFor,
  type ColumnId,
  type CoverageResult,
  type QueryKey,
  type SampleResult,
  type SampleRow,
} from '@mriqc/shared';
import type { TopLevelSpec } from 'vega-lite';
import {
  cohortColor,
  CATEGORY_PALETTE,
  OTHER_COLOR,
  themedColor,
  groupRange,
  LIGHT_THEME,
  type ChartTheme,
  type CohortResult,
  type CohortSeries,
  type MetricAxis,
} from '../panels/specs';
import { foldCohorts, OTHER_COHORT } from '../panels/specs/fold-cohorts';
import { timePanelView } from './time-view';
import { analysisPanelView, type AnalysisRow } from './analysis-view';
import { cohortChip, splitCohorts, type CohortChip } from '../graph/cohorts';
import { PANEL_KINDS } from '../graph/panel-shapes';
import {
  cohortResults,
  panelCohort,
  distributionResult,
  panelCohorts,
  panelKeys,
  resultOf,
  sampleColumns,
  splitDistributionCohorts,
} from '../graph/queries';
import { CURRENT_COHORT, isDerivedCohort, type Cohort, type CohortId, type Panel, type PanelId, type State } from '../graph/state';
import { comparisonStats, outsideRangeNotes, panelStats, type ComparisonStats, type PanelStat } from './stats';
import {
  activeView,
  clipChip,
  countAxisTitle,
  countLabel,
  fieldDef,
  metricDef,
  panelMeaning,
  panelNotes,
  unitNoun,
} from './text';

/** Why a panel is not drawing a chart, or that it is. */
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
  let fallback: number | null = null;
  for (const other of state.panels) {
    const total = PANEL_KINDS[shapeOf(other)].recordTotal;
    if (total === null) continue;
    const keys = panelKeys(state, other);
    if (total === 'buckets') {
      const result = resultOf<CoverageResult>(state, keys[0]);
      if (result) return result.buckets.reduce((sum, bucket) => sum + bucket.n, 0);
    }
    // A grouped result has one `n` per group and no single total, so only an
    // ungrouped distribution answers.
    if (total === 'n' && other.split === null && fallback === null) {
      const result = distributionResult(state, keys[0]);
      if (result) fallback = result.n;
    }
  }
  return fallback;
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
  const columns = sampleColumns(state, view);
  const fields = fieldsFor(state.global.modality, view, 'export');
  const rows: SampleRow[] = [];
  let nextCursor: string | null = null;
  for (const key of keys) {
    const page = resultOf<SampleResult>(state, key);
    if (!page) break;
    for (const row of page.rows) rows.push(row);
    nextCursor = page.nextCursor ?? null;
  }
  return {
    columns,
    headers: columns.map((id) => fields.find((f) => f.id === id)?.label ?? String(id)),
    rows,
    nextCursor,
  };
}

/**
 * The cohorts as a chart encodes them: keyed by id, labelled by name.
 *
 * Keyed on the id because two cohorts can legitimately share a name, and a
 * name-keyed series merged them into one -- one ECDF line through both curves,
 * two boxes on one row, one legend entry. The name is the label and nothing
 * else.
 */
function cohortSeries(
  cohorts: readonly Cohort[],
  split = false,
  ordered = false,
): readonly CohortSeries[] {
  const colors = split ? groupRange(cohorts.map((cohort) => cohort.name), ordered) : [];
  const slots = new Map<string, number>();
  const used = new Set<number>();
  for (const cohort of [...cohorts].filter((c) => c.id !== OTHER_COHORT).sort((a, b) => a.color - b.color || a.id.localeCompare(b.id))) {
    let slot = ((cohort.color % CATEGORY_PALETTE.length) + CATEGORY_PALETTE.length) % CATEGORY_PALETTE.length;
    while (used.has(slot) && used.size < CATEGORY_PALETTE.length) slot = (slot + 1) % CATEGORY_PALETTE.length;
    used.add(slot); slots.set(cohort.id, slot);
  }
  return cohorts.map((cohort, index) => ({
    id: cohort.id, label: cohort.name,
    color: cohort.id === OTHER_COHORT ? OTHER_COLOR : split ? colors[index] : CATEGORY_PALETTE[slots.get(cohort.id)!],
  }));
}

/**
 * The groups of one split field, as chips the card can tick and compare -- but
 * only on a panel a comparison could actually be made from.
 *
 * A coverage panel is split by manufacturer as often as a grouped one is, and it
 * has no metric, so offering "Compare selected" there is a control that can do
 * nothing: `convertToComparison` refuses a kind with no metric, silently, which
 * is worse than not asking.
 */
function splitChips(state: State, panel: Panel): readonly CohortChip[] {
  if (!PANEL_KINDS[shapeOf(panel)].supportsSplit) return [];
  if (panel.split === null || panel.x === null) return [];
  return splitCohorts(state, panel.split as CohortId).map(cohortChip);
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

/** The view for one panel: spec, named datasets, and why it is or is not drawing. */
export function panelView(state: State, id: PanelId, theme: ChartTheme = LIGHT_THEME): PanelView | null {
  const panel = state.panels.find((p) => p.id === id);
  if (!panel) {
    memos.delete(id);
    return null;
  }
  const def = PANEL_KINDS[shapeOf(panel)];
  const keys = panelKeys(state, panel);
  // A sample panel's denominator comes from a sibling's result, so the memo has
  // to see that result change; every other kind reads nothing outside `keys`.
  const total = def.rowsTable ? corpusTotal(state) : null;
  const deps: readonly unknown[] = [
    theme,
    panel,
    state.global,
    state.catalog,
    state.dataVersion,
    state.selections,
    // A comparison panel reads the cohort list by id, so a rename or a filter
    // change on a cohort it draws has to re-derive it.
    state.cohorts,
    state.study,
    total,
    ...keys.map((key) => state.datasets[key]),
  ];
  const memo = memos.get(id);
  if (memo && sameDeps(memo.deps, deps)) return memo.view;
  if ((panel.y !== null && panel.chart !== 'table') || panel.chart === 'correlation') {
    const view = panel.chart === 'medianBand' ? timePanelView(state, panel, theme) : analysisPanelView(state, panel, theme);
    // Worker results are another dataset entry read by this view.
    if (panel.chart !== 'clusters') memos.set(id, { deps, view });
    return view;
  }

  const splitCandidates =
    shapeOf(panel) === 'grouped' && panel.split !== null && panel.chart !== 'box'
      ? splitDistributionCohorts(state, panel)
      : [];
  const splitSeries = splitCandidates.length > 0;
  const queryCohorts = def.supportsCohorts
    ? panelCohorts(state, panel)
    : splitSeries
      ? splitCandidates
      : [];
  // A cohort-backed panel's keys come in two groups and only the first is required
  // before it can draw: `panelQueries` emits each cohort's own distribution
  // first, then the shared-range histograms, so the head of the list is step one.
  const required = queryCohorts.length > 0 ? keys.slice(0, queryCohorts.length) : keys;
  const status: PanelStatus =
    keys.length === 0
      ? { kind: 'empty', message: def.emptyMessage }
      : statusOf(state, keys, required);
  const queryResults: readonly CohortResult[] =
    queryCohorts.length > 0 ? cohortResults(state, panel, queryCohorts) : [];
  const { cohorts, results, folded } = def.supportsCohorts
    ? foldCohorts(queryCohorts, queryResults)
    : { cohorts: queryCohorts, results: queryResults, folded: false };
  const axis = { ...axisFor(state, panel), theme };
  const groupDef = fieldDef(state, panel.split);
  const series = cohortSeries(cohorts, splitSeries,
    groupDef?.kind === 'numeric' || groupDef?.id === 'magnetic_field_strength');
  const seriesColor = (id: string) => themedColor(series.find((s) => s.id === id)?.color ?? OTHER_COLOR, theme);
  const comparison = comparisonStats(state, panel, cohorts, results);
  if (comparison) {
    comparison.rows = comparison.rows.map((row) => ({ ...row, color: seriesColor(row.id),
      cells: row.id === OTHER_COHORT ? row.cells.map((cell, i) => i >= 4 && cell !== '--' ? `≈ ${cell}` : cell) : row.cells }));
    if (comparison.differences) comparison.differences = { ...comparison.differences,
      rows: comparison.differences.rows.map((row) => ({ ...row, color: seriesColor(row.id) })) };
  }
  const chart = def.spec({
    chart: panel.chart,
    axis,
    clip: panel.options.clip,
    brush: ownSelection(state, panel),
    groupLabel: groupDef?.label ?? 'Group',
    // The id, not the label: `fieldValueLabel` keys its display names by field
    // id so an axis, a legend and a filter list all write `afni` the same way.
    groupField: panel.split === null ? null : String(panel.split),
    groupOrdered: groupDef?.kind === 'numeric' || groupDef?.id === 'magnetic_field_strength',
    cohortLabel: panelCohort(state, panel).name,
    granularity: panel.options.granularity,
    options: panel.options,
    result: resultOf<unknown>(state, keys[0]),
    cohorts: series,
    cohortResults: results,
  });
  const table = def.rowsTable ? tableFor(state, panel, keys) : null;
  const metric = metricDef(state, panel.x);
  const viewDef = activeView(state);
  const chips = splitChips(state, panel);
  const hasChipLegend = chips.length > 0 || (def.supportsCohorts && cohorts.length > 0);
  const view: PanelView = {
    id,
    xPositive: axisEvidence(state, panel).positive,
    panel,
    title: def.title(metric?.label ?? null),
    meaning: panelMeaning({
      kind: shapeOf(panel),
      chart: panel.chart,
      modality: state.global.modality,
      view: viewDef,
      metricLabel: metric?.label ?? null,
      metricDescription: metric?.description ?? null,
      metricUnit: metric?.unit ?? null,
      groupLabel: fieldDef(state, panel.split)?.label ?? null,
      granularity: panel.options.granularity,
      cohortCount: cohorts.length,
    }),
    subtitle: panelSubtitle(state, panel, table, total),
    notes: [...panelNotes(state, panel), ...(chart.degenerateNote ? [chart.degenerateNote] : []), ...(folded ? ['Other pools cohort memberships; overlaps count repeatedly. Its quantiles are estimated from shared bins.'] : [])],
    clipChip: clipChip(panel.options.clip, metric, panel),
    metricHelp: metric
      ? {
          label: metric.label,
          taxonomy: metric.subfamily ? `${metric.family} / ${metric.subfamily}` : metric.family,
          description: metric.description ?? null,
          unit: metric.unit ?? null,
        }
      : null,
    // `clip` is deliberately absent: no spec builder reads it, it only decides
    // which rows the chart builder produces, and hashing it here would tear
    // down and re-embed the view -- losing the visible brush -- on a Range
    // change that a dataset push already covers.
    specKey: JSON.stringify([
      theme.mode,
      shapeOf(panel),
      panel.chart,
      hasChipLegend,
      panel.split,
      axis.label,
      axis.unit ?? null,
      axis.xScale, axis.xRange, axis.xScale === 'symlog' ? axis.constant : null, axis.yMode, panel.options.layout,
      axis.countTitle,
      panel.options.granularity,
      // These options change the Vega spec itself, not only its rows. Without
      // them the directive pushes new data into the old view: choosing facets
      // leaves the overlay on screen, and coverage keeps the old axis title.
      panel.options.splitPresentation,
      panel.options.boxSort,
      panel.options.cumulative,
      panel.options.share,
      panel.options.coverageLogY,
      // A comparison spec declares its colour scale's domain, its range and its
      // legend labels from the cohort list, so a cohort added, renamed or
      // recoloured changes the spec's shape and has to re-embed rather than
      // push rows. The ids are in it because they are the scale's domain.
      series.map((cohort) => `${cohort.id}\u0000${cohort.label}\u0000${cohort.color}`),
    ]),
    spec: chart.spec && hasChipLegend ? withChipLegend(chart.spec) : chart.spec,
    datasets: chart.datasets,
    table,
    status,
    brushable: chart.brushable,
    hasRows: Object.values(chart.datasets).some((rows) => rows.length > 0),
    live: status.kind === 'ready',
    n: chart.n,
    countLabel:
      (panel.cohorts[0] ?? CURRENT_COHORT) === CURRENT_COHORT
        ? countLabel(state, panel)
        : `${countLabel(state, panel)} · ${panelCohort(state, panel).name}`,
    stats: panelStats(state, panel, keys),
    cohorts: def.supportsCohorts
      ? cohorts.map((cohort, i) => ({
          id: cohort.id,
          name: cohort.name,
          color: seriesColor(cohort.id),
          n: results[i]?.base?.n ?? null,
          editable: !isDerivedCohort(cohort.id),
        }))
      : null,
    comparison,
    splitCohorts: chips.map((entry) => ({
      ...entry,
      color: series.some((s) => s.id === entry.cohort.id)
        ? seriesColor(entry.cohort.id) : themedColor(entry.color, theme),
    })),
    outsideNotes: outsideRangeNotes(cohorts, results),
    // Step one is in (`status` says so) but a cohort's shared-range histogram is
    // not, which is the one state where the card has a real chart and a real
    // table and is still waiting for something.
    partial:
      cohorts.length > 0 &&
      status.kind === 'ready' &&
      results.some((result) => result.ranged === null),
  };
  memos.set(id, { deps, view });
  return view;
}
