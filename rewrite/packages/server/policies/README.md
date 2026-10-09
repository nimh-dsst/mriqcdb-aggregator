# Frozen policy artifacts

Two kinds live here: the per-policy canonicalization **scales**, and the vendor
**mapping** that normalizes the free-text manufacturer string. Both are frozen —
the build reads them, never recomputes them — and both are part of
`data_version`, so editing either invalidates every cached answer.

## Frozen canonicalization scales

Three committed artifacts, one per policy. They are the only numbers the
canonicalization views cannot derive from the data they are applied to, and they
are **frozen per policy version**: ingest reads them, never recomputes them.
Recalibrating the scales is a new policy version (`docs/k3pp-structural-
canonicalization.md`, "Decisions (2026-10-05)"), not an edit to these files.

| file | policy | rows | columns |
|---|---|---|---|
| `k4plus.scales.csv` | K4+ (bold) | 31 | `metric,q25,q75,iqr` |
| `k3pp-t1w.scales.csv` | K3++-T1w | 62 | `metric,q25,q75,iqr,fallback` |
| `k3pp-t2w.scales.csv` | K3++-T2w | 62 | `metric,q25,q75,iqr,fallback` |

`iqr` is the only column the views read. `q25` and `q75` are kept so the IQR can
be checked without recomputing it, and `fallback` records which rows come from the
zero-IQR rule below.

### The recipe

Computed once, on 2026-10-05, from the August 2026 Parquet dump:

1. Read the raw observation file and keep the rows whose **complete vector** is
   entirely finite — no null, NaN or infinity in any component. The complete vector
   is the policy's exact fields plus its continuous metrics:
   `size_x/y/z`, `spacing_x/y/z` and the 62 continuous metrics for K3++;
   the 5 exact metrics and the 31 continuous metrics for K4+.
2. **Deduplicate on that complete vector.** One row per distinct vector, so a scan
   uploaded a thousand times counts once.
3. Per metric, `q25 = quantile_cont(0.25)`, `q75 = quantile_cont(0.75)` and
   `iqr = q75 - q25` over that deduplicated set.
4. **Zero-IQR fallback.** Where `iqr == 0`, take `q25`/`q75`/`iqr` over that
   metric's **non-zero** values within the same deduplicated set and set
   `fallback = true`. Only one metric in this dump needs it: T2w `summary_bg_p05`,
   whose corpus IQR is 0 and whose non-zero IQR is 15.036358946561814. Thirteen
   T2w groups depend on that scale, and the value the artifact implies agrees with
   it to 9 significant digits.

Deduplicated set sizes under this recipe: bold 744,848 vectors, T1w 799,324,
T2w 178,243.

The recipe is not a guess. Reproducing `mriqc_api.bold.K4+.scales.parquet` from
raw bold under it matches **31 of 31 metrics bit-identically on `q25`, `q75` and
`iqr`** (worst relative difference exactly 0); no other candidate row set tried —
distinct raw values, one row per group and vector, the canonical corpus itself —
matches. `k4plus.scales.csv` is therefore a straight copy of that Parquet table,
verified to be reproducible rather than merely transcribed.

Deduplicating on `size_*` only, as the reconstruction audit did, instead of on
`size_*` and `spacing_*`, gives the same deduplicated set size and the same IQR
for all 62 metrics in both modalities. The two readings of the recipe are
indistinguishable in this corpus; the six-field form is the one recorded here.

### Sources

| file | bytes | mtime (UTC) |
|---|---|---|
| `mriqc_api.bold.parquet` | 283,311,682 | 2026-08-20T23:36:42.547Z |
| `mriqc_api.T1w.parquet` | 528,587,583 | 2026-08-21T00:04:49.823Z |
| `mriqc_api.T2w.parquet` | 90,157,199 | 2026-08-20T23:32:51.183Z |
| `mriqc_api.bold.K4+.scales.parquet` | 1,494 | 2026-09-21T22:15:47.476Z |

All four under `C:/Users/licc/projects/mriqc` (`MRIQC_DATA_DIR`), read-only.

### Who reads these files

