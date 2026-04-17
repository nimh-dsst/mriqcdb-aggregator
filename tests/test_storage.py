from __future__ import annotations

import json
from pathlib import Path

from mriqc_aggregator.storage import (
    append_jsonl,
    build_run_layout,
    write_json,
    write_text,
)


def test_build_run_layout_creates_expected_directories(tmp_path: Path) -> None:
    layout = build_run_layout(tmp_path, "run-123")

    assert layout.root == tmp_path / "runs" / "run-123"
    assert layout.frontier_dir.is_dir()
    assert layout.plans_dir.is_dir()
    assert layout.manifest_dir.is_dir()
    assert layout.raw_dir.is_dir()


def test_write_helpers_create_parent_directories(tmp_path: Path) -> None:
    json_path = tmp_path / "nested" / "payload.json"
    text_path = tmp_path / "nested" / "notes.txt"
    jsonl_path = tmp_path / "nested" / "rows.jsonl"

    write_json(json_path, {"b": 2, "a": 1})
    write_text(text_path, "hello")
    append_jsonl(jsonl_path, [{"z": 1}, {"a": 2}])

    assert json.loads(json_path.read_text(encoding="utf-8")) == {"a": 1, "b": 2}
    assert text_path.read_text(encoding="utf-8") == "hello"
    assert jsonl_path.read_text(encoding="utf-8").splitlines() == [
        '{"z": 1}',
        '{"a": 2}',
    ]
