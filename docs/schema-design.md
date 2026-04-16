# SQLAlchemy Schema Design

## Current ORM Shape

The current ORM exposes three core fact tables:

- `t1w`
- `t2w`
- `bold`

The shared columns intentionally use the same names across all three tables so a
future dashboard-wide `UNION ALL` view can be added without remapping every
field. The modality-specific IQMs stay in their own tables to avoid a sparse
"one giant table" design.

## Why Three Core Tables Are Acceptable

This is a reasonable starting point for the dashboard because:

1. Most MRIQC metrics are modality-specific.
2. Query predicates such as scanner, software version, and acquisition identity
   still remain aligned across tables.
3. The warehouse can add a cross-modality view later without changing the raw
   fact tables.

The main downside is that any dashboard widget spanning all modalities will need
either:

- a `UNION ALL` view over the shared columns, or
- a separate normalized dimension table keyed off the modality tables.

## Dedupe Strategy

The representative pull already shows meaningful duplication:

- `T1w`: 169 duplicate `md5sum` groups in the sample, largest group size 129
- `T2w`: 135 duplicate `md5sum` groups, largest group size 18
- `bold`: 218 duplicate `md5sum` groups, largest group size 6

That suggests a two-stage dedupe strategy:

1. Exact duplicate key:
   - Prefer `provenance.md5sum`
   - Persist as `dedupe_exact_key`
2. Series-level duplicate key:
   - Hash normalized BIDS identity plus stable acquisition fields
   - Persist as `dedupe_series_key`

Recommended canonical-pick order inside a duplicate group:

1. record with non-null `source_md5sum`
2. record with the newest `mriqc_version`
3. record with the most complete BIDS metadata
4. latest `source_created_at`
5. lexicographically highest `source_api_id` as a final tie-breaker

The ORM includes:

- `dedupe_exact_key`
- `dedupe_series_key`
- `dedupe_status`
- `canonical_source_api_id`

That should be enough for initial warehouse loading without locking the pipeline
into one irreversible dedupe policy.

