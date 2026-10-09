-- K4+ BOLD canonicalization, as `docs/k4-bold-canonicalization.md` defines it and
-- `docs/k3pp-structural-canonicalization.md` confirms against the artifact.
--
-- Holes: {{raw_table}} is the raw observation table, {{scale_table}} the frozen
-- `policies/k4plus.scales.csv` loaded as (metric, q25, q75, iqr). Both are quoted
-- identifiers supplied by `src/db/canonical.ts`; nothing else is substituted.
--
-- Key:        (provenance_md5sum, provenance_version, provenance_settings_fd_thres,
--              hmc_mode), hmc_mode derived from the version and hmc_fsl below.
-- Vector:     5 exact metrics + 31 continuous, normalized by the frozen IQR.
-- Admission:  no null or non-finite value anywhere in the 36-vector, each exact
--             metric with exactly one distinct value, and every normalized range
--             within 1e-6. A metric whose frozen iqr is not > 0 normalizes to NULL,
--             which makes every row non-finite and quarantines the whole corpus
--             loudly rather than admitting on a degenerate scale.
-- Represent.: the member carrying the unweighted L1 medoid of the group's distinct
--             normalized vectors; ties go to the lowest id among the tied vectors'
--             lowest ids.

-- @statement normalized
CREATE OR REPLACE VIEW v_k4plus_bold_normalized AS
WITH scale AS (
  SELECT
    max(iqr) FILTER (WHERE metric = 'aor') AS aor,
    max(iqr) FILTER (WHERE metric = 'aqi') AS aqi,
    max(iqr) FILTER (WHERE metric = 'dvars_nstd') AS dvars_nstd,
    max(iqr) FILTER (WHERE metric = 'dvars_std') AS dvars_std,
    max(iqr) FILTER (WHERE metric = 'dvars_vstd') AS dvars_vstd,
    max(iqr) FILTER (WHERE metric = 'efc') AS efc,
    max(iqr) FILTER (WHERE metric = 'fber') AS fber,
    max(iqr) FILTER (WHERE metric = 'fd_mean') AS fd_mean,
    max(iqr) FILTER (WHERE metric = 'fwhm_avg') AS fwhm_avg,
    max(iqr) FILTER (WHERE metric = 'fwhm_x') AS fwhm_x,
    max(iqr) FILTER (WHERE metric = 'fwhm_y') AS fwhm_y,
    max(iqr) FILTER (WHERE metric = 'fwhm_z') AS fwhm_z,
    max(iqr) FILTER (WHERE metric = 'gcor') AS gcor,
    max(iqr) FILTER (WHERE metric = 'gsr_x') AS gsr_x,
    max(iqr) FILTER (WHERE metric = 'gsr_y') AS gsr_y,
    max(iqr) FILTER (WHERE metric = 'snr') AS snr,
    max(iqr) FILTER (WHERE metric = 'tsnr') AS tsnr,
    max(iqr) FILTER (WHERE metric = 'summary_bg_k') AS summary_bg_k,
    max(iqr) FILTER (WHERE metric = 'summary_bg_mean') AS summary_bg_mean,
    max(iqr) FILTER (WHERE metric = 'summary_bg_median') AS summary_bg_median,
    max(iqr) FILTER (WHERE metric = 'summary_bg_mad') AS summary_bg_mad,
    max(iqr) FILTER (WHERE metric = 'summary_bg_p05') AS summary_bg_p05,
    max(iqr) FILTER (WHERE metric = 'summary_bg_p95') AS summary_bg_p95,
    max(iqr) FILTER (WHERE metric = 'summary_bg_stdv') AS summary_bg_stdv,
    max(iqr) FILTER (WHERE metric = 'summary_fg_k') AS summary_fg_k,
    max(iqr) FILTER (WHERE metric = 'summary_fg_mean') AS summary_fg_mean,
    max(iqr) FILTER (WHERE metric = 'summary_fg_median') AS summary_fg_median,
    max(iqr) FILTER (WHERE metric = 'summary_fg_mad') AS summary_fg_mad,
    max(iqr) FILTER (WHERE metric = 'summary_fg_p05') AS summary_fg_p05,
    max(iqr) FILTER (WHERE metric = 'summary_fg_p95') AS summary_fg_p95,
    max(iqr) FILTER (WHERE metric = 'summary_fg_stdv') AS summary_fg_stdv
  FROM {{scale_table}}
),
-- One cast per metric, so the expressions below stay readable.
keyed AS (
  SELECT
    r.id AS id,
    r.provenance_md5sum AS provenance_md5sum,
    r.provenance_version AS provenance_version,
    r.provenance_settings_fd_thres AS provenance_settings_fd_thres,
    r.provenance_settings_hmc_fsl AS hmc_fsl,
    TRY_CAST(regexp_extract(r.provenance_version,
      '^([0-9]+)\.([0-9]+)', 1) AS INTEGER) AS version_major,
    TRY_CAST(regexp_extract(r.provenance_version,
      '^([0-9]+)\.([0-9]+)', 2) AS INTEGER) AS version_minor,
    CAST(r.dummy_trs AS DOUBLE) AS dummy_trs,
    CAST(r.fd_num AS DOUBLE) AS fd_num,
    CAST(r.fd_perc AS DOUBLE) AS fd_perc,
    CAST(r.summary_bg_n AS DOUBLE) AS summary_bg_n,
    CAST(r.summary_fg_n AS DOUBLE) AS summary_fg_n,
    CAST(r.aor AS DOUBLE) AS aor,
    CAST(r.aqi AS DOUBLE) AS aqi,
    CAST(r.dvars_nstd AS DOUBLE) AS dvars_nstd,
    CAST(r.dvars_std AS DOUBLE) AS dvars_std,
    CAST(r.dvars_vstd AS DOUBLE) AS dvars_vstd,
    CAST(r.efc AS DOUBLE) AS efc,
    CAST(r.fber AS DOUBLE) AS fber,
    CAST(r.fd_mean AS DOUBLE) AS fd_mean,
    CAST(r.fwhm_avg AS DOUBLE) AS fwhm_avg,
    CAST(r.fwhm_x AS DOUBLE) AS fwhm_x,
    CAST(r.fwhm_y AS DOUBLE) AS fwhm_y,
    CAST(r.fwhm_z AS DOUBLE) AS fwhm_z,
    CAST(r.gcor AS DOUBLE) AS gcor,
    CAST(r.gsr_x AS DOUBLE) AS gsr_x,
    CAST(r.gsr_y AS DOUBLE) AS gsr_y,
    CAST(r.snr AS DOUBLE) AS snr,
    CAST(r.tsnr AS DOUBLE) AS tsnr,
    CAST(r.summary_bg_k AS DOUBLE) AS summary_bg_k,
    CAST(r.summary_bg_mean AS DOUBLE) AS summary_bg_mean,
    CAST(r.summary_bg_median AS DOUBLE) AS summary_bg_median,
    CAST(r.summary_bg_mad AS DOUBLE) AS summary_bg_mad,
    CAST(r.summary_bg_p05 AS DOUBLE) AS summary_bg_p05,
    CAST(r.summary_bg_p95 AS DOUBLE) AS summary_bg_p95,
    CAST(r.summary_bg_stdv AS DOUBLE) AS summary_bg_stdv,
    CAST(r.summary_fg_k AS DOUBLE) AS summary_fg_k,
    CAST(r.summary_fg_mean AS DOUBLE) AS summary_fg_mean,
    CAST(r.summary_fg_median AS DOUBLE) AS summary_fg_median,
    CAST(r.summary_fg_mad AS DOUBLE) AS summary_fg_mad,
    CAST(r.summary_fg_p05 AS DOUBLE) AS summary_fg_p05,
    CAST(r.summary_fg_p95 AS DOUBLE) AS summary_fg_p95,
    CAST(r.summary_fg_stdv AS DOUBLE) AS summary_fg_stdv
  FROM {{raw_table}} r
),
-- normalized_hmc_mode, verbatim from the K4 doc: an unparseable version, or a
-- combination the four rules do not cover, is 'unknown'.
moded AS (
  SELECT k.*,
    CASE
      WHEN version_major IS NULL OR version_minor IS NULL THEN 'unknown'
      WHEN version_major = 0 AND version_minor < 16 AND hmc_fsl THEN 'fsl'
      WHEN version_major = 0 AND version_minor < 16 AND NOT hmc_fsl THEN 'afni'
      WHEN NOT (version_major = 0 AND version_minor < 16)
        AND hmc_fsl IS NULL THEN 'afni'
      ELSE 'unknown'
    END AS hmc_mode
  FROM keyed k
),
normalized AS (
  SELECT
    coalesce(CAST(k.provenance_md5sum AS VARCHAR), '<null>')
      || '|' || coalesce(CAST(k.provenance_version AS VARCHAR), '<null>')
      || '|' || coalesce(CAST(k.provenance_settings_fd_thres AS VARCHAR), '<null>')
      || '|' || k.hmc_mode AS group_id,
    k.hmc_mode AS hmc_mode,
    k.id AS id,
    k.dummy_trs AS x_dummy_trs,
    k.fd_num AS x_fd_num,
    k.fd_perc AS x_fd_perc,
    k.summary_bg_n AS x_summary_bg_n,
    k.summary_fg_n AS x_summary_fg_n,
    CASE WHEN isfinite(k.aor) THEN k.aor / s.aor END AS n_aor,
    CASE WHEN isfinite(k.aqi) THEN k.aqi / s.aqi END AS n_aqi,
    CASE WHEN isfinite(k.dvars_nstd) THEN k.dvars_nstd / s.dvars_nstd END AS n_dvars_nstd,
    CASE WHEN isfinite(k.dvars_std) THEN k.dvars_std / s.dvars_std END AS n_dvars_std,
    CASE WHEN isfinite(k.dvars_vstd) THEN k.dvars_vstd / s.dvars_vstd END AS n_dvars_vstd,
    CASE WHEN isfinite(k.efc) THEN k.efc / s.efc END AS n_efc,
    CASE WHEN isfinite(k.fber) THEN k.fber / s.fber END AS n_fber,
    CASE WHEN isfinite(k.fd_mean) THEN k.fd_mean / s.fd_mean END AS n_fd_mean,
    CASE WHEN isfinite(k.fwhm_avg) THEN k.fwhm_avg / s.fwhm_avg END AS n_fwhm_avg,
    CASE WHEN isfinite(k.fwhm_x) THEN k.fwhm_x / s.fwhm_x END AS n_fwhm_x,
    CASE WHEN isfinite(k.fwhm_y) THEN k.fwhm_y / s.fwhm_y END AS n_fwhm_y,
    CASE WHEN isfinite(k.fwhm_z) THEN k.fwhm_z / s.fwhm_z END AS n_fwhm_z,
    CASE WHEN isfinite(k.gcor) THEN k.gcor / s.gcor END AS n_gcor,
    CASE WHEN isfinite(k.gsr_x) THEN k.gsr_x / s.gsr_x END AS n_gsr_x,
    CASE WHEN isfinite(k.gsr_y) THEN k.gsr_y / s.gsr_y END AS n_gsr_y,
    CASE WHEN isfinite(k.snr) THEN k.snr / s.snr END AS n_snr,
    CASE WHEN isfinite(k.tsnr) THEN k.tsnr / s.tsnr END AS n_tsnr,
    CASE WHEN isfinite(k.summary_bg_k) THEN k.summary_bg_k / s.summary_bg_k END AS n_summary_bg_k,
    CASE WHEN isfinite(k.summary_bg_mean) THEN k.summary_bg_mean / s.summary_bg_mean END AS n_summary_bg_mean,
    CASE WHEN isfinite(k.summary_bg_median) THEN k.summary_bg_median / s.summary_bg_median END AS n_summary_bg_median,
    CASE WHEN isfinite(k.summary_bg_mad) THEN k.summary_bg_mad / s.summary_bg_mad END AS n_summary_bg_mad,
    CASE WHEN isfinite(k.summary_bg_p05) THEN k.summary_bg_p05 / s.summary_bg_p05 END AS n_summary_bg_p05,
    CASE WHEN isfinite(k.summary_bg_p95) THEN k.summary_bg_p95 / s.summary_bg_p95 END AS n_summary_bg_p95,
    CASE WHEN isfinite(k.summary_bg_stdv) THEN k.summary_bg_stdv / s.summary_bg_stdv END AS n_summary_bg_stdv,
    CASE WHEN isfinite(k.summary_fg_k) THEN k.summary_fg_k / s.summary_fg_k END AS n_summary_fg_k,
    CASE WHEN isfinite(k.summary_fg_mean) THEN k.summary_fg_mean / s.summary_fg_mean END AS n_summary_fg_mean,
    CASE WHEN isfinite(k.summary_fg_median) THEN k.summary_fg_median / s.summary_fg_median END AS n_summary_fg_median,
    CASE WHEN isfinite(k.summary_fg_mad) THEN k.summary_fg_mad / s.summary_fg_mad END AS n_summary_fg_mad,
    CASE WHEN isfinite(k.summary_fg_p05) THEN k.summary_fg_p05 / s.summary_fg_p05 END AS n_summary_fg_p05,
    CASE WHEN isfinite(k.summary_fg_p95) THEN k.summary_fg_p95 / s.summary_fg_p95 END AS n_summary_fg_p95,
    CASE WHEN isfinite(k.summary_fg_stdv) THEN k.summary_fg_stdv / s.summary_fg_stdv END AS n_summary_fg_stdv
  FROM moded k, scale s
)
SELECT
  n.*,
  (
    n.x_dummy_trs IS NOT NULL AND n.x_fd_num IS NOT NULL AND n.x_fd_perc IS NOT NULL AND
    n.x_summary_bg_n IS NOT NULL AND n.x_summary_fg_n IS NOT NULL AND isfinite(n.x_dummy_trs) AND
    isfinite(n.x_fd_num) AND isfinite(n.x_fd_perc) AND isfinite(n.x_summary_bg_n) AND
    isfinite(n.x_summary_fg_n) AND n.n_aor IS NOT NULL AND n.n_aqi IS NOT NULL AND
    n.n_dvars_nstd IS NOT NULL AND n.n_dvars_std IS NOT NULL AND n.n_dvars_vstd IS NOT NULL AND
    n.n_efc IS NOT NULL AND n.n_fber IS NOT NULL AND n.n_fd_mean IS NOT NULL AND
    n.n_fwhm_avg IS NOT NULL AND n.n_fwhm_x IS NOT NULL AND n.n_fwhm_y IS NOT NULL AND
    n.n_fwhm_z IS NOT NULL AND n.n_gcor IS NOT NULL AND n.n_gsr_x IS NOT NULL AND
    n.n_gsr_y IS NOT NULL AND n.n_snr IS NOT NULL AND n.n_tsnr IS NOT NULL AND
    n.n_summary_bg_k IS NOT NULL AND n.n_summary_bg_mean IS NOT NULL AND
    n.n_summary_bg_median IS NOT NULL AND n.n_summary_bg_mad IS NOT NULL AND
    n.n_summary_bg_p05 IS NOT NULL AND n.n_summary_bg_p95 IS NOT NULL AND
    n.n_summary_bg_stdv IS NOT NULL AND n.n_summary_fg_k IS NOT NULL AND
    n.n_summary_fg_mean IS NOT NULL AND n.n_summary_fg_median IS NOT NULL AND
    n.n_summary_fg_mad IS NOT NULL AND n.n_summary_fg_p05 IS NOT NULL AND
    n.n_summary_fg_p95 IS NOT NULL AND n.n_summary_fg_stdv IS NOT NULL
  ) AS vector_finite,
  hash(
    n.x_dummy_trs, n.x_fd_num, n.x_fd_perc, n.x_summary_bg_n, n.x_summary_fg_n, n.n_aor, n.n_aqi,
    n.n_dvars_nstd, n.n_dvars_std, n.n_dvars_vstd, n.n_efc, n.n_fber, n.n_fd_mean, n.n_fwhm_avg,
    n.n_fwhm_x, n.n_fwhm_y, n.n_fwhm_z, n.n_gcor, n.n_gsr_x, n.n_gsr_y, n.n_snr, n.n_tsnr,
    n.n_summary_bg_k, n.n_summary_bg_mean, n.n_summary_bg_median, n.n_summary_bg_mad,
    n.n_summary_bg_p05, n.n_summary_bg_p95, n.n_summary_bg_stdv, n.n_summary_fg_k,
    n.n_summary_fg_mean, n.n_summary_fg_median, n.n_summary_fg_mad, n.n_summary_fg_p05,
    n.n_summary_fg_p95, n.n_summary_fg_stdv
  ) AS vector_hash
