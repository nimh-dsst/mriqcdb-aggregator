# Rewrite Architecture

Architecture decisions for the total rewrite of mriqcdb-aggregator into a
dashboard for visual statistics over the MRIQC population. Agreed on
`2026-09-21`. Nothing here is implemented; this document records what was
decided, what was rejected and why, and what is still open.

## Requirements that drove the decisions

Two properties of the product eliminated most alternatives, so they are stated
first.

- **Public.** The site is reachable by anyone, with no login. Nothing may accept
  SQL or arbitrary query shapes from the browser, and no per-visitor state may
  live on the server.
- **Interactive.** Many linked panels on one page. A filter, a brush, or a
  chart-type change must update only what depends on it, without a server round
  trip where none is needed.

Further requirements: shareable dashboards (all state in the URL); comparison
of an uploaded study against the population using identical statistics;
periodic ingest from the MRIQC MongoDB; raw observations retained and reachable
through the dashboard, because the PI wants raw access; a small team where most
code will be agent-written, so conventions that constrain code shape matter.

## Storage

**DuckDB is the database.** PostgreSQL is dropped.

- One long-lived DuckDB file holds the raw observation tables per modality
  (immutable log, as today) and canonical tables per policy version, with a
  links table from canonical records back to raw observations.
- Periodic ingest appends to raw and rebuilds the affected canonical tables in
  one transaction. Readers see a consistent snapshot throughout.
- DuckDB permits one writing process and forbids any other process from opening
  the file while it is held for writing. Ingest therefore runs inside the
  serving process as a scheduled job. There is no separate loader process and
  no file swap.
- Research access for Python notebooks is a snapshot copy written after each
  ingest, not the live file.

Why not Postgres: its remaining advantage was multi-client access, and nothing
needs it once PI raw access is through the dashboard. Analytical scans over two
million rows of a hundred-plus columns are DuckDB's workload, and PostgreSQL's
row store needed request caches and materialized views to keep up.

Why not pg_duckdb or a DuckDB replica beside Postgres: both were considered and
were reasonable, but each kept two systems for a workload one system serves.

## Backend

**Node, TypeScript, tRPC, raw SQL. No query builder.**

- One Node process serves the tRPC API and the static frontend, behind nginx as
  today, and hosts the ingest job.
- The query surface is fixed: catalog, histogram, quantiles, grouped summary,
  coverage over time, record sample, and likely outlier cohorts. Each is a
  hand-written SQL template. The dynamic parts, metric column, grouping column,
  filter set, and view, all come from the metric catalog, which is an allowlist.
- A small filter compiler turns a validated filter set into a parameterized
  `WHERE` fragment. This plus the templates replaces Kysely. Kysely was dropped
  because its DuckDB dialects are single-maintainer 0.x packages, no codegen
  produces DuckDB schema types, and the catalog already provides the safety a
  builder would add.
- Every statistics procedure takes a `view` parameter selecting raw or a
  canonical policy table. The current raw, exact, series axis becomes raw plus
  one entry per canonical policy.
- Streaming is used in exactly two places: progressive delivery of a many-panel
  dashboard load, and export of raw rows. Aggregate queries return in one
  response.
- Arrow is a row serialization format only, for the export and drill-down path,
  streamed as record batches so large pulls never materialize in memory. It is
  not a separate access path. The apache-arrow JavaScript package has no
  published vulnerabilities; the Arrow CVEs since 2023 are in the Python, Rust,
  R, and C++ implementations.
- Raw row-level access is public, matching the source MRIQC API, which already
  serves the same fields. Controls are a column allowlist on row-level
  procedures, row caps and cursoring, and nginx rate limits on the export route.
  There is no auth layer anywhere.

## Frontend

**Angular 22, zoneless, with an Elm-style command loop written in RxJS.**

The application is one fold over a stream of commands. State lives in the
graph; nothing subscribes except the edges.

```ts
const commands$ = merge(
  controls.modality.valueChanges.pipe(map(setModality)),
  controls.filters.valueChanges.pipe(map(setFilters)),
  panelEvents$,                        // add/remove panel, set metric, set chart type
  vegaSelections$.pipe(map(setBrush)),
  route.queryParamMap.pipe(first(), map(hydrate)),
  dataArrivals$,                       // dataArrived(key, rows), datasetsStale
);

const state$ = commands$.pipe(scan(reduce, initialState), shareReplay(1));
```

- **Commands** are a discriminated union, one variant per user action plus data
  arrival and invalidation. Reactive form controls, panel buttons, Vega
  selection signals, the initial URL, and query results all map into it.
- **The reducer** is a pure function and the only place dashboard logic lives.
  It is unit-tested with plain objects. Commands are serializable, so logging
  and replay are free.
- **State** holds the global controls, the panel list, and one datasets map
  keyed by query key. Data is not owned by panels. Two panels with the same key
  share one entry.
- **Projections**, each a single `map` off `state$` guarded by
  `distinctUntilChanged` on its own slice, and never recombined downstream:
  - the set of query keys the current panels need, minus the keys already in the
    datasets map. The difference is fetched through tRPC and re-enters as
    `dataArrived` commands. This is where lazy querying comes from, and it is
    the single interception point for effects: a test asserts which keys a
    command history makes needed without running a fetch.
  - one view projection per panel, returning the Vega-Lite spec and the
    datasets that spec names as a tuple. The Vega directive diffs the tuple at
    the edge: spec changed, re-embed; only datasets changed, update named
    datasets in place. Spec and data are projected jointly rather than as two
    streams so no panel ever sees a spec from one state and data from another.
  - the URL, which excludes datasets.
