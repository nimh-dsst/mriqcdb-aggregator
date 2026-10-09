import { describe, expect, it } from "vitest";

import {
  aggregateAvailable,
  columnYChart,
  countBandChart,
  countBandRows,
  countBoxChart,
  countBoxRows,
  summaryRows,
  type BinnedSummaryResult,
  type BinSeries,
} from "./grammar";

const axis = {
  label: "Age",
  countTitle: "Scans",
  logScale: false,
  xScale: "linear" as const,
};

const counts: readonly BinSeries[] = [
  {
    id: "a",
    name: "A",
    color: "#111111",
    bins: [
      { lo: 0, hi: 1, count: 10 },
      { lo: 1, hi: 2, count: 10 },
    ],
  },
  {
    id: "b",
    name: "B",
    color: "#222222",
    bins: [{ lo: 0, hi: 1, count: 0 }],
  },
];

const summary: BinnedSummaryResult = {
  xKind: "metric",
  yKind: "metric",
  range: [0, 1],
  buckets: [
    {
      lo: 0,
      hi: 1,
      group: null,
      n: 8,
      isOther: false,
      quantiles: { p05: 1, p25: 2, p50: 3, p75: 4, p95: 5 },
      mean: 9,
      thin: false,
    },
  ],
};

describe("count grammar", () => {
  it("includes Other as a series in per-bin quantiles", () => {
    const other = { ...counts[0], id: "other", name: "Other", bins: [{ lo: 0, hi: 1, count: 20 }] };
    const chart = countBandChart([...counts, other], "Scans", axis);
    expect(chart.datasets["countBand"]).toEqual([
      expect.objectContaining({ p25: 5, p50: 10, p75: 15 }),
      expect.objectContaining({ p25: 0, p50: 0, p75: 5 }),
    ]);
    expect(chart.spec).toHaveProperty("layer");
  });
  it("uses cross-series quantiles and zero-fills an absent aligned bin", () => {
    const rows = countBandRows(counts);

    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ x: 1, x2: 2, p25: 2.5, p50: 5, p75: 7.5 });
  });

  it("uses a single series as a line and returns the band hint", () => {
    const chart = countBandChart([counts[0]], "Count", axis);

    expect(chart.degenerateNote).toBe("One series: Band draws its counts as a line");
    expect(chart.spec).toMatchObject({ mark: { type: "line" } });
  });

  it("puts each series' bin counts on the vertical boxplot axis", () => {
    const rows = countBoxRows(counts);
    const chart = countBoxChart(counts, "Count");

    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ series: "A", count: 10 }),
        expect.objectContaining({ series: "B", count: 0 }),
      ]),
    );
    expect(chart.spec).toMatchObject({
      encoding: { x: { field: "seriesId", type: "nominal" }, y: { field: "count", type: "quantitative" } },
    });
  });
});

describe("column-y grammar", () => {
  it("selects mean and median independently", () => {
    expect(summaryRows(summary, "mean")[0].value).toBe(9);
    expect(summaryRows(summary, "median")[0].value).toBe(3);
    expect(columnYChart(summary, "Response", axis, "line", "mean").datasets["summary"]).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: 9 })]),
    );
  });

  it("uses the selected aggregate rather than counts for density and ECDF", () => {
    const twoBins: BinnedSummaryResult = {
      ...summary,
      buckets: [
        ...summary.buckets,
        {
          ...summary.buckets[0],
          lo: 1,
          hi: 2,
        },
      ],
    };
    const shiftedMean: BinnedSummaryResult = {
      ...twoBins,
      buckets: [
        twoBins.buckets[0],
        {
          ...twoBins.buckets[1],
          mean: 19,
          quantiles: { ...twoBins.buckets[1].quantiles, p50: 6 },
        },
      ],
    };

    const originalDensity = columnYChart(twoBins, "Response", axis, "density", "mean").datasets[
      "summaryDensity"
    ] as readonly { value: number }[];
    const density = columnYChart(shiftedMean, "Response", axis, "density", "mean").datasets[
      "summaryDensity"
    ] as readonly { value: number }[];
    const originalEcdf = columnYChart(twoBins, "Response", axis, "ecdf", "mean").datasets[
      "summaryEcdf"
    ] as readonly { value: number }[];
    const ecdf = columnYChart(shiftedMean, "Response", axis, "ecdf", "mean").datasets[
      "summaryEcdf"
    ] as readonly { value: number }[];

    expect(density.map((row) => row.value)).not.toEqual(originalDensity.map((row) => row.value));
    expect(ecdf.map((row) => row.value)).not.toEqual(originalEcdf.map((row) => row.value));
    expect(ecdf.map((row) => row.value)).toEqual([9, 28]);
  });

  it("does not advertise unavailable server aggregates", () => {
    expect(aggregateAvailable(summary, "sum")).toBe(false);
    expect(aggregateAvailable(summary, "min")).toBe(false);
    expect(aggregateAvailable(summary, "max")).toBe(false);
  });

  it("converts time-valued responses to temporal values", () => {
    const timeResponse: BinnedSummaryResult = {
      ...summary,
      yKind: "time",
      buckets: [{ ...summary.buckets[0], mean: 2 }],
    };
    const chart = columnYChart(timeResponse, "Acquired", axis, "line", "mean");

    expect((chart.datasets["summary"] as readonly { value: number }[])[0].value).toBe(
      Date.UTC(2000, 0, 3),
    );
    expect(chart.spec).toMatchObject({ encoding: { y: { type: "temporal" } } });
  });
});