`src/db/canonical.ts` loads each CSV into a one-table-per-policy scale table and
substitutes the table name into `src/sql/canonical/<policy>.sql`. The loader
refuses a file that is missing a metric the policy names, or that carries a
non-positive `iqr` for one — a zero scale would divide every row to NULL and
quarantine the whole corpus silently. `scripts/validate-canonical.mjs` checks the
views built on them against the Parquet artifacts.

## Frozen vendor mapping

`vendors.csv` — columns `raw,canonical` — is the one artifact that rewrites data
rather than scaling it. `bids_meta.Manufacturer` is free text an uploader typed,
so one vendor arrives as `Siemens`, `SIEMENS`, `SIEMENS␣␣`, `Siemens
Healthineers` and `Simiens`. The build keeps the uploaded string in
`manufacturer_raw` and writes the canonical spelling to `manufacturer`, so
grouping by vendor gives one bar per vendor instead of one per typo. Nothing is
lost: `manufacturer_raw` is a catalog field of its own, "Manufacturer (as
uploaded)".

### The rule

Applied to the uploaded string **before** the lookup, in this order:

1. collapse every run of whitespace to one space, then trim;
2. strip a trailing legal suffix, repeatedly while one matches and never down to
   the empty string: `Healthcare`, `Medical Systems`, `Healthineers`, `Medical`,
   `Inc`, `Ltd`, `GmbH`, `Co.` — each with an optional trailing period and
   requiring a space or comma in front, so `Nanoco` is not truncated to `Nano`;
3. lowercase.

`vendors.csv` lists **post-rule keys**, written lowercase. The lookup lowercases
both sides, so `GE Healthcare`, `GE MEDICAL SYSTEMS` and `ge` all reach the key
`ge`. Underscores are not whitespace, so `GE_MEDICAL_SYSTEMS` is its own key and
is listed as one.

### The canonical set

`Siemens`, `GE`, `Philips`, `Canon`, `Toshiba`, `Bruker`, `United Imaging`,
`Hitachi`, `Fujifilm`, `Mediso`, `Agilent`, `Hyperfine`, and the token `(none)`.

`(none)` covers null, empty, whitespace-only, `n/a`, `unknown`, the bare
placeholder `scanner` and the rest of the non-answers; it becomes **SQL NULL**
in the database, not the literal text, because `(none)` is already the label the
frontend prints for a null or empty categorical value and a filter on it already
expands to "is null or is the empty string".

`Toshiba` is deliberately **not** folded into `Canon`. Canon bought Toshiba
Medical Systems in 2016, but a scan whose header says `Toshiba` was made by a
machine badged Toshiba, and the field records the badge, not today's corporate
owner.

A spelling the file does not list is **not** dropped and is **not** bucketed as
`Other`: it becomes its own trimmed, title-cased self. The suffix rule is a
lookup key, not a rewrite, so an unclassified `Elscint Ltd` stays `Elscint Ltd`.

### Values decided case by case (2026-10-07)

Four spellings the dump carries that are neither a typo for a known vendor nor
an obvious placeholder. Each was ruled on rather than left to the fallback, and
each is listed in `vendors.csv`, so the title-casing fallback never has to fire
on known data:

| raw | rows | ruling |
|---|---|---|
| `Hyperfine` | 541 | **a canonical vendor.** Portable low-field MRI; a real manufacturer, just a newer one than the rest of the set |
| `Synthesized` | 3 | kept as itself, `Synthesized`. Not a vendor — synthetic data — but saying so is more useful than hiding it in `(none)` |
| `MEDICS` | 3 | kept as itself, title-cased to `Medics`. Unidentified; possibly a site or a software name |
| `scanner` | 1 | **`(none)`.** A placeholder, not an answer |

### Who reads this file

`src/db/vendors.ts` parses it, hashes its bytes into `data_version`, and turns
the mapping plus the distinct values actually present in each Parquet file into
the `CASE` expression `src/db/build.ts` projects. The normalization rule lives in
TypeScript, where `src/db/vendors.test.ts` asserts it against every legal suffix
and every spelling the August 2026 dump carries; DuckDB only ever compares exact
literals.

The canonicalization policies are unaffected: their group key is
`(provenance_md5sum, provenance_version, provenance_settings_*)` plus `hmc_mode`
for K4+, their vectors are IQMs, and their `canonical` views select `r.*` from
the raw table — so the rewritten column rides through unchanged and admission is
identical either way.
