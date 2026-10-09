import type { Query } from '../api/api';
/**
 * The five panel kinds, as one table.
 *
 * Everything that used to be a `switch (shapeOf(panel))` in the query planner, the
 * view layer and the reducer is a lookup in here: which procedures a kind asks
 * for, which charts it may draw, what its card says, which spec builder draws
 * it, and the handful of yes/no facts the rest of the dashboard asks about a
 * kind (does it carry a metric, a split, a cohort list, a brush).
 *
 * A sixth panel kind is therefore a row in this table plus a spec builder, and
 * the compiler finds every place that has to answer for it -- which is what the
 * scattered switches could not do.
 */

import type { Granularity, PanelKind } from '@mriqc/shared';
import {
  comparisonChart,
  coverageChart,
  distributionChart,
  groupedChart,
  sampleChart,
  type ChartInput,
  type ChartOutput,
} from '../panels/specs/select';
import { isValueChart, type Panel, type PanelChart } from './state';

/** The procedure names a panel's queries can name. */
export type ProcName = Query['proc'];

/**
 * What a plan may ask for. The helpers are closures over one state and one
 * panel, built in `queries.ts`: the table says *which* of them a kind uses, and
 * `queries.ts` says what each one does.
 */
export interface PlanContext {
  panel: Panel;
  /**
   * One query of this procedure for this panel, or null when a parameter it
   * needs -- a metric, a split field -- is not set yet. That null is how an
   * unconfigured panel fetches nothing.
   */
  query(proc: ProcName): Query | null;
  /** One `sample` query per page the table has loaded, oldest first. */
  pages(): readonly Query[];
  /** The two-step cohort fetch: each cohort's own distribution, then the shared range. */
  cohortSteps(): readonly Query[];
  /** The same two-step fetch, for the top split groups plus their folded tail. */
  splitSteps(): readonly Query[];
}

/**
 * The pieces a meaning template writes a sentence from, already composed.
 *
 * The templates take this rather than a `State` or a catalog, so each one is a
 * string and nothing else -- `panelMeaning` in `view/text.ts` does the composing
 * and the table does the wording.
 */
export interface MeaningParts {
  /** What one row of the current view is: "scans", "uploads". */
  unit: string;
  /** The metric as a sentence names it, or null when the panel has none. */
  metric: string | null;
  /** The split field's label, or null when the panel is not split. */
  group: string | null;
  chart: PanelChart;
  granularity: Granularity;
  /** How many cohorts a comparison panel is comparing; zero for every other kind. */
  cohortCount: number;
}

/** Everything the dashboard asks about a panel kind. */
export interface PanelKindDef {
  /**
   * The procedures this kind reads. The first is what the default plan asks
   * for; a kind with a `plan` of its own may name more than one.
   */
  readonly procedures: readonly ProcName[];
  /** The charts this kind may draw, the first being the one it opens on. */
  readonly charts: readonly PanelChart[];
  readonly defaultChart: PanelChart;
  /**
   * The queries one panel of this kind needs. Omitted means the obvious one:
   * a single query of `procedures[0]`, and none at all while a parameter it
   * needs is missing.
   */
  readonly plan?: (ctx: PlanContext) => readonly Query[];
  /** The card's one standing sentence. */
  readonly meaning: (parts: MeaningParts) => string;
  /** The spec and the rows, from results the panel view already resolved. */
  readonly spec: (input: ChartInput) => ChartOutput;
  /** The card's heading. */
  readonly title: (metricLabel: string | null) => string;
  /** How the "+ panel" menu names this kind, and the line under it. */
  readonly label: string;
  readonly hint: string;
  /** What the card says before it has been configured. */
  readonly emptyMessage: string;
  /** True for a kind whose split groups can be compared with each other. */
  readonly supportsSplit: boolean;
  /** True for the kind that carries a cohort list and a reference. */
  readonly supportsCohorts: boolean;
  /**
   * What `n` counts: rows of the view, or values of one metric. The server's
   * `n` on a metric query is the number of finite values it found, not the
   * number of rows it scanned, so only the two row-counting kinds may say
   * "scans" without a qualifier.
   */
  readonly countNoun: 'rows' | 'values';
  /** True for a kind that is about one metric. */
  readonly needsMetric: boolean;
  /** True for a kind that cannot draw anything without a split field. */
  readonly needsGroup: boolean;
  /** True when the clip narrows what this card draws, so the chip means something. */
  readonly clips: boolean;
  /** True for the one kind whose single result makes a stat row. */
  readonly stats: boolean;
  /**
   * True for the one kind that renders rows in a scrolling table rather than a
   * chart, and whose count line is therefore a fraction of a sibling's total.
   */
  readonly rowsTable: boolean;
  /**
   * Whether a panel of this kind can answer "how many rows does this slice
   * hold" for the sample panel's denominator, and from what: the sum of a
   * coverage result's buckets, or an ungrouped distribution's `n`, which counts
   * finite values of one metric and is therefore only the fallback.
   */
  readonly recordTotal: 'buckets' | 'n' | null;
  /**
   * True when this panel, as it is set right now, carries the interval brush.
   * Chart-aware: a comparison panel's box is a summary per cohort row, with no
   * interval on it to drag.
   */
  readonly brushable: (panel: Panel) => boolean;
}

