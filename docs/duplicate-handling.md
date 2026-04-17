# Duplicate Handling

## Goal

Describe how duplicate handling currently works in `mriqc-aggregator`, what the
current dedupe keys mean, and how consumers should interpret `raw`, `exact`,
and `series` views.

This document reflects the current implementation. It does not define a final
canonicalization policy.

## Current Model

Every raw observation row is loaded into one of:

- `t1w`
- `t2w`
- `bold`

Each row stores:

- `source_api_id`
- `source_md5sum`
- `dedupe_exact_key`
- `dedupe_series_key`
- `dedupe_status`
- `canonical_source_api_id`

The raw tables remain the source of truth. No separate canonical tables exist
yet.

## Two Duplicate Shapes

There are currently two duplicate concepts.

### Exact Duplicates

Exact duplicates are based on `provenance.md5sum`.

- loader behavior: `dedupe_exact_key = source_md5sum`
- interpretation: these rows are treated as byte-level or payload-level
  duplicates when the upstream `md5sum` is present and stable
- strength: high confidence
- weakness: only works when upstream md5 values are present and consistent

This is the strongest duplicate signal in the current system.

### Series Duplicates

Series duplicates are based on a modality-specific identity hash, not on md5.

- loader behavior: `dedupe_series_key = sha256(normalized identity tuple)`
- interpretation: these rows appear to represent the same acquisition signature
  within a modality
- strength: catches likely duplicates even when md5 is missing or changed
- weakness: heuristic, not proof

Series dedupe is intentionally modality-local. It does not attempt to connect
`T1w`, `T2w`, and `bold` to a shared cross-modality scan entity.

## Series Key Construction

The current series key is computed from:

1. a modality-specific ordered field list
2. normalized field values
3. a JSON payload containing `{modality, fields}`
4. a SHA-256 hash of that JSON payload

The implementation lives in
[mriqc_aggregator/parsing.py](../mriqc_aggregator/parsing.py) and
[mriqc_aggregator/models.py](../mriqc_aggregator/models.py).

### Normalization Rules

Before hashing, values are normalized as follows:

- strings: trim, collapse repeated whitespace, lowercase
- floats: round to 12 significant digits
- `None`: kept as `None`
- all other values: used as-is

This is meant to absorb small representational differences without inventing a
more aggressive fuzzy-matching policy.

### Structural Series Fields

For `T1w` and `T2w`, the current series identity fields are:

- `subject_id`
- `session_id`
- `run_id`
- `acq_id`
- `manufacturer`
- `manufacturers_model_name`
- `magnetic_field_strength`
- `echo_time`
- `repetition_time`
- `inversion_time`
- `flip_angle`
- `size_x`
- `size_y`
- `size_z`
- `spacing_x`
- `spacing_y`
- `spacing_z`

### Bold Series Fields

For `bold`, the current series identity fields are:

- `subject_id`
- `session_id`
- `run_id`
- `acq_id`
- `task_id`
- `task_name`
- `manufacturer`
- `manufacturers_model_name`
- `magnetic_field_strength`
- `echo_time`
- `repetition_time`
- `flip_angle`
- `size_t`
- `size_x`
- `size_y`
- `size_z`
- `spacing_tr`
- `spacing_x`
- `spacing_y`
- `spacing_z`

## Representative Row Selection

`raw`, `exact`, and `series` are currently query-time row-selection modes, not
separate stored tables.

- `raw`: every loaded row
- `exact`: one representative row per `dedupe_exact_key`
- `series`: one representative row per `dedupe_series_key`

When a representative row must be chosen for `exact` or `series`, rows are
ranked by:

1. newest `source_created_at`
2. highest `id`

That means:

- the representative row is deterministic
- it is not yet a semantic “best” row
- no completeness-based or quality-based canonical-pick policy is applied yet

## API Semantics

The backend exposes dedupe through the `view` query parameter.

- `view=raw`: no dedupe
- `view=exact`: representative rows by exact duplicate key
- `view=series`: representative rows by series duplicate key

This applies to:

- overview counts
- profile payloads
- metric summaries
- metric histograms
- categorical distributions
- missingness summaries

Duplicate summary endpoints are slightly different:

- duplicate summaries are always computed from the filtered raw rows
- they show actual duplication pressure, not representative-row counts

## Current Meaning Of `dedupe_status`

`dedupe_status` exists in the schema, but it is not driving query behavior yet.

Right now:

- the loader populates it as metadata
- query behavior is controlled by `view`
- no canonical row table or canonical row workflow is implemented

So consumers should not interpret `dedupe_status` as a final adjudication field
yet.

## How To Interpret The Modes

### Use `raw` When

- you want to measure ingestion volume
- you want to inspect upstream messiness directly
- you want duplicate pressure itself to be visible
- you are debugging loader behavior or source irregularities

### Use `exact` When

- you want high-confidence deduped summaries
- you want to remove repeated payloads without applying a broader heuristic
- you want a conservative dashboard default

### Use `series` When

- you want a more aggressive approximation of unique acquisitions
- you want to collapse likely repeats that do not share md5
- you are exploring acquisition-level trends within a modality

## Limitations

Series dedupe is useful, but it is not ground truth.

It can under-collapse when:

- one row has a missing identity field and another does not
- scanner metadata is inconsistently populated
- timing or geometry metadata differs slightly across nominally repeated rows

It can over-collapse when:

- two genuinely different acquisitions share the same identity tuple
- metadata is too coarse to separate distinct scans

It is also intentionally blind to:

- cross-modality relationships
- manual review outcomes
- IQM similarity
- any future canonical-pick policy not yet implemented

## Recommended Consumer Behavior

For frontend and analysis work:

- always send `view` explicitly
- do not rely on the default `view=raw`
- treat `exact` as the conservative deduped view
- treat `series` as a heuristic acquisition-level view
- expose the active dedupe mode clearly in any figure labels or UI state

For debugging duplicate behavior:

- compare the same endpoint under `raw`, `exact`, and `series`
- use `/api/v1/modalities/{modality}/duplicates/exact`
- use `/api/v1/modalities/{modality}/duplicates/series`

## Future Work

Likely next improvements:

- make dedupe mode explicit in the frontend contract, potentially renaming
  `view` to `dedupe_mode`
- add visibility into the exact identity tuple used for a series group
- add completeness-aware or policy-aware canonical selection
- add review workflows for ambiguous series groups
- decide whether canonical tables are needed or whether query-time views remain
  sufficient
