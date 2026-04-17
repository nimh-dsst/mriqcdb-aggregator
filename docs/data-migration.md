# Data Migration: MRIQC Web API To PostgreSQL

## Context

This project is using the MRIQC Web API as the source contract for the first
phase of migration work.

- Source app: [nipreps/mriqcwebapi](https://github.com/nipreps/mriqcwebapi)
- Live deployment: [mriqc.nimh.nih.gov](https://mriqc.nimh.nih.gov/)
- API base used by this repo: [https://mriqc.nimh.nih.gov/api/v1](https://mriqc.nimh.nih.gov/api/v1)

The original service is an Eve application backed by MongoDB. Its
`dockereve-master/eve-app/settings.py` schema defines the main scan resources
(`T1w`, `T2w`, and `bold`), the nested `bids_meta` and `provenance` objects,
and the optional `rating` object on `bold`.

The important decision here was to migrate against the application-level data
contract instead of trying to reproduce MongoDB internals one-to-one in
PostgreSQL. That keeps the work anchored to the payloads the dashboard will
actually read and avoids coupling the warehouse shape to Eve or Mongo-specific
behavior.

## Phase 1 Scope

The first pass is intentionally narrow:

- in scope: scan observations for `T1w`, `T2w`, and `bold`
- included data: source lineage, selected BIDS metadata, modality-specific IQMs,
  `bold` ratings, and dedupe hints
- out of scope: `rating_counts`, `nipype_telemetry`, full cross-modality
  normalization, and any attempt to mirror every MongoDB collection or
  aggregation endpoint

This scope matches the immediate product goal: support a dashboard with better
read performance than the current Mongo/Eve setup can provide for repeated
filtering, aggregation, histograms, and duplicate analysis.

## Migration Flow

The current workflow is:

1. Pull raw page JSON from the live API and save it under `data/runs/<run-id>/`.
2. Treat those saved payloads as the raw landing zone.
3. Parse each observation into a typed row for one of `t1w`, `t2w`, or `bold`.
4. Upsert into PostgreSQL by `source_api_id`.
5. Preserve any unmapped source fragments in JSON extra columns.

This was a deliberate choice.

- It makes parser changes rerunnable without hitting the live API again.
- It preserves an audit trail back to the exact source page payload.
- It separates extraction failures from transformation failures.

The current larger exploratory run is `20260416T175935Z`, which pulled `231,100`
observations and about `676 MB` of raw JSON. The local `data/` directory used
for this work is now roughly `1.0 GB` on disk.

## Schema Decisions

### Three Fact Tables Instead Of One

We kept `t1w`, `t2w`, and `bold` as separate fact tables.

Reasons:

- most IQMs are modality-specific
- a single table would be sparse and harder to reason about
- dashboard filters still depend on a common set of shared fields
- shared column names are aligned so a future `UNION ALL` view remains possible

This is the same tradeoff described in [docs/schema-design.md](schema-design.md):
avoid a giant sparse table now, keep the shared columns compatible, and defer
cross-modality consolidation until there is a concrete dashboard need.

### Raw First, Not Canonical First

The loader keeps every raw observation row and computes dedupe hints alongside
it:

- `dedupe_exact_key`: from `provenance.md5sum`
- `dedupe_series_key`: SHA-256 over normalized modality-local identity fields
- `dedupe_status`: loader state for future canonicalization work
- `canonical_source_api_id`: reserved for a stronger canonical pick policy later

That means `raw`, `exact`, and `series` are read semantics over the same base
tables, not separate canonicalized tables. This reduces irreversible early
decisions while still letting the dashboard hide obvious duplicates.

### Idempotent Source Key

`source_api_id` is the business key for loading.

- it comes directly from the API `_id`
- it is unique per table
- reloads use `INSERT ... ON CONFLICT DO UPDATE`

This lets us rerun a load after parser or schema changes without creating
duplicate rows.

### Preserve Unknown Fields

We intentionally did not flatten every field from `bids_meta`, `provenance`, or
the top-level payload on day one. Unmapped fragments are preserved in:

- `payload_extra`
- `bids_meta_extra`
- `provenance_settings_extra`
- `provenance_extra`
- `rating_extra` for `bold`

That keeps the migration forward-compatible with source drift and lets us add
typed columns later only when the dashboard proves they are worth promoting.

### Index For Expected Dashboard Reads

The initial indexes are aimed at the filters and summarization paths the
dashboard already uses or is expected to use:

- `source_api_id` uniqueness
- `source_created_at`
- `source_md5sum`
- `dedupe_exact_key`
- `dedupe_series_key`
- `canonical_source_api_id`
- modality identity tuples
- scanner tuple: manufacturer, model, field strength
- `mriqc_version`
- `task_id` for `bold`

This is a read-oriented migration. The schema is not merely storing data; it is
optimizing for the dashboard workload that motivated the move to PostgreSQL in
the first place:

- computing modality-specific QC metric distributions
- filtering those distributions by scanner, version, task, and acquisition
  metadata
- giving researchers a way to compare their own study outputs against the
  broader MRIQC reference distribution
- making those comparisons dedupe-aware so the reference population is not
  distorted by repeated uploads of the same or near-identical scans

Duplicate analysis is therefore a prerequisite for trustworthy distributions and
benchmarking, not the primary product outcome by itself.

## How Types Were Chosen

The type mapping follows the Eve schema from the source app wherever that schema
is explicit, with a few pragmatic adjustments for PostgreSQL.

| Source shape | PostgreSQL choice | Why |
| --- | --- | --- |
| Eve `string` identifiers such as `_id`, `subject_id`, `session_id`, `run_id`, `acq_id`, `task_id` | `String(...)` | The source contract treats them as strings, and many values are hashed or alphanumeric rather than safely numeric. |
| Fixed-format machine tokens such as MD5s and modality names | bounded `String` | Keeps indexes compact and encodes clear expectations about length. |
| Free text fields such as `institution_address`, `instructions`, `pulse_sequence_details`, `task_description`, and `rating_comment` | `Text` | These fields can be long and unpredictable. |
| Eve `integer` fields | `Integer` | Preserves discrete semantics from the source schema. |
| Eve `float` fields and IQMs | `Float` | Matches the source contract and the statistical nature of the dashboard queries. |
| Eve `boolean` fields | `Boolean` | Direct mapping. |
| HTTP date strings from `_created` and `_updated` | `DateTime(timezone=True)` | Enables stable filtering and representative-row ordering. |
| Flexible nested or unknown fragments | `JSON` | Preserves fidelity without blocking on complete normalization. |
| Small controlled loader state | SQL enum | Suitable for `dedupe_status`. |

Important details:

- `source_api_id` is stored as `String(24)` because the API ids are Mongo
  `ObjectId`-like 24-character hex strings.
- `source_md5sum` and `rating_md5sum` are `String(32)` because they are MD5
  hex digests.
- `subject_id`, `session_id`, `run_id`, `acq_id`, and `task_id` remain strings
  even when some values look numeric. Coercing them to integers would be wrong
  for hashed or mixed-format values.
- Structural `size_x`, `size_y`, and `size_z` are `Integer` because the source
  schema declares them as integers.
- `bold` `size_t`, `size_x`, `size_y`, and `size_z` remain `Float` because the
  source Eve schema declares them as floats, and the migration currently
  prioritizes source fidelity over local reinterpretation.
- We did not use `NUMERIC` or fixed decimal precision for IQMs because the
  source contract only guarantees floating-point values and the dashboard is
  doing analytical summaries rather than exact decimal accounting.

## Dedupe Decisions

The current sample already shows enough duplication pressure to justify explicit
dedupe metadata.

From the current profiled sample:

- `T1w`: `3,047` exact-duplicate groups, max group size `3,479`
- `T2w`: `13,993` exact-duplicate groups, max group size `71`
- `bold`: `11,380` exact-duplicate groups, max group size `76`

That is why the migration keeps two distinct dedupe concepts:

1. Exact payload duplicates, keyed by `provenance.md5sum`
2. Series-level duplicates, keyed by a modality-local identity hash

The series key is intentionally modality-local. We are not assuming the source
data can support a universal cross-modality scan identifier yet.

## Why PostgreSQL Should Help The Dashboard

The public API is page-oriented and document-oriented. It is good for serving
observations but not ideal for repeated dashboard reads.

PostgreSQL gives us:

- typed filterable columns for scanner, version, task, and time
- explicit indexes on the fields we actually filter on
- cheap SQL aggregates for counts, missingness, histograms, and top values
- a clean path to dedupe-aware serving layers on top of raw ingestion tables
- a clean path to materialized views for frequently repeated dashboard queries

The migration is therefore not about replacing MongoDB because MongoDB is
generally inadequate. It is about aligning the storage engine and schema shape
with a specific analytical dashboard workload centered on reference
distributions and study-to-population comparison.

## Recommended Path Forward

The most likely path forward is a layered serving model:

1. Keep the current raw tables as the landing zone for ingestion.
2. Continue computing dedupe metadata at load time so representative semantics
   are available to downstream layers.
3. Add materialized views for the dedupe-aware serving datasets the dashboard
   actually needs.
4. Add pre-aggregated metric distribution artifacts only for the most heavily
   used queries after real usage shows where the hot paths are.

The important point is that raw ingestion and dashboard serving do not need to
be the same physical layer.

### Suggested Serving Layers

Recommended direction:

- raw fact tables: `t1w`, `t2w`, `bold`
- representative materialized views: one row per `dedupe_exact_key` or
  `dedupe_series_key`, depending on the comparison use case
- optional aggregate materialized views: metric distributions and summary stats
  for the most common filter combinations

This would keep ingestion simple while making repeated dashboard reads much
cheaper.

### Why Materialized Views Fit Well

Materialized views are a good match for this project because they are
compatible with ongoing ingestion of newly uploaded MRIQC records.

They allow us to:

- preserve raw source fidelity in the base tables
- refresh representative datasets after new data arrives
- separate ingestion latency from dashboard query latency
- avoid recomputing expensive windowing and aggregation logic on every request

The likely operational model is:

1. ingest new raw rows
2. update or recompute dedupe keys if needed
3. refresh representative materialized views
4. refresh any distribution-oriented materialized views built on top of them

The refresh policy can be tuned later based on freshness requirements:

- refresh after every load for small or moderate updates
- scheduled refreshes for routine background ingestion
- a periodic full reconcile to catch drift or changed dedupe rules

Nothing in the current schema blocks that approach.

## Outstanding Risks At Full-Archive Scale

### 1. Extraction Throughput And API Reliability

The live API is page-based and caps `max_results` at `50`. The current sample
workflow already encountered server-side `500` responses on some `T1w` pages.
At a full `~15 GB` crawl, the extraction path will need:

- resumable downloads
- page-level completeness auditing
- retries with persistent error manifests
- a decision on whether a direct MongoDB export is required for completeness

If extraction remains API-based, extraction time and missing-page handling may
become the biggest operational risk, not the PostgreSQL load itself.

### 2. Storage Amplification In PostgreSQL

`~15 GB` of source payloads will not become only `~15 GB` of PostgreSQL data.
The real footprint will include:

- three wide fact tables
- multiple secondary indexes
- TOAST storage for JSON and text
- WAL during backfills
- free space needed for vacuum and future updates

Disk budgeting should assume a multiple of the raw source size, not parity with
it.

### 3. Upsert Cost On Indexed Wide Rows

The current loader uses batched `INSERT ... ON CONFLICT DO UPDATE` statements.
That is correct for idempotency, but it becomes more expensive as row count,
index count, and row width increase.

For a full backfill, a staging-table strategy may be better:

1. bulk load into minimally indexed staging tables
2. validate and dedupe there
3. merge into the indexed serving tables

Without that, the initial load may spend more time maintaining indexes than
actually ingesting data.

### 4. Representative-Row Queries May Stop Being Cheap

The current `exact` and `series` views are computed from raw tables using
window-function ranking. That is reasonable at the current size, but it may
become an issue under repeated dashboard traffic at full scale.

The preferred next step is likely materialized views, because they preserve the
raw tables as the ingestion layer while giving the dashboard a stable,
dedupe-aware serving layer.

Possible follow-up options:

- materialized views
- precomputed canonical tables
- dedicated duplicate group tables

### 5. JSON Extras Are Preserved But Not Yet Optimized

Using `JSON` for the extra fragments is the right ingestion choice, but it is
not the fastest long-term query shape if the dashboard starts filtering on those
keys.

If extras become product-critical, we will likely want one or both of:

- promoted typed columns
- `JSONB` plus GIN indexes for the remaining semi-structured fields

### 6. Dedupe Quality Depends On Sparse And Inconsistent Metadata

The source data has substantial missingness in fields that would otherwise help
with identity, especially `session_id`, `run_id`, `acq_id`, manufacturer, and
other acquisition metadata.

As the archive grows, sparse metadata can cause:

- false merges in `dedupe_series_key`
- false splits for records that should have grouped together
- inconsistent scanner or session filters in the dashboard

The current dedupe keys are useful, but they should be treated as operational
hints rather than unquestionable ground truth.

### 7. Source Schema Drift

Unknown source keys are preserved, so we should not silently lose data when the
API changes. However, schema drift still has operational cost:

- new fields will stay hidden inside `*_extra` until promoted
- source type changes can break assumptions in the parser
- new MRIQC versions may introduce new dashboard-relevant columns

This argues for keeping schema-drift audits in the load workflow.

### 8. No Normalized Dimensions Yet

The current denormalized design is appropriate for the first dashboard, but it
does mean:

- repeated subject, session, and scanner strings across large tables
- no referential cleanup for casing or spelling variants
- no stable cross-modality entity to anchor richer drill-downs

If dashboard requirements expand toward multi-modality drill-downs, scanner
inventory views, or subject/session pages, dimension tables will likely be the
next normalization step.

## Remaining Issues To Consider Later

These do not block the current migration, but they are worth keeping in view:

- cohort definition: if researchers want study-vs-reference comparison, we may
  eventually need explicit concepts for study membership, site, or submission
  batches rather than inferring everything from scan-level metadata
- freshness expectations: the product should decide how stale distribution views
  are allowed to be after new MRIQC uploads
- scanner normalization: manufacturer and model values may need controlled
  normalization to avoid fragmented distributions caused by spelling or casing
  variants
- version stratification: MRIQC version can materially affect comparability, so
  comparison views may need version-aware defaults
- provenance of benchmark sets: users may eventually need to know exactly which
  rows or filters contributed to a displayed reference distribution
- operational observability: the load pipeline should eventually expose row
  counts, refresh timings, failed pages, and schema-drift signals as first-class
  metrics
- partitioning strategy: not needed yet, but worth revisiting if raw fact tables
  and refresh windows become large enough that vacuum, refresh, or backfill
  costs become hard to manage

## Recommended Follow-Up Before A Full `~15 GB` Load

Before treating this as a production migration, the following upgrades are worth
doing:

1. Add a completeness audit comparing expected source pages or counts with what
   was actually landed.
2. Decide whether the full migration can tolerate API-only extraction or needs a
   direct database export path.
3. Benchmark a staging-table plus merge workflow against the current direct
   upsert path.
4. Measure disk growth including indexes and WAL, not just raw table bytes.
5. Define the first materialized serving layer for dedupe-aware benchmark
   queries.
6. Decide which QC metric distributions should be computed on demand versus
   pre-aggregated.
7. Promote any dashboard-critical fields still living only in `*_extra`.

## Summary

The current migration is intentionally conservative:

- preserve source fidelity
- load only the scan resources needed for the dashboard
- keep raw rows first
- add just enough typing and indexing to support benchmark distributions and
  study-to-population comparison

That is a sound first step. The main risks as we move from the current `~1 GB`
working sample to a full `~15 GB` archive are not correctness of the basic row
mapping, but extraction completeness, ingest cost on wide indexed tables,
dedupe ambiguity under sparse metadata, and building the right dedupe-aware
serving layer for repeated distribution queries.
