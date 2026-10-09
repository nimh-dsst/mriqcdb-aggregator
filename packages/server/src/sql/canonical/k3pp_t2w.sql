-- K3++ structural canonicalization for T2w, reconstructed in
-- `docs/k3pp-structural-canonicalization.md` ("Reconstructed K3++ definition").
--
-- Holes: {{raw_table}} is the raw observation table, {{scale_table}} the frozen
-- `policies/k3pp-t2w.scales.csv` loaded as (metric, q25, q75, iqr, fallback).
-- Both are quoted identifiers supplied by `src/db/canonical.ts`; nothing else is
-- substituted.
--
-- Key:        (provenance_md5sum, provenance_version, provenance_settings_testing).
-- Exact:      size_x/y/z and spacing_x/y/z, which must be constant in the group.
--             Neither is ever decisive in this corpus; both are recorded per the
--             policy decision of 2026-10-05.
-- Vector:     the 58 DOUBLE structural IQMs plus the four summary_*_n counts, 62 in
--             all, normalized by the frozen corpus IQR (zero-IQR metrics carry the
--             non-zero-value IQR and are flagged `fallback` in the scale table).
-- Admission:  no null or non-finite value in the 62-vector, the exact fields
--             constant, and every normalized range within 0.1.
-- Represent.: the member carrying the unweighted L1 medoid of the group's distinct
--             normalized vectors; ties go to the lowest id among the tied vectors'
--             lowest ids.

