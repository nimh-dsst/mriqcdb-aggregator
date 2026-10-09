# mriqcdb-aggregator

pnpm workspace for the mriqcdb-aggregator rewrite: a DuckDB-backed tRPC server and an
Angular dashboard, sharing one TypeScript vocabulary package.

| package | name | what it is |
| --- | --- | --- |
| `packages/shared` | `@mriqc/shared` | plain TypeScript library (ESM, built with `tsc`) for types both sides agree on |
| `packages/server` | `@mriqc/server` | Node HTTP + tRPC server reading DuckDB |
| `packages/web` | `@mriqc/web` | Angular 22 app (standalone, zoneless), Tailwind 4 + Angular Material |

## Quick start on a Mac

Everything below runs in Terminal. The steps assume nothing is installed yet; skip any
you already have.

**1. Install Homebrew** (the Mac package manager), if `brew --version` says "command not
found":

```sh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Follow the two "Next steps" lines it prints at the end; they put `brew` on your `PATH`.

**2. Install git and pnpm.** pnpm fetches the right Node version for this project by
itself, so Node does not need installing separately.

```sh
brew install git pnpm
```

**3. Get the code** and switch to this branch:

```sh
git clone https://github.com/nimh-dsst/mriqcdb-aggregator.git
cd mriqcdb-aggregator
git checkout rewrite-usability
```

**4. Install and build** (a few minutes the first time):

```sh
pnpm install
pnpm -r build
```

**5a. Just look around, no database.** The dashboard has a built-in mock with about
780,000 made-up scans:

```sh
pnpm dev start web
```

Open **http://localhost:4300/?mock=1**. The numbers are invented; use it to try the
charts, not to read results.

**5b. Run it on real data.** Build a database, then start both servers. The small test
set in the repo (267 BOLD scans from June 2017) is enough to see everything work:

```sh
pnpm --filter @mriqc/server build:db -- --from-dumps packages/server/test/fixtures/dumps
pnpm dev start
```

Open **http://localhost:4300/?mock=0**. For the full data, point `--from-dumps` at the
MongoDB dump folder instead (see [Database](#database-build-the-database-first)).

**Stopping:** `pnpm dev stop`. **Updating later:** `git pull`, `pnpm install`,
`pnpm -r build`, then `pnpm dev restart`.

### Using the dashboard

- **Add panel** (bottom bar) asks once whether you want guidance. Guided mode starts from
  a question ("How does FD mean differ by manufacturer?") and sets the chart up for you;
  otherwise you pick the X and Y columns. A **Guided** checkbox at the top switches
  between the two.
- **Click a panel's title** (the pencil) to change its columns or to **compare**: split
  by a field such as manufacturer, compare saved groups, or build a custom split. The
  pencil after a panel's legend opens the same place.
- **Chart type, bins and cells** sit to the right of the legend. **Stats** shows the
  summary table.
- **Axes:** hover an axis and click **⋯**, or use the sliders icon → *Axes*, for log
  scales, count vs. share of each group, and a custom range.
- **Drag across a histogram** (or a rectangle on a heatmap) to filter every other panel
  to that range.
- **Filters** along the top apply to every panel. **Share this view** copies a link
  that reopens exactly what is on screen.

## Requirements

- Node **^22.22.3 || ^24.15.0 || >=26.0.0** (Angular 22's floor). The workspace pins a Node
  runtime through `devEngines.runtime` in the root `package.json`, so `pnpm install`
  downloads a matching Node and every `pnpm`-run command uses it even if the Node on your
  `PATH` is older.
- pnpm 12.6 (`corepack enable pnpm`).

## Install

```sh
pnpm install
```

## Build

```sh
pnpm -r build          # shared -> server -> web, in dependency order
pnpm --filter @mriqc/server build
pnpm --filter @mriqc/web build
```

## Run

The server and the web dev server run side by side; `ng serve` proxies `/trpc` to the API,
so the browser only ever talks to one origin. Run these from the repo root:

```sh
pnpm dev status                  # ports, PIDs, memory, health, and older stray Node processes
pnpm dev start                   # start both; or add api / web for one server
pnpm dev restart api --build     # rebuild and restart only the API
pnpm dev restart web --fresh     # clear Angular cache, then restart web
pnpm dev stop                    # stop both listening servers
pnpm dev kill-strays             # stop the unrelated Node processes shown by status
```

`start` refuses an occupied port; `restart` stops the listener before starting it.
`status` adopts any existing listener into its PID file and excludes that process and
its ancestors and descendants from strays; processes under 120 seconds old are also
excluded. Logs and PID files are in `.dev/`. Build the server before its first start with
`pnpm dev restart api --build`. Then open
**http://localhost:4300/** -- the dashboard opens five panels, fetches the catalog and
every panel's data through `/trpc`, and the status line in the top right shows the
server's `data_version` once everything has landed. A database has to exist first (see
below).

The web app only ever calls its own origin: `packages/web/proxy.conf.json` forwards
`/trpc` to `http://127.0.0.1:8787`, and in production the server serves the built
dashboard itself. Queries go out batched over `httpBatchLink` -- a fresh dashboard is one
request -- and the `dataVersion` subscription rides SSE through `httpSubscriptionLink`.

