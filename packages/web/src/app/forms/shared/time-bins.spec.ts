import type { CoverageResult, Granularity } from "@mriqc/shared";
import { describe, expect, it } from "vitest";

import { coverageBins, coverageDistribution } from "./time-bins";

function coverage(
  buckets: Array<{ start: string; n: number }>,
): CoverageResult {
  return {
    buckets: buckets.map(({ start, n }) => ({ start, group: null, n })),
  } as CoverageResult;
}

function granularity(value: string): Granularity {
  return value as unknown as Granularity;
}

describe("coverageBins", () => {
  it("fills missing months with zero-count calendar buckets", () => {
    const bins = coverageBins(
      coverage([
        { start: "2024-01-01T00:00:00.000Z", n: 2 },
        { start: "2024-03-01T00:00:00.000Z", n: 4 },
      ]),
      granularity("month"),
    );

    expect(bins.map(({ count }) => count)).toEqual([2, 0, 4]);
    expect(bins.map(({ lo }) => lo)).toEqual([
      Date.UTC(2024, 0, 1),
      Date.UTC(2024, 1, 1),
      Date.UTC(2024, 2, 1),
    ]);
  });

  it("uses the real leap-February month boundary", () => {
    const [february] = coverageBins(
      coverage([{ start: "2024-02-01T00:00:00.000Z", n: 1 }]),
      granularity("month"),
    );

    expect(february).toMatchObject({
      lo: Date.UTC(2024, 1, 1),
      hi: Date.UTC(2024, 2, 1),
    });
    expect(february.hi - february.lo).toBe(29 * 24 * 60 * 60 * 1000);
  });
});

describe("coverageDistribution", () => {
  it("uses occupied bin midpoints for weighted statistics and quantiles", () => {
    const distribution = coverageDistribution(
      coverage([
        { start: "2024-01-01T00:00:00.000Z", n: 1 },
        { start: "2024-01-03T00:00:00.000Z", n: 2 },
        { start: "2024-01-04T00:00:00.000Z", n: 1 },
      ]),
      granularity("day"),
    );

    expect(distribution.n).toBe(4);
    expect(distribution.histogram).toEqual({ lo: 0, hi: 4, width: 1, counts: [1, 0, 2, 1] });
    expect(distribution.min).toBe(0.5);
    expect(distribution.max).toBe(3.5);
    expect(distribution.mean).toBe(2.25);
    expect(distribution.quantiles).toEqual({
      p01: 0.5,
      p05: 0.5,
      p25: 0.5,
      p50: 2.5,
      p75: 2.5,
      p95: 3.5,
      p99: 3.5,
    });
  });
});
