import type { TopLevelSpec } from 'vega-lite';

import type { BinnedSummaryResult } from '@mriqc/shared';

import type { MetricAxis } from './histogram';
import { continuousX } from './continuous-axis';
import { baseConfig, FILLS_CONTAINER, LIGHT_THEME, VL_SCHEMA } from './palette';

export interface BinnedSeries {
  id: string;
  name: string;
  color: string;
  result: BinnedSummaryResult;
}

export interface BinnedSummaryRow {
  seriesId: string;
  seriesName: string;
  bucket: number;
  n: number;
  p05: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  thin: boolean;
  note: string;
  isolated: boolean;
}

const DAY = 86_400_000;
const EPOCH = Date.UTC(2000, 0, 1);

function midpoint(result: BinnedSummaryResult, lo: number, hi: number): number {
  const value = (lo + hi) / 2;
  return result.xKind === 'time' ? EPOCH + value * DAY : value;
}

export function binnedSummaryRows(series: readonly BinnedSeries[]): BinnedSummaryRow[] {
  return series.flatMap(({ id, name, result }) => {
    const buckets = [...result.buckets].sort((left, right) => left.lo - right.lo);
    return buckets.map((bucket) => ({
      seriesId: id,
      seriesName: name,
      bucket: midpoint(result, bucket.lo, bucket.hi),
      n: bucket.n,
      p05: bucket.quantiles.p05,
      p25: bucket.quantiles.p25,
      p50: bucket.quantiles.p50,
      p75: bucket.quantiles.p75,
      p95: bucket.quantiles.p95,
      thin: bucket.thin,
      note: bucket.thin
        ? '<20 observations'
        : bucket.isOther
          ? 'Other'
          : bucket.cohort != null
            ? String(bucket.cohort)
            : bucket.group != null
              ? String(bucket.group)
              : '',
      isolated: buckets.length === 1,
    }));
  });
}

type SummaryRow = BinnedSummaryRow & {
  segmentId?: string;
  segmentThin?: boolean;
};

function segmentRows(rows: readonly BinnedSummaryRow[]): SummaryRow[] {
  const segments: SummaryRow[] = [];
  let offset = 0;
  while (offset < rows.length) {
    const seriesId = rows[offset].seriesId;
    const end = rows.findIndex((row, index) => index >= offset && row.seriesId !== seriesId);
    const stop = end === -1 ? rows.length : end;
    const group = rows.slice(offset, stop);
    for (let index = 0; index < group.length - 1; index += 1) {
      const segmentId = `${seriesId}:${index}`;
      const segmentThin = Boolean(group[index].thin || group[index + 1].thin);
      segments.push({ ...group[index], segmentId, segmentThin });
      segments.push({ ...group[index + 1], segmentId, segmentThin });
    }
    offset = stop;
  }
  return segments;
}

const percentileLabels = {
  p05: 'p05',
  p25: 'Q1',
  p50: 'Median',
  p75: 'Q3',
  p95: 'p95',
} as const;

function percentileRows(
  rows: readonly BinnedSummaryRow[],
  lowerPercentile: 'p05' | 'p25',
  upperPercentile: 'p75' | 'p95',
) {
  return rows.flatMap((row) =>
    ([lowerPercentile, 'p50', upperPercentile] as const).map((percentile) => ({
      ...row,
      percentile: percentileLabels[percentile],
      value: row[percentile],
    })),
  );
}

export function bandChart(
  series: readonly BinnedSeries[],
  yLabel: string,
  axis: MetricAxis,
  form: 'band' | 'lines' = 'band',
  quantiles: 'quartiles' | 'tails' = 'quartiles',
): { spec: TopLevelSpec; datasets: Record<string, readonly unknown[]> } {
  const [lowerPercentile, upperPercentile] =
    quantiles === 'tails' ? (['p05', 'p95'] as const) : (['p25', 'p75'] as const);
  const rows = binnedSummaryRows(series);
  const segments = segmentRows(rows);
  const percentiles = percentileRows(rows, lowerPercentile, upperPercentile);
  const xKind = series[0]?.result.xKind ?? 'metric';
  const x = continuousX(axis, 'bucket');
  const y = { field: 'p50', type: 'quantitative', title: yLabel, scale: { zero: false } } as const;
  const color = {
    field: 'seriesId',
    type: 'nominal',
    scale: { domain: series.map((item) => item.id), range: series.map((item) => item.color) },
    legend: null,
  } as const;
  const tooltip = [
    { field: 'seriesName', type: 'nominal', title: 'Series' },
    { field: 'bucket', type: xKind === 'time' ? 'temporal' : 'quantitative', title: xKind === 'time' ? 'Date' : 'Value' },
    { field: lowerPercentile, type: 'quantitative', title: quantiles === 'quartiles' ? 'Q1' : 'p05' },
    { field: 'p50', type: 'quantitative', title: 'Median' },
    { field: upperPercentile, type: 'quantitative', title: quantiles === 'quartiles' ? 'Q3' : 'p95' },
    { field: 'n', type: 'quantitative', title: 'n' },
    { field: 'thin', type: 'nominal', title: 'Thin' },
    { field: 'note', type: 'nominal', title: 'Note' },
  ];
  const layers =
    form === 'lines'
      ? [
          {
            data: { name: 'percentileLines' },
            mark: { type: 'line', point: true },
            encoding: {
              x,
              y: { field: 'value', type: 'quantitative', title: yLabel, scale: { zero: false } },
              color,
              detail: [{ field: 'seriesId' }, { field: 'percentile' }],
              strokeDash: { field: 'percentile', type: 'nominal', legend: { title: 'Percentile' } },
              opacity: { condition: { test: 'datum.thin', value: 0.4 }, value: 1 },
              tooltip,
            },
          },
        ]
      : [
          {
            data: { name: 'binnedSummarySegments' },
            mark: { type: 'area', interpolate: 'monotone', opacity: 0.22 },
            encoding: {
              x,
              y: { field: lowerPercentile, type: 'quantitative', title: yLabel, scale: { zero: false } },
              y2: { field: upperPercentile },
              color,
              detail: { field: 'segmentId' },
              opacity: { condition: { test: 'datum.segmentThin', value: 0.16 }, value: 0.36 },
              tooltip,
            },
          },
          {
            data: { name: 'binnedSummarySegments' },
            mark: { type: 'line' },
            encoding: {
              x,
              y,
              color,
              detail: { field: 'segmentId' },
              opacity: { condition: { test: 'datum.segmentThin', value: 0.4 }, value: 1 },
              tooltip,
            },
          },
          {
            data: { name: 'binnedSummary' },
            transform: [{ filter: 'datum.isolated || datum.thin' }],
            mark: { type: 'point', filled: true },
            encoding: {
              x,
              y,
              color,
              size: { value: 55 },
              opacity: { condition: { test: 'datum.thin', value: 0.4 }, value: 1 },
              tooltip,
            },
          },
        ];
  const spec: TopLevelSpec = {
    $schema: VL_SCHEMA,
    ...baseConfig(axis.theme ?? LIGHT_THEME),
    ...FILLS_CONTAINER,
    data: { name: 'binnedSummary' },
    layer: layers,
  } as TopLevelSpec;
  return {
    spec,
    datasets: { binnedSummary: rows, binnedSummarySegments: segments, percentileLines: percentiles },
  };
}
