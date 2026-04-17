from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from mriqc_aggregator.app import create_app
from mriqc_aggregator.database import create_database_schema
from mriqc_aggregator.loading import load_raw_run
from mriqc_aggregator.profiling import (
    DatabaseProfiler,
    ObservationView,
    write_database_profile,
)


STRUCTURAL_METRICS = {
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
}

BOLD_METRICS = {
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
    "size_t": 120,
    "size_x": 64,
    "size_y": 64,
    "size_z": 36,
    "snr": 1.8,
    "spacing_tr": 2.0,
    "spacing_x": 3.0,
    "spacing_y": 3.0,
    "spacing_z": 3.0,
    "summary_bg_k": 1.9,
    "summary_bg_mean": 2.0,
    "summary_bg_median": 2.1,
    "summary_bg_mad": 2.2,
    "summary_bg_p05": 2.3,
    "summary_bg_p95": 2.4,
    "summary_bg_stdv": 2.5,
    "summary_bg_n": 2.6,
    "summary_fg_k": 2.7,
    "summary_fg_mean": 2.8,
    "summary_fg_median": 2.9,
    "summary_fg_mad": 3.0,
    "summary_fg_p05": 3.1,
    "summary_fg_p95": 3.2,
    "summary_fg_stdv": 3.3,
    "summary_fg_n": 3.4,
    "tsnr": 3.5,
}


def _write_page(
    run_root: Path, modality: str, page_number: int, items: list[dict[str, object]]
) -> None:
    raw_dir = run_root / "raw" / modality
    raw_dir.mkdir(parents=True, exist_ok=True)
    payload = {"_items": items}
    (raw_dir / f"page-{page_number:06d}.json").write_text(
        json.dumps(payload),
        encoding="utf-8",
    )


def _t1w_item(
    *,
    source_id: str,
    created: str,
    md5sum: str,
    manufacturer: str,
    session_id: str | None,
    extra_metric: str,
    metric_overrides: dict[str, float | int] | None = None,
) -> dict[str, object]:
    bids_meta = {
        "modality": "T1w",
        "subject_id": "subject-1",
        "Manufacturer": manufacturer,
        "EchoTime": 0.002,
        "RepetitionTime": 2.4,
        "InversionTime": 1.0,
        "MagneticFieldStrength": 3.0,
        "ManufacturersModelName": "Prisma",
        "MysteryField": "kept-raw",
    }
    if session_id is not None:
        bids_meta["session_id"] = session_id

    return {
        "_id": source_id,
        "_etag": "etag",
        "_created": created,
        "_updated": created,
        **{**STRUCTURAL_METRICS, **(metric_overrides or {})},
        "custom_metric": extra_metric,
        "bids_meta": bids_meta,
        "provenance": {
            "md5sum": md5sum,
            "version": "24.0.0",
            "software": "mriqc",
            "settings": {"testing": False, "fd_thres": 0.2, "custom_setting": True},
            "upstream_note": "kept-raw",
        },
    }


def _bold_item(
    *,
    source_id: str,
    created: str,
    md5sum: str,
    manufacturer: str,
    task_id: str,
    metric_overrides: dict[str, float | int] | None = None,
) -> dict[str, object]:
    return {
        "_id": source_id,
        "_etag": "etag",
        "_created": created,
        "_updated": created,
        **{**BOLD_METRICS, **(metric_overrides or {})},
        "custom_metric": "bold-extra",
        "bids_meta": {
            "modality": "bold",
            "subject_id": "subject-b",
            "session_id": "session-b",
            "run_id": "01",
            "task_id": task_id,
            "TaskName": task_id,
            "Manufacturer": manufacturer,
            "EchoTime": 0.03,
            "RepetitionTime": 2.0,
            "MagneticFieldStrength": 3.0,
            "ManufacturersModelName": "Vida",
            "UnknownBidsField": "kept-raw",
        },
        "provenance": {
            "md5sum": md5sum,
            "version": "24.0.0",
            "software": "mriqc",
            "settings": {"testing": False},
        },
        "rating": {
            "rating": "accept",
            "name": "qa",
            "comment": "looks good",
            "md5sum": md5sum,
            "rater": "secondary",
        },
    }


def _load_profile_fixture(tmp_path: Path, database_url: str) -> str:
    run_root = tmp_path / "runs" / "profile-run"
    _write_page(
        run_root,
        "T1w",
        1,
        [
            _t1w_item(
                source_id="abc123def456abc123def456",
                created="Thu, 08 Jun 2017 05:54:47 GMT",
                md5sum="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                manufacturer="Siemens",
                session_id="session-1",
                extra_metric="x",
                metric_overrides={"cjv": 0.1, "cnr": 0.2},
            ),
            _t1w_item(
                source_id="def456abc123def456abc123",
                created="Thu, 08 Jun 2017 06:54:47 GMT",
                md5sum="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                manufacturer="Siemens",
                session_id=None,
                extra_metric="y",
                metric_overrides={"cjv": 0.4, "cnr": 0.6},
            ),
            _t1w_item(
                source_id="fedcba987654fedcba987654",
                created="Thu, 08 Jun 2017 07:54:47 GMT",
                md5sum="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                manufacturer="GE",
                session_id="session-2",
                extra_metric="z",
                metric_overrides={"cjv": 0.7, "cnr": 1.0},
            ),
        ],
    )
    _write_page(
        run_root,
        "bold",
        1,
        [
            _bold_item(
                source_id="111111111111111111111111",
                created="Thu, 08 Jun 2017 08:54:47 GMT",
                md5sum="cccccccccccccccccccccccccccccccc",
                manufacturer="Siemens",
                task_id="rest",
                metric_overrides={"fd_mean": 0.5},
            ),
            _bold_item(
                source_id="222222222222222222222222",
                created="Thu, 08 Jun 2017 09:54:47 GMT",
                md5sum="dddddddddddddddddddddddddddddddd",
                manufacturer="GE",
                task_id="nback",
                metric_overrides={"fd_mean": 1.5},
            ),
        ],
    )

    create_database_schema(database_url)
    load_raw_run(run_root=run_root, database_url=database_url, batch_size=100)
    return database_url


