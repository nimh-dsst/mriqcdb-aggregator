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
pixi run db-load -- --run-id 20260416T152222Z
```

You can also point at an explicit path:

```bash
pixi run db-load -- --run-root data/runs/20260416T152222Z
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