/** One metric over a slice of the corpus, and the faceted form of the same. */
function spreadMeaning(parts: MeaningParts): string {
  if (parts.metric === null) return `Pick a metric to summarise these ${parts.unit}.`;
  if (parts.group !== null) return `Spread of ${parts.metric} for each ${parts.group}.`;
  if (parts.chart === 'ecdf') {
    return `Share of ${parts.unit} at or below each value of ${parts.metric}.`;
  }
  if (parts.chart === 'density') {
    return `Smoothed share of ${parts.unit} at each value of ${parts.metric}.`;
  }
  return `How many ${parts.unit} fall in each range of ${parts.metric}.`;
}

function metricTitle(label: string | null): string {
  return label ?? 'Pick a metric';
}

export type PanelShape = PanelKind | 'bivariate' | 'timeMetric' | 'correlation';

export function shapeOf(panel: Pick<Panel, 'x' | 'y' | 'split' | 'cohorts' | 'chart'>): PanelShape {
  if (panel.chart === 'correlation') return 'correlation';
  if (panel.chart === 'table') return 'sample';
  if (panel.x === 'created_at') return panel.y === null ? 'coverage' : 'timeMetric';
  if (panel.y !== null) return 'bivariate';
  if (panel.split !== null) return 'grouped';
  return panel.cohorts.length > 1 ? 'comparison' : 'distribution';
}

