import type { BinnedSummaryQuery, BinnedSummaryResult } from '@mriqc/shared';
/**
 * A deterministic stand-in for the server, so the dashboard can be built and
 * demonstrated before `@mriqc/server`'s router exists.
 *
 * Every answer is a pure function of the query: the query key seeds a small
 * PRNG, so the same panel always draws the same chart, two panels with the same
 * key get the same numbers, and a screenshot is reproducible. Shapes are the
 * shared result types, never an approximation of them.
 */

import { Injectable } from '@angular/core';
import { Observable, delay, of, timer } from 'rxjs';
import { map } from 'rxjs/operators';
import {
  getAuthoredCatalog,
  queryKey,
  type ByModalityView,
  type CompletedCatalog,
  type CoverageBucket,
  type CoverageResult,
  type Density2dResult,
  type CorrelationResult,
  type DistributionResult,
  type FieldValueCount,
  type GroupSummary,
  type GroupedSummaryResult,
  type Histogram,
  type Modality,
  type NumericRange,
  type Quantiles,
  type QuarantineCounts,
  type SampleResult,
  type SampleRow,
  type View,
} from '@mriqc/shared';
import type {
  Api,
  CoverageQuery,
  DistributionQuery,
  GroupedSummaryQuery,
  SampleQuery,
  Density2dQuery,
  CorrelationQuery,
} from './api';

/** Round trip the mock pretends to spend on the network. */
export const MOCK_LATENCY_MS = 150;

/** The ingest version the mock reports; changing it makes every panel refetch. */
export const MOCK_DATA_VERSION = 'mock-2026-09-28';

/* ------------------------------------------------------------------- random */

function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: small, fast, and good enough to make a histogram look alive. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------- value lists */

const VALUES: Record<string, readonly (string | number)[]> = {
  manufacturer: ['SIEMENS', 'GE MEDICAL SYSTEMS', 'Philips Medical Systems', 'TOSHIBA'],
  manufacturers_model_name: [
    'Prisma_fit',
    'Skyra',
    'TrioTim',
    'Achieva',
    'Ingenia',
    'DISCOVERY MR750',
    'SIGNA HDxt',
  ],
  magnetic_field_strength: [1.5, 3, 7],
  provenance_version: ['0.9.6', '0.15.1', '0.16.1', '21.0.0', '22.0.6', '23.1.0', '24.0.2'],
  task_id: ['rest', 'nback', 'motor', 'language', 'checkerboard'],
  institution_name: [
    'Massachusetts General Hospital',
    'Donders Institute',
    'University of Minnesota',
    'CHUV',
    'NIMH',
  ],
  protocol_name: ['task-rest_bold', 'anat-T1w', 'func-bold_acq-mb4', 'MPRAGE', 'BOLD_EPI'],
  // The values the real column holds, so the mock exercises the same display
  // mapping ("AFNI (3dvolreg)", "FSL (MCFLIRT)") the live catalog does.
  canonical_hmc_mode: ['afni', 'fsl', 'unknown'],
  echo_time: [0.03, 0.035, 0.05],
  repetition_time: [0.72, 2, 2.5, 3],
  spacing_x: [1, 2, 2.5, 3],
  spacing_y: [1, 2, 2.5, 3],
  spacing_z: [1, 2, 3, 4],
  spacing_tr: [0.72, 2, 2.5],
  size_x: [64, 96, 128, 256],
  size_y: [64, 96, 128, 256],
  size_z: [36, 48, 60, 176],
  size_t: [120, 200, 300, 490],
  created_at: [],
};

const MODALITIES: readonly Modality[] = ['bold', 'T1w', 'T2w'];
const VIEWS_OF: Record<Modality, readonly View[]> = {
  bold: ['raw', 'k4plus', 'k4plus_all'],
  T1w: ['raw', 'k3pp', 'k3pp_all'],
  T2w: ['raw', 'k3pp', 'k3pp_all'],
};

/**
 * The real corpus sizes, so a mock dashboard is the shape of a real one. The
 * `_all` view is the canonical row count plus the quarantined rows, and the
 * quarantine figures below are the ones the policy audit reports
 * (`docs/k3pp-structural-canonicalization.md`).
 */
