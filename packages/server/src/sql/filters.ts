/**
 * The filter compiler, catalog side.
 *
 * See `docs/backend-graph.md`, "Query templates and the filter compiler": every
 * template's `WHERE` begins with `TRUE` so this fragment may be empty, column
 * identifiers are catalog-validated and quoted, and every value is a positional
 * parameter. No user string is ever interpolated.
 *
 * The fragment-building itself -- operator to SQL, parameter order, the `(none)`
 * expansion, the brushed selection -- is `@mriqc/shared`'s `compileFiltersCore`,
 * because the dashboard's DuckDB-WASM runner compiles the same `Filter[]` against
 * an uploaded study's table and must produce the same predicate. What is left
 * here is this server's own validation: the authored catalog's per-modality,
 * per-view allowlist, which a study table has no equivalent of. Everything the
 * core defines is re-exported, so `./filters.js` stays the one import for callers.
 *
 * The function is pure: it touches no database and no module state, which is why
 * it can be unit-tested exhaustively.
 */

import type {
  AuthoredCatalog,
  FieldDef,
  Filter,
  Modality,
  Selection,
  View,
} from '@mriqc/shared';
import {
  ALLOWED_OPS,
  FilterError,
  MAX_IN_VALUES,
  compileFiltersCore,
  isIsoDateString,
  quoteIdent,
  quoteLiteral,
  type CompiledFilters,
  type FilterValidator,
} from '@mriqc/shared';

export {
  ALLOWED_OPS,
  FilterError,
  MAX_IN_VALUES,
  isIsoDateString,
  quoteIdent,
  quoteLiteral,
  type CompiledFilters,
};

/** Everything the compiler needs from the catalog. */
export type FilterCatalog = Pick<AuthoredCatalog, 'fields' | 'metrics'>;

function findField(
  catalog: FilterCatalog,
  modality: Modality,
  view: View,
  fieldId: string,
): FieldDef {
  const field = catalog.fields.find((f) => f.id === fieldId);
  if (field === undefined) throw new FilterError(`unknown filter field "${fieldId}"`);
  if (!field.modalities.includes(modality)) {
    throw new FilterError(`field "${fieldId}" does not exist for modality ${modality}`);
  }
  if (field.views !== undefined && !field.views.includes(view)) {
    throw new FilterError(`field "${fieldId}" does not exist in the ${view} view`);
  }
  if (!field.filterable) throw new FilterError(`field "${fieldId}" is not filterable`);
  return field;
}

function findMetric(catalog: FilterCatalog, modality: Modality, metricId: string): string {
  // `some`, not `find`: the catalog deliberately lists the eight `summary_bg_*`
  // ids twice -- once bold-only, once for T1w/T2w -- so matching only the first
  // entry would reject every brush on those metrics for T1w and T2w, while
  // `isValidMetric` (which this mirrors) accepts them.
  const valid = catalog.metrics.some(
    (m) => m.id === metricId && m.modalities.includes(modality),
  );
  if (!valid) {
    throw new FilterError(`unknown selection metric "${metricId}" for modality ${modality}`);
  }
  return metricId;
}

/** The catalog's answer to which columns this `(modality, view)` admits. */
export function catalogValidator(
  modality: Modality,
  view: View,
  catalog: FilterCatalog,
): FilterValidator {
  return {
    field: (fieldId) => findField(catalog, modality, view, fieldId),
    metric: (metricId) => findMetric(catalog, modality, metricId),
  };
}

/**
 * Compile filters and the linked selection into one predicate fragment.
 *
 * The result always begins with `TRUE`, so `WHERE ${where}` is valid even with no
 * filters at all, and every value is bound positionally in `params` order.
 */
export function compileFilters(
  filters: readonly Filter[],
  selections: readonly Selection[] | Selection | null | undefined,
  modality: Modality,
  view: View,
  catalog: FilterCatalog,
): CompiledFilters {
  return compileFiltersCore(filters, selections, catalogValidator(modality, view, catalog));
}
