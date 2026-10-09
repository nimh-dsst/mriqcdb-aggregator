# K4 BOLD Canonicalization

## Status

K4 is a proposed canonicalization policy for BOLD observations. It is not yet
implemented. Raw observations remain immutable.

## K4 Group Key

```text
K4 = (
  provenance.md5sum,
  provenance.version,
  provenance.settings.fd_thres,
  normalized_hmc_mode
)
```

Key comparisons are exact. `provenance.version` is the original version string,
not a normalized release family.

```text
normalized_hmc_mode =
  "fsl"     if parsed_version < 0.16 and hmc_fsl == true
  "afni"    if parsed_version < 0.16 and hmc_fsl == false
  "afni"    if parsed_version >= 0.16 and hmc_fsl is null
  "unknown" otherwise
```

An unparseable version produces `"unknown"`.

## K4+ Metric Equivalence

K4+ decides whether all observations in one K4 group may share one canonical
record.

```text
exact_metrics = (
  dummy_trs,
  fd_num,
  fd_perc,
  summary_bg_n,
  summary_fg_n
)
```

```text
continuous_metrics = (
  aor,
  aqi,
  dvars_nstd,
  dvars_std,
  dvars_vstd,
  efc,
  fber,
  fd_mean,
  fwhm_avg,
  fwhm_x,
  fwhm_y,
  fwhm_z,
  gcor,
  gsr_x,
  gsr_y,
  snr,
  tsnr,
  summary_bg_k,
  summary_bg_mean,
  summary_bg_median,
  summary_bg_mad,
  summary_bg_p05,
  summary_bg_p95,
  summary_bg_stdv,
  summary_fg_k,
  summary_fg_mean,
  summary_fg_median,
  summary_fg_mad,
  summary_fg_p05,
  summary_fg_p95,
  summary_fg_stdv
)
```

The complete metric vector contains these 36 metrics.

## Frozen Scale

For each continuous metric:

```text
global_iqr[metric] = Q75(metric) - Q25(metric)
```

Compute the IQR over distinct complete 36-metric vectors in the reference BOLD
corpus. For each metric, exclude its null and non-finite values before computing
its quantiles.

The resulting IQR table is immutable within a K4 policy version. Recalibration
creates a new policy version instead of changing the existing table.

## Admission Rule

For every K4 group, compute state over all observations in the group:

```text
invalid_count
distinct_values[exact_metric]
min_value[continuous_metric]
max_value[continuous_metric]
distinct_36_metric_vectors
```

Admit the group if and only if:

```text
invalid_count == 0

and for every exact metric:
  count(distinct_values[metric]) == 1

and for every continuous metric:
  global_iqr[metric] > 0
  (max_value[metric] - min_value[metric]) / global_iqr[metric] <= 1e-6
```

`invalid_count` includes any observation with a null or non-finite value in the
36-metric vector.

The range is computed over the whole group. Pairwise chaining is not permitted.
A single-vector group is admitted only when its complete vector is finite.

On each new observation, update the group state and evaluate the same rule. The
result is state-dependent but independent of observation arrival order. A group
may move from admitted to quarantined when new evidence violates the rule.

## Output

```text
admitted K4 group:
  one canonical group record
  links to every raw observation in the group

quarantined K4 group:
  no canonical metric output
  preserve every raw observation and the failed predicates
```

Admission depends only on whole-group state. It must not depend on which metric
vector is selected for canonical output.

The canonical metric-vector selection rule remains undecided. A medoid is
order-independent but can change as observations arrive; a fixed first vector is
stable but arbitrary and cannot establish that a singleton is correct.

## Corpus Audit

Audit source: 1,515,368 BOLD observations.

```text
K4 groups                              779,973
duplicate K4 groups                    197,228
rows in duplicate K4 groups            932,623
exact-vector removals                   695,837
K4+ fuzzy removals                       35,793
total K4+ removals                      731,630
quarantined groups                        1,898
quarantined rows                          5,663
retained canonical plus quarantine      783,738
corpus reduction                        48.2807%
K4 duplicate excess explained           99.488%
MD5-only removals explained              84.303%
```

All 31 continuous metrics had positive global IQR in this audit.
