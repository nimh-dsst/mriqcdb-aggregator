/**
 * The `distribution` template text.
 *
 * A string constant rather than a file read at runtime: the browser's
 * DuckDB-WASM runner has no filesystem, and the point of keeping one source of
 * truth for the statistics SQL is that both runners compile the same text.
 * See `docs/backend-graph.md`, "Query templates and the filter compiler".
 */
export const DISTRIBUTION_SQL = `-- Distribution of one metric: summary statistics and quantiles in one statement,
-- the equal-width histogram over the clipped range in a second, and the histogram
-- over an explicitly requested range in a third.
--
-- Holes: {{table}} from the view map, {{metric}} a catalog-validated, quoted and
-- DOUBLE-cast column, {{where}} the compiled filter fragment (always starts TRUE).
-- Every value is a positional parameter, in textual order.

-- @statement stats
WITH v AS (
  SELECT {{metric}} AS x
  FROM {{table}}
  WHERE isfinite({{metric}}) AND {{where}}
)
SELECT
  count(*)                                                   AS n,
  min(x)                                                     AS min,
  max(x)                                                     AS max,
  avg(x)                                                     AS mean,
  stddev_pop(x)                                              AS stddev,
  -- One aggregate for all seven quantiles: the reason a histogram panel and an
  -- ECDF panel of the same metric can share a single dataset entry.
  quantile_cont(x, [0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99]) AS quantiles
FROM v

-- @statement histogram
-- Parameters after the filter fragment: bins, lo, width, lo, hi.
WITH v AS (
  SELECT {{metric}} AS x
  FROM {{table}}
  WHERE isfinite({{metric}}) AND {{where}}
),
binned AS (
  SELECT greatest(
           0,
           least(
             CAST(? AS BIGINT) - 1,
             CAST(floor((x - CAST(? AS DOUBLE)) / CAST(? AS DOUBLE)) AS BIGINT)
           )
         ) AS bin
  FROM v
  WHERE x >= CAST(? AS DOUBLE) AND x <= CAST(? AS DOUBLE)
)
SELECT bin, count(*) AS n
FROM binned
GROUP BY bin
ORDER BY bin

-- @statement histogram_ranged
-- The histogram over an explicitly requested [lo, hi], which is what a comparison
-- panel asks for: two cohorts given the same range get the same bin edges, and
-- overlaid histograms over different edges would lie. Rows outside the range are
-- counted rather than dropped -- bin -1 below it, bin \`bins\` above it -- so the
-- bin counts plus the underflow plus the overflow still sum to n.
-- Parameters after the filter fragment: lo, hi, bins, bins, lo, width.
WITH v AS (
  SELECT {{metric}} AS x
  FROM {{table}}
  WHERE isfinite({{metric}}) AND {{where}}
),
binned AS (
  SELECT CASE
           WHEN x < CAST(? AS DOUBLE) THEN -1
           WHEN x > CAST(? AS DOUBLE) THEN CAST(? AS BIGINT)
           ELSE greatest(
                  0,
                  least(
                    CAST(? AS BIGINT) - 1,
                    CAST(floor((x - CAST(? AS DOUBLE)) / CAST(? AS DOUBLE)) AS BIGINT)
                  )
                )
         END AS bin
  FROM v
)
SELECT bin, count(*) AS n
FROM binned
GROUP BY bin
ORDER BY bin`;
