import { axisType } from '../panels/shapes';
/**
 * The figures under a form: one stat row for a distribution panel, and the
 * whole comparison table for a comparison panel.
 *
 * Formatting only. The arithmetic is in `graph/comparison-stats.ts`; this file
 * decides which numbers are shown, in what order, under which label, and with
 * which explanation in the tooltip.
 */

import { type DistributionResult,type QueryKey } from '@mriqc/shared';
import { MIN_COMPARISON_COHORTS,type Cohort,type CohortId,type Panel,type State } from '../../graph/state';
import { cohortColor,type CohortResult } from '../../panels/specs';
import { resultOf } from '../history/results';
import { activeView,metricDef,significant,statUnitLabel,unitNoun } from '../panels/text';
import {
allPairsKs,
cohortNumbers,
differencesFrom,
outsideShare,
worstPair,
type CohortDifference,
type KsPair,
} from './comparison-stats';

/**
 * One figure under a panel's form: a short label, an already-formatted value,
 * and the one line that says what the label means.
 *
 * `title` is the whole explanation of a stat row: eight uppercase abbreviations
 * are unreadable to anyone who has not met them, and a tooltip is the one place
 * the explanation can live without turning the row into prose.
 */
export interface PanelStat {
  label: string;
  value: string;
  title: string;
}

/** One row of a comparison panel's statistics table: a cohort, in its own colour. */
export interface CohortStatRow {
  id: CohortId;
  name: string;
  /** The cohort's palette hex, which the row's text wears. */
  color: string;
  /** n, median, IQR, p05–p95, median shift / IQR, KS; in header order. */
  cells: readonly string[];
}

/**
 * One compact row per series, including differences against series zero.
 */
export interface ComparisonStats {
  /** Column headers, the first for the cohort name. */
  headers: readonly string[];
  rows: readonly CohortStatRow[];
  /**
   * The differences block: one row per non-reference cohort, each against the
   * reference. With two cohorts this is the single row `comparison-design.md`
   * asks for; with more it is one row each, which is the only reading of
   * "the difference" that stays a number rather than becoming a matrix.
   */
  differences: ComparisonDifferences | null;
  /**
   * Every pairwise KS distance, for the "All pairs" view. It answers the one
   * question a single reference cannot -- which two of these cohorts are
   * furthest apart -- and is bounded by the palette, so at most nine cohorts and
   * 36 pairs.
   */
  pairs: readonly KsCell[] | null;
}

/** The differences block: who the reference is, and one row per other cohort. */
export interface ComparisonDifferences {
  reference: CohortId;
  referenceName: string;
  rows: readonly DifferenceRow[];
}

/** One cohort measured against the reference. */
export interface DifferenceRow {
  id: CohortId;
  name: string;
  color: string;
  /** Median shift, the same shift in reference-IQR units, mean shift, KS. */
  cells: readonly PanelStat[];
}

/** One cell of the all-pairs KS table. */
export interface KsCell {
  aName: string;
  bName: string;
  value: string;
  /** True for the largest distance in the table, which the view emphasises. */
  worst: boolean;
}

/** The headers of the differences block, in the order a reader reads them. */
export const DIFFERENCE_HEADERS: readonly string[] = [
  'vs',
  'MEDIAN SHIFT',
  'AS SHARE OF IQR',
  'MEAN SHIFT',
  'KS DISTANCE',
];

/**
 * How the KS figure is labelled.
 *
 * The value is computed from two binned cumulative curves, so its supremum can
 * fall inside a bin and the figure is an approximation. The `≈` is in the value
 * as well as the tooltip: a bare `0.25` reads as exact, and the one thing a
 * reader must not take from this cell is three decimal places of authority.
 */
export const KS_APPROX_NOTE = '≈ at histogram resolution';

/** Which cohort the differences subtract from: the panel's choice, or the first. */
export function referenceIndex(panel: Panel, cohorts: readonly Cohort[]): number {
  if (panel.reference === undefined) return 0;
  const at = cohorts.findIndex((cohort) => cohort.id === panel.reference);
  return at >= 0 ? at : 0;
}

