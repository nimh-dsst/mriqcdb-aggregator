/**
 * The `coverage` template text.
 *
 * A string constant rather than a file read at runtime: the browser's
 * DuckDB-WASM runner has no filesystem, and the point of keeping one source of
 * truth for the statistics SQL is that both runners compile the same text.
 * See `docs/backend-graph.md`, "Query templates and the filter compiler".
 */
export const COVERAGE_SQL = `-- Upload coverage: row counts per time bucket per group value.
--
-- {{granularity}} is one of day, week, month or year, checked against that
-- allowlist and written as a literal; it is never user text. Rows with no
-- \`created_at\` cannot be placed on a time axis and are excluded here; the
-- procedure reports the null group value as \`(none)\`.

-- @statement group_range
-- Bounds of a numeric group column under the same predicate, for its bin edges.
SELECT min({{group_expr}}) AS lo, max({{group_expr}}) AS hi
FROM {{table}}
WHERE created_at IS NOT NULL AND isfinite({{group_expr}}) AND {{where}}

-- @statement buckets
SELECT
  date_trunc({{granularity}}, created_at) AS bucket,
  {{group_expr}}                          AS value,
  count(*)                                AS n
FROM {{table}}
WHERE created_at IS NOT NULL AND {{where}}
GROUP BY 1, 2
ORDER BY 1, 2 NULLS LAST`;