export const PANEL_KINDS: Readonly<Record<PanelShape, PanelKindDef>> = {
  correlation: {
    procedures: ['correlation'], charts: ['correlation'], defaultChart: 'correlation',
    meaning: () => 'Relationships between metrics.', spec: sampleChart,
    title: () => 'Metric correlations', label: 'Correlation', hint: 'Relationships across metric families', emptyMessage: 'Choose at least two metrics.',
    supportsSplit: false, supportsCohorts: false, countNoun: 'values', needsMetric: false, needsGroup: false,
    clips: false, stats: false, rowsTable: false, recordTotal: null, brushable: () => false,
  },
  distribution: {
    procedures: ['distribution', 'groupedSummary'],
    // `density` first: a smoothed share is the shape a reader is actually
    // looking for, and the bars are what you drop to when you want to see the
    // binning.
    charts: ['histogram', 'density', 'ecdf', 'box'],
    defaultChart: 'histogram',
    // Boxes use the compact grouped summary. Every distribution-shaped split
    // uses real group cohorts, so its histogram grid and density smoothing are
    // identical to a comparison panel's two-step shared-range machinery.
    plan: (ctx) =>
      ctx.panel.split === null
        ? one(ctx.query('distribution'))
        : ctx.panel.chart === 'box'
          ? one(ctx.query('groupedSummary'))
          : ctx.splitSteps(),
    meaning: spreadMeaning,
    spec: distributionChart,
    title: metricTitle,
    label: 'Distribution',
    hint: 'One metric, histogram, density, ECDF or box',
    emptyMessage: 'Choose a metric.',
    supportsSplit: true,
    supportsCohorts: false,
    countNoun: 'values',
    needsMetric: true,
    needsGroup: false,
    clips: true,
    stats: true,
    rowsTable: false,
    recordTotal: 'n',
    brushable: (panel) => panel.split === null,
  },
  grouped: {
    procedures: ['groupedSummary'],
    charts: ['density', 'histogram', 'box', 'facetedHistogram', 'facetedEcdf', 'table'],
    defaultChart: 'density',
    plan: (ctx) => ctx.panel.chart === 'box' ? one(ctx.query('groupedSummary')) : ctx.splitSteps(),
    meaning: spreadMeaning,
    spec: distributionChart,
    title: metricTitle,
    label: 'Grouped summary',
    hint: 'One metric split by a field',
    emptyMessage: 'Choose a metric and a grouping field.',
    supportsSplit: true,
    supportsCohorts: false,
    countNoun: 'values',
    needsMetric: true,
    needsGroup: true,
    clips: true,
    stats: false,
    rowsTable: false,
    recordTotal: null,
    brushable: () => false,
  },
  coverage: {
    procedures: ['coverage'],
    charts: ['stackedBar', 'area', 'line', 'table'],
    defaultChart: 'stackedBar',
    meaning: (parts) => {
      const by = parts.group === null ? '' : `, by ${parts.group}`;
      const noun = parts.unit.charAt(0).toUpperCase() + parts.unit.slice(1);
      return `${noun} uploaded per ${parts.granularity}${by}.`;
    },
    spec: coverageChart,
    title: () => 'Uploads over time',
    label: 'Coverage over time',
    hint: 'Uploads per month',
    emptyMessage: 'Choose a field to split uploads by.',
    supportsSplit: false,
    supportsCohorts: false,
    countNoun: 'rows',
    needsMetric: false,
    needsGroup: true,
    clips: false,
    stats: false,
    rowsTable: false,
    recordTotal: 'buckets',
    brushable: () => false,
  },
  sample: {
    procedures: ['sample'],
    charts: ['table'],
    defaultChart: 'table',
    // One query per page the table has loaded, so a page the user scrolled past
    // stays referenced and stays on screen.
    plan: (ctx) => ctx.pages(),
    meaning: (parts) => `The individual ${parts.unit} behind these charts, most recent first.`,
    spec: sampleChart,
    title: () => 'Raw records',
    label: 'Raw records',
    hint: 'The rows behind the statistics',
    emptyMessage: 'Choose a metric.',
    supportsSplit: false,
    supportsCohorts: false,
    countNoun: 'rows',
    needsMetric: false,
    needsGroup: false,
    clips: false,
    stats: false,
    rowsTable: true,
    recordTotal: null,
    brushable: () => false,
  },
  comparison: {
    procedures: ['distribution'],
    // `box` is the third comparison chart: one box row per cohort, named on its
    // own y axis. It is the same `ChartType` the grouped panel uses -- what
    // differs is the rows and the colour scale, not the mark.
    charts: ['histogram', 'density', 'ecdf', 'box'],
    defaultChart: 'density',
    plan: (ctx) => ctx.cohortSteps(),
    meaning: (parts) => {
      if (parts.metric === null) return 'Pick a metric to compare these cohorts on.';
      const k = parts.cohortCount;
      if (k < 2) return `Add a second cohort to compare ${parts.metric} across.`;
      if (parts.chart === 'density') {
        return `Smoothed share of ${parts.unit} at each value of ${parts.metric}, across ${k} cohorts.`;
      }
      return `How ${parts.metric} compares across ${k} cohorts.`;
    },
    spec: comparisonChart,
    // The cohorts are named in the legend, the count line and every row of the
    // table, so the title says what is compared and not who with.
    title: (label) => (label === null ? 'Cohort comparison' : `${label} compared`),
    label: 'Compare cohorts',
    hint: 'One metric across two or more cohorts',
    emptyMessage: 'Choose a metric and at least two cohorts to compare.',
    supportsSplit: false,
    supportsCohorts: true,
    countNoun: 'values',
    needsMetric: true,
    needsGroup: false,
    clips: true,
    stats: false,
    rowsTable: false,
    recordTotal: null,
    brushable: (panel) => isValueChart(panel.chart),
  },
  bivariate: {
    procedures: ['density2d'], charts: ['density2d', 'scatter', 'hexbin', 'clusters', 'table'], defaultChart: 'density2d',
    meaning: () => 'Relationship between two metrics.', spec: sampleChart,
    title: metricTitle, label: 'Two metrics', hint: 'Density and exploratory clusters', emptyMessage: 'Choose two metrics.',
    supportsSplit: false, supportsCohorts: true, countNoun: 'values', needsMetric: true, needsGroup: false,
    clips: true, stats: false, rowsTable: false, recordTotal: null, brushable: () => true,
  },
  timeMetric: {
    procedures: ['timeSummary'], charts: ['medianBand', 'table'], defaultChart: 'medianBand',
    meaning: parts => `${parts.metric} over upload time, median and middle half, by ${parts.group ?? 'cohorts'}.`, spec: sampleChart,
    title: () => 'Metric over time', label: 'Metric over time', hint: 'Median and middle half over upload time', emptyMessage: 'Choose a metric.',
    supportsSplit: true, supportsCohorts: true, countNoun: 'values', needsMetric: false, needsGroup: false,
    clips: false, stats: false, rowsTable: false, recordTotal: null, brushable: () => false,
  },
};