- **Rules that keep it one graph.** `state$` is the only root; no other subject
  or replayed stream holds state. Anything that needs two facts about state is
  one projection returning both, never two projections combined. Time operators
  appear only at the edges: `debounceTime` on continuous controls before they
  become commands, and per-key cancellation of fetches whose key has left the
  needed set.
- **Data enters Vega through the view API** as named datasets, not by
  re-embedding the spec. Brushes leave Vega as signal listeners and become
  commands, closing the loop. Linked panels are therefore not a mechanism, just
  state changes.
- **Invalidation and eviction are reducer rules.** Ingest completion produces
  one `datasetsStale` command; the next derivation refetches exactly what is on
  screen. Entries referenced by no panel are dropped.
- **Ephemeral UI state** such as hover or an open side sheet stays in local
  component signals and may not be read by anything else. The rule: if it
  affects a query or the URL it is a graph node, otherwise it is local.

Angular's role is limited to reactive forms as command sources, templates for
controls and layout, a directive owning a Vega view and exposing its selections
as an observable, and the router for URL sync. The graph is intended to fit in
one file; growth beyond that means something leaked in that belongs elsewhere.

Rest of the frontend stack:

- **Charts: Vega-Lite.** Specs are data, so a chart is a pure function of panel
  and state. Interval selections are built in. Client-side clipping to the
  p01 to p99 range is a transform in the spec. The renderer sits behind one
  function, spec and element in, selections out, so it is replaceable as a
  module.
- **Browser compute: DuckDB-WASM**, lazily loaded only when the upload panel
  opens, roughly 8 MB gzipped. It runs the same SQL as the server on the
  uploaded study, which is the only way to guarantee identical quantile and
  histogram definitions on both sides of a comparison. The WASM build pins
  apache-arrow 17 and a version mismatch fails silently. Sits behind a
  study-statistics interface so Arquero could replace it if bundle size becomes
  the complaint.
- **UI kit:** Angular Material for form controls, which bind natively to
  reactive forms, with a custom theme; Tailwind for layout; Angular CDK table
  with virtual scroll for raw drill-down.
- **Tooling:** Angular CLI build, Vitest, Playwright, pnpm workspace with three
  packages: `server`, `web`, and a shared package holding the metric catalog and
  the tRPC router types.

## Rejected alternatives

Recorded so they are not re-proposed.

| Alternative | Why not |
|---|---|
| React 19, Solid, Svelte 5 | Same architecture, worse fit. React needs ref, effect, and memo discipline around every imperative chart. Solid and Svelte have no reactive forms, so command sources would need hand-written subjects, and their own reactivity models pull generated code away from the graph. Svelte was the closest runner-up since Observables satisfy its store contract. |
| Python end to end (Shiny for Python or Dash, Altair, DuckDB) | The strongest alternative for a lab tool, and the one to revisit if the audience becomes internal. Loses on public plus interactive: Shiny holds a session per visitor, Dash round-trips every interaction. |
| Server-side graph with a thin client | Per-visitor server state and a round trip per slider drag. |
| Observable Framework | Purpose-built for dataviz pages, but its static build model and lack of an application layer do not fit a configurable multi-panel tool with uploads. |
| Mosaic / vgplot | Requires the browser to send SQL to DuckDB. Excellent fit technically, incompatible with a public site. |
| Observable Plot | No release since February 2025, no brushing. |
| recharts | Not a statistics library. |
| Kysely | See Backend. |
| TanStack Query | No official Angular adapter; the datasets map in state is the cache. |
| NgRx or any store library | The `scan` loop is the store. |
| pg_duckdb, DuckDB replica beside Postgres, Parquet snapshot files | Superseded by DuckDB as the sole database. |
| Static Parquet views served by nginx | Never wanted. |

## Open

Decided out of scope for now, or not yet designed.

- **Ingest and canonicalization.** K4+ for BOLD is specified in
  `k4-bold-canonicalization.md` with an audit over 1.5M observations; the rule
  for choosing the canonical member of an admitted group is undecided. K3++ for
  T1w and T2w exists only as notes: no metric vector, no audit, and a tolerance
  of 0.1 against K4+'s 1e-6 that needs the same measurement on the structural
  tables before it becomes the layer people compare studies against. Neither has
  code.
- **Serving schema and metric catalog.** Which tables and columns the dashboard
  reads, and the catalog as the single contract shared by SQL templates, tRPC
  procedures, and Vega specs. Groupable and exportable columns are catalog
  attributes so extending the query surface is a catalog entry, not a
  procedure.
- **Procedure list** with concrete inputs and outputs. First draft, together
  with the command union, state shape, and projections, is in
  `dashboard-graph.md`.
- **Comparison path.** Intended shape: the uploaded study is a second data
  source inside the same loop. `studyLoaded(rows)` is a command, the study is
  state, and every query key carries a source tag, population or study. The
  fetch effect dispatches population keys to tRPC and study keys to DuckDB-WASM;
  both return as `dataArrived`. A comparison panel is a spec naming two
  datasets. Details of the shared SQL module are not yet designed.
- **Deployment details.** Ingest schedule, snapshot copy for research access,
  caching headers, rate limits.