-- @statement normalized
CREATE OR REPLACE VIEW v_k3pp_t2w_normalized AS
WITH scale AS (
  SELECT
    max(iqr) FILTER (WHERE metric = 'cjv') AS cjv,
    max(iqr) FILTER (WHERE metric = 'cnr') AS cnr,
    max(iqr) FILTER (WHERE metric = 'efc') AS efc,
    max(iqr) FILTER (WHERE metric = 'fber') AS fber,
    max(iqr) FILTER (WHERE metric = 'fwhm_avg') AS fwhm_avg,
    max(iqr) FILTER (WHERE metric = 'fwhm_x') AS fwhm_x,
    max(iqr) FILTER (WHERE metric = 'fwhm_y') AS fwhm_y,
    max(iqr) FILTER (WHERE metric = 'fwhm_z') AS fwhm_z,
    max(iqr) FILTER (WHERE metric = 'icvs_csf') AS icvs_csf,
    max(iqr) FILTER (WHERE metric = 'icvs_gm') AS icvs_gm,
    max(iqr) FILTER (WHERE metric = 'icvs_wm') AS icvs_wm,
    max(iqr) FILTER (WHERE metric = 'inu_med') AS inu_med,
    max(iqr) FILTER (WHERE metric = 'inu_range') AS inu_range,
    max(iqr) FILTER (WHERE metric = 'qi_1') AS qi_1,
    max(iqr) FILTER (WHERE metric = 'qi_2') AS qi_2,
    max(iqr) FILTER (WHERE metric = 'rpve_csf') AS rpve_csf,
    max(iqr) FILTER (WHERE metric = 'rpve_gm') AS rpve_gm,
    max(iqr) FILTER (WHERE metric = 'rpve_wm') AS rpve_wm,
    max(iqr) FILTER (WHERE metric = 'snr_csf') AS snr_csf,
    max(iqr) FILTER (WHERE metric = 'snr_gm') AS snr_gm,
    max(iqr) FILTER (WHERE metric = 'snr_total') AS snr_total,
    max(iqr) FILTER (WHERE metric = 'snr_wm') AS snr_wm,
    max(iqr) FILTER (WHERE metric = 'snrd_csf') AS snrd_csf,
    max(iqr) FILTER (WHERE metric = 'snrd_gm') AS snrd_gm,
    max(iqr) FILTER (WHERE metric = 'snrd_total') AS snrd_total,
    max(iqr) FILTER (WHERE metric = 'snrd_wm') AS snrd_wm,
    max(iqr) FILTER (WHERE metric = 'summary_bg_k') AS summary_bg_k,
    max(iqr) FILTER (WHERE metric = 'summary_bg_mad') AS summary_bg_mad,
    max(iqr) FILTER (WHERE metric = 'summary_bg_mean') AS summary_bg_mean,
    max(iqr) FILTER (WHERE metric = 'summary_bg_median') AS summary_bg_median,
    max(iqr) FILTER (WHERE metric = 'summary_bg_p05') AS summary_bg_p05,
    max(iqr) FILTER (WHERE metric = 'summary_bg_p95') AS summary_bg_p95,
    max(iqr) FILTER (WHERE metric = 'summary_bg_stdv') AS summary_bg_stdv,
    max(iqr) FILTER (WHERE metric = 'summary_csf_k') AS summary_csf_k,
    max(iqr) FILTER (WHERE metric = 'summary_csf_mad') AS summary_csf_mad,
    max(iqr) FILTER (WHERE metric = 'summary_csf_mean') AS summary_csf_mean,
    max(iqr) FILTER (WHERE metric = 'summary_csf_median') AS summary_csf_median,
    max(iqr) FILTER (WHERE metric = 'summary_csf_p05') AS summary_csf_p05,
    max(iqr) FILTER (WHERE metric = 'summary_csf_p95') AS summary_csf_p95,
    max(iqr) FILTER (WHERE metric = 'summary_csf_stdv') AS summary_csf_stdv,
    max(iqr) FILTER (WHERE metric = 'summary_gm_k') AS summary_gm_k,
    max(iqr) FILTER (WHERE metric = 'summary_gm_mad') AS summary_gm_mad,
    max(iqr) FILTER (WHERE metric = 'summary_gm_mean') AS summary_gm_mean,
    max(iqr) FILTER (WHERE metric = 'summary_gm_median') AS summary_gm_median,
    max(iqr) FILTER (WHERE metric = 'summary_gm_p05') AS summary_gm_p05,
    max(iqr) FILTER (WHERE metric = 'summary_gm_p95') AS summary_gm_p95,
    max(iqr) FILTER (WHERE metric = 'summary_gm_stdv') AS summary_gm_stdv,
    max(iqr) FILTER (WHERE metric = 'summary_wm_k') AS summary_wm_k,
    max(iqr) FILTER (WHERE metric = 'summary_wm_mad') AS summary_wm_mad,
    max(iqr) FILTER (WHERE metric = 'summary_wm_mean') AS summary_wm_mean,
    max(iqr) FILTER (WHERE metric = 'summary_wm_median') AS summary_wm_median,
    max(iqr) FILTER (WHERE metric = 'summary_wm_p05') AS summary_wm_p05,
    max(iqr) FILTER (WHERE metric = 'summary_wm_p95') AS summary_wm_p95,
    max(iqr) FILTER (WHERE metric = 'summary_wm_stdv') AS summary_wm_stdv,
    max(iqr) FILTER (WHERE metric = 'tpm_overlap_csf') AS tpm_overlap_csf,
    max(iqr) FILTER (WHERE metric = 'tpm_overlap_gm') AS tpm_overlap_gm,
    max(iqr) FILTER (WHERE metric = 'tpm_overlap_wm') AS tpm_overlap_wm,
    max(iqr) FILTER (WHERE metric = 'wm2max') AS wm2max,
    max(iqr) FILTER (WHERE metric = 'summary_bg_n') AS summary_bg_n,
    max(iqr) FILTER (WHERE metric = 'summary_csf_n') AS summary_csf_n,
    max(iqr) FILTER (WHERE metric = 'summary_gm_n') AS summary_gm_n,
    max(iqr) FILTER (WHERE metric = 'summary_wm_n') AS summary_wm_n
  FROM {{scale_table}}
),
-- One cast per metric, so the expressions below stay readable.
keyed AS (
  SELECT
    r.id AS id,
    r.provenance_md5sum AS provenance_md5sum,
    r.provenance_version AS provenance_version,
    r.provenance_settings_testing AS provenance_settings_testing,
    CAST(r.size_x AS DOUBLE) AS size_x,
    CAST(r.size_y AS DOUBLE) AS size_y,
    CAST(r.size_z AS DOUBLE) AS size_z,
    CAST(r.spacing_x AS DOUBLE) AS spacing_x,
    CAST(r.spacing_y AS DOUBLE) AS spacing_y,
    CAST(r.spacing_z AS DOUBLE) AS spacing_z,
    CAST(r.cjv AS DOUBLE) AS cjv,
    CAST(r.cnr AS DOUBLE) AS cnr,
    CAST(r.efc AS DOUBLE) AS efc,
    CAST(r.fber AS DOUBLE) AS fber,
    CAST(r.fwhm_avg AS DOUBLE) AS fwhm_avg,
    CAST(r.fwhm_x AS DOUBLE) AS fwhm_x,
    CAST(r.fwhm_y AS DOUBLE) AS fwhm_y,
    CAST(r.fwhm_z AS DOUBLE) AS fwhm_z,
    CAST(r.icvs_csf AS DOUBLE) AS icvs_csf,
    CAST(r.icvs_gm AS DOUBLE) AS icvs_gm,
    CAST(r.icvs_wm AS DOUBLE) AS icvs_wm,
    CAST(r.inu_med AS DOUBLE) AS inu_med,
    CAST(r.inu_range AS DOUBLE) AS inu_range,
    CAST(r.qi_1 AS DOUBLE) AS qi_1,
    CAST(r.qi_2 AS DOUBLE) AS qi_2,
    CAST(r.rpve_csf AS DOUBLE) AS rpve_csf,
    CAST(r.rpve_gm AS DOUBLE) AS rpve_gm,
    CAST(r.rpve_wm AS DOUBLE) AS rpve_wm,
    CAST(r.snr_csf AS DOUBLE) AS snr_csf,
    CAST(r.snr_gm AS DOUBLE) AS snr_gm,
    CAST(r.snr_total AS DOUBLE) AS snr_total,
    CAST(r.snr_wm AS DOUBLE) AS snr_wm,
    CAST(r.snrd_csf AS DOUBLE) AS snrd_csf,
    CAST(r.snrd_gm AS DOUBLE) AS snrd_gm,
    CAST(r.snrd_total AS DOUBLE) AS snrd_total,
    CAST(r.snrd_wm AS DOUBLE) AS snrd_wm,
    CAST(r.summary_bg_k AS DOUBLE) AS summary_bg_k,
    CAST(r.summary_bg_mad AS DOUBLE) AS summary_bg_mad,
    CAST(r.summary_bg_mean AS DOUBLE) AS summary_bg_mean,
    CAST(r.summary_bg_median AS DOUBLE) AS summary_bg_median,
    CAST(r.summary_bg_p05 AS DOUBLE) AS summary_bg_p05,
    CAST(r.summary_bg_p95 AS DOUBLE) AS summary_bg_p95,
    CAST(r.summary_bg_stdv AS DOUBLE) AS summary_bg_stdv,
    CAST(r.summary_csf_k AS DOUBLE) AS summary_csf_k,
    CAST(r.summary_csf_mad AS DOUBLE) AS summary_csf_mad,
    CAST(r.summary_csf_mean AS DOUBLE) AS summary_csf_mean,
    CAST(r.summary_csf_median AS DOUBLE) AS summary_csf_median,
    CAST(r.summary_csf_p05 AS DOUBLE) AS summary_csf_p05,
    CAST(r.summary_csf_p95 AS DOUBLE) AS summary_csf_p95,
    CAST(r.summary_csf_stdv AS DOUBLE) AS summary_csf_stdv,
    CAST(r.summary_gm_k AS DOUBLE) AS summary_gm_k,
    CAST(r.summary_gm_mad AS DOUBLE) AS summary_gm_mad,
    CAST(r.summary_gm_mean AS DOUBLE) AS summary_gm_mean,
    CAST(r.summary_gm_median AS DOUBLE) AS summary_gm_median,
    CAST(r.summary_gm_p05 AS DOUBLE) AS summary_gm_p05,
    CAST(r.summary_gm_p95 AS DOUBLE) AS summary_gm_p95,
    CAST(r.summary_gm_stdv AS DOUBLE) AS summary_gm_stdv,
    CAST(r.summary_wm_k AS DOUBLE) AS summary_wm_k,
    CAST(r.summary_wm_mad AS DOUBLE) AS summary_wm_mad,
    CAST(r.summary_wm_mean AS DOUBLE) AS summary_wm_mean,
    CAST(r.summary_wm_median AS DOUBLE) AS summary_wm_median,
    CAST(r.summary_wm_p05 AS DOUBLE) AS summary_wm_p05,
    CAST(r.summary_wm_p95 AS DOUBLE) AS summary_wm_p95,
    CAST(r.summary_wm_stdv AS DOUBLE) AS summary_wm_stdv,
    CAST(r.tpm_overlap_csf AS DOUBLE) AS tpm_overlap_csf,
    CAST(r.tpm_overlap_gm AS DOUBLE) AS tpm_overlap_gm,
    CAST(r.tpm_overlap_wm AS DOUBLE) AS tpm_overlap_wm,
    CAST(r.wm2max AS DOUBLE) AS wm2max,
    CAST(r.summary_bg_n AS DOUBLE) AS summary_bg_n,
    CAST(r.summary_csf_n AS DOUBLE) AS summary_csf_n,
    CAST(r.summary_gm_n AS DOUBLE) AS summary_gm_n,
    CAST(r.summary_wm_n AS DOUBLE) AS summary_wm_n
  FROM {{raw_table}} r
),
normalized AS (
  SELECT
    coalesce(CAST(k.provenance_md5sum AS VARCHAR), '<null>')
      || '|' || coalesce(CAST(k.provenance_version AS VARCHAR), '<null>')
      || '|' || coalesce(CAST(k.provenance_settings_testing AS VARCHAR), '<null>') AS group_id,
    k.id AS id,
    k.size_x AS x_size_x,
    k.size_y AS x_size_y,
    k.size_z AS x_size_z,
    k.spacing_x AS x_spacing_x,
    k.spacing_y AS x_spacing_y,
    k.spacing_z AS x_spacing_z,
    CASE WHEN isfinite(k.cjv) THEN k.cjv / s.cjv END AS n_cjv,
    CASE WHEN isfinite(k.cnr) THEN k.cnr / s.cnr END AS n_cnr,
    CASE WHEN isfinite(k.efc) THEN k.efc / s.efc END AS n_efc,
    CASE WHEN isfinite(k.fber) THEN k.fber / s.fber END AS n_fber,
    CASE WHEN isfinite(k.fwhm_avg) THEN k.fwhm_avg / s.fwhm_avg END AS n_fwhm_avg,
    CASE WHEN isfinite(k.fwhm_x) THEN k.fwhm_x / s.fwhm_x END AS n_fwhm_x,
    CASE WHEN isfinite(k.fwhm_y) THEN k.fwhm_y / s.fwhm_y END AS n_fwhm_y,
    CASE WHEN isfinite(k.fwhm_z) THEN k.fwhm_z / s.fwhm_z END AS n_fwhm_z,
    CASE WHEN isfinite(k.icvs_csf) THEN k.icvs_csf / s.icvs_csf END AS n_icvs_csf,
    CASE WHEN isfinite(k.icvs_gm) THEN k.icvs_gm / s.icvs_gm END AS n_icvs_gm,
    CASE WHEN isfinite(k.icvs_wm) THEN k.icvs_wm / s.icvs_wm END AS n_icvs_wm,
    CASE WHEN isfinite(k.inu_med) THEN k.inu_med / s.inu_med END AS n_inu_med,
    CASE WHEN isfinite(k.inu_range) THEN k.inu_range / s.inu_range END AS n_inu_range,
    CASE WHEN isfinite(k.qi_1) THEN k.qi_1 / s.qi_1 END AS n_qi_1,
    CASE WHEN isfinite(k.qi_2) THEN k.qi_2 / s.qi_2 END AS n_qi_2,
    CASE WHEN isfinite(k.rpve_csf) THEN k.rpve_csf / s.rpve_csf END AS n_rpve_csf,
    CASE WHEN isfinite(k.rpve_gm) THEN k.rpve_gm / s.rpve_gm END AS n_rpve_gm,
    CASE WHEN isfinite(k.rpve_wm) THEN k.rpve_wm / s.rpve_wm END AS n_rpve_wm,
    CASE WHEN isfinite(k.snr_csf) THEN k.snr_csf / s.snr_csf END AS n_snr_csf,
    CASE WHEN isfinite(k.snr_gm) THEN k.snr_gm / s.snr_gm END AS n_snr_gm,
    CASE WHEN isfinite(k.snr_total) THEN k.snr_total / s.snr_total END AS n_snr_total,
    CASE WHEN isfinite(k.snr_wm) THEN k.snr_wm / s.snr_wm END AS n_snr_wm,
    CASE WHEN isfinite(k.snrd_csf) THEN k.snrd_csf / s.snrd_csf END AS n_snrd_csf,
    CASE WHEN isfinite(k.snrd_gm) THEN k.snrd_gm / s.snrd_gm END AS n_snrd_gm,
    CASE WHEN isfinite(k.snrd_total) THEN k.snrd_total / s.snrd_total END AS n_snrd_total,
    CASE WHEN isfinite(k.snrd_wm) THEN k.snrd_wm / s.snrd_wm END AS n_snrd_wm,
    CASE WHEN isfinite(k.summary_bg_k) THEN k.summary_bg_k / s.summary_bg_k END AS n_summary_bg_k,
    CASE WHEN isfinite(k.summary_bg_mad) THEN k.summary_bg_mad / s.summary_bg_mad END AS n_summary_bg_mad,
    CASE WHEN isfinite(k.summary_bg_mean) THEN k.summary_bg_mean / s.summary_bg_mean END AS n_summary_bg_mean,
    CASE WHEN isfinite(k.summary_bg_median) THEN k.summary_bg_median / s.summary_bg_median END AS n_summary_bg_median,
    CASE WHEN isfinite(k.summary_bg_p05) THEN k.summary_bg_p05 / s.summary_bg_p05 END AS n_summary_bg_p05,
    CASE WHEN isfinite(k.summary_bg_p95) THEN k.summary_bg_p95 / s.summary_bg_p95 END AS n_summary_bg_p95,
    CASE WHEN isfinite(k.summary_bg_stdv) THEN k.summary_bg_stdv / s.summary_bg_stdv END AS n_summary_bg_stdv,
    CASE WHEN isfinite(k.summary_csf_k) THEN k.summary_csf_k / s.summary_csf_k END AS n_summary_csf_k,
    CASE WHEN isfinite(k.summary_csf_mad) THEN k.summary_csf_mad / s.summary_csf_mad END AS n_summary_csf_mad,
    CASE WHEN isfinite(k.summary_csf_mean) THEN k.summary_csf_mean / s.summary_csf_mean END AS n_summary_csf_mean,
    CASE WHEN isfinite(k.summary_csf_median) THEN k.summary_csf_median / s.summary_csf_median END AS n_summary_csf_median,
    CASE WHEN isfinite(k.summary_csf_p05) THEN k.summary_csf_p05 / s.summary_csf_p05 END AS n_summary_csf_p05,
    CASE WHEN isfinite(k.summary_csf_p95) THEN k.summary_csf_p95 / s.summary_csf_p95 END AS n_summary_csf_p95,
    CASE WHEN isfinite(k.summary_csf_stdv) THEN k.summary_csf_stdv / s.summary_csf_stdv END AS n_summary_csf_stdv,
    CASE WHEN isfinite(k.summary_gm_k) THEN k.summary_gm_k / s.summary_gm_k END AS n_summary_gm_k,
    CASE WHEN isfinite(k.summary_gm_mad) THEN k.summary_gm_mad / s.summary_gm_mad END AS n_summary_gm_mad,
    CASE WHEN isfinite(k.summary_gm_mean) THEN k.summary_gm_mean / s.summary_gm_mean END AS n_summary_gm_mean,
    CASE WHEN isfinite(k.summary_gm_median) THEN k.summary_gm_median / s.summary_gm_median END AS n_summary_gm_median,
    CASE WHEN isfinite(k.summary_gm_p05) THEN k.summary_gm_p05 / s.summary_gm_p05 END AS n_summary_gm_p05,
    CASE WHEN isfinite(k.summary_gm_p95) THEN k.summary_gm_p95 / s.summary_gm_p95 END AS n_summary_gm_p95,
    CASE WHEN isfinite(k.summary_gm_stdv) THEN k.summary_gm_stdv / s.summary_gm_stdv END AS n_summary_gm_stdv,
    CASE WHEN isfinite(k.summary_wm_k) THEN k.summary_wm_k / s.summary_wm_k END AS n_summary_wm_k,
    CASE WHEN isfinite(k.summary_wm_mad) THEN k.summary_wm_mad / s.summary_wm_mad END AS n_summary_wm_mad,
    CASE WHEN isfinite(k.summary_wm_mean) THEN k.summary_wm_mean / s.summary_wm_mean END AS n_summary_wm_mean,
    CASE WHEN isfinite(k.summary_wm_median) THEN k.summary_wm_median / s.summary_wm_median END AS n_summary_wm_median,
    CASE WHEN isfinite(k.summary_wm_p05) THEN k.summary_wm_p05 / s.summary_wm_p05 END AS n_summary_wm_p05,
    CASE WHEN isfinite(k.summary_wm_p95) THEN k.summary_wm_p95 / s.summary_wm_p95 END AS n_summary_wm_p95,
    CASE WHEN isfinite(k.summary_wm_stdv) THEN k.summary_wm_stdv / s.summary_wm_stdv END AS n_summary_wm_stdv,
    CASE WHEN isfinite(k.tpm_overlap_csf) THEN k.tpm_overlap_csf / s.tpm_overlap_csf END AS n_tpm_overlap_csf,
    CASE WHEN isfinite(k.tpm_overlap_gm) THEN k.tpm_overlap_gm / s.tpm_overlap_gm END AS n_tpm_overlap_gm,
    CASE WHEN isfinite(k.tpm_overlap_wm) THEN k.tpm_overlap_wm / s.tpm_overlap_wm END AS n_tpm_overlap_wm,
    CASE WHEN isfinite(k.wm2max) THEN k.wm2max / s.wm2max END AS n_wm2max,
    CASE WHEN isfinite(k.summary_bg_n) THEN k.summary_bg_n / s.summary_bg_n END AS n_summary_bg_n,
    CASE WHEN isfinite(k.summary_csf_n) THEN k.summary_csf_n / s.summary_csf_n END AS n_summary_csf_n,
    CASE WHEN isfinite(k.summary_gm_n) THEN k.summary_gm_n / s.summary_gm_n END AS n_summary_gm_n,
    CASE WHEN isfinite(k.summary_wm_n) THEN k.summary_wm_n / s.summary_wm_n END AS n_summary_wm_n
  FROM keyed k, scale s
)
SELECT
  n.*,
  (
    n.n_cjv IS NOT NULL AND n.n_cnr IS NOT NULL AND n.n_efc IS NOT NULL AND n.n_fber IS NOT NULL AND
    n.n_fwhm_avg IS NOT NULL AND n.n_fwhm_x IS NOT NULL AND n.n_fwhm_y IS NOT NULL AND
    n.n_fwhm_z IS NOT NULL AND n.n_icvs_csf IS NOT NULL AND n.n_icvs_gm IS NOT NULL AND
    n.n_icvs_wm IS NOT NULL AND n.n_inu_med IS NOT NULL AND n.n_inu_range IS NOT NULL AND
    n.n_qi_1 IS NOT NULL AND n.n_qi_2 IS NOT NULL AND n.n_rpve_csf IS NOT NULL AND
    n.n_rpve_gm IS NOT NULL AND n.n_rpve_wm IS NOT NULL AND n.n_snr_csf IS NOT NULL AND
    n.n_snr_gm IS NOT NULL AND n.n_snr_total IS NOT NULL AND n.n_snr_wm IS NOT NULL AND
    n.n_snrd_csf IS NOT NULL AND n.n_snrd_gm IS NOT NULL AND n.n_snrd_total IS NOT NULL AND
    n.n_snrd_wm IS NOT NULL AND n.n_summary_bg_k IS NOT NULL AND n.n_summary_bg_mad IS NOT NULL AND
    n.n_summary_bg_mean IS NOT NULL AND n.n_summary_bg_median IS NOT NULL AND
    n.n_summary_bg_p05 IS NOT NULL AND n.n_summary_bg_p95 IS NOT NULL AND
    n.n_summary_bg_stdv IS NOT NULL AND n.n_summary_csf_k IS NOT NULL AND
    n.n_summary_csf_mad IS NOT NULL AND n.n_summary_csf_mean IS NOT NULL AND
    n.n_summary_csf_median IS NOT NULL AND n.n_summary_csf_p05 IS NOT NULL AND
    n.n_summary_csf_p95 IS NOT NULL AND n.n_summary_csf_stdv IS NOT NULL AND
    n.n_summary_gm_k IS NOT NULL AND n.n_summary_gm_mad IS NOT NULL AND
    n.n_summary_gm_mean IS NOT NULL AND n.n_summary_gm_median IS NOT NULL AND
    n.n_summary_gm_p05 IS NOT NULL AND n.n_summary_gm_p95 IS NOT NULL AND
    n.n_summary_gm_stdv IS NOT NULL AND n.n_summary_wm_k IS NOT NULL AND
    n.n_summary_wm_mad IS NOT NULL AND n.n_summary_wm_mean IS NOT NULL AND
    n.n_summary_wm_median IS NOT NULL AND n.n_summary_wm_p05 IS NOT NULL AND
    n.n_summary_wm_p95 IS NOT NULL AND n.n_summary_wm_stdv IS NOT NULL AND
    n.n_tpm_overlap_csf IS NOT NULL AND n.n_tpm_overlap_gm IS NOT NULL AND
    n.n_tpm_overlap_wm IS NOT NULL AND n.n_wm2max IS NOT NULL AND n.n_summary_bg_n IS NOT NULL AND
    n.n_summary_csf_n IS NOT NULL AND n.n_summary_gm_n IS NOT NULL AND
    n.n_summary_wm_n IS NOT NULL
  ) AS vector_finite,
  hash(
    n.n_cjv, n.n_cnr, n.n_efc, n.n_fber, n.n_fwhm_avg, n.n_fwhm_x, n.n_fwhm_y, n.n_fwhm_z,
    n.n_icvs_csf, n.n_icvs_gm, n.n_icvs_wm, n.n_inu_med, n.n_inu_range, n.n_qi_1, n.n_qi_2,
    n.n_rpve_csf, n.n_rpve_gm, n.n_rpve_wm, n.n_snr_csf, n.n_snr_gm, n.n_snr_total, n.n_snr_wm,
    n.n_snrd_csf, n.n_snrd_gm, n.n_snrd_total, n.n_snrd_wm, n.n_summary_bg_k, n.n_summary_bg_mad,
    n.n_summary_bg_mean, n.n_summary_bg_median, n.n_summary_bg_p05, n.n_summary_bg_p95,
    n.n_summary_bg_stdv, n.n_summary_csf_k, n.n_summary_csf_mad, n.n_summary_csf_mean,
    n.n_summary_csf_median, n.n_summary_csf_p05, n.n_summary_csf_p95, n.n_summary_csf_stdv,
    n.n_summary_gm_k, n.n_summary_gm_mad, n.n_summary_gm_mean, n.n_summary_gm_median,
    n.n_summary_gm_p05, n.n_summary_gm_p95, n.n_summary_gm_stdv, n.n_summary_wm_k,
    n.n_summary_wm_mad, n.n_summary_wm_mean, n.n_summary_wm_median, n.n_summary_wm_p05,
    n.n_summary_wm_p95, n.n_summary_wm_stdv, n.n_tpm_overlap_csf, n.n_tpm_overlap_gm,
    n.n_tpm_overlap_wm, n.n_wm2max, n.n_summary_bg_n, n.n_summary_csf_n, n.n_summary_gm_n,
    n.n_summary_wm_n
  ) AS vector_hash