const QUARANTINE_OF: Record<Modality, QuarantineCounts> = {
  bold: { groups: 1_898, rows: 5_663 },
  T1w: { groups: 54_981, rows: 167_994 },
  T2w: { groups: 15_757, rows: 43_124 },
};

const ROWS_OF: Record<Modality, Partial<Record<View, number>>> = {
  bold: { raw: 1_515_368, k4plus: 778_075, k4plus_all: 783_738 },
  T1w: { raw: 2_340_058, k3pp: 639_605, k3pp_all: 807_599 },
  T2w: { raw: 238_441, k3pp: 129_845, k3pp_all: 172_969 },
};

function valueCounts(field: string, modality: Modality, view: View): readonly FieldValueCount[] {
  const values = VALUES[field] ?? [];
  const total = ROWS_OF[modality][view] ?? 100_000;
  const random = prng(hash(`${field}|${modality}|${view}`));
  const weights = values.map(() => 0.05 + random());
  const sum = weights.reduce((a, b) => a + b, 0);
  return values
    .map((value, i) => ({ value, n: Math.round((total * weights[i] * 0.9) / sum) }))
    .sort((a, b) => b.n - a.n);
}

/* --------------------------------------------------------------- statistics */

/**
 * A plausible unimodal histogram over `bins` bars, with the metric's own seed
 * choosing its centre, spread and magnitude, so `fd_mean` and `tsnr` do not
 * draw the same curve.
 */
/**
 * A metric's scale and rough shape come from `scaleSeed` (the metric), so every
 * cohort of one metric lives on the same axis; `seed` (the cohort) only nudges
 * the shape. Without that split each series of a comparison came back on its
 * own random scale -- FD mean in the hundreds of millimetres for one vendor.
 */
function makeHistogram(seed: number, bins: number, total: number, scaleSeed = seed): Histogram {
  const random = prng(seed);
  const metric = prng(scaleSeed);
  const magnitude = 10 ** (Math.floor(metric() * 4) - 1);
  const hi = magnitude * (1 + 9 * metric());
  const lo = 0;
  const width = (hi - lo) / bins;
  const centre = 0.18 + 0.45 * metric() + 0.12 * (random() - 0.5);
  const spread = (0.07 + 0.13 * metric()) * (0.85 + 0.3 * random());
  const skew = 0.5 + metric();
  const shape: number[] = [];
  for (let i = 0; i < bins; i++) {
    const x = (i + 0.5) / bins;
    const z = (x - centre) / spread;
    const base = Math.exp(-0.5 * z * z) * (x < centre ? 1 : skew);
    shape.push(base * (0.85 + 0.3 * random()));
  }
  const sum = shape.reduce((a, b) => a + b, 0) || 1;
  const counts = shape.map((value) => Math.max(0, Math.round((total * value) / sum)));
  return { lo, hi, width, counts };
}

function quantilesOf(histogram: Histogram): { quantiles: Quantiles; n: number; mean: number; stddev: number } {
  const n = histogram.counts.reduce((a, b) => a + b, 0);
  const centres = histogram.counts.map((_, i) => histogram.lo + (i + 0.5) * histogram.width);
  const mean = n === 0 ? 0 : centres.reduce((sum, c, i) => sum + c * histogram.counts[i], 0) / n;
  const variance =
    n === 0 ? 0 : centres.reduce((sum, c, i) => sum + (c - mean) ** 2 * histogram.counts[i], 0) / n;
  const at = (p: number): number => {
    const target = p * n;
    let cumulative = 0;
    for (let i = 0; i < histogram.counts.length; i++) {
      cumulative += histogram.counts[i];
      if (cumulative >= target) return histogram.lo + (i + 1) * histogram.width;
    }
    return histogram.hi;
  };
  return {
    n,
    mean,
    stddev: Math.sqrt(variance),
    quantiles: { p01: at(0.01), p05: at(0.05), p25: at(0.25), p50: at(0.5), p75: at(0.75), p95: at(0.95), p99: at(0.99) },
  };
}

function summaryFor(seed: number, bins: number, total: number, scaleSeed = seed): DistributionResult {
  const histogram = makeHistogram(seed, bins, total, scaleSeed);
  const stats = quantilesOf(histogram);
  return {
    n: stats.n,
    min: histogram.lo,
    max: histogram.hi,
    mean: stats.mean,
    stddev: stats.stddev,
    quantiles: stats.quantiles,
    histogram,
  };
}

