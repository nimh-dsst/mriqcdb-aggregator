/**
 * The procedures.
 *
 * See `docs/backend-graph.md`, "Procedures". Every input is a zod schema built
 * from the catalog's ids, so an unknown metric fails validation before any SQL is
 * built; every query is one template from `sql/` with catalog-validated identifiers
 * and positional parameters; a query that outruns its budget comes back as
 * `TIMEOUT` and a refused input as `BAD_REQUEST`.
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type {
  ClipMode,
  CoverageResult,
  CorrelationResult,
  Density2dResult,
  DistributionResult,
  Filter,
  GroupSummary,
  GroupedSummaryResult,
  Histogram,
  MetricSummary,
  Modality,
  Quantiles,
  SampleResult,
  SampleRow,
  SelectionScope,
  BinnedSummaryResult,
  BinnedSummaryBucket,
  View,
} from '@mriqc/shared';
import {
  CATALOG_VERSION,
  NONE_LABEL,
  asColumnId,
  binnedSummaryFragments,
  correlationFragments,
  getAuthoredCatalog,
  isNoneValue,
  isValidField,
  isValidMetric,
  normalizeSelections,
} from '@mriqc/shared';
import { getCompletedCatalog } from '../catalog/complete.js';
import type { Db, DbConnection, ParamValue, Row } from '../db/instance.js';
import { PoolBusyError, QueryAbortedError, QueryTimeoutError } from '../db/instance.js';
import { UnknownViewError, isServableView, tableFor } from '../db/views.js';
import { dataVersionStream, getDataVersion } from '../ingest/version.js';
import { FilterError, compileFilters, quoteIdent } from '../sql/filters.js';
import {
  GROUPED_HISTOGRAM_BINS,
  MAX_GROUPS,
  NUMERIC_GROUP_BINS,
  TemplateError,
  binLabel,
  continuousXExpr,
  cursorFromRow,
  cursorPredicate,
  decodeCursor,
  encodeCursor,
  fill,
  granularityLiteral,
  groupExpr,
  groupField,
  groupValueExpr,
  loadTemplate,
  metricExpr,
  projectionColumns,
  projectionSql,
} from '../sql/run.js';
import { binnedSummaryInput, checkSelections, correlationInput, density2dInput, filterSchema, modalitySchema, selectionFields, viewSchema } from './inputs.js';
import { createCallerFactory, publicProcedure, router } from './trpc.js';

/* ------------------------------------------------------------ error mapping */

/**
 * Map the three failure kinds the query path produces onto tRPC codes: a refused
 * input is the client's problem, an interrupted query is a timeout, everything
 * else is ours.
 */
/**
 * A value DuckDB refused to convert for a bound parameter. The filter compiler
 * types what it can, but the authored catalog does not carry each column's DuckDB
 * type -- `magnetic_field_strength` is a DOUBLE served as a categorical value
 * list -- so a wrongly-typed value can still reach the binder. That is the
 * client's input, not our fault, and the raw message quotes the column and the
 * value back, so it never leaves the server.
 */
function isValueConversionError(error: unknown): boolean {
  return error instanceof Error && /Conversion Error|Invalid Input Error/i.test(error.message);
}

async function guard<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof QueryTimeoutError) {
      throw new TRPCError({ code: 'TIMEOUT', message: error.message, cause: error });
    }
    if (error instanceof QueryAbortedError) {
      throw new TRPCError({ code: 'CLIENT_CLOSED_REQUEST', message: error.message, cause: error });
    }
    if (error instanceof PoolBusyError) {
      throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: error.message, cause: error });
    }
    if (
      error instanceof FilterError ||
      error instanceof TemplateError ||
      error instanceof UnknownViewError
    ) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: error.message, cause: error });
    }
    if (isValueConversionError(error)) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'a filter or cursor value does not match its column type',
        cause: error,
      });
    }
    throw error;
  }
}

/* ------------------------------------------------------------------- inputs */

/** The scoping parameters every data query carries. */
const scopedShape = {
  modality: modalitySchema,
  view: viewSchema,
  filters: z.array(filterSchema).default([]),
  ...selectionFields,
};