export function chartsFor(shape: PanelShape): readonly PanelChart[] {
  return shape === 'distribution' ? ['histogram', 'density', 'ecdf', 'box', 'table', 'correlation'] :
    shape === 'comparison' ? ['density', 'histogram', 'ecdf', 'box', 'table', 'correlation'] : PANEL_KINDS[shape].charts;
}

export function defaultChartFor(shape: PanelShape): PanelChart { return PANEL_KINDS[shape].defaultChart; }

export function validChart(panel: Panel): Panel {
  if (panel.chart === 'overlaidHistogram' || panel.chart === 'overlaidEcdf') panel = { ...panel, chart: panel.chart === 'overlaidEcdf' ? 'ecdf' : 'histogram' };
  const shape = shapeOf(panel);
  return chartsFor(shape).includes(panel.chart) ? panel : { ...panel, chart: defaultChartFor(shape) };
}

/** A list of one, or of none when the planner had nothing to ask for. */
function one(query: Query | null): readonly Query[] {
  return query === null ? [] : [query];
}

/** Every panel kind, in the order the table declares them. */
export const PANEL_KIND_IDS: readonly PanelKind[] = ['distribution', 'grouped', 'coverage', 'sample', 'comparison'];

/**
 * The chart each panel kind opens with, and the only charts it may use.
 *
 * A projection of the table, kept under its old name because the URL decoder,
 * the reducer and the card's chart menu all ask exactly this question.
 */
export const CHARTS_BY_KIND = Object.fromEntries(
  Object.entries(PANEL_KINDS).map(([kind, def]) => [kind, def.charts]),
) as Readonly<Record<PanelKind, readonly PanelChart[]>>;

/**
 * The same reader-facing chart has different mark data for a comparison: a
 * distribution histogram is one set of bars, while a comparison histogram is
 * the shared-grid step-area overlay.  Keep that conversion here, beside the
 * per-kind chart table, so switching a panel never silently changes the
 * question the reader selected.
 */
export function chartForKind(kind: PanelKind, chart: PanelChart): PanelChart {
  // The first cohort implementation serialized the mark names. Keep old links
  // readable while exposing one reader-facing chart vocabulary everywhere.
  if (chart === 'overlaidHistogram') chart = 'histogram';
  if (chart === 'overlaidEcdf') chart = 'ecdf';
  if (CHARTS_BY_KIND[kind].includes(chart)) return chart;
  if (kind === 'comparison') {
    if (chart === 'histogram' || chart === 'ecdf') return chart;
  }
  if (kind === 'distribution') {
    if (chart === 'histogram' || chart === 'ecdf') return chart;
  }
  return kind === 'distribution' ? 'density' : kind === 'grouped' ? 'box' : PANEL_KINDS[kind].defaultChart;
}
