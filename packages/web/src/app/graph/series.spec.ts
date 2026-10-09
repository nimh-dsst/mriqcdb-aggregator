import { asColumnId } from "@mriqc/shared";
import { describe, expect, it } from "vitest";

import {
  normalizeSeries,
  withoutGroup,
  seriesDisabledReason,
  seriesLabel,
  seriesSlots,
  type Series,
} from "./series";

const manufacturer = asColumnId("Manufacturer");

describe("graph series", () => {
  it("reserves five chromatic slots for a five-value grouping; Other is neutral", () => {
    const grouping: Series = { kind: "field", field: manufacturer };

    expect(seriesSlots(grouping, () => 5)).toBe(5);
    expect(
      seriesDisabledReason([grouping], { kind: "population" }, {
        fieldCount: () => 5,
      }),
    ).toBe(
      "Six coloured series plus Other maximum. Remove a comparison or choose fewer values.",
    );
  });

  it("permits two chosen values alongside the whole population", () => {
    const selection: Series = {
      kind: "values",
      field: manufacturer,
      values: ["Siemens", "GE"],
    };

    expect(seriesSlots(selection)).toBe(2);
    expect(seriesDisabledReason([selection], { kind: "population" })).toBeNull();
  });

  it('preserves the missing token and exact whitespace in chosen values', () => {
    expect(normalizeSeries([{ kind: 'values', field: manufacturer, values: ['', ' padded '] }]))
      .toEqual([{ kind: 'values', field: manufacturer, values: ['', ' padded '] }]);
  });

  it("allows one grouping and only two comparisons with it", () => {
    const grouping: Series = { kind: "field", field: manufacturer };

    expect(
      seriesDisabledReason([grouping], {
        kind: "values",
        field: asColumnId("Model"),
        values: ["A"],
      }),
    ).toMatch(/one grouping/i);
    expect(
      seriesDisabledReason(
        [
          grouping,
          { kind: "population" },
          { kind: "span", from: "2026-01-01", to: "2026-01-31" },
        ],
        { kind: "cohort", id: "pilot" },
        { fieldCount: () => 0 },
      ),
    ).toMatch(/at most two/i);
    expect(
      seriesDisabledReason(
        [
          { kind: "population" },
          { kind: "cohort", id: "pilot" },
          { kind: "study" },
        ],
        grouping,
      ),
    ).toMatch(/at most two/i);
  });

  it("uses the bound display labels and validates direct candidates", () => {
    expect(seriesLabel({ kind: "field", field: manufacturer })).toBe(
      "by Manufacturer",
    );
    expect(seriesLabel({ kind: "cohort", id: "pilot" })).toBe("pilot");
    expect(seriesLabel({ kind: "study" })).toBe("My study");
    expect(
      seriesLabel({ kind: "span", from: "2025-01-01", to: "2025-12-31" }),
    ).toBe("2025");
    expect(
      seriesDisabledReason([], { kind: "values", field: manufacturer, values: [] }),
    ).toBe("This series is invalid.");
  });

  it("deduplicates selections and selected values without mutating input", () => {
    const raw = [
      {
        kind: "values",
        field: "Manufacturer",
        values: ["Siemens", "GE", "Siemens"],
      },
      { kind: "values", field: "Manufacturer", values: ["GE", "Siemens"] },
    ];

    expect(normalizeSeries(raw)).toEqual([
      { kind: "values", field: manufacturer, values: ["Siemens", "GE"] },
    ]);
    expect(raw[0].values).toEqual(["Siemens", "GE", "Siemens"]);
  });

  it("drops malformed URL state instead of throwing", () => {
    expect(normalizeSeries("%E0%A4%A")).toEqual([]);
    expect(
      normalizeSeries('{"series":[{"kind":"values","field":"","values":[]}]}'),
    ).toEqual([]);
  });

  it("accepts real ISO date spans and rejects invalid or inverted spans", () => {
    expect(
      normalizeSeries([
        { kind: "span", from: "2024-02-29", to: "2024-03-01" },
        { kind: "span", from: "2023-02-29", to: "2023-03-01" },
        { kind: "span", from: "2024-04-02", to: "2024-04-01" },
      ]),
    ).toEqual([{ kind: "span", from: "2024-02-29", to: "2024-03-01" }]);
  });

  describe("hiding one group of a split", () => {
    it("turns a whole-field split into the values still showing", () => {
      expect(withoutGroup({ kind: "field", field: manufacturer }, "", ["SIEMENS", "", "GE"]))
        .toEqual({ kind: "values", field: manufacturer, values: ["SIEMENS", "GE"] });
    });

    it("drops one value, and the whole split with its last value", () => {
      expect(withoutGroup({ kind: "values", field: manufacturer, values: ["SIEMENS", "GE"] }, "GE"))
        .toEqual({ kind: "values", field: manufacturer, values: ["SIEMENS"] });
      expect(withoutGroup({ kind: "values", field: manufacturer, values: ["GE"] }, "GE")).toBeNull();
    });

    it("drops a custom group by name", () => {
      const a = { name: "A", filters: [{ field: manufacturer, op: "in" as const, values: ["SIEMENS"] }] };
      const b = { name: "B", filters: [{ field: manufacturer, op: "in" as const, values: ["GE"] }] };
      expect(withoutGroup({ kind: "buckets", buckets: [a, b] }, "A")).toEqual({ kind: "buckets", buckets: [b] });
    });
  });

  it("restores a custom split and drops groups with no conditions", () => {
    const restored = normalizeSeries([{
      kind: "buckets",
      buckets: [
        { name: "Band", filters: [], selections: [{ metric: "tsnr", range: [1, 2] }] },
        { name: "Empty", filters: [] },
      ],
    }]);
    expect(restored).toEqual([{
      kind: "buckets",
      buckets: [{ name: "Band", filters: [], selections: [{ metric: "tsnr", range: [1, 2] }] }],
    }]);
  });
});