FROM normalized n;

-- @statement groups
CREATE OR REPLACE VIEW v_k4plus_bold_groups AS
WITH aggregated AS (
  SELECT
    group_id,
    min(hmc_mode) AS hmc_mode,
    count(*) AS group_rows,
    count(DISTINCT vector_hash) AS distinct_vectors,
    count(*) FILTER (WHERE NOT vector_finite) AS nonfinite_rows,
    (count(DISTINCT x_dummy_trs) = 1) AS dummy_trs_constant,
    (count(DISTINCT x_fd_num) = 1) AS fd_num_constant,
    (count(DISTINCT x_fd_perc) = 1) AS fd_perc_constant,
    (count(DISTINCT x_summary_bg_n) = 1) AS summary_bg_n_constant,
    (count(DISTINCT x_summary_fg_n) = 1) AS summary_fg_n_constant,
    max(n_aor) - min(n_aor) AS rng_aor,
    max(n_aqi) - min(n_aqi) AS rng_aqi,
    max(n_dvars_nstd) - min(n_dvars_nstd) AS rng_dvars_nstd,
    max(n_dvars_std) - min(n_dvars_std) AS rng_dvars_std,
    max(n_dvars_vstd) - min(n_dvars_vstd) AS rng_dvars_vstd,
    max(n_efc) - min(n_efc) AS rng_efc,
    max(n_fber) - min(n_fber) AS rng_fber,
    max(n_fd_mean) - min(n_fd_mean) AS rng_fd_mean,
    max(n_fwhm_avg) - min(n_fwhm_avg) AS rng_fwhm_avg,
    max(n_fwhm_x) - min(n_fwhm_x) AS rng_fwhm_x,
    max(n_fwhm_y) - min(n_fwhm_y) AS rng_fwhm_y,
    max(n_fwhm_z) - min(n_fwhm_z) AS rng_fwhm_z,
    max(n_gcor) - min(n_gcor) AS rng_gcor,
    max(n_gsr_x) - min(n_gsr_x) AS rng_gsr_x,
    max(n_gsr_y) - min(n_gsr_y) AS rng_gsr_y,
    max(n_snr) - min(n_snr) AS rng_snr,
    max(n_tsnr) - min(n_tsnr) AS rng_tsnr,
    max(n_summary_bg_k) - min(n_summary_bg_k) AS rng_summary_bg_k,
    max(n_summary_bg_mean) - min(n_summary_bg_mean) AS rng_summary_bg_mean,
    max(n_summary_bg_median) - min(n_summary_bg_median) AS rng_summary_bg_median,
    max(n_summary_bg_mad) - min(n_summary_bg_mad) AS rng_summary_bg_mad,
    max(n_summary_bg_p05) - min(n_summary_bg_p05) AS rng_summary_bg_p05,
    max(n_summary_bg_p95) - min(n_summary_bg_p95) AS rng_summary_bg_p95,
    max(n_summary_bg_stdv) - min(n_summary_bg_stdv) AS rng_summary_bg_stdv,
    max(n_summary_fg_k) - min(n_summary_fg_k) AS rng_summary_fg_k,
    max(n_summary_fg_mean) - min(n_summary_fg_mean) AS rng_summary_fg_mean,
    max(n_summary_fg_median) - min(n_summary_fg_median) AS rng_summary_fg_median,
    max(n_summary_fg_mad) - min(n_summary_fg_mad) AS rng_summary_fg_mad,
    max(n_summary_fg_p05) - min(n_summary_fg_p05) AS rng_summary_fg_p05,
    max(n_summary_fg_p95) - min(n_summary_fg_p95) AS rng_summary_fg_p95,
    max(n_summary_fg_stdv) - min(n_summary_fg_stdv) AS rng_summary_fg_stdv
  FROM v_k4plus_bold_normalized
  GROUP BY group_id
),
measured AS (
  SELECT
    aggregated.*,
    greatest(
      rng_aor, rng_aqi, rng_dvars_nstd, rng_dvars_std, rng_dvars_vstd, rng_efc, rng_fber,
      rng_fd_mean, rng_fwhm_avg, rng_fwhm_x, rng_fwhm_y, rng_fwhm_z, rng_gcor, rng_gsr_x,
      rng_gsr_y, rng_snr, rng_tsnr, rng_summary_bg_k, rng_summary_bg_mean, rng_summary_bg_median,
      rng_summary_bg_mad, rng_summary_bg_p05, rng_summary_bg_p95, rng_summary_bg_stdv,
      rng_summary_fg_k, rng_summary_fg_mean, rng_summary_fg_median, rng_summary_fg_mad,
      rng_summary_fg_p05, rng_summary_fg_p95, rng_summary_fg_stdv
    ) AS diameter
  FROM aggregated
)
SELECT
  measured.*,
  (nonfinite_rows > 0) AS has_nonfinite,
  (
    dummy_trs_constant AND fd_num_constant AND fd_perc_constant AND summary_bg_n_constant AND
    summary_fg_n_constant
  ) AS exact_constant,
  (
    nonfinite_rows = 0
    AND (
      dummy_trs_constant AND fd_num_constant AND fd_perc_constant AND summary_bg_n_constant AND
      summary_fg_n_constant
    )
    AND diameter IS NOT NULL
    AND diameter <= 1e-6
  ) AS admitted