FROM normalized n;

-- @statement groups
CREATE OR REPLACE VIEW v_k3pp_t2w_groups AS
WITH aggregated AS (
  SELECT
    group_id,
    count(*) AS group_rows,
    count(DISTINCT vector_hash) AS distinct_vectors,
    count(*) FILTER (WHERE NOT vector_finite) AS nonfinite_rows,
    (min(x_size_x) IS NOT DISTINCT FROM max(x_size_x)) AS size_x_constant,
    (min(x_size_y) IS NOT DISTINCT FROM max(x_size_y)) AS size_y_constant,
    (min(x_size_z) IS NOT DISTINCT FROM max(x_size_z)) AS size_z_constant,
    (min(x_spacing_x) IS NOT DISTINCT FROM max(x_spacing_x)) AS spacing_x_constant,
    (min(x_spacing_y) IS NOT DISTINCT FROM max(x_spacing_y)) AS spacing_y_constant,
    (min(x_spacing_z) IS NOT DISTINCT FROM max(x_spacing_z)) AS spacing_z_constant,
    max(n_cjv) - min(n_cjv) AS rng_cjv,
    max(n_cnr) - min(n_cnr) AS rng_cnr,
    max(n_efc) - min(n_efc) AS rng_efc,
    max(n_fber) - min(n_fber) AS rng_fber,
    max(n_fwhm_avg) - min(n_fwhm_avg) AS rng_fwhm_avg,
    max(n_fwhm_x) - min(n_fwhm_x) AS rng_fwhm_x,
    max(n_fwhm_y) - min(n_fwhm_y) AS rng_fwhm_y,
    max(n_fwhm_z) - min(n_fwhm_z) AS rng_fwhm_z,
    max(n_icvs_csf) - min(n_icvs_csf) AS rng_icvs_csf,
    max(n_icvs_gm) - min(n_icvs_gm) AS rng_icvs_gm,
    max(n_icvs_wm) - min(n_icvs_wm) AS rng_icvs_wm,
    max(n_inu_med) - min(n_inu_med) AS rng_inu_med,
    max(n_inu_range) - min(n_inu_range) AS rng_inu_range,
    max(n_qi_1) - min(n_qi_1) AS rng_qi_1,
    max(n_qi_2) - min(n_qi_2) AS rng_qi_2,
    max(n_rpve_csf) - min(n_rpve_csf) AS rng_rpve_csf,
    max(n_rpve_gm) - min(n_rpve_gm) AS rng_rpve_gm,
    max(n_rpve_wm) - min(n_rpve_wm) AS rng_rpve_wm,
    max(n_snr_csf) - min(n_snr_csf) AS rng_snr_csf,
    max(n_snr_gm) - min(n_snr_gm) AS rng_snr_gm,
    max(n_snr_total) - min(n_snr_total) AS rng_snr_total,
    max(n_snr_wm) - min(n_snr_wm) AS rng_snr_wm,
    max(n_snrd_csf) - min(n_snrd_csf) AS rng_snrd_csf,
    max(n_snrd_gm) - min(n_snrd_gm) AS rng_snrd_gm,
    max(n_snrd_total) - min(n_snrd_total) AS rng_snrd_total,
    max(n_snrd_wm) - min(n_snrd_wm) AS rng_snrd_wm,
    max(n_summary_bg_k) - min(n_summary_bg_k) AS rng_summary_bg_k,
    max(n_summary_bg_mad) - min(n_summary_bg_mad) AS rng_summary_bg_mad,
    max(n_summary_bg_mean) - min(n_summary_bg_mean) AS rng_summary_bg_mean,
    max(n_summary_bg_median) - min(n_summary_bg_median) AS rng_summary_bg_median,
    max(n_summary_bg_p05) - min(n_summary_bg_p05) AS rng_summary_bg_p05,
    max(n_summary_bg_p95) - min(n_summary_bg_p95) AS rng_summary_bg_p95,
    max(n_summary_bg_stdv) - min(n_summary_bg_stdv) AS rng_summary_bg_stdv,
    max(n_summary_csf_k) - min(n_summary_csf_k) AS rng_summary_csf_k,
    max(n_summary_csf_mad) - min(n_summary_csf_mad) AS rng_summary_csf_mad,
    max(n_summary_csf_mean) - min(n_summary_csf_mean) AS rng_summary_csf_mean,
    max(n_summary_csf_median) - min(n_summary_csf_median) AS rng_summary_csf_median,
    max(n_summary_csf_p05) - min(n_summary_csf_p05) AS rng_summary_csf_p05,
    max(n_summary_csf_p95) - min(n_summary_csf_p95) AS rng_summary_csf_p95,
    max(n_summary_csf_stdv) - min(n_summary_csf_stdv) AS rng_summary_csf_stdv,
    max(n_summary_gm_k) - min(n_summary_gm_k) AS rng_summary_gm_k,
    max(n_summary_gm_mad) - min(n_summary_gm_mad) AS rng_summary_gm_mad,
    max(n_summary_gm_mean) - min(n_summary_gm_mean) AS rng_summary_gm_mean,
    max(n_summary_gm_median) - min(n_summary_gm_median) AS rng_summary_gm_median,
    max(n_summary_gm_p05) - min(n_summary_gm_p05) AS rng_summary_gm_p05,
    max(n_summary_gm_p95) - min(n_summary_gm_p95) AS rng_summary_gm_p95,
    max(n_summary_gm_stdv) - min(n_summary_gm_stdv) AS rng_summary_gm_stdv,
    max(n_summary_wm_k) - min(n_summary_wm_k) AS rng_summary_wm_k,
    max(n_summary_wm_mad) - min(n_summary_wm_mad) AS rng_summary_wm_mad,
    max(n_summary_wm_mean) - min(n_summary_wm_mean) AS rng_summary_wm_mean,
    max(n_summary_wm_median) - min(n_summary_wm_median) AS rng_summary_wm_median,
    max(n_summary_wm_p05) - min(n_summary_wm_p05) AS rng_summary_wm_p05,
    max(n_summary_wm_p95) - min(n_summary_wm_p95) AS rng_summary_wm_p95,
    max(n_summary_wm_stdv) - min(n_summary_wm_stdv) AS rng_summary_wm_stdv,
    max(n_tpm_overlap_csf) - min(n_tpm_overlap_csf) AS rng_tpm_overlap_csf,
    max(n_tpm_overlap_gm) - min(n_tpm_overlap_gm) AS rng_tpm_overlap_gm,
    max(n_tpm_overlap_wm) - min(n_tpm_overlap_wm) AS rng_tpm_overlap_wm,
    max(n_wm2max) - min(n_wm2max) AS rng_wm2max,
    max(n_summary_bg_n) - min(n_summary_bg_n) AS rng_summary_bg_n,
    max(n_summary_csf_n) - min(n_summary_csf_n) AS rng_summary_csf_n,
    max(n_summary_gm_n) - min(n_summary_gm_n) AS rng_summary_gm_n,
    max(n_summary_wm_n) - min(n_summary_wm_n) AS rng_summary_wm_n
  FROM v_k3pp_t2w_normalized
  GROUP BY group_id
),
measured AS (
  SELECT
    aggregated.*,
    greatest(
      rng_cjv, rng_cnr, rng_efc, rng_fber, rng_fwhm_avg, rng_fwhm_x, rng_fwhm_y, rng_fwhm_z,
      rng_icvs_csf, rng_icvs_gm, rng_icvs_wm, rng_inu_med, rng_inu_range, rng_qi_1, rng_qi_2,
      rng_rpve_csf, rng_rpve_gm, rng_rpve_wm, rng_snr_csf, rng_snr_gm, rng_snr_total, rng_snr_wm,
      rng_snrd_csf, rng_snrd_gm, rng_snrd_total, rng_snrd_wm, rng_summary_bg_k,
      rng_summary_bg_mad, rng_summary_bg_mean, rng_summary_bg_median, rng_summary_bg_p05,
      rng_summary_bg_p95, rng_summary_bg_stdv, rng_summary_csf_k, rng_summary_csf_mad,
      rng_summary_csf_mean, rng_summary_csf_median, rng_summary_csf_p05, rng_summary_csf_p95,
      rng_summary_csf_stdv, rng_summary_gm_k, rng_summary_gm_mad, rng_summary_gm_mean,
      rng_summary_gm_median, rng_summary_gm_p05, rng_summary_gm_p95, rng_summary_gm_stdv,
      rng_summary_wm_k, rng_summary_wm_mad, rng_summary_wm_mean, rng_summary_wm_median,
      rng_summary_wm_p05, rng_summary_wm_p95, rng_summary_wm_stdv, rng_tpm_overlap_csf,
      rng_tpm_overlap_gm, rng_tpm_overlap_wm, rng_wm2max, rng_summary_bg_n, rng_summary_csf_n,
      rng_summary_gm_n, rng_summary_wm_n
    ) AS diameter
  FROM aggregated
)
SELECT
  measured.*,
  (nonfinite_rows > 0) AS has_nonfinite,
  (
    size_x_constant AND size_y_constant AND size_z_constant AND spacing_x_constant AND
    spacing_y_constant AND spacing_z_constant
  ) AS exact_constant,
  (
    nonfinite_rows = 0
    AND (
      size_x_constant AND size_y_constant AND size_z_constant AND spacing_x_constant AND
      spacing_y_constant AND spacing_z_constant
    )
    AND diameter IS NOT NULL
    AND diameter <= 0.1
  ) AS admitted
