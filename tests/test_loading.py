import json
from pathlib import Path

from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from mriqc_aggregator.database import create_database_schema
from mriqc_aggregator.loading import load_raw_run
from mriqc_aggregator.models import T1wRecord


def _write_t1w_page(
    run_root: Path,
    *,
    source_id: str,
    manufacturer: str,
    session_id: str | None = "session-1",
    page_number: int = 1,
) -> None:
    payload = {
        "_items": [
            {
                "_id": source_id,
                "_etag": "etag",
                "_created": "Thu, 08 Jun 2017 05:54:47 GMT",
                "_updated": "Thu, 08 Jun 2017 05:54:47 GMT",
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
                    "subject_id": "subject-1",
                    "Manufacturer": manufacturer,
                },
                "provenance": {
                    "md5sum": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "version": "24.0.0",
                    "software": "mriqc",
                    "settings": {"testing": False},
                },
            }
        ]
    }
    if session_id is not None:
        payload["_items"][0]["bids_meta"]["session_id"] = session_id
    raw_dir = run_root / "raw" / "T1w"
    raw_dir.mkdir(parents=True, exist_ok=True)
    (raw_dir / f"page-{page_number:06d}.json").write_text(
        json.dumps(payload),
        encoding="utf-8",
    )


def test_load_raw_run_is_idempotent(tmp_path: Path) -> None:
    run_root = tmp_path / "runs" / "test-run"
    _write_t1w_page(
        run_root,
        source_id="abc123def456abc123def456",
        manufacturer="Siemens",
    )

    database_path = tmp_path / "ingest.db"
    database_url = f"sqlite+pysqlite:///{database_path}"
    create_database_schema(database_url)

    first = load_raw_run(run_root=run_root, database_url=database_url, batch_size=1)
    second = load_raw_run(run_root=run_root, database_url=database_url, batch_size=1)

    engine = create_engine(database_url)
    with Session(engine) as session:
        row_count = session.execute(
            select(func.count()).select_from(T1wRecord)
        ).scalar_one()
        record = session.execute(select(T1wRecord)).scalar_one()

    assert row_count == 1
    assert first.per_modality["T1w"].inserted_count == 1
    assert first.per_modality["T1w"].updated_count == 0
    assert second.per_modality["T1w"].inserted_count == 0
    assert second.per_modality["T1w"].updated_count == 1
    assert record.manufacturer == "Siemens"
    assert record.dedupe_exact_key == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"


def test_load_raw_run_updates_existing_row(tmp_path: Path) -> None:
    run_root = tmp_path / "runs" / "test-run"
    _write_t1w_page(
        run_root,
        source_id="abc123def456abc123def456",
        manufacturer="Siemens",
    )

    database_path = tmp_path / "ingest.db"
    database_url = f"sqlite+pysqlite:///{database_path}"

    load_raw_run(run_root=run_root, database_url=database_url, batch_size=1)
    _write_t1w_page(
        run_root,
        source_id="abc123def456abc123def456",
        manufacturer="GE",
    )
    load_raw_run(run_root=run_root, database_url=database_url, batch_size=1)

    engine = create_engine(database_url)
    with Session(engine) as session:
        record = session.execute(select(T1wRecord)).scalar_one()

    assert record.manufacturer == "GE"


def test_load_raw_run_handles_mixed_optional_columns_in_batch(tmp_path: Path) -> None:
    run_root = tmp_path / "runs" / "test-run"
    _write_t1w_page(
        run_root,
        source_id="abc123def456abc123def456",
        manufacturer="Siemens",
        session_id="session-1",
        page_number=1,
    )
    _write_t1w_page(
        run_root,
        source_id="def456abc123def456abc123",
        manufacturer="GE",
        session_id=None,
        page_number=2,
    )

    database_path = tmp_path / "ingest.db"
    database_url = f"sqlite+pysqlite:///{database_path}"

    summary = load_raw_run(run_root=run_root, database_url=database_url, batch_size=250)

    engine = create_engine(database_url)
    with Session(engine) as session:
        records = (
            session.execute(select(T1wRecord).order_by(T1wRecord.source_api_id))
            .scalars()
            .all()
        )

    assert summary.per_modality["T1w"].inserted_count == 2
    assert [record.session_id for record in records] == ["session-1", None]