/** Reject a `(modality, view)` pair that has no table before any SQL is built. */
function checkView(value: { modality: Modality; view: View }, ctx: z.RefinementCtx): void {
  if (!isServableView(value.modality, value.view)) {
    ctx.addIssue({ code: 'custom', message: `no ${value.view} view for ${value.modality}` });
  }
}

function checkMetric(
  value: { modality: Modality; metric: string },
  ctx: z.RefinementCtx,
): void {
  if (!isValidMetric(value.modality, value.metric)) {
    ctx.addIssue({
      code: 'custom',
      path: ['metric'],
      message: `unknown metric "${value.metric}" for ${value.modality}`,
    });
  }
}

const distributionInput = z
  .object({
    ...scopedShape,
    metric: z.string(),
    bins: z.number().int().min(1).max(200).default(50),
    clip: z.enum(['p01p99', 'p05p95', 'none']).default('p01p99'),
    /**
     * The exact `[lo, hi]` to bin over, overriding `clip`. What a comparison
     * panel sends so every cohort's histogram shares bin edges
     * (`docs/comparison-design.md`, "Comparison panel"). The quantiles and the
     * summary statistics are unaffected: they are always over the whole filtered
     * finite set, whatever the histogram is clipped to.
     */
    range: z.tuple([z.number(), z.number()]).optional(),
  })
  .superRefine((value, ctx) => {
    checkSelections(value, ctx);
    checkView(value, ctx);
    checkMetric(value, ctx);
    if (value.range !== undefined) {
      const [lo, hi] = value.range;
      // `lo < hi` strictly, not `<=`: a zero-width range has no bin edges to share,
      // and the width would be 0, so every value would land in bin 0 or outside.
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
        ctx.addIssue({ code: 'custom', path: ['range'], message: 'range needs two finite bounds' });
      } else if (!(lo < hi)) {
        ctx.addIssue({ code: 'custom', path: ['range'], message: 'range needs lo below hi' });
      }
    }
  });

const groupedSummaryInput = z
  .object({ ...scopedShape, metric: z.string(), group: z.string() })
  .superRefine((value, ctx) => {
    checkSelections(value, ctx);
    checkView(value, ctx);
    checkMetric(value, ctx);
    if (!isValidField(value.modality, value.view, value.group, 'group')) {
      ctx.addIssue({
        code: 'custom',
        path: ['group'],
        message: `"${value.group}" is not a group field for ${value.modality}/${value.view}`,
      });
    }
  });

const coverageInput = z
  .object({
    ...scopedShape,
    group: z.string(),
    granularity: z.enum(['day', 'week', 'month', 'year']).default('month'),
  })
  .superRefine((value, ctx) => {
    checkSelections(value, ctx);
    checkView(value, ctx);
    if (!isValidField(value.modality, value.view, value.group, 'group')) {
      ctx.addIssue({
        code: 'custom',
        path: ['group'],
        message: `"${value.group}" is not a group field for ${value.modality}/${value.view}`,
      });
    }
  });

const sampleInput = z
  .object({
    ...scopedShape,
    columns: z.array(z.string()).min(1),
    cursor: z.string().nullish(),
    limit: z.number().int().min(1).max(500).default(100),
  })
  .superRefine((value, ctx) => {
    checkSelections(value, ctx);
    checkView(value, ctx);
    for (const column of value.columns) {
      if (
        !isValidField(value.modality, value.view, column, 'export') &&
        !isValidMetric(value.modality, column)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['columns'],
          message: `"${column}" is not an exportable column for ${value.modality}/${value.view}`,
        });
      }
    }
  });

/* --------------------------------------------------------------- row shaping */

/** Seven quantiles come back as one DuckDB list, in the order the template asks for them. */
function toQuantiles(value: unknown): Quantiles | null {
  if (!Array.isArray(value) || value.length !== 7) return null;
  const [p01, p05, p25, p50, p75, p95, p99] = value.map(Number);
  return {
    p01: p01 as number,
    p05: p05 as number,
    p25: p25 as number,
    p50: p50 as number,
    p75: p75 as number,
    p95: p95 as number,
    p99: p99 as number,
  };
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isNaN(parsed) && typeof value !== 'number' ? null : parsed;
}