FROM measured;

-- @statement members
CREATE OR REPLACE VIEW v_k3pp_t2w_members AS
SELECT n.group_id, n.id
FROM v_k3pp_t2w_normalized n
JOIN v_k3pp_t2w_groups g USING (group_id)
WHERE g.admitted;

-- @statement vectors
CREATE OR REPLACE VIEW v_k3pp_t2w_vectors AS
SELECT
  n.group_id,
  n.vector_hash,
  count(*) AS vector_rows,
  min(n.id) AS vector_min_id,
  any_value(n.n_cjv) AS c_cjv,
  any_value(n.n_cnr) AS c_cnr,
  any_value(n.n_efc) AS c_efc,
  any_value(n.n_fber) AS c_fber,
  any_value(n.n_fwhm_avg) AS c_fwhm_avg,
  any_value(n.n_fwhm_x) AS c_fwhm_x,
  any_value(n.n_fwhm_y) AS c_fwhm_y,
  any_value(n.n_fwhm_z) AS c_fwhm_z,
  any_value(n.n_icvs_csf) AS c_icvs_csf,
  any_value(n.n_icvs_gm) AS c_icvs_gm,
  any_value(n.n_icvs_wm) AS c_icvs_wm,
  any_value(n.n_inu_med) AS c_inu_med,
  any_value(n.n_inu_range) AS c_inu_range,
  any_value(n.n_qi_1) AS c_qi_1,
  any_value(n.n_qi_2) AS c_qi_2,
  any_value(n.n_rpve_csf) AS c_rpve_csf,
  any_value(n.n_rpve_gm) AS c_rpve_gm,
  any_value(n.n_rpve_wm) AS c_rpve_wm,
  any_value(n.n_snr_csf) AS c_snr_csf,
  any_value(n.n_snr_gm) AS c_snr_gm,
  any_value(n.n_snr_total) AS c_snr_total,
  any_value(n.n_snr_wm) AS c_snr_wm,
  any_value(n.n_snrd_csf) AS c_snrd_csf,
  any_value(n.n_snrd_gm) AS c_snrd_gm,
  any_value(n.n_snrd_total) AS c_snrd_total,
  any_value(n.n_snrd_wm) AS c_snrd_wm,
  any_value(n.n_summary_bg_k) AS c_summary_bg_k,
  any_value(n.n_summary_bg_mad) AS c_summary_bg_mad,
  any_value(n.n_summary_bg_mean) AS c_summary_bg_mean,
  any_value(n.n_summary_bg_median) AS c_summary_bg_median,
  any_value(n.n_summary_bg_p05) AS c_summary_bg_p05,
  any_value(n.n_summary_bg_p95) AS c_summary_bg_p95,
  any_value(n.n_summary_bg_stdv) AS c_summary_bg_stdv,
  any_value(n.n_summary_csf_k) AS c_summary_csf_k,
  any_value(n.n_summary_csf_mad) AS c_summary_csf_mad,
  any_value(n.n_summary_csf_mean) AS c_summary_csf_mean,
  any_value(n.n_summary_csf_median) AS c_summary_csf_median,
  any_value(n.n_summary_csf_p05) AS c_summary_csf_p05,
  any_value(n.n_summary_csf_p95) AS c_summary_csf_p95,
  any_value(n.n_summary_csf_stdv) AS c_summary_csf_stdv,
  any_value(n.n_summary_gm_k) AS c_summary_gm_k,
  any_value(n.n_summary_gm_mad) AS c_summary_gm_mad,
  any_value(n.n_summary_gm_mean) AS c_summary_gm_mean,
  any_value(n.n_summary_gm_median) AS c_summary_gm_median,
  any_value(n.n_summary_gm_p05) AS c_summary_gm_p05,
  any_value(n.n_summary_gm_p95) AS c_summary_gm_p95,
  any_value(n.n_summary_gm_stdv) AS c_summary_gm_stdv,
  any_value(n.n_summary_wm_k) AS c_summary_wm_k,
  any_value(n.n_summary_wm_mad) AS c_summary_wm_mad,
  any_value(n.n_summary_wm_mean) AS c_summary_wm_mean,
  any_value(n.n_summary_wm_median) AS c_summary_wm_median,
  any_value(n.n_summary_wm_p05) AS c_summary_wm_p05,
  any_value(n.n_summary_wm_p95) AS c_summary_wm_p95,
  any_value(n.n_summary_wm_stdv) AS c_summary_wm_stdv,
  any_value(n.n_tpm_overlap_csf) AS c_tpm_overlap_csf,
  any_value(n.n_tpm_overlap_gm) AS c_tpm_overlap_gm,
  any_value(n.n_tpm_overlap_wm) AS c_tpm_overlap_wm,
  any_value(n.n_wm2max) AS c_wm2max,
  any_value(n.n_summary_bg_n) AS c_summary_bg_n,
  any_value(n.n_summary_csf_n) AS c_summary_csf_n,
  any_value(n.n_summary_gm_n) AS c_summary_gm_n,
  any_value(n.n_summary_wm_n) AS c_summary_wm_n
