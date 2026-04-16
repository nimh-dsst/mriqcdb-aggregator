# mriqc-aggregator

Reusable Python tooling for pulling representative MRIQC Web API samples into a local raw data cache.

## Layout

- `mriqc_aggregator/`: reusable package code
- `scripts/`: thin entrypoint wrappers around package workflows
- `docs/`: project documentation
- `docs/temp/`: ignored scratch space
- `data/`: ignored local data outputs

## Quickstart

```bash
pixi run pull-sample -- --pages-per-modality 64
```

That command will:

1. Discover a usable page frontier for `T1w`, `T2w`, and `bold`
2. Build a wide archive-spanning page plan
3. Download exact raw API page payloads into `data/runs/<run-id>/raw/`
4. Write derived item/page manifests and a summary for inspection

See [docs/representative-sampling.md](docs/representative-sampling.md) for details.

## Local Postgres

```bash
cp .env.example .env
pixi run db-up
pixi run db-init
pixi run db-load -- --run-id 20260416T152222Z
```

That starts a local PostgreSQL instance with Docker Compose and initializes the
current SQLAlchemy schema, then loads a sampled raw run into `t1w`, `t2w`, and
`bold` using idempotent `source_api_id` upserts.

See [docs/erd.md](docs/erd.md) for the current and proposed normalized entity model.
See [docs/ingestion.md](docs/ingestion.md) for the raw ingestion workflow.
