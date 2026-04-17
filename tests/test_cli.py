from __future__ import annotations

from pathlib import Path

from mriqc_aggregator import cli


def test_main_dispatches_pull_representative(
    monkeypatch, capsys, tmp_path: Path
) -> None:
    called: dict[str, object] = {}

    class FakeLayout:
        root = tmp_path / "runs" / "run-123"

    def fake_pull_representative_sample(**kwargs):
        called.update(kwargs)
        return FakeLayout()

    monkeypatch.setattr(
        cli, "pull_representative_sample", fake_pull_representative_sample
    )

    exit_code = cli.main(["pull-representative", "--output-root", str(tmp_path)])

    assert exit_code == 0
    assert called["output_root"] == tmp_path
    assert (
        capsys.readouterr().out.strip()
        == f"Representative sample written to {FakeLayout.root}"
    )


def test_main_dispatches_load_raw_run(monkeypatch, capsys) -> None:
    class FakeSummary:
        def to_dict(self):
            return {"inserted": 1}

    called: dict[str, object] = {}

    def fake_load_raw_run(**kwargs):
        called.update(kwargs)
        return FakeSummary()

    monkeypatch.setattr(cli, "load_raw_run", fake_load_raw_run)

    exit_code = cli.main(["load-raw-run", "--run-id", "run-123", "--skip-schema"])

    assert exit_code == 0
    assert called["run_id"] == "run-123"
    assert called["create_schema_first"] is False
    assert capsys.readouterr().out.strip() == "{'inserted': 1}"


def test_main_dispatches_profile_db(monkeypatch, capsys, tmp_path: Path) -> None:
    called: dict[str, object] = {}

    def fake_write_database_profile(**kwargs):
        called.update(kwargs)
        return tmp_path / "docs" / "temp" / "profile-run"

    monkeypatch.setattr(cli, "write_database_profile", fake_write_database_profile)

    exit_code = cli.main(["profile-db", "--output-root", str(tmp_path)])

    assert exit_code == 0
    assert called["output_root"] == tmp_path
    assert capsys.readouterr().out.strip() == (
        f"Database profile written to {tmp_path / 'docs' / 'temp' / 'profile-run'}"
    )
