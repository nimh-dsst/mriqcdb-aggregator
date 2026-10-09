import { describe, expect, it } from 'vitest';

import { categoryChart, type CategorySeries } from "./categories";

const exampleSeries: readonly CategorySeries[] = [
  {
    id: "current",
    name: "Current study",
    color: "#2463eb",
    counts: [
      { category: "Siemens", n: 2 },
      { category: "GE", n: 3 },
    ],
  },
  {
    id: "reference",
    name: "Reference cohort",
    color: "#db2777",
    counts: [
      { category: "GE", n: 0 },
      { category: "Philips", n: 0 },
    ],
  },
];

const encodingOf = (spec: unknown): Record<string, unknown> =>
  (spec as { encoding: Record<string, unknown> }).encoding;

describe("categoryChart", () => {
  it("keeps exact counts and normalizes shares within each series", () => {
    const chart = categoryChart(exampleSeries, "Manufacturer", true);

    expect(chart.datasets["categories"]).toEqual([
      {
        category: "Siemens",
        series: "current",
        label: "Current study",
        n: 2,
        share: 0.4,
      },
      {
        category: "GE",
        series: "current",
        label: "Current study",
        n: 3,
        share: 0.6,
      },
      {
        category: "GE",
        series: "reference",
        label: "Reference cohort",
        n: 0,
        share: 0,
      },
      {
        category: "Philips",
        series: "reference",
        label: "Reference cohort",
        n: 0,
        share: 0,
      },
    ]);
  });

  it("uses the HTML legend, explicit colors, stable categories, and grouped bars", () => {
    const chart = categoryChart(exampleSeries, "Manufacturer", false);
    const encoding = encodingOf(chart.spec);

    expect(encoding["x"]).toMatchObject({
      field: "category",
      title: "Manufacturer",
      sort: ["Siemens", "GE", "Philips"],
    });
    expect(encoding["xOffset"]).toMatchObject({ field: "series" });
    expect(encoding["color"]).toMatchObject({
      legend: null,
      scale: {
        domain: ["current", "reference"],
        range: ["#2463eb", "#db2777"],
      },
    });
  });

  it("switches the y encoding and percentage formatting for share charts", () => {
    const countEncoding = encodingOf(
      categoryChart(exampleSeries, "Manufacturer", false, "Images").spec,
    );
    const shareEncoding = encodingOf(
      categoryChart(exampleSeries, "Manufacturer", true).spec,
    );

    expect(countEncoding["y"]).toMatchObject({
      field: "n",
      title: "Images",
    });
    expect(shareEncoding["y"]).toMatchObject({
      field: "share",
      title: "Share",
      axis: { format: ".0%" },
    });
  });

  it("handles empty and zero-total inputs without offsets or non-finite shares", () => {
    const empty = categoryChart([], "Manufacturer", false);
    const zero = categoryChart(
      [
        {
          id: "empty",
          name: "Empty",
          color: "#000000",
          counts: [{ category: "Unknown", n: 0 }],
        },
      ],
      "Manufacturer",
      true,
    );

    expect(empty.datasets["categories"]).toEqual([]);
    expect(encodingOf(empty.spec)["xOffset"]).toBeUndefined();
    expect(zero.datasets["categories"]).toEqual([
      {
        category: "Unknown",
        series: "empty",
        label: "Empty",
        n: 0,
        share: 0,
      },
    ]);
  });
});