### Review sessions without Angular's dev server

The Angular dev server is optional for review sessions. Build the dashboard once,
then let the API serve it, including client routes such as `/about`, without
keeping a roughly 2GB `ng serve` process resident:

```sh
pnpm --filter @mriqc/web build
NODE_ENV=production pnpm --filter @mriqc/server start
```

Verified on port 8792 after a production web build: `curl /` and `curl /about`
both returned HTTP 200, `text/html`, and the same 18,650-byte application shell
(11ms and 7ms respectively). The temporary production process was then stopped.

Run from the repo root after building the server. Stop any API already using the
DuckDB file first; two writing processes cannot open it together. Production
deployments should also set `UV_THREADPOOL_SIZE` before starting Node (see
`docs/backend-graph.md`, Process and concurrency).

For live editing, `pnpm --filter @mriqc/web serve` runs Angular with Node's
`--max-old-space-size=1536` on Windows and POSIX, without `cross-env`. Add
`--port 4300` for the usual review port. Source maps remain enabled in development
and tests; the proposed prebundle exclusions and source-map removal were tested
and reverted because neither reduced measured RSS.

Fresh-process Angular measurements on 2026-10-08, port 4301, one Chromium page
load (`?mock=1`), using `wmic` WorkingSetSize for the `node … ng.js serve` PID:

| Change from original config | Cold startup (s) | RSS before page / after page (MiB) | HMR | Kept |
| --- | ---: | ---: | --- | --- |
| Baseline | 7.67 | 1322 / 1513 | yes | — |
| Exclude DuckDB-WASM, Arrow, Vega, Vega-Lite, Vega-Embed from prebundle | 8.62 | 1650 / 1969 | yes | no |
| Development source maps off, exclusions removed | 8.18 | 1538 / 2157 | yes | no |
| Same source-map setting, repeat | 7.71 | 1321 / 1555 | yes | no |
| 1536MiB heap cap, original source maps/prebundle | 8.16 | 1295 / 1425 | yes | yes |

Each run used a fresh process and browser profile, retaining the normal Angular
disk cache. A temporary dashboard template comment caused a WebSocket update and
Angular's “Component update sent” message in every run; the comment was removed
while preserving concurrent source edits. All benchmark dev servers and browsers
were stopped. The pre-existing 4300 server was left running. Single-run timings
and RSS vary with compilation/cache state; the heap limit is not a total RSS cap.

### Running without a server

`MockApi` answers every procedure from arithmetic, so the dashboard can be opened, tested
and screenshotted with nothing behind it. `environment.useMock` is the build-time default
(`false`), and either of these overrides it per browser:

```
http://localhost:4300/?mock=1     # mock; remembered in localStorage as mriqc.mock
http://localhost:4300/?mock=0     # back to the real server
localStorage.setItem('mriqc.mock', '1')
```

The dashboard's component test runs against `MockApi` unconditionally.

