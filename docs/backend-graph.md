# Backend Graph

Server-side design for the rewrite, at the same depth as `dashboard-graph.md`.
Drafted `2026-09-28`. Data facts come from the flattened dumps in the sibling
directory `../mriqc` (see "Source data" below); everything else is design.

## Source data

`../mriqc` holds MRIQC Web-API MongoDB dumps already flattened to Parquet with
DuckDB, plus canonical-policy outputs and a scanner catalog.

| File | Rows | What |
|---|---|---|
| `mriqc_api.bold.parquet` | 1,515,368 | raw BOLD observations, 121 columns |
| `mriqc_api.T1w.parquet` | 2,340,058 | raw T1w, 176 columns |
| `mriqc_api.T2w.parquet` | 238,441 | raw T2w, 124 columns |
| `mriqc_api.rating.parquet` | 4,281 | user ratings keyed by md5sum |
| `mriqc_api.bold.K4+.parquet` | 778,075 | one row per admitted K4+ group: the medoid representative's full record plus `canonical_*` columns |
| `mriqc_api.T1w.K3++.parquet` | 639,605 | same for T1w under K3++ |
| `mriqc_api.T2w.K3++.parquet` | 129,845 | same for T2w under K3++ |
| `mriqc_api.bold.K4+.scales.parquet` | 31 | frozen IQR table for K4+ continuous metrics |
| `scanners.parquet`, `mriqc_schemas.parquet`, `mriqc_schema_fields.parquet`, `schema_scanner.parquet` | 4,761 / 10 / 567 / 8,096 | scanner and schema catalog |

Facts that shape the schema:

- Columns use dot names verbatim: `bids_meta.EchoTime`, `provenance.version`,
  `provenance.settings.fd_thres`. `_created` and `_updated` are TIMESTAMP.
- Absent is NULL, computed NaN is NaN, and ±Infinity is ±Inf. All three occur.
  Every metric aggregation must filter with `isfinite(x)`.
- Types are inconsistent across modalities: counts are BIGINT in bold and T2w
  but DOUBLE in T1w; several `bids_meta` numerics likewise.
- Array-valued BIDS fields are VARCHAR holding JSON text. T1w has
  `bids_meta.ImageType` exploded into five columns and a two-row
  `bids_meta.Modality__altcase1` collision column.
- The canonical Parquet files contain representatives only. Rows that failed
  admission are absent, and there is no membership table linking a group to its
  raw rows. `canonical_group_rows` gives the group size. The K4+ and K3++
  computations are not reproducible from any script on disk; the Parquet files
  are the artifact.

## Serving schema

One DuckDB file, built from the Parquet directory by `build`. Column names are
normalized once at build time so no query ever quotes a dotted name.

Normalization: drop the `bids_meta.` prefix, replace remaining dots with `_`,
then snake_case. `bids_meta.EchoTime` becomes `echo_time`,
`provenance.settings.fd_thres` becomes `provenance_settings_fd_thres`,
`_created` becomes `created_at`. The build script keeps the mapping in a
`columns` table so the catalog can show source names. `Modality__altcase1` and
the exploded T1w `ImageType` columns are dropped; the T2w and bold `ImageType`
JSON text is kept as-is.

Types are unified across modalities at build time: counts to BIGINT, IQMs and
acquisition numerics to DOUBLE, `MagneticFieldStrength` to DOUBLE, booleans to
BOOLEAN. NaN and Inf are preserved, not nulled, so the raw tables stay
faithful; aggregation templates apply `isfinite`.

Tables:

| Table | Source | Notes |
|---|---|---|
| `raw_bold`, `raw_t1w`, `raw_t2w` | raw Parquet | immutable log; `_id` primary identity |
| `canon_bold_k4plus`, `canon_t1w_k3pp`, `canon_t2w_k3pp` | computed by the build from the policy views (see "Implementation notes: computed canonical tables") | same normalized columns plus `canonical_policy`, `canonical_group_rows`, `canonical_distinct_vectors`, `canonical_diameter`, `canonical_selection`, and for bold `canonical_hmc_mode` |
| `canonical_groups_<policy>`, `canonical_members_<policy>` | build | the groups aggregate and the admitted membership each policy was materialized through |
| `v_<policy>_quarantined_raw`, `v_<modality>_<view>_all` | build (views) | the raw rows the policy refused, and the canonical table unioned with them |
| `k4plus_scales` | scales Parquet | `metric, q25, q75, iqr` |
| `ratings` | rating Parquet | plus a view `ratings_by_md5` with count and mean |
| `scanners` | scanners Parquet | for filter value lists |
| `columns` | build | `modality, column, source_name, duck_type` |
| `meta` | build | single row: `data_version`, `built_at`, `source_manifest` JSON, `policies` JSON |

Views are the only names the procedures address. Each `(modality, view)` pair
maps through a fixed table in code, never through string input:

```
('bold','raw')    → raw_bold   ('bold','k4plus') → canon_bold_k4plus  ('bold','k4plus_all') → v_bold_k4plus_all
('T1w','raw')     → raw_t1w    ('T1w','k3pp')    → canon_t1w_k3pp     ('T1w','k3pp_all')    → v_t1w_k3pp_all
('T2w','raw')     → raw_t2w    ('T2w','k3pp')    → canon_t2w_k3pp     ('T2w','k3pp_all')    → v_t2w_k3pp_all
```

`data_version` is a hash of the source files' names, sizes, and modification
times plus the policy ids. It changes exactly when a rebuild changes what
queries would return. It is the ETag for every response and the version tag the
frontend stores on each dataset entry.

## Metric catalog

The catalog is the contract shared by SQL templates, tRPC procedures, and Vega
specs. It lives in `@mriqc/shared` as authored data and is completed at server
start with facts only the database knows.

Authored (`packages/shared/src/catalog/`):

```ts
interface MetricDef   { id: ColumnId; label: string; shortLabel?: string; family: string;
                        subfamily?: string; description?: string; unit?: string;
                        higherIsBetter?: boolean | null; source?: 'mriqc-docs' | 'authored';
                        docsUrl?: string; modalities: Modality[];
                        clipDefault: 'p01p99' | 'p05p95' | 'none'; logScale?: boolean }
interface FieldDef    { id: ColumnId; label: string; kind: 'categorical' | 'date' | 'numeric';
                        modalities: Modality[]; filterable: boolean; groupable: boolean;
                        exportable: boolean }
interface ViewDef     { id: View; label: string; modalities: Modality[]; policy?: string }
```

