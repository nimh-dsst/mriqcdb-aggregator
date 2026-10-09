/**
 * The `sample` template text.
 *
 * A string constant rather than a file read at runtime: the browser's
 * DuckDB-WASM runner has no filesystem, and the point of keeping one source of
 * truth for the statistics SQL is that both runners compile the same text.
 * See `docs/backend-graph.md`, "Query templates and the filter compiler".
 */
export const SAMPLE_SQL = `-- One page of raw rows under the same predicate the charts use.
--
-- Pagination is a keyset on \`(created_at, id)\` descending, not an OFFSET: a page
-- costs the same however deep it is, and a concurrent insert cannot make a row
-- appear twice or be skipped. \`created_at\` must be present for a row to have a
-- place in that order, so rows without one are excluded.
--
-- Holes: {{columns}} an allowlisted, quoted projection that always includes
-- \`created_at\` and \`id\`, {{cursor}} either \`TRUE\` or the keyset predicate.
-- Parameters after the filter fragment: the cursor's, then the limit.
--
-- \`__created_us\` is the row's position in epoch microseconds. \`created_at\` is a
-- microsecond TIMESTAMP and a JS \`Date\` is only millisecond-resolved, so the
-- cursor is built from this column rather than from the converted timestamp.

-- @statement page
SELECT {{columns}},
  epoch_us(created_at) AS "__created_us"
FROM {{table}}
WHERE {{where}}
  AND created_at IS NOT NULL
  AND {{cursor}}
ORDER BY created_at DESC, id DESC
LIMIT CAST(? AS BIGINT)`;