### Metric selections and time summaries

Every scoped procedure (`distribution`, `groupedSummary`, `coverage`, `sample`,
`density2d`, `correlation`, `timeSummary`) and `/export` accepts
`selections: [{ metric, range: [lo, hi] }]`: zero to four distinct metric IDs,
finite inclusive bounds, ANDed with each other and the ordinary filters.
The deprecated `selection` object still means a one-element list; null means no
selection. Supplying both a non-null alias and `selections` is rejected.
For export, JSON-encode the `selections` query parameter. Query keys sort ranges
by metric, so array order and the legacy alias do not cause duplicate datasets.

`timeSummary` accepts `modality`, `view`, `filters`, selections, `metric`, and
`granularity` (`day`, `week`, `month`, `year`), with optional `group` and inclusive
`window: [from, to]` ISO timestamps (a date-only bound means midnight). For example:

```json
{"modality":"bold","view":"k4plus","metric":"fd_mean","granularity":"month","group":"manufacturer","selections":[]}
```

The result is `{ buckets: [{ start, group, isOther, n, quantiles, mean, thin }] }`;
`quantiles` contains p05/p25/p50/p75/p95 over finite metric values. Undated rows
are excluded; empty buckets are omitted; occupied buckets with `n < 20` remain
and have `thin: true`. Ungrouped rows have `group: null`. Categorical groups are
capped at 50 across the filtered window, with remaining observations pooled
into `Other` before computing quantiles; `isOther` distinguishes that fold from
a category named Other. Retained missing groups read `Not reported`; they count
toward the same group cap. Numeric
group fields use ten equal-width bins over that same window's finite values.

The single-statement `time_summary` template is exported from shared for study
tables too. `TimeSummaryQuery` is exported separately and accepted by `queryKey`
so the current web's exhaustive `Query` dispatcher keeps compiling. Web wiring
for multiple brushes and median bands is a separate pass; this adds the API
without changing `packages/web`.

### Database: build the database first

Start with the MongoDB `mongoexport --jsonArray` files (including the August 2026
full dumps). From the repo root:

```sh
pnpm --filter @mriqc/server build:db -- --from-dumps data/dumps
pnpm --filter @mriqc/server build:db -- --from-dumps data/dumps --sample 20000 --out data/dev.duckdb --memory-limit 8GiB --threads 8
```

No existing database or Parquet files are needed. The build adopts unmanifested
`mriqc_api.<collection>[.<YYYYMMDDTHHMMSS>].json` files using the dump tool's
`--adopt` implementation, then loads every manifest entry through the existing
ingest pipeline. `packages/server/policies/columns.csv` supplies the frozen column
names, JSON paths, types and nullability. The build computes the canonical policies,
scanner catalog and metadata, and records fully consumed file hashes so a later
`ingest -- --dumps <absolute-dump-directory>` skips them. `--sample N` reads the first N documents
per collection across manifest entries; partially consumed files remain eligible
for a later full ingest. Dump builds require the workspace's `tools/mriqc-dump/`.

The output defaults to `data/mriqc.duckdb`. A temporary database replaces
the destination only after a successful build. While an API is using that file,
build to a separate `--out` path. `--from-dumps` cannot be combined with `--data-dir`
or `--canonical-from-parquet`.

If flattened Parquet dumps are available, the original path remains:

**The canonical tables are computed, not loaded.** The build applies each
canonicalization policy (`src/sql/canonical/`, frozen scales in `policies/`) to the raw
table it just loaded and materializes `canon_bold_k4plus`, `canon_t1w_k3pp` and
`canon_t2w_k3pp` from it, plus the membership tables and the
canonical-plus-quarantined views the third view per modality serves. That is where a full
Parquet build's time goes: about 2 minutes for the raw load and catalog tables, about 9 minutes
for the three policies, roughly 12 minutes end to end. The published canonical Parquet
artifacts are only a cross-check -- the build compares its admitted counts against their
row counts and warns if they differ -- and the build no longer needs them to be present.