def test_database_profiler_reports_counts_and_duplicates(
    tmp_path: Path,
    postgres_database_url: str,
) -> None:
    database_url = _load_profile_fixture(tmp_path, postgres_database_url)
    with DatabaseProfiler(database_url=database_url) as profiler:
        profile = profiler.modality_profile(
            "T1w",
            view=ObservationView.RAW,
            top_n=5,
            duplicate_group_limit=5,
            duplicate_member_limit=2,
            extra_key_limit=5,
        )

    assert profile["overview"]["row_counts"] == {"raw": 3, "exact": 2, "series": 3}
    manufacturer_values = profile["top_values"]["manufacturer"]
    assert manufacturer_values[0] == {"value": "Siemens", "count": 2}

    missing_by_field = {
        row["field"]: row["missing_count"] for row in profile["missingness"]
    }
    assert missing_by_field["session_id"] == 1

    extra_keys = profile["extra_key_counts"]["payload_extra"]["keys"]
    assert {"key": "custom_metric", "row_count": 3} in extra_keys

    metric_summaries = {row["field"]: row for row in profile["qc_metric_summaries"]}
    assert metric_summaries["cjv"]["value_count"] == 3
    assert metric_summaries["cjv"]["min"] == 0.1
    assert metric_summaries["cjv"]["max"] == 0.7
    assert metric_summaries["cjv"]["mean"] == pytest.approx(0.4)

    exact_duplicates = profile["duplicates"]["exact"]
    assert exact_duplicates["duplicate_group_count"] == 1
    assert exact_duplicates["duplicate_row_count"] == 2
    assert exact_duplicates["histogram"][0] == {"group_size": 2, "group_count": 1}


def test_write_database_profile_writes_snapshot(
    tmp_path: Path,
    postgres_database_url: str,
) -> None:
    database_url = _load_profile_fixture(tmp_path, postgres_database_url)

    output_root = write_database_profile(
        output_root=tmp_path / "docs-temp",
        database_url=database_url,
        modalities=["T1w"],
        view=ObservationView.EXACT,
        top_n=5,
    )

    assert (output_root / "config.json").exists()
    assert (output_root / "overview.json").exists()
    assert (output_root / "T1w.json").exists()


def test_fastapi_profile_endpoint_returns_expected_payload(
    tmp_path: Path,
    postgres_database_url: str,
) -> None:
    database_url = _load_profile_fixture(tmp_path, postgres_database_url)
    with TestClient(create_app(database_url=database_url)) as client:
        modalities_response = client.get("/api/v1/modalities")
        assert modalities_response.status_code == 200
        t1w_modality = next(
            row
            for row in modalities_response.json()["modalities"]
            if row["name"] == "T1w"
        )
        assert "cjv" in t1w_modality["metric_fields"]

        profile_response = client.get(
            "/api/v1/modalities/T1w/profile", params={"view": "exact"}
        )
        assert profile_response.status_code == 200
        profile_payload = profile_response.json()
        assert profile_payload["selected_view"]["row_count"] == 2
        assert profile_payload["overview"]["row_counts"]["raw"] == 3

        distribution_response = client.get(
            "/api/v1/modalities/bold/distributions/task_id",
            params={"view": "raw"},
        )
        assert distribution_response.status_code == 200
        values = distribution_response.json()["values"]
        assert values == [
            {"value": "nback", "count": 1},
            {"value": "rest", "count": 1},
        ]

        metric_summaries_response = client.get(
            "/api/v1/modalities/T1w/metrics",
            params={"view": "raw"},
        )
        assert metric_summaries_response.status_code == 200
        metric_summaries = {
            row["field"]: row for row in metric_summaries_response.json()["metrics"]
        }
        assert metric_summaries["cjv"]["mean"] == pytest.approx(0.4)

        metric_distribution_response = client.get(
            "/api/v1/modalities/T1w/metrics/cjv",
            params={"view": "raw", "bins": 3},
        )
        assert metric_distribution_response.status_code == 200
        distribution = metric_distribution_response.json()["distribution"]
        assert distribution["mean"] == pytest.approx(0.4)
        assert distribution["quantiles"]["p50"] == pytest.approx(0.4)
        assert sum(bucket["count"] for bucket in distribution["histogram"]) == 3
