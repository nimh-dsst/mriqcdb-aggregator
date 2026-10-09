# K3++ Structural Canonicalization: Reconstructed Policy and Audit

Written `2026-10-05`. K3++ for T1w and T2w had no specification beyond four
lines of notes and no code anywhere; the only artifact was the Parquet output
in `../mriqc`. This note reconstructs the policy from that artifact, confirms
the documented K4+ policy for bold the same way, audits all three modalities,
and records an opinion on the tolerance. Analysis scripts and per-step outputs
live in the session scratchpad under `duckcheck/k3pp-audit/`; the method is
DuckDB SQL over the raw and canonical Parquet files, read-only.

## Reconstructed K3++ definition

```
key            = (provenance.md5sum, provenance.version, provenance.settings.testing)
exact fields   = (size_x, size_y, size_z)              -- never decisive, see below
continuous     = 62 metrics: the 58 DOUBLE structural IQMs
                 (cjv, cnr, efc, fber, fwhm_{avg,x,y,z}, icvs_{csf,gm,wm},
                  inu_{med,range}, qi_1, qi_2, rpve_{csf,gm,wm},
                  snr_{csf,gm,total,wm}, snrd_{csf,gm,total,wm},
                  summary_{bg,csf,gm,wm}_{k,mad,mean,median,p05,p95,stdv},
                  tpm_overlap_{csf,gm,wm}, wm2max)
                 plus summary_{bg,csf,gm,wm}_n
scale          = corpus_iqr[m] = quantile_cont(0.75) - quantile_cont(0.25) over the
                 DISTINCT rows whose complete vector (3 exact + 62 continuous) is finite;
                 if that IQR is 0, the IQR over the metric's non-zero values instead
diameter       = max over the 62 metrics of (max - min) / corpus_iqr[m] within the group
admission      = no null or non-finite value in the 62-vector
                 AND size_x/y/z constant within the group
                 AND diameter <= 0.1
representative = medoid of the DISTINCT observed vectors under L1 distance on the
                 IQR-normalized vector, unweighted by multiplicity;
                 the emitted row is the lowest _id carrying that vector
```

Evidence per component, against the T1w artifact (639,605 groups) and the T2w
artifact (129,845 groups):

| Component | Evidence |
|---|---|
| Key | Group sizes match `canonical_group_rows` and each group has exactly one representative for 100% of groups in both modalities. Dropping `testing` breaks 17 T1w and 6 T2w groups; adding subject, session, run or dataset breaks thousands; md5 alone breaks 185,455. |
| Normalization | In the 133 T1w groups where exactly one metric varies, the implied scale equals the corpus IQR to 2.2e-16 relative. Rival normalizations (range over group median, over corpus stddev, raw range) reproduce 0 of 44,111 diameters; range over IQR reproduces 43,986 before the zero-IQR fallback and all of them after. |
| Vector | Recomputed `canonical_diameter` matches all 639,605 T1w and all 129,845 T2w groups (max abs diff 1.4e-17 and 1.8e-13). The 58 DOUBLE metrics alone undershoot in 125 groups; adding `summary_*_n` closes every one. No candidate metric ever exceeds the diameter, so nothing can be excluded. |
| Scale recipe | Reproducing `bold.K4+.scales.parquet` from raw bold: only "deduplicate fully-finite rows on the complete vector, then quantile_cont" matches, 31 of 31 metrics exactly. |
| Zero-IQR fallback | T2w `summary_bg_p05` has IQR 0. The 13 groups that depend on it imply one scale, 15.036358812, which equals the IQR over non-zero values and nothing else tested. |
| Tolerance | Max admitted diameter 0.09999114 (T1w) and 0.09995362 (T2w); none above 0.1. Admission predicted 639,605 and 129,845 groups, matching the artifacts with zero extra and zero missing. |
| Representative | Unweighted L1 medoid over distinct vectors: bold 100%, T1w 99.82%, T2w 99.68%. Row-weighted medoid is worse (bold 79.7%). L1 beats L2 and L∞. Lowest `_id` within the chosen vector: 100%. |
| Exact fields | `size_x/y/z` never vary inside an admitted group, but only 12 T1w raw groups (0 T2w) have varying size and all 12 also fail the diameter test. `spacing_x/y/z` has identical status. The data cannot distinguish size from spacing, nor confirm either is tested. |

## K4+ confirmation (bold)

The documented policy in `k4-bold-canonicalization.md` reproduces the artifact
exactly: 779,973 groups, 778,075 admitted, 1,898 quarantined groups with 5,663
rows, `canonical_hmc_mode` agreeing on all rows, every representative in the
right raw group, zero admitted groups failing the recomputed test and zero
passing groups absent from the artifact. `canonical_diameter` equals the max
normalized range on all 778,075 groups with zero difference.

