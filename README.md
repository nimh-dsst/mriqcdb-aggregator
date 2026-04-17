# mriqc-aggregator

Reusable Python tooling for pulling representative MRIQC Web API samples,
loading them into PostgreSQL, profiling the raw tables, and serving a thin
FastAPI backend for future frontend work.

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
pixi run db-load -- --run-id <run-id>
```

That starts a local PostgreSQL instance with Docker Compose and initializes the
current SQLAlchemy schema, then loads a sampled raw run into `t1w`, `t2w`, and
`bold` using idempotent `source_api_id` upserts.

See [docs/erd.md](docs/erd.md) for the current and proposed normalized entity model.
See [docs/ingestion.md](docs/ingestion.md) for the raw ingestion workflow.
See [docs/backend.md](docs/backend.md) for the profiling workflow and FastAPI read layer.
See [docs/data-migration.md](docs/data-migration.md) for the MongoDB-to-PostgreSQL migration rationale, typing decisions, and scaling risks.

## Profiling And API

```bash
pixi run db-profile
pixi run api-dev
```

`db-profile` writes per-modality database summaries into `docs/temp/db-profiles/`.
`api-dev` starts a FastAPI backend for local frontend development, with docs at
[http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs).

The backend now exposes both categorical summaries and modality-specific QC
metric summaries/histograms, all queryable in `raw`, `exact`, and `series`
views.

The larger local representative run used to shake out the current ingestion and
backend path is `data/runs/20260416T175935Z`, but the workflows above operate on
any sampled `<run-id>`.
