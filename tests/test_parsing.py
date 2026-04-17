from pathlib import Path

from mriqc_aggregator.parsing import (
    compute_dedupe_series_key,
    parse_observation,
    parse_datetime,
    parse_page_number,
)
from mriqc_aggregator.loading import normalize_dump_payload


def test_parse_t1w_observation_preserves_extras() -> None:
    payload = {
        "_id": "abc123def456abc123def456",
        "_etag": "etag",
        "_created": "Thu, 08 Jun 2017 05:54:47 GMT",
        "_updated": "Thu, 08 Jun 2017 05:54:47 GMT",
        "_links": {"self": {"href": "T1w/abc"}},
        "cjv": 0.1,
        "cnr": 0.2,
        "efc": 0.3,
        "fber": 0.4,
        "fwhm_avg": 0.5,
        "fwhm_x": 0.6,
        "fwhm_y": 0.7,
        "fwhm_z": 0.8,
        "icvs_csf": 0.9,
        "icvs_gm": 1.0,
        "icvs_wm": 1.1,
        "inu_med": 1.2,
        "inu_range": 1.3,
        "qi_1": 1.4,
        "qi_2": 1.5,
        "rpve_csf": 1.6,
        "rpve_gm": 1.7,
        "rpve_wm": 1.8,
        "size_x": 176,
        "size_y": 256,
        "size_z": 256,
        "snr_csf": 1.9,
        "snr_gm": 2.0,
        "snr_total": 2.1,
        "snr_wm": 2.2,
        "snrd_csf": 2.3,
        "snrd_gm": 2.4,
        "snrd_total": 2.5,
        "snrd_wm": 2.6,
        "spacing_x": 1.0,
        "spacing_y": 1.0,
        "spacing_z": 1.0,
        "summary_bg_k": 2.7,
        "summary_bg_mean": 2.8,
        "summary_bg_median": 2.9,
        "summary_bg_mad": 3.0,
        "summary_bg_p05": 3.1,
        "summary_bg_p95": 3.2,
        "summary_bg_stdv": 3.3,
        "summary_bg_n": 3.4,
        "summary_csf_k": 3.5,
        "summary_csf_mean": 3.6,
        "summary_csf_median": 3.7,
        "summary_csf_mad": 3.8,
        "summary_csf_p05": 3.9,
        "summary_csf_p95": 4.0,
        "summary_csf_stdv": 4.1,
        "summary_csf_n": 4.2,
        "summary_gm_k": 4.3,
        "summary_gm_mean": 4.4,
        "summary_gm_median": 4.5,
        "summary_gm_mad": 4.6,
        "summary_gm_p05": 4.7,
        "summary_gm_p95": 4.8,
        "summary_gm_stdv": 4.9,
        "summary_gm_n": 5.0,
        "summary_wm_k": 5.1,
        "summary_wm_mean": 5.2,
        "summary_wm_median": 5.3,
        "summary_wm_mad": 5.4,
        "summary_wm_p05": 5.5,
        "summary_wm_p95": 5.6,
        "summary_wm_stdv": 5.7,
        "summary_wm_n": 5.8,
        "tpm_overlap_csf": 5.9,
        "tpm_overlap_gm": 6.0,
        "tpm_overlap_wm": 6.1,
        "wm2max": 6.2,
        "bids_meta": {
            "modality": "T1w",
            "subject_id": "subj",
            "session_id": "ses-01",
            "Manufacturer": "Siemens",
            "FlipAngle": 7,
            "ImageType": ["ORIGINAL"],
        },
        "provenance": {
            "md5sum": "abcabcabcabcabcabcabcabcabcabcab",
            "version": "24.0.0",
            "software": "mriqc",
            "settings": {
                "testing": False,
                "custom_flag": "kept",
            },
            "custom_top": "extra",
        },
    }

    parsed = parse_observation(
        "T1w",
        payload,
        raw_payload_path="data/runs/test/raw/T1w/page-000001.json",
        source_page=1,
    )

    assert parsed.values["source_api_id"] == payload["_id"]
    assert parsed.values["dedupe_exact_key"] == payload["provenance"]["md5sum"]
    assert parsed.values["manufacturer"] == "Siemens"
    assert parsed.values["bids_meta_extra"] == {"ImageType": ["ORIGINAL"]}
    assert parsed.values["provenance_settings_extra"] == {"custom_flag": "kept"}
    assert parsed.values["provenance_extra"] == {"custom_top": "extra"}
    assert parsed.values["payload_extra"] == {"_links": {"self": {"href": "T1w/abc"}}}


