export const TIME_SUMMARY_SQL = `
-- @statement buckets
-- Rank groups over the filtered population, then fold before bucket quantiles.
WITH base AS (
  SELECT
    date_trunc({{granularity}}, created_at) AS bucket,
    {{metric}} AS x,
    {{group_expr}} AS g
  FROM {{table}}
  WHERE created_at IS NOT NULL
    AND isfinite(created_at)
    AND isfinite({{metric}})
    AND {{where}}
),
numeric_bounds AS (
  SELECT
    min(TRY_CAST(g AS DOUBLE)) FILTER (WHERE isfinite(TRY_CAST(g AS DOUBLE))) AS group_lo,
    max(TRY_CAST(g AS DOUBLE)) FILTER (WHERE isfinite(TRY_CAST(g AS DOUBLE))) AS group_hi
  FROM base
  WHERE {{group_numeric}}
),
normalized AS (
  SELECT
    base.bucket,
    base.x,
    CASE
      WHEN {{group_numeric}} THEN
        CASE
          WHEN isfinite(TRY_CAST(base.g AS DOUBLE)) THEN
            CASE
              -- A degenerate numeric domain keeps its numeric value as an identity key.
              WHEN numeric_bounds.group_hi = numeric_bounds.group_lo
                THEN CAST(TRY_CAST(base.g AS DOUBLE) AS VARCHAR)
              ELSE CAST(CAST(
                LEAST(
                  ({{group_bins}} - 1)::DOUBLE,
                  GREATEST(
                    0.0,
                    FLOOR(
                      ((TRY_CAST(base.g AS DOUBLE) - numeric_bounds.group_lo)
                        / (numeric_bounds.group_hi - numeric_bounds.group_lo))
                      * {{group_bins}}
                    )
                  )
                ) AS BIGINT
              ) AS VARCHAR)
            END
          ELSE NULL::VARCHAR
        END
      -- Empty categorical values share the NULL group.
      ELSE NULLIF(CAST(base.g AS VARCHAR), '')
    END AS value,
    CASE
      WHEN {{group_numeric}}
        AND numeric_bounds.group_hi > numeric_bounds.group_lo
        AND isfinite(TRY_CAST(base.g AS DOUBLE))
        THEN numeric_bounds.group_lo
      ELSE NULL::DOUBLE
    END AS group_lo,
    CASE
      WHEN {{group_numeric}}
        AND numeric_bounds.group_hi > numeric_bounds.group_lo
        AND isfinite(TRY_CAST(base.g AS DOUBLE))
        THEN (numeric_bounds.group_hi - numeric_bounds.group_lo) / {{group_bins}}
      ELSE NULL::DOUBLE
    END AS group_width
  FROM base
  CROSS JOIN numeric_bounds
),
group_counts AS (
  SELECT value, count(*) AS n
  FROM normalized
  GROUP BY value
),
ranked_groups AS (
  SELECT
    value,
    row_number() OVER (ORDER BY n DESC, value ASC NULLS LAST) AS group_rank
  FROM group_counts
),
folded AS (
  SELECT
    normalized.bucket,
    normalized.x,
    CASE
      WHEN ranked_groups.group_rank <= {{max_groups}} THEN normalized.value
      ELSE NULL::VARCHAR
    END AS value,
    ranked_groups.group_rank > {{max_groups}} AS is_other,
    CASE
      WHEN ranked_groups.group_rank <= {{max_groups}} THEN normalized.group_lo
      ELSE NULL::DOUBLE
    END AS group_lo,
    CASE
      WHEN ranked_groups.group_rank <= {{max_groups}} THEN normalized.group_width
      ELSE NULL::DOUBLE
    END AS group_width
  FROM normalized
  INNER JOIN ranked_groups
    ON normalized.value IS NOT DISTINCT FROM ranked_groups.value
)
SELECT
  bucket,
  value,
  is_other,
  count(*)::BIGINT AS n,
  quantile_cont(x, [0.05, 0.25, 0.50, 0.75, 0.95]) AS qs,
  avg(x) AS mean,
  count(*) < 20 AS thin,
  group_lo,
  group_width
FROM folded
GROUP BY bucket, value, is_other, group_lo, group_width
ORDER BY bucket ASC, is_other ASC, value ASC NULLS LAST;
`;