Quarantine reasons: exact-metric split only, 746 groups; exact plus
continuous, 561; non-finite only, 331; continuous only, 252; non-finite plus
continuous, 8.

One documented number does not reproduce. The doc splits the 731,630 removals
into 695,837 exact-vector and 35,793 fuzzy. Against the medoid representative
the observed split is 708,795 and 22,835, and none of nine alternative
definitions of "exact" yields the documented pair. Every other documented
figure reproduces, so the split is a stale or differently defined number, not a
different corpus.

## Audit

| | T1w (K3++) | T2w (K3++) | bold (K4+) |
|---|---|---|---|
| raw rows | 2,340,058 | 238,441 | 1,515,368 |
| groups | 694,586 | 145,602 | 779,973 |
| duplicate groups (size > 1) | 177,390 | 43,026 | 197,228 |
| rows in duplicate groups | 1,822,862 | 135,865 | 932,623 |
| admitted groups | 639,605 | 129,845 | 778,075 |
| rows in admitted groups | 2,172,064 | 195,317 | 1,509,705 |
| exact-vector removals | 1,472,828 | 50,340 | 708,795 |
| fuzzy removals | 59,631 | 15,132 | 22,835 |
| total removals | 1,532,459 | 65,472 | 731,630 |
| quarantined groups | 54,981 | 15,757 | 1,898 |
| quarantined rows | 167,994 | 43,124 | 5,663 |
| retained (canonical + quarantined raw) | 807,599 | 172,969 | 783,738 |
| distinct md5 | 572,913 | 120,888 | 647,506 |
| corpus reduction | 65.49% | 27.46% | 48.28% |
| duplicate excess explained | 93.13% | 70.52% | 99.49% |
| md5-only removals explained | 86.72% | 55.70% | 84.30% |

Why excluded groups are excluded. T1w: diameter over 0.1 alone accounts for
45,408 of 54,981 quarantined groups, non-finite values alone for 9,481, both
for 80, varying size plus diameter for 12. T2w: diameter alone 15,629 of
15,757, non-finite alone 97, both 31.

### Diameter distribution among admitted groups

| | T1w | T2w | bold |
|---|---|---|---|
| diameter exactly 0 | 595,494 | 117,396 | 767,509 |
| diameter > 1e-6 | 43,949 (6.87%) | 12,410 (9.56%) | 0 |
| p99 | 0.0717 | 0.0735 | 8.9e-9 |
| p99.9 | 0.0964 | 0.0967 | 1.6e-7 |
| max | 0.09999 | 0.09995 | 1.0e-6 |

Within the fuzzy set (diameter above 1e-6), T1w quartiles are 0.021, 0.037,
0.058 with p95 0.089; T2w 0.010, 0.021, 0.047, p95 0.086; bold 8e-9, 2.5e-8,
6.4e-8, p95 2.7e-7. Under K4+'s tolerance of 1e-6, 43,949 T1w and 12,410 T2w
admitted groups would be quarantined.

### What drives fuzzy admissions

Argmax metric of the normalized range, with the median relative difference
(range over group median) in parentheses.

- T1w: `tpm_overlap_wm` 23.7% (0.3%), `tpm_overlap_gm` 22.2% (0.5%),
  `tpm_overlap_csf` 21.3% (1.4%), `qi_2` 12.3% (9.7%), `summary_gm_k` 6.6%
  (4.4%), `qi_1` 3.0% (0.1%), `summary_bg_k` 3.0% (1.4%), `summary_wm_median`
  2.4% (0.1%).
- T2w: `qi_2` 34.7% (4.8%), `tpm_overlap_csf` 18.2% (0.6%), `summary_bg_k`
  11.6% (4.2%), `qi_1` 8.0% (0.4%), `summary_bg_mad` 6.5% (0.5%).
- bold: `dvars_vstd` 88.7% (8.6e-10), `tsnr` 5.7% (8.8e-8).

Over all (group, metric) pairs with a non-zero range inside a fuzzy group, the
relative difference is p50 0.14%, p90 1.0%, p99 9.8%, max 249× for T1w, and
p50 0.25%, p90 1.7%, p99 17%, max 62× for T2w.

### Effect on dashboard statistics

Percent change from raw to canonical.

| Metric | p05 | p50 | p95 |
|---|---|---|---|
| T1w cjv | −2.7% | +15.1% | +1.5% |
| T1w cnr | −23.2% | −13.7% | +2.7% |
| T1w efc | −1.5% | +2.6% | +5.3% |
| T1w snr_total | −7.0% | −9.7% | +6.7% |
| T1w fber | 0% | +10.7% | +36.4% |
| bold fd_mean | +16.9% | +13.0% | +25.1% |
| bold tsnr | −9.1% | −17.5% | −23.8% |
| bold dvars_std | −0.9% | −2.5% | −0.1% |
| T2w (all five metrics) | within ±6% | within ±4%, fber +11.7% | within ±4%, fber +11.7% |