function toSummary(row: Row | undefined): MetricSummary {
  return {
    n: Number(row?.['n'] ?? 0),
    min: numberOrNull(row?.['min']),
    max: numberOrNull(row?.['max']),
    mean: numberOrNull(row?.['mean']),
    stddev: numberOrNull(row?.['stddev']),
    quantiles: toQuantiles(row?.['quantiles']),
  };
}

/** Make a DuckDB value safe to hand to JSON: bigints narrow, timestamps become ISO text. */
function jsonValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  return String(value);
}

/** The `[lo, hi]` a clip mode selects out of the summary. */
export function clipRange(summary: MetricSummary, clip: ClipMode): [number, number] {
  const q = summary.quantiles;
  if (clip === 'p01p99' && q !== null) return [q.p01, q.p99];
  if (clip === 'p05p95' && q !== null) return [q.p05, q.p95];
  return [summary.min ?? 0, summary.max ?? 0];
}

/**
 * The bounds the histogram is actually built over.
 *
 * A metric with one dominant value -- `fd_num` at 0 -- has p01 equal to p99 while
 * `min` and `max` genuinely differ. Reporting a zero-width bin holding all n rows
 * would then contradict the `min`/`max` in the same response and overcount, since
 * the normal branch excludes out-of-range rows. Falling back to `[min, max]` keeps
 * the histogram consistent with the summary it ships with.
 */
export function histogramRange(summary: MetricSummary, clip: ClipMode): [number, number] {
  const [lo, hi] = clipRange(summary, clip);
  if (hi > lo) return [lo, hi];
  const { min, max } = summary;
  return min !== null && max !== null && max > min ? [min, max] : [lo, hi];
}

/** Run one procedure's statements on one connection, under one shared deadline. */
function read<T>(
  db: Db,
  signal: AbortSignal | undefined,
  fn: (connection: DbConnection) => Promise<T>,
): Promise<T> {
  // One `withRead` per procedure, not per statement: the documented budget is 30 s
  // for the call, and a procedure that issued three statements had three separate
  // budgets on three different connections -- and so, once ingest lands, possibly
  // three different snapshots.
  return db.withRead(fn, signal === undefined ? {} : { signal });
}

/** Spread sparse `(bin, n)` rows into a dense count array. */
function densify(rows: readonly Row[], bins: number, key = 'bin'): number[] {
  const counts = new Array<number>(bins).fill(0);
  for (const row of rows) {
    const bin = Number(row[key]);
    if (Number.isInteger(bin) && bin >= 0 && bin < bins) counts[bin] = Number(row['n']);
  }
  return counts;
}

/** The histogram of a degenerate range: everything is one value, so one bin holds it. */
function singleBin(n: number, lo: number, hi: number): Histogram {
  return { lo, hi, width: 0, counts: [n] };
}

/**
 * The two out-of-range keys the `histogram_ranged` statement reports beside the
 * bins: -1 for everything below `lo`, `bins` for everything above `hi`. Absent
 * means none, so 0 -- `densify` ignores both, which is what keeps
 * `sum(counts) + underflow + overflow === n`.
 */
function outsideCount(rows: readonly Row[], bin: number): number {
  const row = rows.find((r) => Number(r['bin']) === bin);
  return row === undefined ? 0 : Number(row['n']);
}

/* ------------------------------------------------------------------ helpers */

/** The compiled predicate for one scoped query. */
function predicate(
  input: { modality: Modality; view: View; filters: readonly unknown[]; selections?: unknown; selection?: unknown },
): { table: string; where: string; params: ParamValue[] } {
  const table = tableFor(input.modality, input.view);
  const compiled = compileFilters(
    input.filters as readonly Filter[],
    normalizeSelections(input as SelectionScope),
    input.modality,
    input.view,
    getAuthoredCatalog(),
  );
  return { table: quoteIdent(table), where: compiled.where, params: compiled.params };
}

/* --------------------------------------------------------------- procedures */

