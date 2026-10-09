# rewrite/ — how to operate

pnpm workspace, three packages plus one tool: `packages/shared` (catalog, types,
query keys), `packages/server` (Node + tRPC + DuckDB), `packages/web`
(Angular 22), and `tools/mriqc-dump` (`@mriqc/dump-tool`, plain ESM, no build).
Design: `../docs/rewrite-architecture.md`, `../docs/dashboard-graph.md`,
`../docs/backend-graph.md`. Run instructions with ports and flags: `README.md`.
The frontend's module map and the URL format are in `dashboard-graph.md`,
"Implementation notes: the module map and the compact URL".

- Always run pnpm from `rewrite/`. pnpm provisions its own Node 24.21 via
  `devEngines` in `package.json` because Angular 22 refuses the host's Node 24.14.
  `pnpm exec node` is the right Node; bare `node` is the host one.
- Build / test / lint everything: `pnpm -r build`, `pnpm -r test`, `pnpm -r lint`
  (web and the dump tool have no lint script; the dump tool has no build script).
  Expected: shared 83, server 345 (+1 skipped), dump-tool 20, web 499 tests.
- The statistics SQL templates are string constants in `packages/shared/src/sql/`,
  not `.sql` files, because the browser's DuckDB-WASM runner compiles the same
  text (`../docs/backend-graph.md`, "Implementation notes: templates in shared").
  Only the canonicalization policy SQL is still a file, under
  `packages/server/src/sql/canonical/`, and `scripts/copy-sql.mjs` copies just that.
- A change to `packages/shared`'s public surface is **not** picked up by a
  running `ng serve`: the Angular compiler caches the dependency's `.d.ts` and
  Vite pre-bundles its JS. Rebuild shared, stop the dev server, delete
  `packages/web/.angular/cache`, and start it again.
- Database: `pnpm --filter @mriqc/server build:db` builds `data/mriqc.duckdb`
  from the Parquet dumps in `C:/Users/licc/projects/mriqc` (read-only source,
  override with `MRIQC_DATA_DIR`). The canonical tables are *computed* from the
  policies, which is most of the time: ~2 min raw load, ~4 min for the three
  policies. `-- --sample 20000` gives a fast dev database;
  `-- --memory-limit 8GiB` caps DuckDB (default ~60% of free RAM);
  `-- --canonical-from-parquet` loads the published artifacts instead and serves
  no `+ quarantined raw` view. A rebuild is picked up only on server restart.
- Ingest adds records to an existing database instead of rebuilding it:
  `pnpm --filter @mriqc/server ingest -- --dumps <dir> [--dry-run]`, or
  `-- --source mongo` with `MRIQC_MONGO_URI` set. The dump files come from
  `node tools/mriqc-dump/bin/mriqc-dump.mjs --out <dir>` (`--adopt` takes
  existing full dumps as first files, `--dry-run` prints the mongoexport lines).
  **The CLI needs the DuckDB file to itself** — DuckDB allows one writing
  process, so stop the server on 8787 first, or point `DUCKDB_PATH` at a copy.
  A running server ingests nightly itself with `INGEST_ENABLED=1` at
  `INGEST_HOUR` (default 3). A `--canonical-from-parquet` database cannot have
  its canonical tables recomputed and ingest says so. Design and the full config
  list: `../docs/backend-graph.md`, "Implementation notes: ingest", and
  `README.md`.
- `pnpm --filter @mriqc/server validate:canonical` builds its own throwaway
  database with `--canonical-from-parquet` and cannot be pointed at the serving
  one: its artifact side reads `canon_*`, which a normal build now computes.
- Server: `pnpm dev start api` (port 8787, `DUCKDB_PATH`
  defaults to `data/mriqc.duckdb`). It sets `UV_THREADPOOL_SIZE` in a bootstrap
  module; in production set it in the environment before Node starts.
- DuckDB defaults: `DUCKDB_MEMORY_LIMIT=1GB`, `DUCKDB_THREADS=min(4, CPUs)`, `DUCKDB_TEMP_DIR=<data dir>/tmp`; ingest uses `INGEST_MEMORY_LIMIT=4GB` until its transaction ends.
- Web: `pnpm dev start web` (port 4300) proxies `/trpc` and
  `/export` to 8787. `?mock=1` switches to the in-browser mock API.
- Dev processes: exactly ONE API (8787) and ONE Angular dev server (4300) per
  machine, shared by every agent and pass. Never start a second instance; check
  `netstat -ano | grep LISTENING | grep -E ":(8787|4300) "` first. Web edits
  are picked up by hot reload. After a server build or a database rebuild,
  restart only the API. After a change to `packages/shared` or `angular.json`,
  restart the dev server once with `pnpm dev restart web --fresh`. Use
  `pnpm dev status|start|stop|restart|kill-strays` (see `scripts/dev.mjs`, which adopts
  port listeners and protects their process trees) rather than ad-hoc `pnpm … start` / `ng serve` commands.
  Note that killing a wrapper shell does not kill its node child: always check
  the port, not the shell.
- IDE TypeScript errors under `rewrite/` are usually the editor's TS server not
  seeing the workspace `node_modules`; trust `pnpm -r build`.
- Review and verification of substantial changes: run `pnpm -r test`, then a
  Playwright pass against the real server (see README "End to end").
