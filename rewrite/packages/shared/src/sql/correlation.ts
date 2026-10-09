/** One statement for every upper-triangle coefficient and finite-pair count. */
export const CORRELATION_SQL = `-- Generated fragments come from correlationFragments below, using only
-- validated metric expressions. Values in where remain positional parameters.
-- Each metric is nulled independently when nonfinite, preserving pairwise deletion.
-- Spearman ranks each metric over its OWN finite population (NULLS LAST), not
-- separately for each pair. Ties receive average ranks, then corr drops NULL pairs.

-- @statement matrix
WITH v AS (
  SELECT {{metric_columns}} FROM {{table}} WHERE {{where}}
), ranked AS (
  SELECT {{rank_columns}} FROM v
)
SELECT {{aggregates}} FROM ranked`;

/**
 * Shared by server and WASM runners. Expressions must already be allowlisted,
 * quoted, DOUBLE-cast columns; this function never accepts raw user identifiers.
 */
export function correlationFragments(
  expressions: readonly string[],
  method: 'pearson' | 'spearman' | 'both',
): Record<string, string> {
  const metric_columns = expressions.map((expr, i) =>
    `CASE WHEN isfinite(${expr}) THEN ${expr} END AS m${i}`,
  ).join(',\n');
  const ranks = expressions.map((_, i) =>
    `CASE WHEN m${i} IS NOT NULL THEN rank() OVER (ORDER BY m${i} NULLS LAST)` +
    ` + (count(*) OVER (PARTITION BY m${i}) - 1) / 2.0 END AS r${i}`,
  );
  const aggregates: string[] = [];
  for (let i = 0; i < expressions.length; i += 1) {
    for (let j = i; j < expressions.length; j += 1) {
      aggregates.push(`count(*) FILTER (WHERE m${i} IS NOT NULL AND m${j} IS NOT NULL) AS n${i}_${j}`);
      if (method !== 'spearman') aggregates.push(`corr(m${i}, m${j}) AS p${i}_${j}`);
      if (method !== 'pearson') aggregates.push(`corr(r${i}, r${j}) AS s${i}_${j}`);
    }
  }
  return {
    metric_columns,
    rank_columns: method === 'pearson' ? '*' : `*, ${ranks.join(',\n')}`,
    aggregates: aggregates.join(',\n'),
  };
}