FROM measured;

-- @statement members
CREATE OR REPLACE VIEW v_k4plus_bold_members AS
SELECT n.group_id, n.id
FROM v_k4plus_bold_normalized n
JOIN v_k4plus_bold_groups g USING (group_id)
WHERE g.admitted;

-- @statement vectors
CREATE OR REPLACE VIEW v_k4plus_bold_vectors AS
SELECT
  n.group_id,
  n.vector_hash,
  count(*) AS vector_rows,
  min(n.id) AS vector_min_id,
  any_value(n.n_aor) AS c_aor,
  any_value(n.n_aqi) AS c_aqi,
  any_value(n.n_dvars_nstd) AS c_dvars_nstd,
  any_value(n.n_dvars_std) AS c_dvars_std,
  any_value(n.n_dvars_vstd) AS c_dvars_vstd,
  any_value(n.n_efc) AS c_efc,
  any_value(n.n_fber) AS c_fber,
  any_value(n.n_fd_mean) AS c_fd_mean,
  any_value(n.n_fwhm_avg) AS c_fwhm_avg,
  any_value(n.n_fwhm_x) AS c_fwhm_x,
  any_value(n.n_fwhm_y) AS c_fwhm_y,
  any_value(n.n_fwhm_z) AS c_fwhm_z,
  any_value(n.n_gcor) AS c_gcor,
  any_value(n.n_gsr_x) AS c_gsr_x,
  any_value(n.n_gsr_y) AS c_gsr_y,
  any_value(n.n_snr) AS c_snr,
  any_value(n.n_tsnr) AS c_tsnr,
  any_value(n.n_summary_bg_k) AS c_summary_bg_k,
  any_value(n.n_summary_bg_mean) AS c_summary_bg_mean,
  any_value(n.n_summary_bg_median) AS c_summary_bg_median,
  any_value(n.n_summary_bg_mad) AS c_summary_bg_mad,
  any_value(n.n_summary_bg_p05) AS c_summary_bg_p05,
  any_value(n.n_summary_bg_p95) AS c_summary_bg_p95,
  any_value(n.n_summary_bg_stdv) AS c_summary_bg_stdv,
  any_value(n.n_summary_fg_k) AS c_summary_fg_k,
  any_value(n.n_summary_fg_mean) AS c_summary_fg_mean,
  any_value(n.n_summary_fg_median) AS c_summary_fg_median,
  any_value(n.n_summary_fg_mad) AS c_summary_fg_mad,
  any_value(n.n_summary_fg_p05) AS c_summary_fg_p05,
  any_value(n.n_summary_fg_p95) AS c_summary_fg_p95,
  any_value(n.n_summary_fg_stdv) AS c_summary_fg_stdv