/**
 * A summary re-binned over an explicit range, the way `distribution` answers a
 * `range` parameter: the same underlying values, counted into a grid the caller
 * chose, with whatever fell outside reported as the two tails.
 *
 * The mock has to do this rather than invent a fresh distribution, because the
 * one thing a comparison panel claims is that its cohorts were binned over the
 * *same* interval. A mock that ignored `range` would answer each cohort over its
 * own grid and the component tests would pass against a chart that silently
 * overlays incomparable histograms -- which is exactly the bug the real client
 * had until `trpc-api.ts` started forwarding the parameter.
 *
 * Each source bin's mass is placed at its centre, so `sum(counts) + underflow +
 * overflow === n` holds exactly, as it does on the server.
 */
function rebin(
  source: DistributionResult,
  bins: number,
  range: readonly [number, number],
): DistributionResult {
  const [lo, hi] = range;
  const width = (hi - lo) / bins;
  const counts = Array.from({ length: bins }, () => 0);
  let underflow = 0;
  let overflow = 0;
  const h = source.histogram;
  for (let i = 0; i < h.counts.length; i++) {
    const centre = h.lo + (i + 0.5) * h.width;
    const count = h.counts[i];
    if (centre < lo) {
      underflow += count;
      continue;
    }
    if (centre >= hi) {
      overflow += count;
      continue;
    }
    counts[Math.min(bins - 1, Math.floor((centre - lo) / width))] += count;
  }
  // The summary itself is over every finite value and does not move with the
  // range, which is how the server answers too.
  return { ...source, histogram: { lo, hi, width, counts, underflow, overflow } };
}

/** Filters shrink the population, which is the visible effect of the top bar. */
function scaleFor(query: { modality: Modality; view: View; filters: readonly unknown[]; selection?: unknown; selections?: readonly unknown[] }): number {
  const base = ROWS_OF[query.modality][query.view] ?? 200_000;
  const narrowed = base * 0.75 ** query.filters.length * 0.35 ** (query.selections?.length ?? (query.selection ? 1 : 0));
  return Math.max(500, Math.round(narrowed));
}

/* ----------------------------------------------------------------- the mock */

/** An `Api` that answers from arithmetic instead of from DuckDB. */
@Injectable()
export class MockApi implements Api {
  binnedSummary(query: BinnedSummaryQuery): Observable<BinnedSummaryResult> {
    const n = Math.round(100 * scaleFor(query));
    const time = query.x === 'created_at';
    const range: [number, number] = query.range ?? (time ? [9132, 9497] : [0, 1]);
    return of({ xKind: time ? 'time' as const : 'metric' as const, yKind: query.y === 'created_at' ? 'time' as const : 'metric' as const, range, buckets: Array.from({ length: 12 }, (_, month) => ({
      lo: time ? (Date.UTC(2025, month, 1) - Date.UTC(2000, 0, 1)) / 86400000 : range[0] + (range[1] - range[0]) * month / 12,
      hi: time ? (Date.UTC(2025, month + 1, 1) - Date.UTC(2000, 0, 1)) / 86400000 : range[0] + (range[1] - range[0]) * (month + 1) / 12,
      ...(time ? { start: `2025-${String(month + 1).padStart(2, '0')}-01` } : {}), group: query.groups ? 'Siemens' : null,
      isOther: false, n, thin: n < 20, mean: 0.3 + month * 0.01,
      quantiles: { p05: 0.1, p25: 0.2, p50: 0.3 + month * 0.01, p75: 0.6, p95: 0.8 },
    })) });
  }

