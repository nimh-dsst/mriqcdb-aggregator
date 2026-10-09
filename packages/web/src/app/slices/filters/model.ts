/**
 * The two questions the dashboard asks about a filter list: which of its
 * predicates the catalog allows here, and whether it is the same list as
 * before.
 *
 * Both are asked of the top bar's own filters and of every cohort's, which is
 * why they are here rather than in either.
 */

import { isValidField,type Filter,type Modality,type View } from '@mriqc/shared';

/**
 * The bound a range control writes when the user left that end empty.
 *
 * A `Filter` has no one-sided variant and the server demands two finite bounds,
 * so an open end travels as a bound wide enough to admit everything. `±Infinity`
 * would not survive the URL (`JSON.stringify` writes it as `null`) and a bound
 * read out of the catalog would make the filter depend on which catalog was
 * loaded when it was typed. These two round-trip through the link, and
 * {@link formFromGlobal} reads them back as "empty", so clearing one end really
 * does reopen it.
 *
 * `2**52 - 0.5` rather than `Number.MAX_VALUE`, because the DuckDB binding
 * infers a parameter's type from the value: every double past `2**53` is
 * integral, so a huge bound would bind as BIGINT and fail with "bigint out of
 * int64 range". A deliberately fractional magnitude binds as DOUBLE, compares
 * correctly against both the DOUBLE and the BIGINT numeric columns, and is still
 * eleven orders of magnitude past anything these columns hold.
 */
export const OPEN_LO = -(2 ** 52) + 0.5;
export const OPEN_HI = 2 ** 52 - 0.5;

/** Keep only filters the catalog marks filterable for this modality and view. */
export function validFilters(filters: readonly Filter[], modality: Modality, view: View): readonly Filter[] {
  return filters.filter((f) => isValidField(modality, view, f.field, 'filter'));
}

/** Structural equality for a filter list, so an unchanged `setFilters` is a no-op. */
export function sameFilters(a: readonly Filter[], b: readonly Filter[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((filter, i) => {
    const other = b[i];
    if (filter.field !== other.field || filter.op !== other.op) return false;
    if (filter.op === 'in' && other.op === 'in') {
      return (
        filter.values.length === other.values.length &&
        filter.values.every((value, j) => value === other.values[j])
      );
    }
    if (filter.op === 'between' && other.op === 'between') {
      return filter.lo === other.lo && filter.hi === other.hi;
    }
    return true;
  });
}
