import type { TimeSummaryResult } from '@mriqc/shared';
import type { TopLevelSpec } from 'vega-lite';

import {
  baseConfig,
  FILLS_CONTAINER,
  LIGHT_THEME,
  type ChartTheme,
  VL_SCHEMA,
} from './palette';

/** A separately computed time-summary series rendered in the same chart. */
export interface TimeSeries {
  id: string;
  name: string;
  color: string;
  result: TimeSummaryResult;
  approximate?: boolean;
}

/** One normalized bucket consumed by the Vega-Lite named dataset. */
export interface MedianBandRow {
  seriesId: string;
  seriesName: string;
  bucket: string;
  value: string | number | boolean | null;
  date: string;
  isOther: boolean;
  n: number;
  p25: number;
  p50: number;
  p75: number;
  thin: boolean;
  note?: string;
  isolated: boolean;
}

interface MedianBandSegmentRow extends MedianBandRow {
  segmentId: string;
  segmentThin: boolean;
}

const THIN_BUCKET_NOTE = '<20 observations';

/**
 * Normalizes every summary bucket without merging or filtering cohort series.
 * Keeping the series identifier on every row makes each cohort an independent
 * line/area path, even when their display names or dates coincide.
 */
export function timeSummaryRows(
  series: readonly TimeSeries[],
): readonly MedianBandRow[] {
  return series.flatMap(({ id, name, result, approximate }) =>
    result.buckets.map(({ start, group, isOther, n, quantiles, thin }) => ({
      seriesId: id,
      seriesName: name,
      bucket: start,
      value: group,
      date: start,
      isOther,
      n,
      p25: quantiles.p25,
      p50: quantiles.p50,
      p75: quantiles.p75,
      thin,
      note: [thin ? THIN_BUCKET_NOTE : '', approximate ? 'Approximate pooled quantiles' : ''].filter(Boolean).join('; ') || undefined,
      isolated: result.buckets.length === 1,
    })),
  );
}

/**
 * Splits each result into adjacent two-point paths.  This lets Vega-Lite fade
 * every p50 and IQR segment touching a thin bucket without joining distinct
 * result/cohort paths.  Consecutive segments share an endpoint, preserving a
 * continuous visual path for each series.
 */
function timeSummarySegmentRows(
  series: readonly TimeSeries[],
): readonly MedianBandSegmentRow[] {
  return series.flatMap(({ id, name, result, approximate }) => {
    const rows = [...timeSummaryRows([{ id, name, color: '', result, approximate }])].sort((a, b) => a.bucket.localeCompare(b.bucket));

    return rows.slice(1).flatMap((current, index) => {
      const previous = rows[index];
      const segmentThin = previous.thin || current.thin;
      const segmentId = `${id}:${index}`;

      return [
        { ...previous, segmentId, segmentThin },
        { ...current, segmentId, segmentThin },
      ];
    });
  });
}

/**
 * Produces a median time series with an interquartile band for each supplied
 * result/cohort.  Values are supplied separately so callers retain control of
 * filtering and cohort colours.
 */
export function medianBandChart(
  series: readonly TimeSeries[],
  yLabel: string,
  theme: ChartTheme = LIGHT_THEME,
): {
  spec: TopLevelSpec;
  datasets: Record<string, readonly unknown[]>;
} {
  const rows = timeSummaryRows(series);
  const segments = timeSummarySegmentRows(series);
  const colorScale = {
    domain: series.map(({ id }) => id),
    range: series.map(({ color }) => color),
  };
  const x = {
    field: 'bucket',
    type: 'temporal' as const,
    title: 'Upload time',
  };
  const color = {
    field: 'seriesId',
    type: 'nominal' as const,
    title: 'Result',
    scale: colorScale,
    legend: { labelExpr: `(${JSON.stringify(Object.fromEntries(series.map(item => [item.id, item.name])))})[datum.label]` },
  };
  const detail = {
    field: 'seriesId',
    type: 'nominal' as const,
  };
  const order = {
    field: 'bucket',
    type: 'temporal' as const,
  };
  const tooltip = [
    { field: 'seriesName', type: 'nominal' as const, title: 'Result' },
    { field: 'bucket', type: 'temporal' as const, title: 'Upload time' },
    { field: 'p25', type: 'quantitative' as const, title: '25th percentile' },
    { field: 'p50', type: 'quantitative' as const, title: 'Median' },
    { field: 'p75', type: 'quantitative' as const, title: '75th percentile' },
    { field: 'n', type: 'quantitative' as const, title: 'Observations' },
    { field: 'note', type: 'nominal' as const, title: 'Note' },
  ];

  const spec = {
    $schema: VL_SCHEMA,
    ...FILLS_CONTAINER,
    height: 220,
    data: { name: 'timeSummary' },
    ...baseConfig(theme),
    layer: [
      {
        data: { name: 'timeSummarySegments' },
        mark: { type: 'area' as const },
        encoding: {
          x,
          y: {
            field: 'p25',
            type: 'quantitative' as const,
            title: yLabel,
            scale: { zero: false },
          },
          y2: { field: 'p75' },
          color,
          detail: { field: 'segmentId', type: 'nominal' as const },
          opacity: {
            condition: { test: 'datum.segmentThin', value: 0.16 },
            value: 0.36,
          },
          tooltip,
        },
      },
      {
        data: { name: 'timeSummarySegments' },
        mark: { type: 'line' as const, strokeWidth: 2 },
        encoding: {
          x,
          y: {
            field: 'p50',
            type: 'quantitative' as const,
            title: yLabel,
            scale: { zero: false },
          },
          color,
          detail: { field: 'segmentId', type: 'nominal' as const },
          order,
          opacity: {
            condition: { test: 'datum.segmentThin', value: 0.4 },
            value: 1,
          },
          tooltip,
        },
      },
      {
        data: { name: 'timeSummary' },
        // A singleton has no adjacent segment, so it remains visible as a
        // point. Thin points also make lower-N values easy to identify.
        mark: { type: 'point' as const, filled: true },
        encoding: {
          size: { condition: { test: 'datum.thin || datum.isolated', value: 28 }, value: 0 },
          x,
          y: {
            field: 'p50',
            type: 'quantitative' as const,
            title: yLabel,
            scale: { zero: false },
          },
          color,
          detail,
          opacity: {
            condition: { test: 'datum.thin', value: 0.4 },
            value: 0.8,
          },
          tooltip,
        },
      },
    ],
  } as unknown as TopLevelSpec;

  return {
    spec,
    datasets: {
      timeSummary: rows,
      timeSummarySegments: segments,
    },
  };
}
