/**
 * The zod shapes every scoped input is built from.
 *
 * They live outside `router.ts` because `/export` is not a tRPC procedure but is,
 * per `docs/backend-graph.md`, "validated by the same zod schemas" -- so the
 * schemas have to be importable without pulling in the router.
 */

import { z } from 'zod';
import {
  MAX_SELECTIONS, MODALITIES, VIEWS, fieldsFor, isValidMetric,
  type Modality, type View,
} from '@mriqc/shared';
import { isServableView } from '../db/views.js';

/**
 * Built from the catalog's own lists rather than spelled out, so a view the
 * catalog gains -- `k4plus_all`, say -- is accepted here without a second edit.
 * A `(modality, view)` pair that exists in the vocabulary but not in this
 * database is still refused, by the view map, further in.
 */
export const modalitySchema = z.enum(MODALITIES as unknown as [Modality, ...Modality[]]);
export const viewSchema = z.enum(VIEWS as unknown as [View, ...View[]]);

const filterValueSchema = z.union([z.string(), z.number(), z.boolean()]);
const boundSchema = z.union([z.number(), z.string()]);

/** One predicate against a filterable column, as the client sends it. */
export const filterSchema = z.discriminatedUnion('op', [
  z.object({ field: z.string(), op: z.literal('in'), values: z.array(filterValueSchema) }),
  z.object({ field: z.string(), op: z.literal('between'), lo: boundSchema, hi: boundSchema }),
  z.object({ field: z.string(), op: z.literal('isNull') }),
  z.object({ field: z.string(), op: z.literal('notNull') }),
]);

/** A whole filter list. */
export const filtersSchema = z.array(filterSchema);

/** A brushed interval on one metric's axis. */
export const selectionSchema = z.object({
  metric: z.string(),
  range: z.tuple([z.number().finite(), z.number().finite()])
    .refine(([lo, hi]) => lo <= hi, 'selection range needs lo at or below hi'),
});

export const selectionsSchema = z.array(selectionSchema).max(MAX_SELECTIONS)
  .refine((selections) => new Set(selections.map((s) => s.metric)).size === selections.length,
    'selection metrics must be distinct');

export const selectionFields = {
  selections: selectionsSchema.optional(),
  selection: selectionSchema.nullish(),
};

export function checkSelections(
  input: { selections?: unknown; selection?: unknown }, ctx: z.RefinementCtx,
): void {
  if (input.selections !== undefined && input.selection != null) {
    ctx.addIssue({ code: 'custom', path: ['selections'], message: 'use selections or selection, not both' });
  }
}

/** Shared by tRPC and the export query-string parser. */
export const selectionInput = z.object(selectionFields).superRefine(checkSelections);

const analysisScope = {
  modality: modalitySchema,
  view: viewSchema,
  filters: filtersSchema.default([]),
  ...selectionFields,
};

const axisRange = z.tuple([z.number().finite(), z.number().finite()])
  .refine(([lo, hi]) => lo < hi && Number.isFinite(hi - lo), 'range needs finite lo below hi');

function checkAnalysis(
  input: { modality: Modality; view: View },
  metrics: readonly string[],
  ctx: z.RefinementCtx,
): void {
  if (!isServableView(input.modality, input.view)) {
    ctx.addIssue({ code: 'custom', message: `no ${input.view} view for ${input.modality}` });
  }
  for (const metric of metrics) {
    if (!isValidMetric(input.modality, metric)) {
      ctx.addIssue({ code: 'custom', message: `unknown metric "${metric}" for ${input.modality}` });
    }
  }
}

/** Only the catalog's time field or a catalog metric can be a continuous x. */
function checkContinuousX(input: { modality: Modality; view: View; x: string }, ctx: z.RefinementCtx): void {
  if (input.x === 'created_at' && fieldsFor(input.modality, input.view, 'filter')
    .some(field => field.id === input.x && field.kind === 'date')) return;
  if (!isValidMetric(input.modality, input.x)) {
    ctx.addIssue({ code: 'custom', path: ['x'], message: `unknown continuous x "${input.x}"` });
  }
}

/** Finite y summaries over continuous x, with one shared range across cohorts. */
export const binnedSummaryInput = z.object({
  ...analysisScope,
  x: z.string(),
  y: z.string(),
  bins: z.union([z.number().int().min(1).max(200), z.enum(['day', 'week', 'month', 'year'])]),
  range: axisRange.optional(),
  groups: z.string().optional(),
  cohorts: z.array(z.object({
    id: z.string().min(1).max(200), filters: filtersSchema, ...selectionFields,
  }).superRefine(checkSelections)).min(1).max(8)
    .refine(cohorts => new Set(cohorts.map(c => c.id)).size === cohorts.length, 'cohort ids must be distinct')
    .optional(),
}).superRefine((input, ctx) => {
  checkSelections(input, ctx);
  checkAnalysis(input, [input.y], ctx);
  checkContinuousX(input, ctx);
  if ((input.x === 'created_at') !== (typeof input.bins === 'string')) {
    ctx.addIssue({ code: 'custom', path: ['bins'], message: 'time x needs calendar bins; metric x needs a bin count' });
  }
  if (input.range !== undefined && typeof input.bins === 'number' && (input.range[1] - input.range[0]) / input.bins === 0) {
    ctx.addIssue({ code: 'custom', path: ['range'], message: 'range is too narrow for bins' });
  }
  if (input.groups !== undefined && !fieldsFor(input.modality, input.view, 'group')
    .some((field) => field.id === input.groups && field.kind !== 'date')) {
    ctx.addIssue({ code: 'custom', path: ['groups'], message: 'groups must be a categorical or numeric group field' });
  }
});

/** Two finite metrics on a shared grid, with a capped reproducible scatter sample. */
export const density2dInput = z.object({
  ...analysisScope,
  x: z.string(),
  y: z.string(),
  bins: z.number().int().min(10).max(200).default(120),
  clip: z.enum(['p01p99', 'p05p95', 'none']).default('p01p99'),
  range: z.object({ x: axisRange, y: axisRange }).optional(),
  sampleSize: z.number().int().min(0).max(20_000).default(2_000),
  seed: z.number().int().min(0).max(2_147_483_647).default(1),
}).superRefine((input, ctx) => {
  checkSelections(input, ctx);
  checkAnalysis(input, [input.y], ctx);
  checkContinuousX(input, ctx);
  if (input.x === input.y) {
    ctx.addIssue({ code: 'custom', path: ['y'], message: 'x and y must be different metrics' });
  }
  if (input.range !== undefined) {
    for (const axis of ['x', 'y'] as const) {
      const [lo, hi] = input.range[axis];
      if ((hi - lo) / input.bins === 0) {
        ctx.addIssue({ code: 'custom', path: ['range', axis], message: 'range is too narrow for bins' });
      }
    }
  }
});

/** Input metric order is the matrix order; duplicate ids are refused. */
export const correlationInput = z.object({
  ...analysisScope,
  metrics: z.array(z.string()).min(2).max(24),
  method: z.enum(['pearson', 'spearman', 'both']).default('both'),
}).superRefine((input, ctx) => {
  checkSelections(input, ctx);
  checkAnalysis(input, input.metrics, ctx);
  if (new Set(input.metrics).size !== input.metrics.length) {
    ctx.addIssue({ code: 'custom', path: ['metrics'], message: 'metrics must be distinct' });
  }
});
