# MRIQC population dashboard: install, run, ingest

For whoever operates the dashboard without being its developer. Everything
below is typed into a terminal: Git Bash on Windows, Terminal on macOS or
Linux. Commands are shown one per line; copy them as written.

## 1. What you need

- A machine with 8 GB of memory and about 15 GB of free disk. The running
  server uses about 1.1 GB; building or ingesting may use up to 4 GB
  (adjustable, see Settings). The database is 2.7 GB and each ingest keeps
  up to three snapshot copies beside it.
- Git.
- pnpm, installed once with your system's package manager: Windows
  `winget install pnpm.pnpm`, macOS `brew install pnpm`, Linux
  `curl -fsSL https://get.pnpm.io/install.sh | sh -`. If Node is already
  installed, `corepack enable pnpm` works too. Either way pnpm downloads the
  exact Node version the project needs on its own, so you never have to
  match versions by hand.
- The data, in one of these forms:
  - **a ready database file** (`mriqc.duckdb`, 2.7 GB) given to you, or
  - **the MongoDB export files** (`mriqc_api.bold.*.json`,
    `mriqc_api.T1w.*.json`, `mriqc_api.T2w.*.json`, `mriqc_api.rating.*.json`),
    or
  - the flattened Parquet files (developer route, not covered here).

## 2. Install

```
git clone https://github.com/nimh-dsst/mriqcdb-aggregator.git
cd mriqcdb-aggregator
git checkout rewrite
cd rewrite
pnpm install
pnpm -r build
```

`pnpm install` takes a few minutes the first time because it also fetches
Node. `pnpm -r build` compiles the shared code, the server and the web app.

## 3. Get a database

Pick one.

**A. You were given `mriqc.duckdb`.** Put it at `rewrite/data/mriqc.duckdb`.
Done.

**B. You have the JSON export files.** Put them in one folder, for example
`rewrite/data/dumps`, then build the database from them:

```
pnpm --filter @mriqc/server build:db -- --from-dumps data/dumps
```

This registers the files in a manifest, reads every export, writes the raw
rows and computes the deduplicated views (the "K4+" and "K3++" policies).
It prints progress per collection and does not need the server running. A
300-document test set builds in about 5 seconds; the full export takes
longer. Add `-- --sample 20000` for a quick test database, and
`-- --out data/other.duckdb` to build beside a database a running server is
using.

**C. Parquet route** (`MRIQC_DATA_DIR`, `build:db` without `--from-dumps`) is
documented in `rewrite/README.md`.

## 4. Run it

One process serves both the web app and the API on one port:

```
pnpm --filter @mriqc/web build
NODE_ENV=production UV_THREADPOOL_SIZE=8 pnpm --filter @mriqc/server start
```

Open http://localhost:8787 in a browser. Health check:
http://localhost:8787/trpc/health should answer with `"ok":true`.

Stop it with Ctrl+C in that terminal. To run it in the background on a
server, use whatever your system offers (a systemd unit, `nohup`, a screen
session); it is a single `node dist/index.js` process in
`rewrite/packages/server`.

## 5. Add new data later (ingest)

When new JSON export files arrive:

1. Stop the server (DuckDB allows one writer).
2. Put the new files in the same dumps folder and register them:

   ```
   node tools/mriqc-dump/bin/mriqc-dump.mjs --adopt --out data/dumps
   ```

   This adds `manifest.json` entries for the files in the folder that are
   not listed yet.
3. Ingest:

   ```
   pnpm --filter @mriqc/server ingest -- --dumps data/dumps
   ```

   Files already ingested are skipped by checksum. New records are added,
   records with a newer `updated_at` replace older ones, the deduplicated
   views are recomputed, and a snapshot `snapshots/mriqc-<version>.duckdb`
   is written beside the database (the newest three are kept; add
   `-- --no-snapshot` to skip). `-- --dry-run` shows what would happen
   without changing anything.
4. Start the server again (step 4). The dashboard shows the new "Uploads
   through <date>" in its top bar.

### Automatic nightly ingest

If the export files land in the dumps folder on their own (for example a
cron job on the machine that can reach MongoDB), the running server can
ingest them itself every night:

```
INGEST_ENABLED=1 MRIQC_DUMP_DIR=/path/to/dumps NODE_ENV=production UV_THREADPOOL_SIZE=8 pnpm --filter @mriqc/server start
```

It runs at 03:00 local time (`INGEST_HOUR` changes the hour) and retries an
hour later if a run fails. Readers are never blocked; the dashboard switches
to the new data when the ingest commits.

The export itself, on the machine that can reach MongoDB, is
`node tools/mriqc-dump/bin/mriqc-dump.mjs --out <dir>` with the connection
string in the `MRIQC_MONGO_URI` environment variable. That machine needs
`mongoexport` installed; see `rewrite/tools/mriqc-dump/README.md`,
including the cron example.

## 6. Settings

All optional, set as environment variables before `start`:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 8787 | port the server listens on |
| `DUCKDB_PATH` | `rewrite/data/mriqc.duckdb` | the database file |
| `DUCKDB_MEMORY_LIMIT` | `1GB` | memory DuckDB may use for queries; raise to `2GB` on a machine with headroom |
| `INGEST_MEMORY_LIMIT` | `4GB` | memory allowed while an ingest runs |
| `DUCKDB_THREADS` | up to 4 | query threads |
| `INGEST_ENABLED` | `0` | `1` turns on the nightly ingest |
| `INGEST_HOUR` | 3 | local hour of the nightly ingest |
| `MRIQC_DUMP_DIR` | `rewrite/data/dumps` | folder the nightly ingest reads |
| `SNAPSHOT_KEEP` | 3 | snapshots kept after an ingest |
| `UV_THREADPOOL_SIZE` | set it to 8 | Node thread pool; must be set in the environment in production |

Memory values are written like `1GB`, `512MB`, `2GiB`.

## 7. If something goes wrong

- **"port 8787 is in use"**: an old server is still running. Find and stop
  it, or start with another `PORT`.
- **ingest says the database is locked or busy**: the server is running.
  Stop it first, or point `DUCKDB_PATH` at a copy.
- **"source file missing"** during a Parquet build: that build needs all
  three modality Parquet files; use route B instead.
- **the page loads but shows no data**: check the health URL; if it answers,
  reload the page; if not, read the terminal output of `start`.
- **after an ingest the counts did not change**: the files were already
  ingested (same checksum). `-- --dry-run` lists what is new.
- Snapshots are full copies of the database. To roll back, stop the server,
  replace `mriqc.duckdb` with a snapshot file, start again.
