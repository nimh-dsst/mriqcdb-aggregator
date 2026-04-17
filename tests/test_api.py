from __future__ import annotations

import json

import httpx
import pytest

from mriqc_aggregator.api import (
    DEFAULT_MANIFEST_PROJECTION,
    MAX_RESULTS_CAP,
    MRIQCAPIError,
    MRIQCWebAPIClient,
    page_items,
)


def test_fetch_page_applies_result_cap_and_projection() -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        captured["query"] = dict(request.url.params)
        return httpx.Response(
            200,
            text='{"_items":[{"_id":"abc"}]}',
            headers={"content-type": "application/json"},
        )

    with MRIQCWebAPIClient(max_retries=1) as client:
        client._client = httpx.Client(
            transport=httpx.MockTransport(handler),
            base_url=client.base_url,
        )
        response = client.fetch_page(
            "T1w",
            7,
            max_results=MAX_RESULTS_CAP + 100,
            projection=DEFAULT_MANIFEST_PROJECTION,
        )

    assert captured["path"] == "/api/v1/T1w"
    assert captured["query"] == {
        "page": "7",
        "max_results": str(MAX_RESULTS_CAP),
        "projection": json.dumps(
            DEFAULT_MANIFEST_PROJECTION,
            sort_keys=True,
            separators=(",", ":"),
        ),
    }
    assert response.payload == {"_items": [{"_id": "abc"}]}


def test_fetch_page_raises_after_retries(monkeypatch: pytest.MonkeyPatch) -> None:
    call_count = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        return httpx.Response(500, text="boom")

    monkeypatch.setattr("mriqc_aggregator.api.time.sleep", lambda _seconds: None)

    with MRIQCWebAPIClient(max_retries=3) as client:
        client._client = httpx.Client(
            transport=httpx.MockTransport(handler),
            base_url=client.base_url,
        )
        with pytest.raises(MRIQCAPIError, match="Failed to fetch bold page 4"):
            client.fetch_page("bold", 4)

    assert call_count == 3


def test_page_items_requires_list() -> None:
    with pytest.raises(MRIQCAPIError, match="list of _items"):
        page_items({"_items": "bad"})