FROM v_k4plus_bold_normalized n
JOIN v_k4plus_bold_groups g USING (group_id)
WHERE g.admitted
GROUP BY n.group_id, n.vector_hash;

-- @statement vector_cost
CREATE OR REPLACE VIEW v_k4plus_bold_vector_cost AS
WITH admitted AS (
  SELECT group_id, distinct_vectors FROM v_k4plus_bold_groups WHERE admitted
),
singleton AS (
  SELECT v.group_id, v.vector_hash, v.vector_min_id, CAST(0 AS DOUBLE) AS dist_sum,
         'observed_normalized_l1_medoid' AS canonical_selection
  FROM v_k4plus_bold_vectors v JOIN admitted a USING (group_id)
  WHERE a.distinct_vectors = 1
),
pairable AS (
  SELECT v.* FROM v_k4plus_bold_vectors v JOIN admitted a USING (group_id)
  WHERE a.distinct_vectors > 1 AND a.distinct_vectors <= 2000
),
medoid AS (
  SELECT a.group_id, a.vector_hash, a.vector_min_id,
         sum(
           abs(a.c_aor - b.c_aor) + abs(a.c_aqi - b.c_aqi) +
           abs(a.c_dvars_nstd - b.c_dvars_nstd) + abs(a.c_dvars_std - b.c_dvars_std) +
           abs(a.c_dvars_vstd - b.c_dvars_vstd) + abs(a.c_efc - b.c_efc) +
           abs(a.c_fber - b.c_fber) + abs(a.c_fd_mean - b.c_fd_mean) +
           abs(a.c_fwhm_avg - b.c_fwhm_avg) + abs(a.c_fwhm_x - b.c_fwhm_x) +
           abs(a.c_fwhm_y - b.c_fwhm_y) + abs(a.c_fwhm_z - b.c_fwhm_z) +
           abs(a.c_gcor - b.c_gcor) + abs(a.c_gsr_x - b.c_gsr_x) + abs(a.c_gsr_y - b.c_gsr_y) +
           abs(a.c_snr - b.c_snr) + abs(a.c_tsnr - b.c_tsnr) +
           abs(a.c_summary_bg_k - b.c_summary_bg_k) +
           abs(a.c_summary_bg_mean - b.c_summary_bg_mean) +
           abs(a.c_summary_bg_median - b.c_summary_bg_median) +
           abs(a.c_summary_bg_mad - b.c_summary_bg_mad) +
           abs(a.c_summary_bg_p05 - b.c_summary_bg_p05) +
           abs(a.c_summary_bg_p95 - b.c_summary_bg_p95) +
           abs(a.c_summary_bg_stdv - b.c_summary_bg_stdv) +
           abs(a.c_summary_fg_k - b.c_summary_fg_k) +
           abs(a.c_summary_fg_mean - b.c_summary_fg_mean) +
           abs(a.c_summary_fg_median - b.c_summary_fg_median) +
           abs(a.c_summary_fg_mad - b.c_summary_fg_mad) +
           abs(a.c_summary_fg_p05 - b.c_summary_fg_p05) +
           abs(a.c_summary_fg_p95 - b.c_summary_fg_p95) +
           abs(a.c_summary_fg_stdv - b.c_summary_fg_stdv)
         ) AS dist_sum,
         'observed_normalized_l1_medoid' AS canonical_selection
  FROM pairable a JOIN pairable b USING (group_id)
  GROUP BY a.group_id, a.vector_hash, a.vector_min_id
),
oversized AS (
  SELECT v.* FROM v_k4plus_bold_vectors v JOIN admitted a USING (group_id)
  WHERE a.distinct_vectors > 2000
),
center AS (
  SELECT group_id,
         median(c_aor) AS m_aor, median(c_aqi) AS m_aqi, median(c_dvars_nstd) AS m_dvars_nstd,
         median(c_dvars_std) AS m_dvars_std, median(c_dvars_vstd) AS m_dvars_vstd,
         median(c_efc) AS m_efc, median(c_fber) AS m_fber, median(c_fd_mean) AS m_fd_mean,
         median(c_fwhm_avg) AS m_fwhm_avg, median(c_fwhm_x) AS m_fwhm_x,
         median(c_fwhm_y) AS m_fwhm_y, median(c_fwhm_z) AS m_fwhm_z, median(c_gcor) AS m_gcor,
         median(c_gsr_x) AS m_gsr_x, median(c_gsr_y) AS m_gsr_y, median(c_snr) AS m_snr,
         median(c_tsnr) AS m_tsnr, median(c_summary_bg_k) AS m_summary_bg_k,
         median(c_summary_bg_mean) AS m_summary_bg_mean,
         median(c_summary_bg_median) AS m_summary_bg_median,
         median(c_summary_bg_mad) AS m_summary_bg_mad,
         median(c_summary_bg_p05) AS m_summary_bg_p05,
         median(c_summary_bg_p95) AS m_summary_bg_p95,
         median(c_summary_bg_stdv) AS m_summary_bg_stdv,
         median(c_summary_fg_k) AS m_summary_fg_k,
         median(c_summary_fg_mean) AS m_summary_fg_mean,
         median(c_summary_fg_median) AS m_summary_fg_median,
         median(c_summary_fg_mad) AS m_summary_fg_mad,
         median(c_summary_fg_p05) AS m_summary_fg_p05,
         median(c_summary_fg_p95) AS m_summary_fg_p95,
         median(c_summary_fg_stdv) AS m_summary_fg_stdv
  FROM oversized GROUP BY group_id
),
proxy AS (
  SELECT o.group_id, o.vector_hash, o.vector_min_id,
         (
           abs(o.c_aor - c.m_aor) + abs(o.c_aqi - c.m_aqi) +
           abs(o.c_dvars_nstd - c.m_dvars_nstd) + abs(o.c_dvars_std - c.m_dvars_std) +
           abs(o.c_dvars_vstd - c.m_dvars_vstd) + abs(o.c_efc - c.m_efc) +
           abs(o.c_fber - c.m_fber) + abs(o.c_fd_mean - c.m_fd_mean) +
           abs(o.c_fwhm_avg - c.m_fwhm_avg) + abs(o.c_fwhm_x - c.m_fwhm_x) +
           abs(o.c_fwhm_y - c.m_fwhm_y) + abs(o.c_fwhm_z - c.m_fwhm_z) +
           abs(o.c_gcor - c.m_gcor) + abs(o.c_gsr_x - c.m_gsr_x) + abs(o.c_gsr_y - c.m_gsr_y) +
           abs(o.c_snr - c.m_snr) + abs(o.c_tsnr - c.m_tsnr) +
           abs(o.c_summary_bg_k - c.m_summary_bg_k) +
           abs(o.c_summary_bg_mean - c.m_summary_bg_mean) +
           abs(o.c_summary_bg_median - c.m_summary_bg_median) +
           abs(o.c_summary_bg_mad - c.m_summary_bg_mad) +
           abs(o.c_summary_bg_p05 - c.m_summary_bg_p05) +
           abs(o.c_summary_bg_p95 - c.m_summary_bg_p95) +
           abs(o.c_summary_bg_stdv - c.m_summary_bg_stdv) +
           abs(o.c_summary_fg_k - c.m_summary_fg_k) +
           abs(o.c_summary_fg_mean - c.m_summary_fg_mean) +
           abs(o.c_summary_fg_median - c.m_summary_fg_median) +
           abs(o.c_summary_fg_mad - c.m_summary_fg_mad) +
           abs(o.c_summary_fg_p05 - c.m_summary_fg_p05) +
           abs(o.c_summary_fg_p95 - c.m_summary_fg_p95) +
           abs(o.c_summary_fg_stdv - c.m_summary_fg_stdv)
         ) AS dist_sum,
         'median_proxy' AS canonical_selection
  FROM oversized o JOIN center c USING (group_id)
)
SELECT * FROM singleton
UNION ALL SELECT * FROM medoid
UNION ALL SELECT * FROM proxy;

