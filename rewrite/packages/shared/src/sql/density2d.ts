/** Shared SQL for paired statistics, a dense-grid input, and a reproducible sample. */
export const DENSITY2D_SQL = `-- x/y are catalog-resolved continuousAxisExpr expressions (either axis may be epoch days).
-- sample_size and seed are validated integer literals: DuckDB's SAMPLE grammar
-- does not accept bound parameters there. All other values are positional ?.

-- @statement stats
WITH v AS (
  SELECT {{x}} AS x, {{y}} AS y FROM {{table}}
  WHERE isfinite({{x}}) AND isfinite({{y}}) AND {{where}}
), ranked AS (
  SELECT *,
    rank() OVER (ORDER BY x) + (count(*) OVER (PARTITION BY x) - 1) / 2.0 AS rx,
    rank() OVER (ORDER BY y) + (count(*) OVER (PARTITION BY y) - 1) / 2.0 AS ry
  FROM v
)
SELECT count(*) AS n, corr(x, y) AS pearson, corr(rx, ry) AS spearman,
  min(x) AS x_min, max(x) AS x_max,
  quantile_cont(x, [0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99]) AS x_quantiles,
  min(y) AS y_min, max(y) AS y_max,
  quantile_cont(y, [0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99]) AS y_quantiles
FROM ranked

-- @statement histogram
-- Parameters after where: x lo, hi, bins, bins, lo, width; then the same for y.
-- Width zero is a constant axis: its in-range values go to bin zero.
WITH v AS (
  SELECT {{x}} AS x, {{y}} AS y FROM {{table}}
  WHERE isfinite({{x}}) AND isfinite({{y}}) AND {{where}}
), binned AS (
  SELECT
    CASE WHEN x < CAST(? AS DOUBLE) THEN -1
         WHEN x > CAST(? AS DOUBLE) THEN CAST(? AS INTEGER)
         ELSE greatest(0, least(CAST(? AS INTEGER) - 1,
           coalesce(CAST(floor((x - CAST(? AS DOUBLE)) / nullif(CAST(? AS DOUBLE), 0)) AS INTEGER), 0))) END AS bx,
    CASE WHEN y < CAST(? AS DOUBLE) THEN -1
         WHEN y > CAST(? AS DOUBLE) THEN CAST(? AS INTEGER)
         ELSE greatest(0, least(CAST(? AS INTEGER) - 1,
           coalesce(CAST(floor((y - CAST(? AS DOUBLE)) / nullif(CAST(? AS DOUBLE), 0)) AS INTEGER), 0))) END AS "by"
  FROM v
)
SELECT bx, "by", count(*) AS n FROM binned GROUP BY bx, "by"

-- @statement sample
-- Parameters after where: x lo, x hi, y lo, y hi.
-- A sorted list feeds UNNEST from a single aggregate row. The reservoir therefore
-- receives one deterministic stream even in a multithreaded read pool; ordinary
-- parallel table sampling with REPEATABLE alone is not reproducible in DuckDB.
WITH v AS (
  SELECT {{x}} AS x, {{y}} AS y FROM {{table}}
  WHERE isfinite({{x}}) AND isfinite({{y}}) AND {{where}}
), ordered AS (
  SELECT list(struct_pack(x := x, y := y) ORDER BY x, y) AS points FROM v
  WHERE x BETWEEN CAST(? AS DOUBLE) AND CAST(? AS DOUBLE)
    AND y BETWEEN CAST(? AS DOUBLE) AND CAST(? AS DOUBLE)
), expanded AS (
  SELECT unnest(points) AS point FROM ordered
), sampled AS (
  SELECT point.x AS x, point.y AS y FROM expanded
  USING SAMPLE reservoir({{sample_size}} ROWS) REPEATABLE ({{seed}})
)
SELECT x, y FROM sampled ORDER BY x, y`;