/**
 * The comparison table for one panel, or null when the panel is not a
 * comparison or has nothing to put in it.
 */
export function comparisonStats(
  state: State,
  panel: Panel,
  cohorts: readonly Cohort[],
  results: readonly CohortResult[],
): ComparisonStats | null {
  if (cohorts.length < MIN_COMPARISON_COHORTS) return null;
  const unit = metricDef(state, panel.x)?.unit;
  const amount = (value: number | null | undefined) =>
    unit ? `${significant(value)} ${unit}` : significant(value);
  const differences = differenceBlock(cohorts, results, 0, amount);
  const rows = cohorts.map((cohort, i): CohortStatRow => {
    const base = results[i]?.base ?? null;
    const numbers = base === null ? null : cohortNumbers(base);
    const difference = differences?.rows.find(row => row.id === cohort.id);
    return {
      id: cohort.id,
      name: cohort.name,
      color: cohortColor(cohort.color),
      cells:
        numbers === null
          ? ['--', '--', '--', '--', '--', '--']
          : [
              numbers.n.toLocaleString('en-US'),
              amount(numbers.p50),
              `${amount(base?.quantiles?.p25)}–${amount(base?.quantiles?.p75)}`,
              `${amount(numbers.p05)}–${amount(numbers.p95)}`,
              difference?.cells[1].value ?? '--',
              difference?.cells[3].value ?? '--',
            ],
    };
  });
  return {
    headers: ['Series', 'n', 'Median', 'IQR', 'p05–p95', 'Δmedian/IQR', 'KS'],
    rows,
    differences: null,
    pairs: ksCells(cohorts, results),
  };
}

/**
 * The differences block: every cohort but the reference, measured against it.
 *
 * Signed throughout, and always "this cohort minus the reference", with the
 * reference named in the block's header and in every `title`: an unsigned shift
 * would not say which cohort is higher, which is the one thing the block exists
 * to answer.
 */
function differenceBlock(
  cohorts: readonly Cohort[],
  results: readonly CohortResult[],
  reference: number,
  amount: (value: number | null | undefined) => string,
): ComparisonDifferences | null {
  const anchor = cohorts[reference];
  if (anchor === undefined) return null;
  const differences: readonly CohortDifference[] = differencesFrom(
    results.map((result) => result.base),
    results.map((result) => result.ranged),
    reference,
  );
  if (differences.length === 0) return null;
  const share = (value: number | null) => (value === null ? '--' : `${signed(value * 100, 1)}%`);
  const rows = differences.map((difference): DifferenceRow => {
    const cohort = cohorts[difference.index];
    const numbers = difference.numbers;
    return {
      id: cohort.id,
      name: cohort.name,
      color: cohortColor(cohort.color),
      cells: [
        {
          label: 'MEDIAN SHIFT',
          value: numbers.medianShift === null ? '--' : signedAmount(numbers.medianShift, amount),
          title: `${cohort.name} minus ${anchor.name}, at the median.`,
        },
        {
          label: 'AS SHARE OF IQR',
          value: share(numbers.medianShiftIqr),
          title: `The median shift as a share of ${anchor.name}'s interquartile range, which is what makes it comparable across metrics.`,
        },
        {
          label: 'MEAN SHIFT',
          value: numbers.meanShift === null ? '--' : signedAmount(numbers.meanShift, amount),
          title: `${cohort.name} minus ${anchor.name}, at the mean.`,
        },
        {
          label: 'KS DISTANCE',
          value: numbers.ks === null ? '--' : `≈ ${significant(numbers.ks, 3)}`,
          title:
            `The largest gap between ${cohort.name}'s and ${anchor.name}'s cumulative shares ` +
            'over the shared bins: 0 means the distributions coincide, 1 that they do not ' +
            `overlap. ${KS_APPROX_NOTE}.`,
        },
      ],
    };
  });
  return { reference: anchor.id, referenceName: anchor.name, rows };
}

