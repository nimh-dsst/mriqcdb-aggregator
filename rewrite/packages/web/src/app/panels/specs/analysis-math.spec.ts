import type { Density2dResult } from "@mriqc/shared";

import { fisherInterval, massContours } from "./analysis-math";

function histogram(counts: number[], xBins: number, yBins = xBins): Density2dResult {
  return { xKind: "metric",
    x: { lo: 0, width: 1, bins: xBins, underflow: 0, overflow: 0 },
    y: { lo: 0, width: 1, bins: yBins, underflow: 0, overflow: 0 },
    counts,
    n: counts.reduce((sum, count) => sum + count, 0),
    pearson: null,
    spearman: null,
    sample: [],
  };
}

function pathsAreClosed(points: ReturnType<typeof massContours>): boolean {
  const grouped = new Map<number, ReturnType<typeof massContours>>();
  for (const point of points) {
    const path = grouped.get(point.path) ?? [];
    path.push(point);
    grouped.set(point.path, path);
  }

  return [...grouped.values()].every((path) => {
    if (path.length < 4) {
      return false;
    }
    const first = path[0]!;
    const last = path[path.length - 1]!;
    return first.x === last.x && first.y === last.y;
  });
}

describe("massContours", () => {
  it("uses descending cumulative histogram mass for density cutoffs", () => {
    const contours = massContours(histogram([10, 4, 1, 1], 2), [0.25, 0.5, 0.75]);
    const levelFor = (mass: number): number | undefined => contours.find((point) => point.mass === mass)?.level;

    expect(levelFor(0.25)).toBe(10);
    expect(levelFor(0.5)).toBe(10);
    expect(levelFor(0.75)).toBe(4);
  });

  it("draws a closed path around an isolated peak", () => {
    const contours = massContours(histogram([0, 0, 0, 0, 10, 0, 0, 0, 0], 3), [0.5]);

    expect(contours).not.toHaveLength(0);
    expect(pathsAreClosed(contours)).toBe(true);
  });

  it("resolves saddles deterministically", () => {
    const density = histogram([10, 0, 0, 10], 2);

    expect(massContours(density, [0.5])).toEqual(massContours(density, [0.5]));
  });

  it("omits empty grids and closes the boundary of a constant grid", () => {
    expect(massContours(histogram([0, 0, 0, 0], 2))).toEqual([]);

    const contours = massContours(histogram([2, 2, 2, 2], 2), [0.5]);
    expect(contours).not.toHaveLength(0);
    expect(contours.every((point) => point.level === 2)).toBe(true);
    expect(pathsAreClosed(contours)).toBe(true);
  });
});

describe("fisherInterval", () => {
  it("returns a symmetric finite interval around zero", () => {
    const interval = fisherInterval(0, 10);

    expect(interval).not.toBeNull();
    if (interval === null) {
      throw new Error("Expected a Fisher interval for n = 10");
    }
    expect(interval[0]).toBeLessThan(0);
    expect(interval[1]).toBeGreaterThan(0);
    expect(interval[0]).toBeCloseTo(-interval[1]);
  });

  it("rejects undefined Fisher cases and handles perfect correlations", () => {
    expect(fisherInterval(null, 10)).toBeNull();
    expect(fisherInterval(Number.NaN, 10)).toBeNull();
    expect(fisherInterval(0.2, 3)).toBeNull();
    expect(fisherInterval(1, 10)).toEqual([1, 1]);
    expect(fisherInterval(-1, 10)).toEqual([-1, -1]);
  });
});
