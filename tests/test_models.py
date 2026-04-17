from sqlalchemy import create_engine, inspect

from mriqc_aggregator.models import Base, BoldRecord, T1wRecord, T2wRecord


def test_sqlalchemy_models_create_tables() -> None:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)

    inspector = inspect(engine)
    assert set(inspector.get_table_names()) == {"bold", "t1w", "t2w"}
    engine.dispose()


def test_structural_models_expose_core_columns() -> None:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    inspector = inspect(engine)

    t1w_columns = {
        column["name"] for column in inspector.get_columns(T1wRecord.__tablename__)
    }
    t2w_columns = {
        column["name"] for column in inspector.get_columns(T2wRecord.__tablename__)
    }
    bold_columns = {
        column["name"] for column in inspector.get_columns(BoldRecord.__tablename__)
    }

    shared = {
        "source_api_id",
        "source_md5sum",
        "subject_id",
        "session_id",
        "run_id",
        "acq_id",
        "manufacturer",
        "manufacturers_model_name",
        "magnetic_field_strength",
        "dedupe_exact_key",
        "dedupe_series_key",
        "dedupe_status",
        "canonical_source_api_id",
    }
    assert shared <= t1w_columns
    assert shared <= t2w_columns
    assert shared <= bold_columns

    assert "inversion_time" in t1w_columns
    assert "task_name" in bold_columns
    assert "rating_label" in bold_columns
    engine.dispose()