def test_parse_bold_observation_sets_task_identity_hash() -> None:
    payload = {
        "_id": "def123abc456def123abc456",
        "_etag": "etag",
        "_created": "Sun, 04 Jun 2017 04:19:33 GMT",
        "_updated": "Sun, 04 Jun 2017 04:19:33 GMT",
        "aor": 0.1,
        "aqi": 0.2,
        "dummy_trs": 0,
        "dvars_nstd": 0.3,
        "dvars_std": 0.4,
        "dvars_vstd": 0.5,
        "efc": 0.6,
        "fber": 0.7,
        "fd_mean": 0.8,
        "fd_num": 0.9,
        "fd_perc": 1.0,
        "fwhm_avg": 1.1,
        "fwhm_x": 1.2,
        "fwhm_y": 1.3,
        "fwhm_z": 1.4,
        "gcor": 1.5,
        "gsr_x": 1.6,
        "gsr_y": 1.7,
        "size_t": 137.0,
        "size_x": 64.0,
        "size_y": 64.0,
        "size_z": 36.0,
        "snr": 4.3,
        "spacing_tr": 2.5,
        "spacing_x": 4.0,
        "spacing_y": 4.0,
        "spacing_z": 4.0,
        "summary_bg_k": 1.8,
        "summary_bg_mean": 1.9,
        "summary_bg_median": 2.0,
        "summary_bg_mad": 2.1,
        "summary_bg_p05": 2.2,
        "summary_bg_p95": 2.3,
        "summary_bg_stdv": 2.4,
        "summary_bg_n": 2.5,
        "summary_fg_k": 2.6,
        "summary_fg_mean": 2.7,
        "summary_fg_median": 2.8,
        "summary_fg_mad": 2.9,
        "summary_fg_p05": 3.0,
        "summary_fg_p95": 3.1,
        "summary_fg_stdv": 3.2,
        "summary_fg_n": 3.3,
        "tsnr": 3.4,
        "bids_meta": {
            "modality": "bold",
            "subject_id": "subj",
            "task_id": "Rest",
            "TaskName": "Rest",
            "run_id": "01",
            "Manufacturer": "SIEMENS",
            "RepetitionTime": 2.5,
        },
        "provenance": {
            "md5sum": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "version": "24.0.0",
            "software": "mriqc",
            "settings": {"fd_thres": 0.2},
        },
        "rating": {"rating": "good", "other": "kept"},
    }

    parsed = parse_observation(
        "bold",
        payload,
        raw_payload_path="data/runs/test/raw/bold/page-000001.json",
        source_page=1,
    )

    assert parsed.values["task_name"] == "Rest"
    assert parsed.values["rating_label"] == "good"
    assert parsed.values["rating_extra"] == {"other": "kept"}
    assert parsed.values["dedupe_series_key"] == compute_dedupe_series_key(
        "bold", parsed.values
    )


def test_parse_page_number() -> None:
    assert parse_page_number(Path("page-000123.json")) == 123


def test_parse_datetime_accepts_iso8601() -> None:
    parsed = parse_datetime("2017-06-08T05:54:47.000Z")

    assert parsed.isoformat() == "2017-06-08T05:54:47+00:00"


def test_normalize_dump_payload_unwraps_extended_json() -> None:
    normalized = normalize_dump_payload(
        {
            "_id": {"$oid": "abc123def456abc123def456"},
            "_created": {"$date": "2017-06-08T05:54:47.000Z"},
            "bids_meta": {
                "FlipAngle": {"$numberInt": "7"},
                "EchoTime": {"$numberDouble": "0.01"},
            },
            "nested": [{"value": {"$numberLong": "42"}}],
        }
    )

    assert normalized == {
        "_id": "abc123def456abc123def456",
        "_created": "2017-06-08T05:54:47.000Z",
        "bids_meta": {
            "FlipAngle": 7,
            "EchoTime": 0.01,
        },
        "nested": [{"value": 42}],
    }
