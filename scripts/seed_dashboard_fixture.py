from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory

from mriqc_aggregator.database import create_database_schema, default_database_url
from mriqc_aggregator.loading import load_raw_run


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
    "fd_num": 1,
    "fd_perc": 2.0,
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
    run_root: Path, page_number: int, items: list[dict[str, object]]
) -> None:
    raw_dir = run_root / "raw" / "bold"
    raw_dir.mkdir(parents=True, exist_ok=True)
    payload = {"_items": items}
    (raw_dir / f"page-{page_number:06d}.json").write_text(
        json.dumps(payload),
        encoding="utf-8",
    )


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
        "custom_metric": "dashboard-fixture",
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


def main() -> None:
    database_url = default_database_url()

    with TemporaryDirectory(prefix="mriqc-dashboard-fixture-") as temp_dir:
        run_root = Path(temp_dir) / "runs" / "dashboard-fixture"
        _write_page(
            run_root,
            1,
            [
                _bold_item(
                    source_id="111111111111111111111111",
                    created="Thu, 08 Jun 2017 08:54:47 GMT",
                    md5sum="cccccccccccccccccccccccccccccccc",
                    manufacturer="Siemens",
                    task_id="rest",
                    metric_overrides={"fd_mean": 0.5, "snr": 1.2, "aor": 0.08},
                ),
                _bold_item(
                    source_id="222222222222222222222222",
                    created="Thu, 08 Jun 2017 09:54:47 GMT",
                    md5sum="dddddddddddddddddddddddddddddddd",
                    manufacturer="GE",
                    task_id="nback",
                    metric_overrides={"fd_mean": 1.5, "snr": 2.4, "aor": 0.12},
                ),
                _bold_item(
                    source_id="333333333333333333333333",
                    created="Thu, 08 Jun 2017 10:54:47 GMT",
                    md5sum="eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                    manufacturer="Philips",
                    task_id="stroop",
                    metric_overrides={"fd_mean": 0.9, "snr": 1.8, "aor": 0.15},
                ),
            ],
        )

        create_database_schema(database_url)
        summary = load_raw_run(
            run_root=run_root, database_url=database_url, batch_size=100
        )
        print(f"Loaded dashboard fixture into {database_url}: {summary}")


if __name__ == "__main__":
    main()