```sh
pnpm --filter @mriqc/server build:db                    # full, ~4M raw rows, ~12 min
pnpm --filter @mriqc/server build:db -- --sample 20000  # first 20k rows per table, seconds
pnpm --filter @mriqc/server build:db -- --memory-limit 8GiB --threads 8
pnpm --filter @mriqc/server build:db -- --canonical-from-parquet   # load the artifacts instead
```

`--memory-limit` defaults to about 60% of what the OS reports free, so a build does not
push the machine into swap; `--canonical-from-parquet` is for comparing the computed
tables against the published ones, and a database built that way serves no
`+ quarantined raw` view.

Parquet sources come from `MRIQC_DATA_DIR` (or `--data-dir`). Check the frozen schema
against an unlocked Parquet-built database with
`pnpm --filter @mriqc/server check:columns -- --database <file>`; without that flag,
the check uses `DUCKDB_PATH` and skips if it is missing or locked.

### Keeping it up to date: ingest

`build:db` makes the file from JSON dumps or Parquet. **Ingest** adds records to an
existing file without rebuilding it, from either a directory of MongoDB dumps or
MongoDB itself. Design: `docs/backend-graph.md`, "Ingest from dumps" and
"Implementation notes: ingest".

The default, and the owner's preference, is that the server never connects to
MongoDB. `tools/mriqc-dump/` runs wherever Mongo is reachable, writes
`mriqc_api.<collection>.<YYYYMMDDTHHMMSS>.json` plus a `manifest.json`, and the
server ingests those files:

```sh
# On the loader host, or from cron (see tools/mriqc-dump/cron.example):
MRIQC_MONGO_URI=... node tools/mriqc-dump/bin/mriqc-dump.mjs --out /srv/mriqc/dumps
node tools/mriqc-dump/bin/mriqc-dump.mjs --out /srv/mriqc/dumps --dry-run  # print, change nothing
node tools/mriqc-dump/bin/mriqc-dump.mjs --out /srv/mriqc/dumps --adopt    # take existing dumps

# On the server host:
pnpm --filter @mriqc/server ingest -- --dumps /srv/mriqc/dumps
pnpm --filter @mriqc/server ingest -- --dumps /srv/mriqc/dumps --dry-run
pnpm --filter @mriqc/server ingest -- --source mongo      # needs MRIQC_MONGO_URI
```

A file whose sha256 is already in the database's `ingest_log` is skipped, so
re-running costs nothing. A record whose `id` is new is appended; a re-sent record
with a strictly newer `updated_at` replaces the old row. After the appends, in the
same transaction, the canonical tables of every modality that received rows are
recomputed from the policies; then `data_version` moves, the catalog cache is
dropped, the `dataVersion` subscription fires, and `snapshots/mriqc-<version>.duckdb`
is written with the oldest pruned to three. `--dry-run` measures all of that for
real and rolls back.

**The CLI needs the file to itself.** DuckDB allows one writing process, so stop
the server first, or let the server do it: with `INGEST_ENABLED=1` it ingests
nightly at `INGEST_HOUR` (default 03:00) in process, and logs the next run time
at startup.

A database built with `--canonical-from-parquet` cannot have its canonical tables
recomputed — there is no policy chain to re-run — and ingest says so rather than
serving stale ones.

```sh
pnpm --filter @mriqc/dump-tool test   # 20 tests, no MongoDB needed
```

Check the API directly:

```sh
curl http://127.0.0.1:8787/trpc/health
# {"result":{"data":{"ok":true,"duckdb":"v1.5.6","catalogVersion":"0.2.0"}}}

curl http://127.0.0.1:8787/trpc/catalog
curl -G http://127.0.0.1:8787/trpc/distribution \
  --data-urlencode '{"modality":"bold","view":"k4plus","metric":"fd_mean"}'

# Arrow IPC stream, not JSON
curl -o rows.arrow -G http://127.0.0.1:8787/export \
  --data-urlencode modality=bold --data-urlencode view=k4plus \
  --data-urlencode columns=id,fd_mean,manufacturer
```

### Paired analysis queries