  density2d(query: Density2dQuery): Observable<Density2dResult> {
    const random = prng(query.seed ?? 42);
    const bins = query.grid ?? query.bins ?? 60;
    const xr = query.range?.x ?? [0, 1];
    const yr = query.range?.y ?? [0, 1];
    const counts = new Array<number>(bins * bins).fill(0);
    const sample: Array<[number, number]> = [];
    const n = Math.min(query.sampleSize, 20000);
    for (let i = 0; i < n; i++) {
      const x = random(), y = random();
      counts[Math.min(bins - 1, Math.floor(y * bins)) * bins + Math.min(bins - 1, Math.floor(x * bins))]++;
      sample.push([xr[0] + x * (xr[1] - xr[0]), yr[0] + y * (yr[1] - yr[0])]);
    }
    return of({ xKind: query.x === 'created_at' ? 'time' as const : 'metric' as const, yKind: query.y === 'created_at' ? 'time' as const : 'metric' as const, x: { lo: xr[0], width: (xr[1] - xr[0]) / bins, bins, underflow: 0, overflow: 0 },
      y: { lo: yr[0], width: (yr[1] - yr[0]) / bins, bins, underflow: 0, overflow: 0 },
      counts, n, pearson: 0, spearman: 0, sample }).pipe(delay(MOCK_LATENCY_MS));
  }

  correlation(query: CorrelationQuery): Observable<CorrelationResult> {
    const matrix = query.metrics.map((_, i) => query.metrics.map((__, j) => i === j ? 1 : 0));
    const n = scaleFor(query);
    return of({ metrics: [...query.metrics], pearson: matrix, spearman: matrix,
      pairN: query.metrics.map(() => query.metrics.map(() => n)), minPairN: n }).pipe(delay(MOCK_LATENCY_MS));
  }

  catalog(): Observable<CompletedCatalog> {
    return of(this.completedCatalog()).pipe(delay(MOCK_LATENCY_MS));
  }

  distribution(query: DistributionQuery): Observable<DistributionResult> {
    // The seed deliberately ignores `range`, so the ranged answer is the *same*
    // cohort re-binned and not an unrelated distribution. Two cohorts asked for
    // the same range therefore come back on the same grid, which is what a
    // comparison panel is asserting.
    // Neither the range nor the bin count is part of the seed: both only
    // re-grid the same values, so the summary must not move when they change.
    const seed = hash(queryKey({ ...query, range: undefined, bins: 0 }));
    const own = summaryFor(seed, 400, scaleFor(query), hash(String(query.metric)));
    const result = rebin(own, query.bins, query.range ?? [own.histogram.lo, own.histogram.hi]);
    return of(result).pipe(delay(MOCK_LATENCY_MS));
  }

  groupedSummary(query: GroupedSummaryQuery): Observable<GroupedSummaryResult> {
    const key = queryKey(query);
    const values = (VALUES[query.group] ?? ['A', 'B', 'C']).slice(0, 6);
    const total = scaleFor(query);
    const groups: GroupSummary[] = values.map((value, i) => {
      const summary = summaryFor(hash(`${key}|${String(value)}`), 24, Math.round((total * (0.5 + i * 0.2)) / values.length), hash(String(query.metric)));
      return { value, ...summary };
    });
    return of({ groups }).pipe(delay(MOCK_LATENCY_MS));
  }

  coverage(query: CoverageQuery): Observable<CoverageResult> {
    const key = queryKey(query);
    const values = (VALUES[query.group] ?? ['A', 'B', 'C']).slice(0, 5);
    const random = prng(hash(key));
    const step = query.granularity === 'year' ? 12 : query.granularity === 'month' ? 1 : 1;
    const buckets: CoverageBucket[] = [];
    const scale = scaleFor(query) / 400;
    for (let month = 0; month < 120; month += step) {
      const date = new Date(Date.UTC(2015, month, 1));
      const growth = 0.3 + month / 90;
      for (const value of values) {
        buckets.push({
          start: date.toISOString().slice(0, 10),
          group: value,
          n: Math.max(0, Math.round(scale * growth * (0.4 + random()) * step)),
        });
      }
    }
    return of({ buckets }).pipe(delay(MOCK_LATENCY_MS));
  }

  sample(query: SampleQuery): Observable<SampleResult> {
    const page = Number(/^page-(\d+)$/.exec(query.cursor ?? '')?.[1] ?? 0);
    const random = prng(hash(`${queryKey(query)}|rows`));
    const rows: SampleRow[] = [];
    for (let i = 0; i < 50; i++) {
      const row: Record<string, string | number | boolean | null> = {};
      for (const column of query.columns) row[column] = this.cell(column, random, page * 50 + i);
      rows.push(row);
    }
    const nextCursor = page < 3 ? `page-${page + 1}` : null;
    return of({ rows, nextCursor }).pipe(delay(MOCK_LATENCY_MS));
  }

