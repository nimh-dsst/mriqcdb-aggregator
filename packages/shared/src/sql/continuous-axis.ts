import type { ColumnId, Granularity } from '../types.js';
import { quoteIdent, quoteLiteral } from './filters-core.js';

/** The runner must first resolve column from its population/study catalog. */
export function continuousAxisExpr(column: ColumnId, kind: 'metric' | 'time'): string {
  const identifier = quoteIdent(column);
  return kind === 'time'
    ? `CASE WHEN isfinite(${identifier}) THEN date_diff('day', DATE '2000-01-01', ${identifier}) END`
    : `CAST(${identifier} AS DOUBLE)`;
}

/** Shared bucket expressions keep native DuckDB and study WASM SQL identical. */
export function binnedSummaryFragments(bins: number | Granularity): { bucket: string; bucket_hi: string } {
  if (typeof bins === 'number') {
    if (!Number.isInteger(bins) || bins < 1 || bins > 200) throw new Error('invalid bin count');
    return {
      bucket: 'CASE WHEN hi > lo THEN least(bins - 1, greatest(0, CAST(floor(((axis_x - lo) / (hi - lo)) * bins) AS INTEGER))) ELSE 0 END',
      bucket_hi: 'NULL::DOUBLE',
    };
  }
  if (!['day', 'week', 'month', 'year'].includes(bins)) throw new Error('invalid granularity');
  return {
    bucket: `date_diff('day', DATE '2000-01-01', date_trunc(${quoteLiteral(bins)}, DATE '2000-01-01' + CAST(axis_x AS INTEGER)))`,
    bucket_hi: `date_diff('day', DATE '2000-01-01', DATE '2000-01-01' + CAST(bucket AS INTEGER) + INTERVAL '1 ${bins}')`,
  };
}