`density2d` and `correlation` accept the same `modality`, `view`, `filters`, and
`selections` (or deprecated `selection`) as `distribution`, including the `_all`
views. A cohort is that same filter/range scope. Both use the read pool, one timeout budget per call, and
the usual data-version ETag and cache headers.

```sh
curl -G http://127.0.0.1:8787/trpc/density2d \
  --data-urlencode 'input={"modality":"bold","view":"k4plus","x":"fd_mean","y":"tsnr","bins":120,"sampleSize":2000,"seed":1}'

curl -G http://127.0.0.1:8787/trpc/correlation \
  --data-urlencode 'input={"modality":"bold","view":"k4plus","metrics":["fd_mean","fd_num","fd_perc","dummy_trs","tsnr"],"method":"both"}'
```

`density2d` returns finite-pair `n`, Pearson and Spearman coefficients, axis
`{lo, width, bins, underflow, overflow}` objects, a flat row-major count grid
(`counts[by * bins + bx]`), and `[x,y]` sample points. Bins default to 120
(10–200), samples to 2,000 (0–20,000), and seed to 1 (0–2,147,483,647).
`clip` is `p01p99` (default), `p05p95`, or `none`. Explicit
`range: {x: [lo,hi], y: [lo,hi]}` overrides clipping and keeps identical edges
across cohorts, even empty ones. Endpoints are inclusive. Points outside both
axes count on x first; y tails count only where x is in range, so the grid plus
the four tails sums to `n`. Constant axes have width zero and use bin zero.

`correlation` accepts 2–24 distinct metric ids and `method: 'pearson' |
'spearman' | 'both'` (default `both`), and returns matrices in input order,
`pairN`, and `minPairN`. Nonfinite values are removed pairwise. Ties receive
average ranks: density ranks within the finite pairs, while the matrix ranks
each metric over its own finite set before correlating available pairs.
Undefined coefficients (too few pairs or zero variance) are JSON `null`;
matrix coefficients are `NaN` for in-process callers.

The SQL lives as TypeScript constants in `packages/shared/src/sql/` for reuse
by DuckDB-WASM. Seeded reservoir sampling uses a sorted, single-stream input
for reproducibility without changing the database thread count. This materializes
the in-range pairs inside DuckDB; only the capped sample reaches the client.

### Configuration

| env var | default | meaning |
| --- | --- | --- |
| `DUCKDB_PATH` | `<repo>/data/mriqc.duckdb` | DuckDB database the server opens, and the file `build:db` writes. A relative value resolves against `packages/server/`. |
| `DUCKDB_MEMORY_LIMIT` | `1GB` | Global DuckDB buffer memory limit, applied before opening pooled connections; logged at startup. |
| `DUCKDB_THREADS` | `min(4, availableParallelism())` | DuckDB execution threads; separate from the read pool and libuv pool. |
| `DUCKDB_TEMP_DIR` | `tmp/` beside `DUCKDB_PATH` | Spill directory, created on instance open; explicit relative paths resolve against `packages/server/`. |
| `INGEST_MEMORY_LIMIT` | `4GB` | Temporary global limit under the writer mutex, set before BEGIN and restored to `DUCKDB_MEMORY_LIMIT` after COMMIT, dry-run ROLLBACK, or failure. Concurrent readers share the headroom. |
| `MRIQC_DATA_DIR` | `C:/Users/licc/projects/mriqc` | directory of the flattened MRIQC Parquet dumps `build:db` reads |
| `PORT` | `8787` | port the HTTP server listens on |
| `READ_POOL_SIZE` | CPUs, clamped to 2..16 | concurrent DuckDB read connections |
| `MRIQC_DUMP_DIR` | `<repo>/data/dumps` | directory of dump files plus `manifest.json` that ingest reads |
| `INGEST_SOURCE` | `dumps` | `dumps` or `mongo`; which source a bare `ingest` and the nightly schedule use |
| `MRIQC_MONGO_URI` | unset | MongoDB connection string. Environment only, never a file in the repo: it carries a credential |
| `MRIQC_MONGO_DB` | `mriqc_api` | database holding the four collections |
| `MONGO_BATCH_SIZE` | `5000` | records per staged page on the Mongo path |
| `INGEST_ENABLED` | `0` | `1` turns on the nightly in-process ingest; off in development |
| `INGEST_HOUR` | `3` | local hour the nightly ingest runs |
| `SNAPSHOT_DIR` | `snapshots/` beside `DUCKDB_PATH` | where the post-ingest research snapshots go |
| `SNAPSHOT_KEEP` | `3` | how many snapshots are kept |

