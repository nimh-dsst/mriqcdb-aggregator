/**
 * The `export` template text.
 *
 * A string constant rather than a file read at runtime: the browser's
 * DuckDB-WASM runner has no filesystem, and the point of keeping one source of
 * truth for the statistics SQL is that both runners compile the same text.
 * See `docs/backend-graph.md`, "Query templates and the filter compiler".
 */
export const EXPORT_SQL = `-- The same predicate and projection as \`sample\`, read as a streaming result.
--
-- The \`LIMIT\` is the row cap, not a page size: the handler streams whatever comes
-- back through an Arrow \`RecordBatchStreamWriter\` and nothing accumulates in
-- memory, but a request that would return more than the cap is truncated rather
-- than allowed to run the server out of time.

-- @statement rows
SELECT {{columns}}
FROM {{table}}
WHERE {{where}}
ORDER BY created_at DESC, id DESC
LIMIT CAST(? AS BIGINT)`;
