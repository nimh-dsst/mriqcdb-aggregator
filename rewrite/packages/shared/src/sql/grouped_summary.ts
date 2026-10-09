/**
 * The `grouped_summary` template text.
 *
 * A string constant rather than a file read at runtime: the browser's
 * DuckDB-WASM runner has no filesystem, and the point of keeping one source of
 * truth for the statistics SQL is that both runners compile the same text.
 * See `docs/backend-graph.md`, "Query templates and the filter compiler".
 */
export const GROUPED_SUMMARY_SQL = `-- The distribution statistics of one metric, split by a group column.
--
-- Groups are ordered by row count and capped: everything past the cap folds into a
-- single \`other\` row, tagged by \`is_other\` rather than by a magic group value, so a
-- genuine NULL group stays distinguishable from the fold. The ranking is a window
-- over the rows themselves, which avoids a self-join on a nullable key.
--
-- Holes: {{table}}, {{metric}} (quoted, DOUBLE-cast), {{group_expr}} (a quoted
-- column or, for a numeric group field, a bin-label expression), {{where}}.

-- @statement group_range
-- Bounds of a numeric group column under the same predicate, so the bin edges are
-- computed from the filtered data rather than the whole table.
SELECT min({{group_expr}}) AS lo, max({{group_expr}}) AS hi
FROM {{table}}
WHERE isfinite({{metric}}) AND isfinite({{group_expr}}) AND {{where}}

-- @statement stats
-- Parameters after the group and filter fragments: cap, cap.
WITH v AS (
  SELECT {{group_expr}} AS g, {{metric}} AS x
  FROM {{table}}
  WHERE isfinite({{metric}}) AND {{where}}
),
counted AS (
  SELECT g, x, count(*) OVER (PARTITION BY g) AS cnt FROM v
),
tagged AS (
  SELECT g, x, dense_rank() OVER (ORDER BY cnt DESC, g NULLS LAST) AS rn FROM counted
)
SELECT
  rn > CAST(? AS BIGINT)                            AS is_other,
  CASE WHEN rn > CAST(? AS BIGINT) THEN NULL ELSE g END AS value,
  count(*)                                          AS n,
  min(x)                                            AS min,
  max(x)                                            AS max,
  avg(x)                                            AS mean,
  stddev_pop(x)                                     AS stddev,
  quantile_cont(x, [0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99]) AS quantiles
FROM tagged
GROUP BY 1, 2
ORDER BY 1, n DESC, 2 NULLS LAST

-- @statement histograms
-- One shared range for every group, so the panels are comparable.
-- Parameters after the group and filter fragments: cap, cap, bins, lo, width, lo, hi.
WITH v AS (
  SELECT {{group_expr}} AS g, {{metric}} AS x
  FROM {{table}}
  WHERE isfinite({{metric}}) AND {{where}}
),
counted AS (
  SELECT g, x, count(*) OVER (PARTITION BY g) AS cnt FROM v
),
tagged AS (
  SELECT g, x, dense_rank() OVER (ORDER BY cnt DESC, g NULLS LAST) AS rn FROM counted
),
binned AS (
  SELECT
    rn > CAST(? AS BIGINT)                            AS is_other,
    CASE WHEN rn > CAST(? AS BIGINT) THEN NULL ELSE g END AS value,
    greatest(
      0,
      least(
        CAST(? AS BIGINT) - 1,
        CAST(floor((x - CAST(? AS DOUBLE)) / CAST(? AS DOUBLE)) AS BIGINT)
      )
    ) AS bin
  FROM tagged
  WHERE x >= CAST(? AS DOUBLE) AND x <= CAST(? AS DOUBLE)
)
SELECT is_other, value, bin, count(*) AS n
FROM binned
GROUP BY 1, 2, 3
ORDER BY 1, 2 NULLS LAST, 3`;
