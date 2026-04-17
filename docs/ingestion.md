# Raw Ingestion

## Goal

Load sampled MRIQC observations from `data/runs/<run-id>/raw/` into PostgreSQL
without normalization.

The loader keeps:

- `t1w`, `t2w`, and `bold` as the raw observation tables
- `source_api_id` as the idempotent load key
- `provenance.md5sum` as `dedupe_exact_key`
- a stable modality-specific identity hash as `dedupe_series_key`
- unmapped source fragments in `payload_extra`, `bids_meta_extra`,
  `provenance_settings_extra`, `provenance_extra`, and `rating_extra`

## Commands

```bash
cp .env.example .env
pixi run db-up
pixi run db-init
pixi run db-load -- --run-id <run-id>
```

You can also point at an explicit path:

```bash
pixi run db-load -- --run-root data/runs/<run-id>
```

For direct Mongo-style dump files, use the dedicated loader instead of the
sampled-run page loader:

```bash
pixi run db-load-dump -- --dump-root /data/dump
```

`load-dump` expects one JSON array file per modality:

- `mriqc_api.T1w.json`
- `mriqc_api.T2w.json`
- `mriqc_api.bold.json`

Those files may contain Mongo extended JSON wrappers such as `{"$oid": ...}`
and `{"$date": ...}`. The dump loader normalizes those wrappers and then
reuses the same typed parser and PostgreSQL upsert path as `load-raw-run`.

On the deployed compose host, the same load can run as a one-shot helper
container against the live PostgreSQL service:

```bash
sudo docker compose -f compose.yaml -f compose.prod.yaml \
  run --rm -v /data/dump:/data/dump:ro api \
  pixi run python scripts/load_dump.py --dump-root /data/dump
```

## Idempotency

Repeated loads upsert on `source_api_id`.

- new `source_api_id` values insert rows
- existing `source_api_id` values update rows in place

This means the same sampled run can be reloaded after parser changes without
creating duplicates.

## Notes

- PostgreSQL is the primary target for this workflow.
- SQLite is only used in tests as a lightweight harness for parser/load logic.
- No canonical or normalized tables are introduced yet.
- `load-raw-run` is for saved API page payloads under `data/runs/<run-id>/raw/`.
- `load-dump` is for direct dump files and avoids the page-based API shape
  entirely.
- `db-init` is safe to rerun and now creates missing indexes on existing tables
  in addition to creating fresh schemas.
- The current larger exploratory run is `20260416T175935Z`, but the loader is
  intentionally run-agnostic.