export const appRouter = router({
  /** Liveness probe that also proves the DuckDB binding loaded and answers queries. */
  health: publicProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.withRead((c) => c.all('SELECT version() AS version'));
    return {
      ok: true as const,
      duckdb: String(rows[0]?.['version'] ?? 'unknown'),
      catalogVersion: CATALOG_VERSION,
    };
  }),

  /** The authored catalog completed with database facts, cached per `data_version`. */
  catalog: publicProcedure.query(({ ctx }) => guard(() => getCompletedCatalog(ctx.db))),

  density2d: publicProcedure
    .input(density2dInput)
    .query(({ ctx, input, signal }): Promise<Density2dResult> =>
      guard(async () => {
        const { table, where, params } = predicate(input);
        const holes = {
          table, where,
          x: continuousXExpr(input.modality, input.view, input.x),
          y: metricExpr(input.modality, input.y),
          // DuckDB SAMPLE requires literals. Zod admits only bounded integers.
          sample_size: String(input.sampleSize),
          seed: String(input.seed),
        };
        return read(ctx.db, signal, async (c) => {
          const [stats] = await c.all(fill(loadTemplate('density2d', 'stats'), holes), params);
          const n = Number(stats?.['n'] ?? 0);
          const bounds = (axis: 'x' | 'y'): [number, number] => input.range?.[axis] ?? histogramRange({
            n, min: numberOrNull(stats?.[`${axis}_min`]), max: numberOrNull(stats?.[`${axis}_max`]),
            mean: null, stddev: null, quantiles: toQuantiles(stats?.[`${axis}_quantiles`]),
          }, input.clip);
          const [xlo, xhi] = bounds('x');
          const [ylo, yhi] = bounds('y');
          const bins = input.bins;
          const x = { lo: xlo, width: (xhi - xlo) / bins, bins, underflow: 0, overflow: 0 };
          const y = { lo: ylo, width: (yhi - ylo) / bins, bins, underflow: 0, overflow: 0 };
          const counts = new Array<number>(bins * bins).fill(0);
          if (n > 0) {
            const rows = await c.all(fill(loadTemplate('density2d', 'histogram'), holes), [
              ...params, xlo, xhi, bins, bins, xlo, x.width, ylo, yhi, bins, bins, ylo, y.width,
            ]);
            for (const row of rows) {
              const bx = Number(row['bx']);
              const by = Number(row['by']);
              const count = Number(row['n']);
              // Disjoint x-first tails conserve n even when both axes are outside.
              if (bx < 0) x.underflow += count;
              else if (bx >= bins) x.overflow += count;
              else if (by < 0) y.underflow += count;
              else if (by >= bins) y.overflow += count;
              else counts[by * bins + bx] = count;
            }
          }
          const sampled = n === 0 || input.sampleSize === 0 ? [] : await c.all(
            fill(loadTemplate('density2d', 'sample'), holes), [...params, xlo, xhi, ylo, yhi],
          );
          const coefficient = (value: unknown): number | null =>
            typeof value === 'number' && Number.isFinite(value) ? value : null;
          return {
            xKind: input.x === 'created_at' ? 'time' : 'metric',
            x, y, counts, n,
            pearson: coefficient(stats?.['pearson']), spearman: coefficient(stats?.['spearman']),
            sample: sampled.map((row) => [Number(row['x']), Number(row['y'])]),
          };
        });
      }),
    ),

  correlation: publicProcedure
    .input(correlationInput)
    .query(({ ctx, input, signal }): Promise<CorrelationResult> =>
      guard(async () => {
        const { table, where, params } = predicate(input);
        const holes = {
          table, where,
          ...correlationFragments(input.metrics.map((id) => metricExpr(input.modality, id)), input.method),
        };
        return read(ctx.db, signal, async (c) => {
          const [row] = await c.all(fill(loadTemplate('correlation', 'matrix'), holes), params);
          const size = input.metrics.length;
          const matrix = (prefix: string, missing: number): number[][] => Array.from({ length: size }, (_, i) =>
            Array.from({ length: size }, (_, j) =>
              Number(row?.[`${prefix}${Math.min(i, j)}_${Math.max(i, j)}`] ?? missing)),
          );
          const pairN = matrix('n', 0);
          return {
            metrics: input.metrics.map(asColumnId), pairN, minPairN: Math.min(...pairN.flat()),
            ...(input.method !== 'spearman' ? { pearson: matrix('p', Number.NaN) } : {}),
            ...(input.method !== 'pearson' ? { spearman: matrix('s', Number.NaN) } : {}),
          };
        });
      }),
    ),

  distribution: publicProcedure
    .input(distributionInput)
    .query(({ ctx, input, signal }): Promise<DistributionResult> =>
      guard(async () => {
        const { table, where, params } = predicate(input);
        const metric = metricExpr(input.modality, input.metric);
        const holes = { table, metric, where };

        return read(ctx.db, signal, async (c) => {
          const statsRows = await c.all(fill(loadTemplate('distribution', 'stats'), holes), params);
          const summary = toSummary(statsRows[0]);

          // An explicitly requested range is binned over exactly as asked, even
          // when it holds no rows at all: a comparison panel needs every cohort's
          // bin edges to agree, and an empty cohort that reported `[0, 0]` would
          // not line up with the others. The clip modes keep their own behaviour.
          if (input.range !== undefined) {
            const [lo, hi] = input.range;
            const bins = input.bins;
            const width = (hi - lo) / bins;
            const binRows =
              summary.n === 0
                ? []
                : await c.all(fill(loadTemplate('distribution', 'histogram_ranged'), holes), [
                    ...params,
                    lo,
                    hi,
                    bins,
                    bins,
                    lo,
                    width,
                  ]);
            return {
              ...summary,
              histogram: {
                lo,
                hi,
                width,
                counts: densify(binRows, bins),
                underflow: outsideCount(binRows, -1),
                overflow: outsideCount(binRows, bins),
              },
            };
          }

          if (summary.n === 0) {
            return { ...summary, histogram: { lo: 0, hi: 0, width: 0, counts: [] } };
          }

          const [lo, hi] = histogramRange(summary, input.clip);
          if (!(hi > lo)) return { ...summary, histogram: singleBin(summary.n, lo, hi) };

          const bins = input.bins;
          const width = (hi - lo) / bins;
          const binRows = await c.all(fill(loadTemplate('distribution', 'histogram'), holes), [
            ...params,
            bins,
            lo,
            width,
            lo,
            hi,
          ]);
          return { ...summary, histogram: { lo, hi, width, counts: densify(binRows, bins) } };
        });
      }),
    ),

  groupedSummary: publicProcedure
    .input(groupedSummaryInput)
    .query(({ ctx, input, signal }): Promise<GroupedSummaryResult> =>
      guard(async () => {
        const { table, where, params } = predicate(input);
        const metric = metricExpr(input.modality, input.metric);
        const field = groupField(input.modality, input.view, input.group);

        return read(ctx.db, signal, async (c) => {
          // A numeric group column needs its own bounds before it can be binned.
          let bounds: { lo: number; width: number } | null = null;
          if (field.kind === 'numeric') {
            const rangeRows = await c.all(
              fill(loadTemplate('grouped_summary', 'group_range'), {
                table,
                metric,
                group_expr: groupValueExpr(field),
                where,
              }),
              params,
            );
            const lo = numberOrNull(rangeRows[0]?.['lo']);
            const hi = numberOrNull(rangeRows[0]?.['hi']);
            if (lo !== null && hi !== null && hi > lo) {
              bounds = { lo, width: (hi - lo) / NUMERIC_GROUP_BINS };
            }
          }

          const group = groupExpr(field, bounds);
          const holes = { table, metric, group_expr: group.expr, where };
          const groupParams = [...group.params, ...params];

          const statRows = await c.all(fill(loadTemplate('grouped_summary', 'stats'), holes), [
            ...groupParams,
            MAX_GROUPS,
            MAX_GROUPS,
          ]);
          if (statRows.length === 0) return { groups: [] };

          const bins = GROUPED_HISTOGRAM_BINS;
          const lo = Math.min(...statRows.map((r) => Number(r['min'])));
          const hi = Math.max(...statRows.map((r) => Number(r['max'])));
          const degenerate = !(hi > lo);
          const width = degenerate ? 0 : (hi - lo) / bins;

          // One key per output row, so the histogram statement's rows find their group.
          const key = (isOther: boolean, value: unknown): string =>
            isOther
              ? '\u0000other'
              : value === null || value === undefined
                ? '\u0000null'
                : String(value);
          const histograms = new Map<string, Row[]>();
          if (!degenerate) {
            const histRows = await c.all(
              fill(loadTemplate('grouped_summary', 'histograms'), holes),
              [...groupParams, MAX_GROUPS, MAX_GROUPS, bins, lo, width, lo, hi],
            );
            for (const row of histRows) {
              const k = key(Boolean(row['is_other']), row['value']);
              (histograms.get(k) ?? histograms.set(k, []).get(k)!).push(row);
            }
          }

          const build = (row: Row): GroupSummary => {
            const summary = toSummary(row);
            const isOther = Boolean(row['is_other']);
            const k = key(isOther, row['value']);
            return {
              ...summary,
              value: isOther ? 'other' : jsonValue(group.label(row['value'])),
              histogram: degenerate
                ? singleBin(summary.n, lo, hi)
                : { lo, hi, width, counts: densify(histograms.get(k) ?? [], bins) },
            };
          };

          const groups = statRows.filter((r) => !r['is_other']).map(build);
          const otherRow = statRows.find((r) => Boolean(r['is_other']));
          return otherRow === undefined ? { groups } : { groups, other: build(otherRow) };
        });
      }),
    ),

  binnedSummary: publicProcedure
    .input(binnedSummaryInput)
    .query(({ ctx, input, signal }): Promise<BinnedSummaryResult> =>
      guard(async () => {
        const compiled = predicate(input);
        const field = input.groups === undefined ? undefined
          : groupField(input.modality, input.view, input.groups);
        const xKind = input.x === 'created_at' ? 'time' : 'metric';
        const common = {
          table: compiled.table,
          x: continuousXExpr(input.modality, input.view, input.x),
          y: metricExpr(input.modality, input.y),
          ...binnedSummaryFragments(input.bins),
          group_expr: field === undefined ? 'NULL::VARCHAR' : groupValueExpr(field),
          group_numeric: field?.kind === 'numeric' ? 'TRUE' : 'FALSE',
          group_bins: String(NUMERIC_GROUP_BINS),
          max_groups: String(MAX_GROUPS),
        };
        // Compile each scope independently so the same metric may be constrained
        // by both the outer brush and a cohort brush (their intersection).
        const scopes = input.cohorts === undefined ? [{ id: undefined, ...compiled }]
          : input.cohorts.map(cohort => {
            const extra = predicate({ ...cohort, modality: input.modality, view: input.view });
            return { id: cohort.id, where: `(${compiled.where}) AND (${extra.where})`,
              params: [...compiled.params, ...extra.params] };
          });
        return read(ctx.db, signal, async c => {
          // First obtain each finite-pair domain, then use one range for every series.
          const ranges: [number, number][] = [];
          if (input.range === undefined) {
            for (const scope of scopes) {
              const [stats] = await c.all(fill(loadTemplate('binned_summary', 'stats'),
                { ...common, where: scope.where }), scope.params);
              const summary = toSummary(stats);
              if (summary.n > 0) ranges.push(histogramRange(summary, xKind === 'time' ? 'none' : 'p01p99'));
            }
          }
          const range: [number, number] = input.range ?? (ranges.length === 0 ? [0, 0]
            : [Math.min(...ranges.map(r => r[0])), Math.max(...ranges.map(r => r[1]))]);
          const [lo, hi] = range;
          const bins = typeof input.bins === 'number' ? input.bins : 1;
          const width = (hi - lo) / bins;
          const buckets: BinnedSummaryBucket[] = [];
          for (const scope of scopes) {
            const rows = await c.all(fill(loadTemplate('binned_summary', 'buckets'),
              { ...common, where: scope.where }), [...scope.params, lo, hi, bins]);
            for (const row of rows) {
              const isOther = Boolean(row['is_other']);
              let value = row['value'];
              const groupWidth = Number(row['group_width']);
              if (field?.kind === 'numeric' && value != null && groupWidth > 0) {
                value = binLabel(Number(row['group_lo']), groupWidth, Number(value));
              }
              const [p05, p25, p50, p75, p95] = (row['qs'] as number[]).map(Number);
              const bin = Number(row['bucket']);
              const bucketLo = xKind === 'time' ? bin : lo + bin * width;
              buckets.push({
                lo: bucketLo,
                hi: xKind === 'time' ? Number(row['bucket_hi']) : Math.min(hi, lo + (bin + 1) * width),
                ...(xKind === 'time' ? { start: new Date(Date.UTC(2000, 0, 1) + bucketLo * 86_400_000).toISOString() } : {}),
                ...(scope.id === undefined ? {} : { cohort: scope.id }),
                group: isOther ? 'Other' : field === undefined ? null
                  : isNoneValue(value) ? NONE_LABEL : jsonValue(value),
                isOther, n: Number(row['n']),
                quantiles: { p05: p05!, p25: p25!, p50: p50!, p75: p75!, p95: p95! },
                mean: Number(row['mean']), thin: Boolean(row['thin']),
              });
            }
          }
          return { xKind, range, buckets };
        });
      }),
    ),

  coverage: publicProcedure
    .input(coverageInput)
    .query(({ ctx, input, signal }): Promise<CoverageResult> =>
      guard(async () => {
        const { table, where, params } = predicate(input);
        const field = groupField(input.modality, input.view, input.group);

        return read(ctx.db, signal, async (c) => {
          let bounds: { lo: number; width: number } | null = null;
          if (field.kind === 'numeric') {
            const rangeRows = await c.all(
              fill(loadTemplate('coverage', 'group_range'), {
                table,
                group_expr: groupValueExpr(field),
                where,
              }),
              params,
            );
            const lo = numberOrNull(rangeRows[0]?.['lo']);
            const hi = numberOrNull(rangeRows[0]?.['hi']);
            if (lo !== null && hi !== null && hi > lo) {
              bounds = { lo, width: (hi - lo) / NUMERIC_GROUP_BINS };
            }
          }

          const group = groupExpr(field, bounds);
          const rows = await c.all(
            fill(loadTemplate('coverage', 'buckets'), {
              table,
              granularity: granularityLiteral(input.granularity),
              group_expr: group.expr,
              where,
            }),
            [...group.params, ...params],
          );

          return {
            buckets: rows.map((row) => {
              const start = row['bucket'];
              const value = group.label(row['value']);
              return {
                start: start instanceof Date ? start.toISOString() : String(start),
                group: isNoneValue(value) ? NONE_LABEL : jsonValue(value),
                n: Number(row['n']),
              };
            }),
          };
        });
      }),
    ),

  sample: publicProcedure
    .input(sampleInput)
    .query(({ ctx, input, signal }): Promise<SampleResult> =>
      guard(async () => {
        const { table, where, params } = predicate(input);
        const columns = projectionColumns(input.modality, input.view, input.columns);
        const cursor = input.cursor == null ? null : decodeCursor(input.cursor);
        const keyset = cursorPredicate(cursor);

        const rows = await read(ctx.db, signal, (c) =>
          c.all(
            fill(loadTemplate('sample', 'page'), {
              table,
              columns: projectionSql(columns),
              where,
              cursor: keyset.sql,
            }),
            [...params, ...keyset.params, input.limit],
          ),
        );

        const shaped: SampleRow[] = rows.map((row) =>
          Object.fromEntries(columns.map((column) => [column, jsonValue(row[column])])),
        );
        const last = rows[rows.length - 1];
        const next = rows.length === input.limit && last !== undefined ? cursorFromRow(last) : null;
        return { rows: shaped, nextCursor: next === null ? null : encodeCursor(next) };
      }),
    ),

  /** The current `data_version`, immediately and again on every change. */
  dataVersion: publicProcedure.subscription(async function* ({ ctx, signal }) {
    yield* dataVersionStream(ctx.db, signal);
  }),
});

export type AppRouter = typeof appRouter;

/** `createCaller(ctx)` invokes procedures in-process; used by tests and the export route. */
export const createCaller = createCallerFactory(appRouter);

/** Re-exported so the HTTP layer can stamp every response without importing ingest. */
export { getDataVersion };
export type { Db };