FROM v_k3pp_t2w_normalized n
JOIN v_k3pp_t2w_groups g USING (group_id)
WHERE g.admitted
GROUP BY n.group_id, n.vector_hash;

-- @statement vector_cost
CREATE OR REPLACE VIEW v_k3pp_t2w_vector_cost AS
WITH admitted AS (
  SELECT group_id, distinct_vectors FROM v_k3pp_t2w_groups WHERE admitted
),
singleton AS (
  SELECT v.group_id, v.vector_hash, v.vector_min_id, CAST(0 AS DOUBLE) AS dist_sum,
         'observed_normalized_l1_medoid' AS canonical_selection
  FROM v_k3pp_t2w_vectors v JOIN admitted a USING (group_id)
  WHERE a.distinct_vectors = 1
),
pairable AS (
  SELECT v.* FROM v_k3pp_t2w_vectors v JOIN admitted a USING (group_id)
  WHERE a.distinct_vectors > 1 AND a.distinct_vectors <= 2000
),
medoid AS (
  SELECT a.group_id, a.vector_hash, a.vector_min_id,
         sum(
           abs(a.c_cjv - b.c_cjv) + abs(a.c_cnr - b.c_cnr) + abs(a.c_efc - b.c_efc) +
           abs(a.c_fber - b.c_fber) + abs(a.c_fwhm_avg - b.c_fwhm_avg) +
           abs(a.c_fwhm_x - b.c_fwhm_x) + abs(a.c_fwhm_y - b.c_fwhm_y) +
           abs(a.c_fwhm_z - b.c_fwhm_z) + abs(a.c_icvs_csf - b.c_icvs_csf) +
           abs(a.c_icvs_gm - b.c_icvs_gm) + abs(a.c_icvs_wm - b.c_icvs_wm) +
           abs(a.c_inu_med - b.c_inu_med) + abs(a.c_inu_range - b.c_inu_range) +
           abs(a.c_qi_1 - b.c_qi_1) + abs(a.c_qi_2 - b.c_qi_2) +
           abs(a.c_rpve_csf - b.c_rpve_csf) + abs(a.c_rpve_gm - b.c_rpve_gm) +
           abs(a.c_rpve_wm - b.c_rpve_wm) + abs(a.c_snr_csf - b.c_snr_csf) +
           abs(a.c_snr_gm - b.c_snr_gm) + abs(a.c_snr_total - b.c_snr_total) +
           abs(a.c_snr_wm - b.c_snr_wm) + abs(a.c_snrd_csf - b.c_snrd_csf) +
           abs(a.c_snrd_gm - b.c_snrd_gm) + abs(a.c_snrd_total - b.c_snrd_total) +
           abs(a.c_snrd_wm - b.c_snrd_wm) + abs(a.c_summary_bg_k - b.c_summary_bg_k) +
           abs(a.c_summary_bg_mad - b.c_summary_bg_mad) +
           abs(a.c_summary_bg_mean - b.c_summary_bg_mean) +
           abs(a.c_summary_bg_median - b.c_summary_bg_median) +
           abs(a.c_summary_bg_p05 - b.c_summary_bg_p05) +
           abs(a.c_summary_bg_p95 - b.c_summary_bg_p95) +
           abs(a.c_summary_bg_stdv - b.c_summary_bg_stdv) +
           abs(a.c_summary_csf_k - b.c_summary_csf_k) +
           abs(a.c_summary_csf_mad - b.c_summary_csf_mad) +
           abs(a.c_summary_csf_mean - b.c_summary_csf_mean) +
           abs(a.c_summary_csf_median - b.c_summary_csf_median) +
           abs(a.c_summary_csf_p05 - b.c_summary_csf_p05) +
           abs(a.c_summary_csf_p95 - b.c_summary_csf_p95) +
           abs(a.c_summary_csf_stdv - b.c_summary_csf_stdv) +
           abs(a.c_summary_gm_k - b.c_summary_gm_k) +
           abs(a.c_summary_gm_mad - b.c_summary_gm_mad) +
           abs(a.c_summary_gm_mean - b.c_summary_gm_mean) +
           abs(a.c_summary_gm_median - b.c_summary_gm_median) +
           abs(a.c_summary_gm_p05 - b.c_summary_gm_p05) +
           abs(a.c_summary_gm_p95 - b.c_summary_gm_p95) +
           abs(a.c_summary_gm_stdv - b.c_summary_gm_stdv) +
           abs(a.c_summary_wm_k - b.c_summary_wm_k) +
           abs(a.c_summary_wm_mad - b.c_summary_wm_mad) +
           abs(a.c_summary_wm_mean - b.c_summary_wm_mean) +
           abs(a.c_summary_wm_median - b.c_summary_wm_median) +
           abs(a.c_summary_wm_p05 - b.c_summary_wm_p05) +
           abs(a.c_summary_wm_p95 - b.c_summary_wm_p95) +
           abs(a.c_summary_wm_stdv - b.c_summary_wm_stdv) +
           abs(a.c_tpm_overlap_csf - b.c_tpm_overlap_csf) +
           abs(a.c_tpm_overlap_gm - b.c_tpm_overlap_gm) +
           abs(a.c_tpm_overlap_wm - b.c_tpm_overlap_wm) + abs(a.c_wm2max - b.c_wm2max) +
           abs(a.c_summary_bg_n - b.c_summary_bg_n) + abs(a.c_summary_csf_n - b.c_summary_csf_n) +
           abs(a.c_summary_gm_n - b.c_summary_gm_n) + abs(a.c_summary_wm_n - b.c_summary_wm_n)
         ) AS dist_sum,
         'observed_normalized_l1_medoid' AS canonical_selection
  FROM pairable a JOIN pairable b USING (group_id)
  GROUP BY a.group_id, a.vector_hash, a.vector_min_id
),
oversized AS (
  SELECT v.* FROM v_k3pp_t2w_vectors v JOIN admitted a USING (group_id)
  WHERE a.distinct_vectors > 2000
),
center AS (
  SELECT group_id,
         median(c_cjv) AS m_cjv, median(c_cnr) AS m_cnr, median(c_efc) AS m_efc,
         median(c_fber) AS m_fber, median(c_fwhm_avg) AS m_fwhm_avg,
         median(c_fwhm_x) AS m_fwhm_x, median(c_fwhm_y) AS m_fwhm_y,
         median(c_fwhm_z) AS m_fwhm_z, median(c_icvs_csf) AS m_icvs_csf,
         median(c_icvs_gm) AS m_icvs_gm, median(c_icvs_wm) AS m_icvs_wm,
         median(c_inu_med) AS m_inu_med, median(c_inu_range) AS m_inu_range,
         median(c_qi_1) AS m_qi_1, median(c_qi_2) AS m_qi_2, median(c_rpve_csf) AS m_rpve_csf,
         median(c_rpve_gm) AS m_rpve_gm, median(c_rpve_wm) AS m_rpve_wm,
         median(c_snr_csf) AS m_snr_csf, median(c_snr_gm) AS m_snr_gm,
         median(c_snr_total) AS m_snr_total, median(c_snr_wm) AS m_snr_wm,
         median(c_snrd_csf) AS m_snrd_csf, median(c_snrd_gm) AS m_snrd_gm,
         median(c_snrd_total) AS m_snrd_total, median(c_snrd_wm) AS m_snrd_wm,
         median(c_summary_bg_k) AS m_summary_bg_k, median(c_summary_bg_mad) AS m_summary_bg_mad,
         median(c_summary_bg_mean) AS m_summary_bg_mean,
         median(c_summary_bg_median) AS m_summary_bg_median,
         median(c_summary_bg_p05) AS m_summary_bg_p05,
         median(c_summary_bg_p95) AS m_summary_bg_p95,
         median(c_summary_bg_stdv) AS m_summary_bg_stdv,
         median(c_summary_csf_k) AS m_summary_csf_k,
         median(c_summary_csf_mad) AS m_summary_csf_mad,
         median(c_summary_csf_mean) AS m_summary_csf_mean,
         median(c_summary_csf_median) AS m_summary_csf_median,
         median(c_summary_csf_p05) AS m_summary_csf_p05,
         median(c_summary_csf_p95) AS m_summary_csf_p95,
         median(c_summary_csf_stdv) AS m_summary_csf_stdv,
         median(c_summary_gm_k) AS m_summary_gm_k, median(c_summary_gm_mad) AS m_summary_gm_mad,
         median(c_summary_gm_mean) AS m_summary_gm_mean,
         median(c_summary_gm_median) AS m_summary_gm_median,
         median(c_summary_gm_p05) AS m_summary_gm_p05,
         median(c_summary_gm_p95) AS m_summary_gm_p95,
         median(c_summary_gm_stdv) AS m_summary_gm_stdv,
         median(c_summary_wm_k) AS m_summary_wm_k, median(c_summary_wm_mad) AS m_summary_wm_mad,
         median(c_summary_wm_mean) AS m_summary_wm_mean,
         median(c_summary_wm_median) AS m_summary_wm_median,
         median(c_summary_wm_p05) AS m_summary_wm_p05,
         median(c_summary_wm_p95) AS m_summary_wm_p95,
         median(c_summary_wm_stdv) AS m_summary_wm_stdv,
         median(c_tpm_overlap_csf) AS m_tpm_overlap_csf,
         median(c_tpm_overlap_gm) AS m_tpm_overlap_gm,
         median(c_tpm_overlap_wm) AS m_tpm_overlap_wm, median(c_wm2max) AS m_wm2max,
         median(c_summary_bg_n) AS m_summary_bg_n, median(c_summary_csf_n) AS m_summary_csf_n,
         median(c_summary_gm_n) AS m_summary_gm_n, median(c_summary_wm_n) AS m_summary_wm_n
  FROM oversized GROUP BY group_id
),
proxy AS (
  SELECT o.group_id, o.vector_hash, o.vector_min_id,
         (
           abs(o.c_cjv - c.m_cjv) + abs(o.c_cnr - c.m_cnr) + abs(o.c_efc - c.m_efc) +
           abs(o.c_fber - c.m_fber) + abs(o.c_fwhm_avg - c.m_fwhm_avg) +
           abs(o.c_fwhm_x - c.m_fwhm_x) + abs(o.c_fwhm_y - c.m_fwhm_y) +
           abs(o.c_fwhm_z - c.m_fwhm_z) + abs(o.c_icvs_csf - c.m_icvs_csf) +
           abs(o.c_icvs_gm - c.m_icvs_gm) + abs(o.c_icvs_wm - c.m_icvs_wm) +
           abs(o.c_inu_med - c.m_inu_med) + abs(o.c_inu_range - c.m_inu_range) +
           abs(o.c_qi_1 - c.m_qi_1) + abs(o.c_qi_2 - c.m_qi_2) +
           abs(o.c_rpve_csf - c.m_rpve_csf) + abs(o.c_rpve_gm - c.m_rpve_gm) +
           abs(o.c_rpve_wm - c.m_rpve_wm) + abs(o.c_snr_csf - c.m_snr_csf) +
           abs(o.c_snr_gm - c.m_snr_gm) + abs(o.c_snr_total - c.m_snr_total) +
           abs(o.c_snr_wm - c.m_snr_wm) + abs(o.c_snrd_csf - c.m_snrd_csf) +
           abs(o.c_snrd_gm - c.m_snrd_gm) + abs(o.c_snrd_total - c.m_snrd_total) +
           abs(o.c_snrd_wm - c.m_snrd_wm) + abs(o.c_summary_bg_k - c.m_summary_bg_k) +
           abs(o.c_summary_bg_mad - c.m_summary_bg_mad) +
           abs(o.c_summary_bg_mean - c.m_summary_bg_mean) +
           abs(o.c_summary_bg_median - c.m_summary_bg_median) +
           abs(o.c_summary_bg_p05 - c.m_summary_bg_p05) +
           abs(o.c_summary_bg_p95 - c.m_summary_bg_p95) +
           abs(o.c_summary_bg_stdv - c.m_summary_bg_stdv) +
           abs(o.c_summary_csf_k - c.m_summary_csf_k) +
           abs(o.c_summary_csf_mad - c.m_summary_csf_mad) +
           abs(o.c_summary_csf_mean - c.m_summary_csf_mean) +
           abs(o.c_summary_csf_median - c.m_summary_csf_median) +
           abs(o.c_summary_csf_p05 - c.m_summary_csf_p05) +
           abs(o.c_summary_csf_p95 - c.m_summary_csf_p95) +
           abs(o.c_summary_csf_stdv - c.m_summary_csf_stdv) +
           abs(o.c_summary_gm_k - c.m_summary_gm_k) +
           abs(o.c_summary_gm_mad - c.m_summary_gm_mad) +
           abs(o.c_summary_gm_mean - c.m_summary_gm_mean) +
           abs(o.c_summary_gm_median - c.m_summary_gm_median) +
           abs(o.c_summary_gm_p05 - c.m_summary_gm_p05) +
           abs(o.c_summary_gm_p95 - c.m_summary_gm_p95) +
           abs(o.c_summary_gm_stdv - c.m_summary_gm_stdv) +
           abs(o.c_summary_wm_k - c.m_summary_wm_k) +
           abs(o.c_summary_wm_mad - c.m_summary_wm_mad) +
           abs(o.c_summary_wm_mean - c.m_summary_wm_mean) +
           abs(o.c_summary_wm_median - c.m_summary_wm_median) +
           abs(o.c_summary_wm_p05 - c.m_summary_wm_p05) +
           abs(o.c_summary_wm_p95 - c.m_summary_wm_p95) +
           abs(o.c_summary_wm_stdv - c.m_summary_wm_stdv) +
           abs(o.c_tpm_overlap_csf - c.m_tpm_overlap_csf) +
           abs(o.c_tpm_overlap_gm - c.m_tpm_overlap_gm) +
           abs(o.c_tpm_overlap_wm - c.m_tpm_overlap_wm) + abs(o.c_wm2max - c.m_wm2max) +
           abs(o.c_summary_bg_n - c.m_summary_bg_n) + abs(o.c_summary_csf_n - c.m_summary_csf_n) +
           abs(o.c_summary_gm_n - c.m_summary_gm_n) + abs(o.c_summary_wm_n - c.m_summary_wm_n)
         ) AS dist_sum,
         'median_proxy' AS canonical_selection
  FROM oversized o JOIN center c USING (group_id)
)
SELECT * FROM singleton
UNION ALL SELECT * FROM medoid
UNION ALL SELECT * FROM proxy;

-- @statement representative
CREATE OR REPLACE VIEW v_k3pp_t2w_representative AS
WITH ranked AS (
  SELECT c.*, min(c.dist_sum) OVER (PARTITION BY c.group_id) AS min_dist
  FROM v_k3pp_t2w_vector_cost c
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
CREATE OR REPLACE VIEW v_k3pp_t2w_canonical AS
SELECT
  r.*,
  'K3++-T2w' AS canonical_policy,
  g.group_rows AS canonical_group_rows,
  g.distinct_vectors AS canonical_distinct_vectors,
  g.diameter AS canonical_diameter,
  rep.canonical_selection AS canonical_selection
FROM v_k3pp_t2w_representative rep
JOIN v_k3pp_t2w_groups g USING (group_id)
JOIN {{raw_table}} r ON r.id = rep.rep_id;

-- @statement quarantined_raw
CREATE OR REPLACE VIEW v_k3pp_t2w_quarantined_raw AS
SELECT r.*
FROM v_k3pp_t2w_normalized n
JOIN v_k3pp_t2w_groups g USING (group_id)
JOIN {{raw_table}} r ON r.id = n.id
WHERE NOT g.admitted;
