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

## Containerized Stack

If you already have direct dump files on disk instead of sampled API pages, use
the dedicated dump loader:

```bash
pixi run db-load-dump -- --dump-root /data/dump
```

That path is meant for large host-side backfills from `mriqc_api.<modality>.json`
files and bypasses the page-oriented API sampling format entirely.

```bash
cp .env.example .env
pixi run stack-up
```

That builds and starts:

1. `postgres` on `localhost:${POSTGRES_PORT:-5432}`
2. `api` on `http://127.0.0.1:${API_PORT:-8000}/docs`
3. `frontend` on `http://127.0.0.1:${FRONTEND_PORT:-5173}`

The API container initializes the current SQLAlchemy schema on startup before
serving requests. The database remains accessible from the host via the same
`MRIQC_DATABASE_URL` in `.env`, so you can still run `pixi run db-load` and
`pixi run db-profile` against the compose-managed Postgres instance.

Local development uses `compose.yaml` plus the automatically loaded
`compose.override.yaml`. That keeps the dev stack simple:

1. `postgres` is published directly for host-side tooling
2. `api` is published directly with the default Uvicorn runtime
3. `frontend` runs as a Vite dev server with `/api` proxied to the API container
4. `nginx` is not part of the local stack by default

For the production shape, use the explicit production override:

```bash
docker compose -f compose.yaml -f compose.prod.yaml up --build -d
```

That changes the runtime to:

1. `postgres` persisted at `POSTGRES_DATA_DIR` when set
2. `api` running Gunicorn inside the app container
3. `nginx` publishing `80/443`, serving the built dashboard at `/`, and proxying `/api/` to the app container

The production override keeps `postgres` and `api` reachable only on
`127.0.0.1` from the host, while public traffic goes through `nginx`.

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