/** Every pairwise KS distance, already formatted, with the largest one marked. */
function ksCells(
  cohorts: readonly Cohort[],
  results: readonly CohortResult[],
): readonly KsCell[] | null {
  if (cohorts.length < MIN_COMPARISON_COHORTS) return null;
  const pairs: readonly KsPair[] = allPairsKs(results.map((result) => result.ranged));
  const worst = worstPair(pairs);
  return pairs.map((pair) => ({
    aName: cohorts[pair.a]?.name ?? '',
    bName: cohorts[pair.b]?.name ?? '',
    value: pair.ks === null ? '--' : `≈ ${significant(pair.ks, 3)}`,
    worst: worst !== null && pair.a === worst.a && pair.b === worst.b,
  }));
}

/** A number with its sign always shown, so a shift says which way it went. */
function signed(value: number, digits = 3): string {
  const text = significant(Math.abs(value), digits);
  if (text === '--') return '--';
  return value < 0 ? `−${text}` : `+${text}`;
}

/** The same, carrying the metric's unit. */
function signedAmount(value: number, amount: (v: number) => string): string {
  const text = amount(Math.abs(value));
  return value < 0 ? `−${text}` : `+${text}`;
}

/**
 * What the shared range left outside each cohort, in words.
 *
 * Only worth saying when it is worth seeing: a tail under half a percent is
 * below the resolution of the chart it would be qualifying. Both ends are
 * reported separately, because "3% above range" and "3% below range" mean
 * opposite things about the cohort.
 */
export function outsideRangeNotes(
  cohorts: readonly Cohort[],
  results: readonly CohortResult[],
): readonly string[] {
  const notes: string[] = [];
  results.forEach((result, i) => {
    if (result.ranged === null) return;
    const { below, above } = outsideShare(result.ranged);
    // One clause per cohort, not one per tail: four cohorts with mass at both
    // ends would otherwise be eight clauses of small print under a chart.
    const parts: string[] = [];
    if (below >= 0.005) parts.push(`${(below * 100).toFixed(1)}% below`);
    if (above >= 0.005) parts.push(`${(above * 100).toFixed(1)}% above`);
    if (parts.length === 0) return;
    notes.push(`${cohorts[i]?.name ?? ''} ${parts.join(', ')} the range`);
  });
  return notes;
}

/**
 * The stat row under the chart, from the same `DistributionResult` the chart is
 * drawing. No request of its own: every figure is already on the client.
 *
 * Quantiles of the numeric x quantity in the dashboard's own rows. Series and
 * drawing form do not change this row; their differences have a separate table.
 */
export function panelStats(
  state: State,
  panel: Panel,
  keys: readonly QueryKey[],
): readonly PanelStat[] | null {
  if (axisType(panel.x) !== 'numeric' || panel.form === 'matrix') return null;
  const result = resultOf<DistributionResult>(state, keys[0]);
  if (!result) return null;
  const unit = metricDef(state, panel.x)?.unit;
  const amount = (value: number | null | undefined) =>
    unit ? `${significant(value)} ${unit}` : significant(value);
  const q = result.quantiles;
  const view = activeView(state);
  const noun = unitNoun(view);
  return [
    {
      label: statUnitLabel(view),
      value: result.n.toLocaleString('en-US'),
      title: `How many ${noun} had a value for this metric.`,
    },
    { label: 'MEAN', value: amount(result.mean), title: 'The average of those values.' },
    {
      label: 'SD',
      value: amount(result.stddev),
      title: 'Standard deviation: how far the values typically sit from the mean.',
    },
    {
      label: '5TH PCT',
      value: amount(q?.p05),
      title: `5% of these ${noun} are below this value.`,
    },
    {
      label: 'MEDIAN',
      value: amount(q?.p50),
      title: `Half of these ${noun} are below this value.`,
    },
    {
      label: '95TH PCT',
      value: amount(q?.p95),
      title: `95% of these ${noun} are below this value.`,
    },
    { label: 'MIN', value: amount(result.min), title: 'The smallest value in the data.' },
    { label: 'MAX', value: amount(result.max), title: 'The largest value in the data.' },
  ];
}
