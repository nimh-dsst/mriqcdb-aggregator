# mriqc-dump

A cron-able `mongoexport` wrapper. It produces the dump files the server
ingests, so **the server never connects to MongoDB** — the design decision
recorded in `../../../docs/backend-graph.md`, "Ingest from dumps (decided
2026-10-08)".

Plain ESM, no build step, no dependencies but Node itself and `mongoexport` on
`PATH`. Copy the directory to wherever Mongo is reachable and run it from cron
there.

## What it does

For each collection (`T1w`, `T2w`, `bold`, `rating`) it runs

```
mongoexport --uri <uri> --collection <c> --jsonArray --out <dir>/mriqc_api.<c>.<YYYYMMDDTHHMMSS>.json \
            --query '{"_updated":{"$gt":{"$date":"<watermark>"}}}'
```

and appends to `<dir>/manifest.json`:

```json
{
  "version": 1,
  "files": [
    {
      "file": "mriqc_api.T2w.20261008T030405.json",
      "collection": "T2w",
      "records": 1413,
      "maxUpdated": "2026-10-07T23:41:02.000Z",
      "since": "2026-10-06T23:58:11.000Z",
      "sha256": "9f2c…",
      "bytes": 5182044,
      "exportedAt": "2026-10-08T03:04:11.882Z"
    }
  ]
}
```

The **watermark** is the highest `maxUpdated` the manifest already holds for that
collection, so a nightly cron entry needs no state of its own: the directory is
the state. `--since` overrides it for every collection.

The output is MongoDB extended JSON in the same shape as the existing full dumps
in `C:/Users/licc/projects/mriqc`, which is what the server's
`read_json(..., format='array')` staging reads and what
`C:/Users/licc/projects/mriqc/KEY.md` describes: `{"$oid": …}`, `{"$date": …}`,
and `{"$numberDouble": "NaN"}` for a computed NaN or ±Infinity.

An export that returns no records is **not** recorded: the file is removed and
the manifest left alone, so a quiet collection does not fill the directory with
empty arrays the server would have to hash and skip.

The manifest is written after each collection, not once at the end, so a run that
dies on the third collection keeps the two that landed. It is written through a
temporary file and a rename, so a killed run never leaves a half-written manifest
— which the server refuses, and which would stop every later ingest.

## Usage

```
mriqc-dump --uri <uri> --out <dir> [options]

  --uri <uri>          MongoDB connection string. Defaults to $MRIQC_MONGO_URI.
  --out <dir>          Where the dump files and manifest.json live. Required.
  --since <iso>        Override the manifest watermark for every collection.
  --db <name>          Database name, when the URI does not carry one.
  --collection <name>  Export only this collection; repeatable.
  --mongoexport <path> The mongoexport binary. Defaults to $MRIQC_MONGOEXPORT
                       or "mongoexport" on PATH.
  --adopt              Do not export; take the dump files already in --out into
                       the manifest.
  --dry-run            Print the mongoexport command lines and change nothing.
```

The connection string carries a password, so pass it in the environment and not
on the command line, where `ps` and cron's mail would show it. Everything this
tool prints has the credential redacted (`//***:***@`).

### Taking the existing full dumps as the first files

```
node bin/mriqc-dump.mjs --adopt --out /srv/mriqc/dumps
```

`--adopt` scans `--out` for `mriqc_api.<collection>[.<stamp>].json`, counts each
file's records, finds its highest `_updated`, hashes it and writes the manifest
entry — without running `mongoexport`. The full August 2026 dumps are valid first
files this way, and the nightly deltas then chain off their `_updated`. It is
idempotent: a file already in the manifest is left alone.

## Cron

See `cron.example`. It runs at 02:30, half an hour before the server's own
`INGEST_HOUR` (default 03:00), so the files are complete before the server looks
at the directory.

## Ingesting what it wrote

```
pnpm --filter @mriqc/server ingest -- --dumps /srv/mriqc/dumps
```

or let the server's nightly schedule do it (`INGEST_ENABLED=1`,
`MRIQC_DUMP_DIR=/srv/mriqc/dumps`). Either way a file whose sha256 is already in
the server's `ingest_log` is skipped, so re-running is free.

## Tests

```
pnpm --filter @mriqc/dump-tool test
```

20 tests, and **no MongoDB or `mongoexport` is required**: `test/fake-mongoexport.mjs`
is a Node script that accepts the same flags, honours the one `--query` shape
this tool builds, and writes a `--jsonArray` file from a fixture. What the tests
cover is the command construction, the dated file naming, the manifest watermark
and resumption, the record/`_updated`/sha256 summary of a written file, the
streaming array scanner, `--dry-run`, `--adopt`, and the failure path.

What no test on a machine without MongoDB can cover is whether the **real**
`mongoexport` accepts these flags and interprets the `$date` filter as a date
comparison. That is the one unverified claim in this directory.