Including quarantined raw rows alongside the canonical set moves these by at
most about two percentage points. The direction is consistent: the raw corpus
over-weights high-quality, repeatedly uploaded scans, so raw understates bold
motion by 13 to 25% and overstates tsnr by 18 to 24%.

## Opinion

**The policy is reproducible and should become a view.** Every admission
decision and every diameter in both structural artifacts is reconstructed
exactly, and the K4+ artifact is reconstructed exactly from its documented
spec. Both can be written as DuckDB views over the raw tables plus a scale
table and materialized on ingest, which replaces the unreproducible Parquet
files with a definition. The one thing that cannot be reconstructed is the
choice between equidistant medoid candidates, which affects about 58% of
multi-vector groups and appears to be implementation-order dependent. The view
should define the tie-break explicitly, lowest `_id` among tied vectors, and
accept that those representatives differ from the artifact's. It has no
statistical consequence, because tied vectors are within tolerance of each
other by construction.

**On the tolerance.** The key fixes the input file by md5 and the software by
exact version string, so every within-group difference is run-to-run
nondeterminism of the same pipeline on the same file. The question 0.1 answers
is therefore not "is this the same measurement" but "was the processing
stable". Read that way, bold's 1e-6 is float noise and 0.1 is a different
regime: the typical fuzzy structural group differs by 0.1 to 0.3% on
segmentation-derived metrics, which is ordinary ANTs and FSL run variance and
is sensibly admitted, but the upper quartile exceeds 5.8% of a corpus IQR, 1%
of pairs differ by 10% or more, and the extremes are tens to hundreds of times.
Those are unstable runs, and calling their medoid "the" value of the scan hides
that instability.

The recommendation is not to tighten the policy, which would quarantine
roughly 33,000 T1w groups and require a new policy version, but to **expose
the diameter the artifact already records**. `canonical_diameter` is a column
on every canonical row. Adding it to the catalog as a numeric filterable field
lets a user ask for processing-stable scans only, for example diameter at most
0.01, without any change to the canonicalization. The default view can stay as
is.

**T2w is the weak case.** K3++ explains 70% of T2w duplicate excess against
99% for bold, and quarantines 10.8% of groups against 0.24%. The residual
duplicates are almost certainly re-uploads with different md5 of the same
acquisition, which no md5-keyed policy can merge. That needs an identity key
from acquisition metadata, which is a separate policy, and until it exists T2w
canonical statistics should be read with that in mind.

**The canonical view should be the dashboard default.** The raw-to-canonical
shifts are not small: bold median framewise displacement moves 13% and median
tsnr 18%. A dashboard that opens on raw presents a population that is
systematically biased toward repeatedly uploaded high-quality scans.

**Small items.** Record both `size_*` and `spacing_*` as exact fields in the
view; neither is ever decisive and both are harmless. Codify the zero-IQR
fallback as the IQR over non-zero values. Update the K4+ doc's exact-versus-
fuzzy split to the observed 708,795 and 22,835, with the definition "member
vector identical to the representative's".

## Decisions (2026-10-05)

Taken with the project owner after the audit:

- **Scales are frozen per policy version.** T1w and T2w scale tables are
  computed once from the August 2026 dump with the recipe above, stored like
  `k4plus_scales`, and never recomputed by ingest. Recalibration is a new
  policy version.
- **Quarantined groups get their own view.** Each modality gains a third view,
  "canonical plus quarantined raw", which appends the raw rows of groups that
  failed admission to the canonical rows. The pure canonical view is unchanged.
  Catalog and status line report quarantined group and row counts.
- **The dashboard opens on the canonical view**, K4+ for bold and K3++ for T1w
  and T2w.
- **`canonical_diameter` becomes a numeric filterable field** and
  `canonical_group_rows` a groupable and filterable field, both on canonical
  views only.
- Defaults accepted without discussion: tie-break by lowest `_id` among tied
  medoid vectors; `size_*` and `spacing_*` both exact; a membership table is
  built; the T2w identity key is a separate future policy.

Resulting work, in order: scale tables for T1w and T2w; the two policy views
and the membership view; a validation harness that regenerates the canonical
tables from raw and diffs them against the Parquet artifacts (expect 100% on
admissions, group sizes and diameters, about 58% on representative ids because
of ties); build and ingest materializing through `CREATE OR REPLACE TABLE` in
one transaction; the quarantined view, the two new catalog fields, and the
default-view change in the server and web packages.