  dataVersion(): Observable<string> {
    // Emits once and then stays open, like the real SSE subscription.
    return timer(0).pipe(map(() => MOCK_DATA_VERSION));
  }

  private cell(column: string, random: () => number, index: number): string | number | boolean | null {
    if (column === 'id') return `mock-${index.toString(16).padStart(8, '0')}`;
    if (column === 'provenance_md5sum') return Math.floor(random() * 0xffffffff).toString(16).padStart(8, '0').repeat(4);
    if (column === 'created_at') {
      return new Date(Date.UTC(2015, 0, 1) + Math.floor(random() * 3.2e11)).toISOString();
    }
    const values = VALUES[column];
    if (values && values.length > 0) return values[Math.floor(random() * values.length)];
    return Math.round(random() * 10000) / 100;
  }

  private completedCatalog(): CompletedCatalog {
    const authored = getAuthoredCatalog();
    const fieldValues: Record<string, ByModalityView<readonly FieldValueCount[]>> = {};
    for (const field of authored.fields) {
      if (!field.filterable || field.kind === 'date') continue;
      const byModality: ByModalityView<readonly FieldValueCount[]> = {};
      for (const modality of MODALITIES) {
        if (!field.modalities.includes(modality)) continue;
        const byView: Partial<Record<View, readonly FieldValueCount[]>> = {};
        for (const view of VIEWS_OF[modality]) {
          if (field.views && !field.views.includes(view)) continue;
          byView[view] = valueCounts(field.id, modality, view);
        }
        byModality[modality] = byView;
      }
      fieldValues[field.id] = byModality;
    }

    // Bounds for the numeric range controls. The value lists above already say
    // what each numeric column plausibly holds, so the mock's range is their
    // span; `canonical_*` have no list, so they get the policy's own scale.
    const numericRange: Record<string, ByModalityView<NumericRange>> = {};
    for (const field of authored.fields) {
      if (!field.filterable || field.kind !== 'numeric') continue;
      const listed = (VALUES[field.id] ?? []).filter((v): v is number => typeof v === 'number');
      const bounds: NumericRange =
        listed.length > 0
          ? { min: Math.min(...listed), max: Math.max(...listed) }
          : field.id === 'canonical_group_rows'
            ? { min: 1, max: 2945 }
            : { min: 0, max: 0.1 };
      const byModality: ByModalityView<NumericRange> = {};
      for (const modality of MODALITIES) {
        if (!field.modalities.includes(modality)) continue;
        const byView: Partial<Record<View, NumericRange>> = {};
        for (const view of VIEWS_OF[modality]) {
          if (field.views && !field.views.includes(view)) continue;
          byView[view] = bounds;
        }
        byModality[modality] = byView;
      }
      numericRange[field.id] = byModality;
    }

    const metricCounts: Record<string, ByModalityView<number>> = {};
    for (const metric of authored.metrics) {
      const byModality: ByModalityView<number> = {};
      for (const modality of metric.modalities) {
        const byView: Partial<Record<View, number>> = {};
        for (const view of VIEWS_OF[modality]) byView[view] = ROWS_OF[modality][view] ?? 0;
        byModality[modality] = byView;
      }
      metricCounts[metric.id] = byModality;
    }

    return {
      ...authored,
      fieldValues,
      numericRange,
      metricCounts,
      dateRange: {
        bold: { min: '2014-03-01T00:00:00.000Z', max: '2025-06-30T00:00:00.000Z' },
        T1w: { min: '2014-03-01T00:00:00.000Z', max: '2025-06-30T00:00:00.000Z' },
        T2w: { min: '2015-01-01T00:00:00.000Z', max: '2025-06-30T00:00:00.000Z' },
      },
      availableViews: { bold: VIEWS_OF.bold, T1w: VIEWS_OF.T1w, T2w: VIEWS_OF.T2w },
      quarantine: { bold: QUARANTINE_OF.bold, T1w: QUARANTINE_OF.T1w, T2w: QUARANTINE_OF.T2w },
      dataVersion: MOCK_DATA_VERSION,
    };
  }
}