-- @statement representative
CREATE OR REPLACE VIEW v_k4plus_bold_representative AS
WITH ranked AS (
  SELECT c.*, min(c.dist_sum) OVER (PARTITION BY c.group_id) AS min_dist
  FROM v_k4plus_bold_vector_cost c
),
tied AS (
  SELECT * FROM ranked WHERE dist_sum <= min_dist * (1 + 1e-9) + 1e-18
)
SELECT
  group_id,
  min(vector_min_id) AS rep_id,
  min(min_dist) AS rep_cost,
  count(*) AS tie_set_size,
  min(canonical_selection) AS canonical_selection
FROM tied
GROUP BY group_id;

-- @statement canonical
CREATE OR REPLACE VIEW v_k4plus_bold_canonical AS
SELECT
  r.*,
  'K4+' AS canonical_policy,
  g.group_rows AS canonical_group_rows,
  g.distinct_vectors AS canonical_distinct_vectors,
  g.diameter AS canonical_diameter,
  g.hmc_mode AS canonical_hmc_mode,
  rep.canonical_selection AS canonical_selection
FROM v_k4plus_bold_representative rep
JOIN v_k4plus_bold_groups g USING (group_id)
JOIN {{raw_table}} r ON r.id = rep.rep_id;

-- @statement quarantined_raw
CREATE OR REPLACE VIEW v_k4plus_bold_quarantined_raw AS
SELECT r.*
FROM v_k4plus_bold_normalized n
JOIN v_k4plus_bold_groups g USING (group_id)
JOIN {{raw_table}} r ON r.id = n.id
WHERE NOT g.admitted;