Metric ids and field ids are normalized column names. The authored file is
seeded from the old frontend's metric catalog (families and subfamilies) and
from the columns the old API exposed as filters and top-value fields, then
extended with the acquisition fields the data-overview note asked for:
manufacturer, model, field strength, MRIQC version, task, HMC mode for bold,
institution, protocol name, and `echo_time`, `repetition_time`, `spacing_*` as
numeric groupables via binning.

`description`, `unit`, `higherIsBetter` and `docsUrl` are paraphrased from
MRIQC's own IQM pages -- `iqms/t1w.html` for the structural metrics (T1w and
T2w share one set) and `iqms/bold.html` for the functional ones -- and
`docsUrl` deep-links to the section each one paraphrases, which is what the
UI's info popover offers as "read more". `higherIsBetter` is paired with
`directionSource` so the UI never passes a convention off as documentation:
`mriqc-docs` for the 18 metrics whose IQM section states the direction in
words, `convention` for the 19 the field agrees on but the docs only describe
(head motion, SNR, DVARS, ghosting, AFNI's outlier ratio, GCOR). It is `null`,
with no `directionSource` at all, wherever neither applies -- including where
the docs name a target interval instead of a direction (`wm2max` around
0.6-0.8, `icvs_*` "within a normative range") and for the descriptive
`summary_*` statistics. The `size_*` and `spacing_*` columns
are image-header geometry, not IQMs, so they are the only entries marked
`source: 'authored'` and the only ones whose `docsUrl` carries no anchor.

Completed at start (`catalog` procedure output):

- for each categorical filterable field, the distinct values with counts per
  modality and view, capped at 200 values ordered by count;
- for the date field, min and max `created_at` per modality;
- for each metric, the finite-value count per modality and view, so the UI can
  grey out metrics that are empty for a policy;
- the available views per modality, from `meta.policies`;
- `data_version`.

The completed catalog is computed once per `data_version` and cached in
memory. It is the first thing the frontend requests and the only response the
server caches.

## Query templates and the filter compiler

Every procedure is one SQL template with three kinds of holes: the target
table, which comes from the view map; column identifiers, which must be ids the
catalog marks as valid for the role (metric, group, filter, export) and are
quoted as identifiers; and values, which are bound as positional parameters.
No user-supplied string is ever interpolated.

Filter compiler contract:

```ts
type Filter =
  | { field: ColumnId; op: 'in';      values: (string | number | boolean)[] }
  | { field: ColumnId; op: 'between'; lo: number | string; hi: number | string }  // numeric or date
  | { field: ColumnId; op: 'isNull' | 'notNull' };

compileFilters(filters: Filter[], selections: readonly Selection[], modality, view, catalog): { where: string; params: unknown[] }
```

The compiler rejects any field not `filterable` for the modality, any `in` list
over 500 values, and any `between` on a categorical field. `selections` holds
zero to four entries with distinct metric IDs and finite, ordered inclusive
ranges. Each compiles to `isfinite(metric) AND metric BETWEEN ? AND ?`; all
ranges are ANDed with the ordinary filters. Filter parameters precede range
parameters in input order. The deprecated `selection` object maps to a singleton
list (null means none); supplying both a non-null alias and `selections` is
rejected. Query keys sort selections by metric and normalize the alias. The
positional compiler still accepts a scalar for existing study callers. The output is
appended to each template's `WHERE` clause, which always begins with `TRUE` so
the fragment can be empty.

Templates are string constants under `packages/shared/src/sql/`, registered in
`SQL_TEMPLATES`; the names below identify their logical SQL templates:

| Template | Shape |
|---|---|
| `distribution.sql` | `WITH v AS (SELECT metric FROM table WHERE isfinite(metric) AND <filters>) SELECT count(*), min, max, avg, stddev_pop, quantile_cont(metric, [0.01,0.05,0.25,0.5,0.75,0.95,0.99]) …` plus a second statement for the equal-width histogram over the clipped range: `floor((x - lo) / width)` bucketed, bins bounded 1 to 200 |
| `grouped_summary.sql` | same statistics `GROUP BY group_col`, groups ordered by count, capped at 50 groups with the remainder folded into `other`; for numeric group fields the group is a bin label |
| `coverage.sql` | `date_trunc(granularity, created_at)` by group value, counts, granularity in day, week, month, year |
| `time_summary.sql` | one statement: finite metric values grouped by `date_trunc` and optional capped group, `quantile_cont(metric, [0.05,0.25,0.5,0.75,0.95])`, count, mean, `thin = n < 20`; numeric bounds and the Other fold are CTEs |
| `sample.sql` | allowlisted columns, `WHERE <filters> AND (created_at, _id) < (?, ?)` keyset cursor, `ORDER BY created_at DESC, _id DESC LIMIT ?`, limit capped at 500 |
| `export.sql` | same predicate and columns as sample, no limit, read as a streaming result |

`distribution` returns quantiles and the histogram from one round trip so a
histogram panel and an ECDF panel of the same metric share one dataset entry.
`quantile_cont` over a list returns all quantiles in one aggregate, which is
why DuckDB makes this cheap.

## Procedures

tRPC router in `packages/server/src/trpc/router.ts`. Every input is a zod
schema built from the catalog's ids, so an unknown metric fails validation
before any SQL is built.

| Procedure | Kind | Input | Output |
|---|---|---|---|
| `catalog` | query | none | completed catalog |
| `distribution` | query | modality, view, filters, selections, metric, bins, clip | `{ n, min, max, mean, stddev, quantiles, histogram: { lo, hi, width, counts[] } }` |
| `density2d` | query | modality, view, filters, selections, x, y, bins, clip, optional range `{x: [lo,hi], y: [lo,hi]}`, sampleSize, seed | `{ x: {lo, width, bins, underflow, overflow}, y: {…}, counts: number[], n, pearson, spearman, sample: [number,number][] }` |
| `correlation` | query | modality, view, filters, selections, metrics (2–24 distinct ids), method (`pearson`, `spearman`, `both`) | `{ metrics, pearson?, spearman?, pairN, minPairN }`, square matrices in input order |
| `groupedSummary` | query | modality, view, filters, selections, metric, group | `{ groups: [{ value, n, quantiles, mean, stddev, histogram }], other?: {…} }` |
| `coverage` | query | modality, view, filters, selections, group, granularity | `{ buckets: [{ start, group, n }] }` |
| `sample` | query | modality, view, filters, selections, columns, cursor, limit | `{ rows, nextCursor }` |
| `timeSummary` | query | modality, view, filters, selections, metric, granularity, optional group, optional inclusive window `[from,to]` | `{ buckets: [{ start, group, isOther, n, quantiles: {p05,p25,p50,p75,p95}, mean, thin }] }` |
| `dataVersion` | subscription | none | emits current version on connect and on every change |

All scoped procedures accept the deprecated `selection` alias described above.

Export is not a tRPC procedure. It is `GET /export?modality&view&filters&selections&columns`
on the same server, validated by the same zod schemas (`trpc/inputs.ts`, shared
with the procedures), returning `application/vnd.apache.arrow.stream`. The
`selections` query parameter is a JSON array; the JSON `selection` alias remains
accepted with the same conflict, count, uniqueness and range checks. The
handler streams DuckDB result chunks through an Arrow
`RecordBatchStreamWriter`, so nothing accumulates in memory: the writer's bytes
go to the socket a batch at a time and the loop waits for `drain`, so a slow
client throttles DuckDB rather than buffering ahead of it, and a client that
disconnects stops the loop and interrupts the connection.
Row cap 2,000,000 and a 120 s query timeout; nginx rate-limits the route.

Every response carries `ETag: "<data_version>"` (quoted, as RFC 9110 requires) and
`Cache-Control: public, max-age=60`. The frontend does not use HTTP caching, it
has the datasets map, but nginx and browsers can.

## Process and concurrency

- The serving instance sets global `memory_limit` (`DUCKDB_MEMORY_LIMIT`, default
  `1GB`), `threads` (`DUCKDB_THREADS`, default `min(4, availableParallelism())`),
  and `temp_directory` (`DUCKDB_TEMP_DIR`, default `<data dir>/tmp`) before any
  pooled connection opens, and logs their effective values. The spill directory
  is created on open. Limits accept positive decimal values with KB, MB, GB,
  GiB, or MiB units. DuckDB pages database blocks from disk and spills supported
  operators; the buffer limit is not a hard process RSS limit.
- Ingest holds the writer mutex while setting `INGEST_MEMORY_LIMIT` (default
  `4GB`) before BEGIN, then restores the exact configured serving limit after
  COMMIT or ROLLBACK, including dry runs and failures. Concurrent readers share
  this temporary global headroom. Build CLI settings still override the serving
  defaults through `BuildOptions.settings`, preserving `--memory-limit`.
- Full-file measurements and request details are in `rewrite/README.md`,
  Server memory measurements: warm RSS was 2402 MiB without an explicit limit,
  1092 MiB at 1GB, and 632 MiB at 512MB; all seven requests completed without
  a greater-than-2x slowdown (Windows, 2026-10-08, single runs).

- One `DuckDBInstance` per process opened on `DUCKDB_PATH`. A small pool of
  read connections, size equal to available CPUs, serves procedures. Reads are
  concurrent.
- Every DuckDB call runs as a `Napi::AsyncWorker` on libuv's threadpool, so that
  threadpool, not the pool size, is the real ceiling on concurrent statements —
  and it is shared with `fs` and DNS, so saturating it stalls static files and
  health checks too. **`UV_THREADPOOL_SIZE` must be set in the environment that
  starts the process** (systemd unit, container env, shell), because libuv reads
  it once, when its threadpool is first used. `src/bootstrap.ts`, imported first
  by `index.ts` and `build-cli.ts`, sets it to `READ_POOL_SIZE + 4` when the
  environment left it unset; that is a development fallback, not a guarantee. The
  read pool is capped at `UV_THREADPOOL_SIZE - 2` so pooled reads cannot starve
  the rest of the process.
- The read pool's wait queue is bounded (`POOL_QUEUE_LIMIT`, default 64) with an
  acquire deadline (`POOL_ACQUIRE_TIMEOUT_MS`, default 10 s); past either, a
  procedure answers `TOO_MANY_REQUESTS` rather than queueing without end. Waiting
  counts against the query budget, and a procedure's abort signal removes its
  waiter and interrupts its running statement.
- A single writer connection is reserved for ingest. Ingest takes an in-process
  mutex, runs inside one transaction, and commits. DuckDB's MVCC means readers
  on other connections keep the pre-commit snapshot until it lands; there is no
  moment where a reader sees a half-loaded table.
- After commit, ingest updates `meta.data_version`, invalidates the catalog
  cache, and emits on an in-process event. The `dataVersion` subscription is an
  async generator over that event. That is the entire mechanism by which the
  frontend learns to refetch.
- Query timeouts use DuckDB's `interrupt` on the connection after 30 s for
  procedures. A timed-out query returns a tRPC `TIMEOUT` error and the frontend
  records it as a failed entry. The budget is per *procedure*, not per statement:
  a procedure that issues two or three statements runs them on one connection
  inside one `withRead`. Interrupting is not a single call — DuckDB clears the
  interrupt flag when a later phase begins — so the call is raced against a
  rejecting timer and the interrupt is re-issued until the native call returns.
  The connection goes back to the pool only then.
- The server process is the only process that opens the file. Research access
  is a snapshot: after each ingest, `COPY DATABASE` to
  `snapshots/mriqc-<data_version>.duckdb`, keeping the last three.

## Ingest

Out of scope for the first build except for `build`, which is also the shape
ingest will take:

1. `build` reads the Parquet directory named by `MRIQC_DATA_DIR`, creates the
   tables above in a fresh file at `DUCKDB_PATH`, writes `meta`, and exits. It
   is idempotent and takes minutes, not hours, for the full 4M rows. It writes a
   temporary file beside the destination and renames it over the target, and it
   removes every `<DUCKDB_PATH>.building-*` left by an earlier run, including its
   own on the failure path.
   **The server must be restarted after a build.** The rename leaves the running
   process reading the unlinked old file, and nothing in the query path watches
   the file or re-reads `meta`, so `data_version` would never move and the
   dashboard would never be told to refetch. (`refreshDataVersion` exists for the
   in-process ingest that will replace this; it has no caller yet.)
2. Ingest later becomes: pull new records from Mongo since `meta.last_pull`,
   append to raw tables, recompute canonical tables for the affected modality
   under the policy version, in one transaction, then bump `data_version`.
   Nothing in the query path changes.

## Ingest from dumps (decided 2026-10-08)

The owner's preference: the server never connects to MongoDB. A cron-able dump
tool produces files; the server ingests files.

**Dump tool** `tools/mriqc-dump/` (Node, runs anywhere Mongo is reachable):
`mriqc-dump --uri $MRIQC_MONGO_URI --out <dir> [--since <iso>]`. For each
collection (`T1w`, `T2w`, `bold`, `rating`) it runs `mongoexport --jsonArray`
with a `_updated` greater-than filter taken from the directory's manifest
(default: everything), writing `mriqc_api.<collection>.<YYYYMMDDTHHMMSS>.json`
in the same MongoDB extended-JSON shape as the existing full dumps, and
updates `manifest.json` (file, collection, record count, max `_updated`,
sha256). A `cron.example` runs it nightly. The existing full dumps in
`../mriqc` are valid first files.

**Ingest job** in the server (`src/ingest/`):
- `pnpm --filter @mriqc/server ingest -- --dumps <dir>` and a nightly in-process
  schedule (default 03:00, `INGEST_ENABLED=1` to turn on; off in dev) that
  calls the same function.
- Reads the manifest, skips files already in the `ingest_log` table (by sha256),
  and for each new file: `read_json` into a staging relation, flatten with the
  same rules the Parquet conversion used (dot names, extended-JSON scalars,
  NaN/Inf preserved), `normalizeColumnName`, vendor normalization, type
  unification; upsert into the raw table by `id` (a re-sent record with a newer
  `updated_at` replaces the old row; raw stays one row per observation).
- Recomputes the canonical tables of every modality that received rows, under
  the frozen scale tables, via the existing policy views, with
  `CREATE OR REPLACE TABLE` in the same transaction as the appends.
- Commits, bumps `data_version` (now also hashing the ingest_log), invalidates
  the catalog cache, emits the version event, writes
  `snapshots/mriqc-<version>.duckdb` keeping the last three, and appends to
  `ingest_log` (file, sha256, collection, rows appended, rows replaced,
  canonical counts before and after, duration).
- Dry-run mode prints what would change. Ratings are ingested into `ratings`.

## Implementation notes: ingest (2026-10-08)

Implemented in `rewrite/packages/server/src/ingest/` and `rewrite/tools/mriqc-dump/`.
Where the code departs from the text above, the code is current.

**Two sources, one job.** The owner added a direct-MongoDB source behind the same
function, chosen by `INGEST_SOURCE` (`dumps`, the default, or `mongo`).
`ingest/sources.ts` defines `IngestSource` and three implementations:
`DumpDirSource` (manifest plus files), `MongoSource` (the official `mongodb`
driver, `MRIQC_MONGO_URI` **from the environment only**, each collection paged by
`_updated` in batches of `MONGO_BATCH_SIZE`, default 5 000), and `RecordsSource`,
an in-memory source the tests use to prove the two agree. Every source yields
`IngestUnit`s carrying records in the same extended-JSON shape; a unit either
names a JSON file DuckDB reads directly or carries records that `ingest()` spills
to a temporary `--jsonArray` file. So staging, normalization, upsert, canonical
recompute, version bump, snapshot and `ingest_log` are written and tested once.
`ingest-cli` takes `--source dumps|mongo`, `--dumps <dir>`, `--dry-run`,
`--no-verify` and `--no-snapshot`.

- The Mongo filter is `_updated >= watermark`, not `>`: `>` would silently drop a
  record whose `_updated` ties the highest one already ingested. Re-reading the
  boundary record costs nothing, because the upsert only replaces a row when the
  incoming `updated_at` is strictly newer.
- A Mongo `ingest_log` row records the collection, the `_updated` window and the
  record count; `file` and `sha256` are NULL, since a watermark source has no
  file to skip on.
- `MongoSource` loads the driver through a dynamic `import`, so the default dump
  path does not pay for it, and takes `EJSON` from the driver's own re-export
  rather than reaching into `bson`.

**Staging is three relations, not one expression.** `ingest/flatten.ts` reads one
JSON value per record (`read_json_objects(..., format='array')`) and then
(1) extracts each dotted source path as JSON, (2) unwraps each to its scalar
text, (3) casts each to the type the serving table already has. Spelling the
unwrap once per column rather than nesting it inside a cast inside a `CASE` is
what keeps T1w's 176 columns to a readable amount of SQL. The flatten rules are
`../mriqc/KEY.md`'s and `convert_T1w.sql`'s: `$oid`/`$date`/`$numberDouble|Int|
Long|Decimal` unwrapped, NaN and ±Infinity preserved as IEEE values, a genuine
array or object kept as its JSON text verbatim, an absent or JSON-null key as
SQL NULL.

**The column set comes from the database, not from discovery.** The targets are
the serving table's own `DESCRIBE` joined to the `columns` table's `source_name`,
so ingest inherits the build's type unification instead of re-deriving it, and a
field a dump carries that the table has no column for is ignored rather than
silently added. A raw column with no `columns` row is an error naming `build:db`.
Step 3 then leaves the staged relation at the serving types, so `db/build.ts`'s
own exported `projection()` runs over it as a pure rename plus the vendor
rewrite — which is how "byte-identical to the Parquet path" is achieved rather
than approximated. `ingest.test.ts` asserts it on all 3000 rows of the fixture's
`raw_t2w`, read back out, re-expressed as a dump and ingested: every column but
`updated_at` comes back equal, NaN, +Inf, NULL and the three misspelled vendors
included.

- The integer cast has two routes, because DuckDB's two disagree:
  `'1000.5'::BIGINT` rounds to 1001 while `1000.5::DOUBLE::BIGINT` truncates to
  1000. Integral text takes the direct route, keeping full 64-bit precision;
  anything else goes through DOUBLE, which is the route the Parquet load takes.
- The vendor `CASE` is generated from the distinct values the *unit* carries,
  exactly as the build generates it from a Parquet file's distinct values, so
  `db/vendors.ts` stays the only implementation of the rule.

**The upsert.** Staged rows are deduplicated by `id` keeping the newest
`updated_at` — an overlapping export window or a page re-read from its watermark
can carry one `_id` twice, and inserting both would break raw's
one-row-per-observation invariant before any policy saw it. A row whose `id` is
new is appended; a row whose `id` is present is replaced only when its
`updated_at` is strictly newer, which is what makes a re-sent record a no-op.

**`data_version` is derived, not chained.** `meta` gains `base_data_version`
(added by `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` on first ingest, so an
existing database needs no rebuild) holding the version the build wrote. The live
version is `sha256(base + the ingest_log rows that changed a table)`. Rows that
changed nothing are left out deliberately: a nightly pull that re-reads the
boundary record, or a new file holding only records the database already has, must
not move the ETag and invalidate every cached answer. So ingesting a file that
appends and replaces nothing is logged and leaves `data_version` alone.

**Transaction boundaries.** Everything — the `ingest_log` and `base_data_version`
schema creation included — is inside one `BEGIN`/`COMMIT` on the single writer, so
`--dry-run` rolls back to exactly the file it found, including not creating the log
table. The snapshot is the one step outside: `COPY FROM DATABASE` needs an
`ATTACH`, which DuckDB refuses inside a transaction, and the catalog name is read
from `current_database()` rather than derived from the file name because DuckDB
sanitizes it (`main.duckdb` attaches as `main_db`). Snapshots are pruned to the
newest `SNAPSHOT_KEEP` (default three) by modification time.

**A `--canonical-from-parquet` database declines the recompute.** Its canonical
tables were loaded, not computed, so there is no policy view chain to re-run;
ingest logs that and reports the counts unchanged rather than failing or quietly
serving stale canonical tables. `meta.policies.canonicalSource` is what it reads.

**Dry run** measures rather than guesses: it stages and upserts for real, reports
the appended/replaced/unchanged counts, then rolls back. It skips the canonical
recompute, which on the full corpus costs minutes a dry run has no use for, and
says which policies it *would* have recomputed.

**Schedule.** `ingest/schedule.ts` is a `setTimeout` chain at `INGEST_HOUR`
(default 3, local) started by `index.ts` and stopped by `shutdownServer`. It logs
the next run time, or logs that it is off when `INGEST_ENABLED` is not `1`. The
next run is computed from the calendar date rather than by adding 24 hours, so it
stays at 03:00 across a daylight-saving boundary; a failed run retries in an hour
rather than taking the schedule with it. A timer rather than cron because ingest
takes the in-process writer mutex, and a second process opening the same DuckDB
file for writing is what DuckDB refuses — which is also why the CLI must not be
run against a file a server is serving.

**Config.** `MRIQC_DUMP_DIR` (default `rewrite/data/dumps`), `INGEST_SOURCE`,
`MRIQC_MONGO_URI`, `MRIQC_MONGO_DB` (default `mriqc_api`), `MONGO_BATCH_SIZE`,
`INGEST_ENABLED`, `INGEST_HOUR`, `SNAPSHOT_DIR` (default beside `DUCKDB_PATH`),
`SNAPSHOT_KEEP`.

**The dump tool** gained `--adopt`, which takes the dump files already in a
directory into the manifest without running `mongoexport` — that is what makes
"the existing full dumps in `../mriqc` are valid first files" true in practice.
An export that returns no records is removed rather than recorded. The manifest is
written after each collection and through a rename, and every printed line has the
URI's credential redacted. The tool needs no MongoDB to test: a stub
`mongoexport` covers the command construction, naming, watermark and summary.
Whether the **real** `mongoexport` accepts these flags is the one claim no test
here can make.

**Verified.** 58 new server tests (345 total, plus one skipped Mongo-driver test
that runs only when `MRIQC_MONGO_URI` is set) and 20 dump-tool tests. A real
smoke: a `--sample 20000` build, then two slices of
`C:/Users/licc/projects/mriqc/mriqc_api.T2w.json` — records 20 001–22 000 (all
new) and records 1–500 with `_updated` moved on a day (all re-sends) — ingested in
11.7 s: 2 000 appended, 500 replaced, `raw_t2w` 20 000 → 22 000,
`canon_t2w_k3pp` 13 782 → 15 020, 101 quarantined groups, snapshot written; the
second run skipped both files by sha256 in 0.1 s and left `data_version` alone.

## Package layout

```
packages/server/src/
  index.ts            http server: /trpc, /export, static web in production
  config.ts           env: DUCKDB_PATH, MRIQC_DATA_DIR, PORT
  db/instance.ts      instance, read pool, writer, mutex
  db/build.ts         Parquet → DuckDB file, normalization, meta
  db/views.ts         (modality, view) → table map
  catalog/complete.ts authored catalog + database facts, cached per data_version
  sql/canonical/*.sql canonicalization policy SQL (the statistics templates are
                      string constants in @mriqc/shared; see the implementation note)
  sql/filters.ts      filter compiler, catalog side over shared's pure core
  sql/run.ts          template lookup, identifier quoting, parameter binding, timeout
  trpc/router.ts      procedures and zod inputs
  trpc/context.ts
  export/arrow.ts     streaming export handler
  ingest/version.ts   data_version, event, subscription source
  ingest/flatten.ts   extended JSON → the serving tables' columns, staging SQL
  ingest/sources.ts   IngestSource: DumpDirSource, MongoSource, RecordsSource
  ingest/ingest.ts    the job: stage, upsert, recompute, commit, snapshot, log
  ingest/ingest-cli.ts  pnpm --filter @mriqc/server ingest
  ingest/schedule.ts  the nightly in-process run
```

Beside the workspace, `tools/mriqc-dump/` is the dump tool: plain ESM, no build
step, its own `README.md` and `cron.example`.

Tests: the filter compiler and identifier validation are pure and unit-tested
exhaustively. Each template runs against a small fixture DuckDB built from a
few hundred synthetic rows with known quantiles, NaN, Inf, and NULL present, so
the `isfinite` handling is asserted, not assumed. The router is tested through
`createCaller` against the fixture.

## Implementation notes (2026-10-01)

Implemented in `rewrite/packages/server/src/`. Where the code departs from the
text above, the code is current:

- Type unification is derived from each Parquet file's DESCRIBE plus source-name
  provenance, not a hand list: disagreeing numerics under `bids_meta.` become
  DOUBLE, integer-anywhere columns become BIGINT, narrowing uses `TRY_CAST` and
  the build reports values lost (zero on the full data). `scanners` keeps its
  source types. `meta.source_manifest` and `meta.policies` are VARCHAR JSON.
  `data_version` also hashes the `--sample` size.
- Templates are one file per procedure with named `-- @statement` sections.
  `grouped_summary` histograms use 30 bins over a shared range; groups are
  keyed by index with labels attached in code so binned labels cannot collide.
  `sample` and `export` always project `created_at` and `id` and exclude NULL
  `created_at`; the cursor is microsecond-precise.
- Extra filter rejections: `in` on a date field, empty `in` lists, and
  non-primitive values anywhere. Procedure inputs live in `trpc/inputs.ts` and
  the `/export` route validates through the same schemas.
- Timeouts race the query against a rejecting timer and re-issue `interrupt`
  every 25 ms until the native call returns, because DuckDB clears the interrupt
  flag when execution begins. A connection is returned to the pool only once
  its statement has finished; a connection that errors fatally is dropped and
  reopened.
- `bootstrap.ts`, imported first, sets `UV_THREADPOOL_SIZE` to at least the read
  pool plus four; the pool is capped at that minus two. In production set the
  variable in the environment, since it must precede any threadpool use.
- The export handler writes Arrow bytes directly to the response, awaits drain,
  stops on client disconnect and interrupts the query. Batched tRPC requests
  are capped, the read queue is bounded with a deadline, errors are formatted
  without stacks, and shutdown closes open SSE subscriptions.
- The completed catalog is a promise cache per `data_version`, so concurrent
  cold requests compute it once.
- A rebuilt database file is picked up only on server restart.

## Implementation notes: computed canonical tables (2026-10-06)

The canonical tables are no longer read from the published Parquet artifacts.
`src/db/build.ts` computes them:

- For each policy of `src/db/canonical.ts`, the build loads the frozen scale CSV
  into `scales_<policy>` (`policies/README.md`), creates the policy's view chain
  over the freshly loaded raw table, and materializes
  `canon_<modality>_<view> AS SELECT * FROM v_<policy>_canonical` -- in the same
  writer transaction as the raw load, so the file is never readable with raw and
  canonical tables that disagree. The resulting table has exactly the artifact's
  schema: the raw columns at their unified types plus the five `canonical_*`
  columns, six for bold.
- Three more relations per policy. `canonical_groups_<policy>` is the groups
  aggregate (`group_id`, `group_rows`, `distinct_vectors`, `nonfinite_rows`,
  `has_nonfinite`, `exact_constant`, `diameter`, `admitted`, plus `hmc_mode` for
  bold), materialized first and then re-pointed at by `v_<policy>_groups`,
  because that view is referenced four times further down the chain and would
  otherwise be recomputed each time. `canonical_members_<policy>(group_id, id)`
  is the membership of the admitted groups. `v_<policy>_quarantined_raw` is
  redefined as a *view*: an anti-join of the raw table against the membership,
  which is the same set -- every raw row is in exactly one group -- for one scan
  instead of the whole chain.
- A third served view per modality, `v_<modality>_<view>_all`, is the canonical
  table `UNION ALL` the quarantined raw rows, the `canonical_*` columns cast to
  NULL on the quarantined half. The column list is generated from the canonical
  table's own `DESCRIBE`, and "canonical-only" is the difference against the raw
  table rather than a name prefix. Every procedure works on it unchanged.
- `meta.policies` gains a `policies` array: per policy its id, version (`1`),
  modality, view, label, scale table and scale file, the `data_version` of the
  raw tables it was applied to, whether it was computed or loaded, and the
  admitted and quarantined group and row counts. The catalog reads the
  quarantine counts back as `CompletedCatalog.quarantine` per modality. The
  `views` map is now what the build actually served rather than the authored
  list, and `data_version` hashes the canonical source, since the computed and
  loaded tables differ in which member of a tie set they emit.
- The artifacts are a cross-check: after materializing, the build compares the
  admitted count against the artifact's row count and logs a warning naming both
  numbers if they differ. A missing artifact is not an error -- the canonical
  tables no longer need it -- only a skipped check, and the `columns` table is
  read off the relations that exist rather than off the Parquet schemas.
- `--canonical-from-parquet` loads the artifacts into the `canon_*` tables as
  before, for comparing the two side by side. Such a build serves no `_all` view
  and records no quarantine counts (null, not zero): it has no admission
  decision per raw row to derive either from. `scripts/validate-canonical.mjs`
  passes this flag, because its artifact side reads `canon_*`.
- `build:db` takes `--memory-limit` (default ~60% of free RAM) and `--threads`,
  which go into the writer's DuckDB settings. The canonicalization is the bulk
  of a full build's time and all of its memory pressure.

## Implementation notes: templates in shared (2026-10-07)

The five statistics templates are no longer files under
`packages/server/src/sql/`. Their text lives in `packages/shared/src/sql/` as
exported string constants (`DISTRIBUTION_SQL` and the rest), collected by
`sql/templates.ts` with `SQL_TEMPLATES`, `statementsOf(template)` and the
`parseStatements` splitter that used to sit in the server's `run.ts`. The holes
are unchanged: `{{table}}`, the identifier holes, and positional `?` for every
value. `sql/run.ts`'s `loadTemplate` reads them from shared instead of from
disk and re-exports `parseStatements` for `db/canonical.ts`.

The reason is `comparison-design.md`: an uploaded study's rows never leave the
browser, so its statistics are computed by a DuckDB-WASM instance there, and the
whole point of running DuckDB on both sides is that the browser compiles *the
same text* the server does. A string constant is also the only form that works
in a browser at all, which is why `scripts/copy-sql.mjs` now copies only
`src/sql/canonical/`: the canonicalization policy SQL is server-only -- it builds
the database -- and stays a file there.

For the same reason the filter compiler is split. `@mriqc/shared`'s
`sql/filters-core.ts` holds the pure part -- operator to fragment, parameter
order, the `(none)` expansion, the selection's `isfinite ... BETWEEN` -- behind a
`FilterValidator` callback that answers which columns exist and may be filtered.
The server's `sql/filters.ts` supplies the authored catalog's per-modality,
per-view allowlist and re-exports everything the core defines, so `./filters.js`
stays the one import; the browser's runner will supply the study table's own
column list, which has no view dimension to validate against.

`distribution` gained an optional `range: [lo, hi]` (two finite numbers,
`lo < hi`) and a third statement, `histogram_ranged`. With a range, the histogram
is binned over exactly `[lo, hi]` in `bins` equal-width bins and the finite values
outside it are *counted*, not dropped: the statement emits bin `-1` below `lo` and
bin `bins` above `hi`, which the procedure reports as `histogram.underflow` and
`histogram.overflow`, so `sum(counts) + underflow + overflow === n`. The
quantiles and the summary statistics stay over the whole filtered finite set. The
requested edges are reported even when the predicate matches no rows, because a
comparison panel needs every cohort's edges to agree and an empty cohort that
answered `[0, 0]` would not line up. Without a range nothing changes, and the two
counts are absent.

## Implementation notes: paired analysis (2026-10-08)

`density2d` and `correlation` reuse the existing filter compiler, view map, pooled
read deadline, error mapping, and HTTP cache/ETag path. They accept all served
modality/view pairs, including `_all`; cohorts remain filters plus selection.
Their templates are `DENSITY2D_SQL` and `CORRELATION_SQL` in shared's
`sql/density2d.ts` and `sql/correlation.ts`, registered in `SQL_TEMPLATES`.
They are string constants, like the five existing templates, rather than runtime
`.sql` files. `correlationFragments` is also shared so WASM runners can compile
the same metric projection, rank windows, and aggregates from validated expressions.

`density2d` has three named statements: `stats`, `histogram`, and `sample`.
Stats use the whole filtered finite-pair population, independently of clipping
or an explicit range. Each axis uses p01–p99 by default (`p05p95` and `none` also
work); coincident clip quantiles fall back to min/max, as in `distribution`.
Bins are 10–200, default 120. Explicit ranges require finite increasing bounds,
override clipping, and keep their edges even for an empty cohort. Constant axes
have width zero and put in-range values in bin zero. Grid order is
`counts[by * bins + bx]`, filled with zeros server-side.

The ranged histogram retains inclusive endpoints and the 1D sentinel bins (-1
below the low edge, `bins` above the high edge). Its four reported tail counts
are **disjoint, x-first**: x tails include every out-of-range x; y tails include
out-of-range y only where x is in range. Thus a corner point is counted once,
and `sum(counts) + x.underflow + x.overflow + y.underflow + y.overflow === n`.
These y counters are consequently not marginal totals over all y values.

The sample is restricted to finite pairs inside both ranges. `sampleSize` is
0–20,000 (default 2,000), and `seed` is an integer 0–2,147,483,647 (default 1).
DuckDB's reservoir sampling uses `REPEATABLE (seed)`; its grammar requires
integer literals for these options, so only schema-validated integers are
inserted into `sample_size`/`seed` holes. Filter and range values stay bound.
Because a seeded parallel reservoir alone is not deterministic, a sorted list
aggregate followed by `UNNEST` supplies one stable stream before sampling; the
output is sorted too. This materializes the in-range pairs inside DuckDB but
does not change the database's global thread settings or return uncapped rows.

`correlation` computes the upper triangle and pairwise finite counts in one
`matrix` statement, then mirrors it server-side in the requested metric order.
`method` defaults to `both`; unrequested matrices are absent and Pearson-only
queries omit rank windows. NaN, infinities, and NULL are excluded independently
per metric, so each pair uses its own available rows. `minPairN` is the minimum
entry of `pairN`.

Both procedures use average tied ranks (`rank() + (tie_count - 1) / 2`) for
Spearman. Density ranks within its finite pairs. The matrix ranks each metric
over **its own finite population after filters/selection**, then correlates
ranks pairwise where both exist; it does not rerank within each pair's complete
cases. Therefore its Spearman cell may differ from a density query of that
pair when their missing-value patterns differ. Undefined coefficients (fewer
than two pairs or zero variance) are JSON `null`; the specified numeric matrix
type uses `NaN` for in-process callers. Nondegenerate diagonals are one to
floating-point precision.

The analysis fixture adds tied, noisy linear, and monotone nonlinear metrics
with distinct NaN/Inf/NULL holes. Router tests compare independent TypeScript
reference correlations within 1e-9, check counts/ranges/order/validation across
all views, and exercise seeded sampling with simultaneous 300,000-row queries.

## Implementation notes: selections and time summaries (2026-10-08)

Shared `SelectionScope` adds `selections` to every existing `Query` variant.
`normalizeSelections` handles the alias, cap and distinct-metric rule; the pure
filter compiler accepts either the list or the old positional scalar, so the
study runner retains its existing calling convention. Server schemas validate
both forms for all scoped procedures and Arrow export. Both compiled predicates
and query keys normalize the alias; key ordering does not mutate the input.

`timeSummary` uses shared `TIME_SUMMARY_SQL` (`sql/time_summary.ts`, registered
as `time_summary`) in one statement, including numeric group bounds. It counts
finite metric observations with finite, non-null `created_at`. An optional ISO
window filters observations inclusively before bucketing, binning and group
ranking; a date-only bound means midnight. Day/week/month/year use DuckDB calendar buckets (weeks start Monday).
Empty buckets are omitted; every occupied bucket remains, with `thin: true`
exactly when `n < 20`. The five quantiles come from one list aggregate.

Without a group, `group` is null. A group must be categorical or numeric;
numeric groups use ten equal-width bins over the filtered window, with one
identity value for a degenerate domain. Missing/empty categorical values and
nonfinite numeric group values read `Not reported` when retained; missing groups
count toward the same cap. The top 50 groups are
chosen globally over that window by descending count then ascending group key,
nulls last. Remaining observations fold into `Other` before each bucket's
quantiles are computed. `isOther` distinguishes that fold from a real category
named Other. Groups therefore retain the same meaning across time buckets.

`TimeSummaryQuery` and its result types are exported from shared; `queryKey`
accepts it alongside the existing `Query`. It stays outside that union until
the web's exhaustive dispatcher gains the new panel. This pass does not edit
web code: existing 1D brushes work through the alias, while linked 2D brushes
and median-band rendering still need web wiring. The shared statement also
runs against an arbitrary study table and study-validated metric columns.

Validation covers fixture monthly quantiles, all granularities, canonical and
structural views, the 19/20 thin threshold, inclusive windows, group capping,
numeric groups, local study tables, multi-range router calls, and HTTP Arrow
exports. On a separate port-8791 instance built with `--sample 20000` (15,931
canonical bold rows), monthly bold/k4plus `fd_mean` returned 5 buckets in
83.6 ms; manufacturer grouping returned 18 cells in 32.1 ms; a two-selection
`density2d` returned 14,276 pairs in 68.3 ms. These are HTTP elapsed times on the
sample, not full-corpus performance claims. Port 8787 remained running.

## Implementation notes: vendor normalization (2026-10-07)

`bids_meta.Manufacturer` is free text, and the August 2026 dump spells the same
five vendors 35 ways. The build therefore writes two columns where the Parquet
has one:

- `manufacturer_raw` is the uploaded string, unchanged, and is a catalog field of
  its own, "Manufacturer (as uploaded)", filterable, groupable and exportable on
  every modality. It is the only normalized column the build *creates* rather
  than reads; `columns` records it against the same `bids_meta.Manufacturer`
  source name.
- `manufacturer` keeps its id and label and now holds the canonical vendor, from
  the frozen mapping `packages/server/policies/vendors.csv`. The normalization
  rule — trim, collapse whitespace, strip trailing legal suffixes, lowercase —
  and the canonical set are documented in `packages/server/policies/README.md`
  and implemented in `src/db/vendors.ts`. An unmapped spelling is passed through
  trimmed and title-cased, never dropped and never bucketed as `Other`;
  null, empty, `n/a` and `unknown` become SQL NULL, which the frontend already
  labels `(none)`.

The rewrite happens in the raw load's projection: the build asks each Parquet
file for its distinct vendor values, resolves each in TypeScript, and emits a
`CASE` over exact literals, so DuckDB never reimplements the rule. The canonical
tables inherit both columns through the policies' `SELECT r.*`, and admission is
untouched — the policy key is `(provenance_md5sum, provenance_version,
provenance_settings_*)` plus `hmc_mode`, never the vendor. `vendors.csv`'s
content hash is part of `data_version`, so editing the mapping invalidates the
catalog cache and every ETag.

## Implementation notes: continuous x summaries (Lane S, 2026-10-09)

Binding client contract for Lane W (greenfield rename; no `timeSummary` alias):

```ts
type MetricId = ColumnId;
type ColumnRef = MetricId | "created_at";
interface BinnedSummaryCohort extends SelectionScope {
  id: string;
  filters: readonly Filter[];
}
interface BinnedSummaryInput extends SelectionScope {
  modality: Modality;
  view: View;
  filters?: readonly Filter[]; // default []
  x: ColumnRef;
  y: MetricId;
  bins: number | Granularity; // metric: integer 1–200; time: day/week/month/year
  range?: [number, number]; // metric units, or days since 2000-01-01 for time
  groups?: ColumnId;
  cohorts?: readonly BinnedSummaryCohort[]; // 1–8, unique ids; omitted = one scope
}
interface BinnedSummaryBucket {
  lo: number;
  hi: number;
  start?: string; // ISO calendar bucket start, present for time x
  group: string | number | boolean | null;
  cohort?: string; // supplied cohort id
  isOther: boolean;
  n: number;
  quantiles: Pick<Quantiles, "p05" | "p25" | "p50" | "p75" | "p95">;
  mean: number;
  thin: boolean; // n < 20
}
interface BinnedSummaryResult {
  xKind: "metric" | "time";
  range: [number, number];
  buckets: readonly BinnedSummaryBucket[];
}
binnedSummary(input: BinnedSummaryInput): Promise<BinnedSummaryResult>;

interface Density2dInput extends SelectionScope {
  modality: Modality;
  view: View;
  filters?: readonly Filter[];
  x: ColumnRef;
  y: MetricId;
  bins?: number; // integer 10–200, default 120
  clip?: "p01p99" | "p05p95" | "none"; // default p01p99
  range?: { x: [number, number]; y: [number, number] };
  sampleSize?: number; // integer 0–20000, default 2000
  seed?: number; // integer 0–2147483647, default 1
}
interface Density2dResult {
  xKind: "metric" | "time";
  x: { lo: number; width: number; bins: number; underflow: number; overflow: number };
  y: { lo: number; width: number; bins: number; underflow: number; overflow: number };
  counts: number[];
  n: number;
  pearson: number | null;
  spearman: number | null;
  sample: Array<[number, number]>;
}
density2d(input: Density2dInput): Promise<Density2dResult>;
```

The shared query union exports `BinnedSummaryQuery` (the input plus `source`
and `proc: "binnedSummary"`; query filters remain required). Cohort predicates
are ANDed with the outer scope. Metric x uses finite x/y pairs, p01–p99 bounds
(falling back to min/max for coincident quantiles), then equal-width bins.
Cohorts share the union of those bounds, or the exact supplied range. Clients
fetch un-ranged summaries, union their returned ranges (including local study),
then refetch with that range, as with distribution. Empty explicit ranges are
preserved. Only occupied bins are returned; both range endpoints are inclusive.
Time uses calendar buckets, with numeric lo/hi edges in epoch days and `start`
as the ISO bucket start. Ranges filter rows before time bucketing. Group ranking
retains the existing top-50 plus Other policy, before per-bin quantiles.

For density, every x edge and sample x value is a metric value or, when
`xKind: "time"`, `date_diff('day', DATE '2000-01-01', created_at)`.
The same exported SQL strings and axis-expression helper serve native DuckDB
and the study WASM runner; column identifiers must be resolved from its catalog
before the expression helper is called. No web source is changed by Lane S.


Template wiring: `statementsOf("binned_summary")` supplies `stats` and `buckets`.
Use `continuousAxisExpr(catalogColumn, xKind)` for x and the metric expression
for y; `binnedSummaryFragments(bins)` supplies the `bucket` and `bucket_hi`
holes. The buckets statement binds predicate parameters, then `[lo, hi, bins]`
(use `1` as the numeric bind for calendar bins). Its metric `bucket` is a zero-based
bin index; its time `bucket` and `bucket_hi` are epoch-day edges. Group holes
remain `group_expr`, `group_numeric`, `group_bins` (10), and `max_groups` (50).
The native runner and WASM runner consume this same exported string.

Validation: shared 101 tests passed; server 510 passed, one skipped; both package
builds and TypeScript check configurations passed. Identifier-injection tests
reject unknown/noncontinuous x before SQL. Shared SQL execution tests cover both
axis kinds, local study columns, nonfinite timestamps, grids, samples, and quantiles.

Full-data smoke (2026-10-09): all 1,515,368 rows of the original
`mriqc_api.bold.parquet`, projected into an isolated in-memory DuckDB table;
1 GB memory limit, four threads. In-process router calls (loading excluded):
metric `fd_mean` x / `tsnr` y, 50 bins: **366.1 ms**, 50 occupied bins and
1,485,061 in-range pairs; monthly upload-time x / `fd_mean` y: **219.0 ms**,
111 buckets and 1,515,368 observations; time x / `fd_mean` density, 120 by 120,
2,000 sampled points: **1,480.0 ms**, 1,515,368 finite pairs. These are single
full-corpus smoke timings, not HTTP or production latency claims. Windows
prevented copying the locked serving database, so the original read-only
Parquet supplied the same full raw population. No server was started/stopped.

Deployment remains pending: the API needs `pnpm dev restart api`; the web dev
server needs `pnpm dev restart web --fresh` for the shared types.