```sh
DUCKDB_PATH=./data/mriqc.duckdb pnpm dev start api
```

The proxy target in `packages/web/proxy.conf.json` is hard-coded to
`http://127.0.0.1:8787`; change it there if you move `PORT`.

Memory limits accept positive numbers, optionally decimal, followed immediately
by `KB`, `MB`, `GB`, `GiB`, or `MiB` (for example `512MB` or `1.5GiB`).
The build CLI's `--memory-limit` and `--threads` still override the serving defaults
through `BuildOptions.settings`. The memory limit bounds DuckDB's buffer manager;
Node, Arrow and some query allocations can put process RSS above it
([DuckDB memory guidance](https://duckdb.org/docs/current/guides/performance/oom)).

### Server memory measurements

Windows, 2026-10-08, full `data/mriqc.duckdb` (2,850,041,856 bytes).
Each column starts a fresh API process on 8787 and warms the catalog before the
sequential HTTP workload. Cells show **milliseconds; RSS MiB before → after**,
measured using `tasklist` for the listening `node dist/index.js` PID. These are
single runs with the OS file cache retained, not peak-memory samples. The baseline
used the original build and DuckDB's default threads; capped runs use four threads.

| Call | (a) Original, no explicit limit | (b) 1GB | (c) 512MB |
| --- | ---: | ---: | ---: |
| Startup + catalog warm RSS | 2402 | 1092 | 632 |
| catalog | 19; 2402 → 2402 | 20; 1093 → 1093 | 11; 632 → 633 |
| distribution | 115; 2402 → 2404 | 94; 1093 → 1094 | 106; 633 → 636 |
| groupedSummary | 844; 2404 → 2434 | 695; 1094 → 1086 | 789; 636 → 420 |
| density2d | 1038; 2434 → 2267 | 698; 1086 → 1091 | 695; 420 → 551 |
| correlation | 1265; 2267 → 2422 | 620; 1091 → 773 | 623; 551 → 309 |
| timeSummary | 187; 2422 → 2429 | 91; 773 → 825 | 107; 309 → 363 |
| export | 475; 2429 → 2444 | 332; 825 → 851 | 334; 363 → 390 |

The distribution uses `bold/k4plus`, `fd_mean`; groupedSummary uses `T1w/raw`,
`cjv`, grouped by `manufacturer`. Remaining calls use `bold/k4plus`: density2d
is `fd_mean` × `tsnr` with default bins/sample/clip; correlation uses both methods
for the Motion family (`fd_mean`, `fd_num`, `fd_perc`, `dummy_trs`); timeSummary
uses `fd_mean`, monthly, by manufacturer. Export selects `fd_mean,tsnr` with
`manufacturer in ['GE']`; all 5,576,936 response bytes were read in every run.
All calls returned HTTP 200. No call exceeded 2× baseline latency, so no 2GB trial
was needed. The 1GB warm RSS was lower than the anticipated 1.2–1.4GB range.
The final default restart on 8787 (PID 13056) warmed the catalog in 8.703s,
passed the catalog HTTP health check, and used 1,081,968 KiB (1056.6 MiB) RSS
according to `tasklist`.

## Test

```sh
pnpm -r test                        # vitest everywhere
pnpm --filter @mriqc/server test    # tRPC caller tests, hits real DuckDB
pnpm --filter @mriqc/dump-tool test # the dump tool, against a stub mongoexport
pnpm --filter @mriqc/web test       # ng test, which runs vitest under the hood
```

`pnpm -r lint` type-checks `shared` and `server` with `tsc` (the server check covers its
tests and fixtures too); the Angular package is type-checked by its build.
