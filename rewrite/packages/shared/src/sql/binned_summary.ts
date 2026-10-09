/**
 * SQL templates for summary plots that share the same axis and grouping rules.
 *
 * `buckets` bind parameters are ordered as follows: parameters in `{{where}}`,
 * then the lower axis bound, upper axis bound, and axis bin count.
 */
export const BINNED_SUMMARY_SQL = /* sql */ `
-- @statement stats
SELECT
  count(*) AS n,
  min({{x}}) AS min,
  max({{x}}) AS max,
  quantile_cont({{x}}, [.01, .05, .25, .5, .75, .95, .99]) AS quantiles
FROM {{table}}
WHERE isfinite({{x}})
  AND isfinite({{y}})
  AND ({{where}});

-- @statement buckets
WITH
  scoped AS (
    SELECT
      {{x}} AS axis_x,
      {{y}} AS y,
      {{group_expr}} AS g
    FROM {{table}}
    WHERE isfinite({{x}})
      AND isfinite({{y}})
      AND ({{where}})
  ),
  bounds AS (
    SELECT
      CAST(? AS DOUBLE) AS lo,
      CAST(? AS DOUBLE) AS hi,
      CAST(? AS INTEGER) AS bins
  ),
  base AS (
    SELECT
      {{bucket}} AS bucket,
      y,
      g
    FROM scoped
    CROSS JOIN bounds
    WHERE axis_x BETWEEN lo AND hi
  ),
  numeric_group_bounds AS (
    SELECT
      min(try_cast(g AS DOUBLE)) AS group_min,
      max(try_cast(g AS DOUBLE)) AS group_max
    FROM base
    WHERE {{group_numeric}}
      AND isfinite(try_cast(g AS DOUBLE))
  ),
  normalized AS (
    SELECT
      base.bucket,
      base.y,
      CASE
        WHEN {{group_numeric}} THEN
          CASE
            WHEN isfinite(try_cast(base.g AS DOUBLE))
              AND numeric_group_bounds.group_max > numeric_group_bounds.group_min
              THEN CAST(
                least(
                  {{group_bins}} - 1,
                  greatest(
                    0,
                    CAST(
                      floor(
                        ((try_cast(base.g AS DOUBLE) - numeric_group_bounds.group_min)
                          / (numeric_group_bounds.group_max - numeric_group_bounds.group_min))
                        * {{group_bins}}
                      ) AS INTEGER
                    )
                  )
                ) AS VARCHAR
              )
            WHEN isfinite(try_cast(base.g AS DOUBLE))
              THEN CAST(try_cast(base.g AS DOUBLE) AS VARCHAR)
            ELSE NULL
          END
        ELSE NULLIF(CAST(base.g AS VARCHAR), '')
      END AS value,
      CASE
        WHEN {{group_numeric}}
          AND isfinite(try_cast(base.g AS DOUBLE))
          AND numeric_group_bounds.group_max > numeric_group_bounds.group_min
          THEN numeric_group_bounds.group_min
        ELSE NULL
      END AS group_lo,
      CASE
        WHEN {{group_numeric}}
          AND isfinite(try_cast(base.g AS DOUBLE))
          AND numeric_group_bounds.group_max > numeric_group_bounds.group_min
          THEN (numeric_group_bounds.group_max - numeric_group_bounds.group_min)
            / {{group_bins}}
        ELSE NULL
      END AS group_width
    FROM base
    CROSS JOIN numeric_group_bounds
  ),
  group_counts AS (
    SELECT
      value,
      count(*) AS n
    FROM normalized
    GROUP BY value
  ),
  ranked AS (
    SELECT
      value,
      row_number() OVER (ORDER BY n DESC, value ASC NULLS LAST) AS rank
    FROM group_counts
  ),
  folded AS (
    SELECT
      normalized.bucket,
      normalized.y,
      CASE
        WHEN ranked.rank <= CAST({{max_groups}} AS INTEGER) THEN normalized.value
        ELSE NULL
      END AS value,
      ranked.rank > CAST({{max_groups}} AS INTEGER) AS is_other,
      CASE
        WHEN ranked.rank <= CAST({{max_groups}} AS INTEGER) THEN normalized.group_lo
        ELSE NULL
      END AS group_lo,
      CASE
        WHEN ranked.rank <= CAST({{max_groups}} AS INTEGER) THEN normalized.group_width
        ELSE NULL
      END AS group_width
    FROM normalized
    INNER JOIN ranked
      ON normalized.value IS NOT DISTINCT FROM ranked.value
  )
SELECT
  bucket,
  {{bucket_hi}} AS bucket_hi,
  count(*) AS n,
  quantile_cont(y, [.05, .25, .5, .75, .95]) AS qs,
  avg(y) AS mean,
  count(*) < 20 AS thin,
  value,
  is_other,
  group_lo,
  group_width
FROM folded
GROUP BY bucket, value, is_other, group_lo, group_width
ORDER BY bucket, is_other, value NULLS LAST;
`;
