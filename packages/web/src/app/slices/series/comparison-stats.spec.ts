/**
 * The comparison arithmetic, against fixtures whose answers are worked out in
 * the comments rather than recorded from a run. A statistic nobody can check by
 * hand is a statistic nobody should put under a chart.
 */

import type { DistributionResult, Quantiles } from '@mriqc/shared';
import {
  MIN_BANDWIDTH_BINS,
  allPairsKs,
  cohortNumbers,
  cumulativeShares,
  densityPoints,
  differenceNumbers,
  differencesFrom,
  histogramTotal,
  ksDistance,
  outsideShare,
  sameGrid,
  silvermanBandwidth,
  worstPair,
} from '../../graph/comparison-stats';

function quantiles(overrides: Partial<Quantiles> = {}): Quantiles {
  return { p01: 0, p05: 1, p25: 2, p50: 3, p75: 6, p95: 9, p99: 10, ...overrides };
}

/** A result over the grid `[0, 10)` in `counts.length` equal bins. */
function result(
  counts: readonly number[],
  overrides: Partial<DistributionResult> = {},
  tails: { underflow?: number; overflow?: number } = {},
): DistributionResult {
  const inside = counts.reduce((sum, count) => sum + count, 0);
  return {
    n: inside + (tails.underflow ?? 0) + (tails.overflow ?? 0),
    min: 0,
    max: 10,
    mean: 4,
    stddev: 2,
    quantiles: quantiles(),
    histogram: {
      lo: 0,
      hi: 10,
      width: 10 / counts.length,
      counts,
      ...tails,
    },
    ...overrides,
  };
}

describe('histogramTotal', () => {
  it('counts the bins and the two tails an explicit range pushed out', () => {
    expect(histogramTotal(result([1, 2, 3]))).toBe(6);
    expect(histogramTotal(result([1, 2, 3], {}, { underflow: 4, overflow: 5 }))).toBe(15);
  });

  it('reads the histogram and not `n`, so a result with no tails still sums to 1', () => {
    // A server that does not report the tails would leave `n` above the bins,
    // and dividing by `n` would make every cohort's shares sum to less than 1 --
    // which on an overlay reads as "this cohort has fewer scans here" when what
    // it has is a denominator nobody can see.
    const noTails = result([2, 2], { n: 100 });
    expect(histogramTotal(noTails)).toBe(4);
    const shares = cumulativeShares(noTails);
    expect(shares[shares.length - 1]).toBe(1);
  });
});

describe('cumulativeShares', () => {
  it('returns one value per bin edge, starting at the underflow mass', () => {
    // 4 bins, underflow 10, counts 10/20/30/20, overflow 10: total 100.
    // Edges: 0.10, 0.20, 0.40, 0.70, 0.90 -- and the last is 1 - overflow/total.
    const shares = cumulativeShares(result([10, 20, 30, 20], {}, { underflow: 10, overflow: 10 }));
    expect(shares).toEqual([0.1, 0.2, 0.4, 0.7, 0.9]);
  });

  it('starts at zero when nothing fell below the range', () => {
    expect(cumulativeShares(result([1, 1, 2]))).toEqual([0, 0.25, 0.5, 1]);
  });

  it('is empty for a histogram that counted nothing', () => {
    expect(cumulativeShares(result([0, 0, 0]))).toEqual([]);
  });
});

describe('sameGrid', () => {
  it('is true for two histograms over the same edges', () => {
    expect(sameGrid(result([1, 2]), result([5, 5]))).toBe(true);
  });

  it('is false at a different bin count or a different range', () => {
    expect(sameGrid(result([1, 2]), result([1, 2, 3]))).toBe(false);
    const shifted = result([1, 2]);
    expect(sameGrid(result([1, 2]), { ...shifted, histogram: { ...shifted.histogram, hi: 20 } })).toBe(
      false,
    );
  });

  it('tolerates the last bit of floating-point error in a shared edge', () => {
    // Both edges came back from separate round trips over the same requested
    // range, so they agree -- but `lo + n * width` is floating-point on both
    // sides, and an exact compare would blank the KS cell for no visible reason.
    const a = result([1, 2]);
    const b = { ...a, histogram: { ...a.histogram, hi: 10 + 1e-12 } };
    expect(sameGrid(a, b)).toBe(true);
  });
});

describe('ksDistance', () => {
  it('is zero for two identically shaped cohorts of different sizes', () => {
    // The statistic is over share-normalized curves, so a 4-scan cohort and a
    // 4000-scan one with the same shape are the same distribution.
    expect(ksDistance(result([1, 2, 1]), result([1000, 2000, 1000]))).toBe(0);
  });

  it('is the largest gap between the two cumulative curves', () => {
    // A: 0, 0.5, 1       (counts 2, 2)
    // B: 0, 0.25, 1      (counts 1, 3)
    // Gaps: 0, 0.25, 0 -> 0.25.
    expect(ksDistance(result([2, 2]), result([1, 3]))).toBe(0.25);
  });

  it('is one for two cohorts that do not overlap', () => {
    // A is entirely in the first bin, B entirely in the last: the curves are
    // 0,1,1,1 and 0,0,0,1, whose largest gap is 1.
    expect(ksDistance(result([4, 0, 0]), result([0, 0, 4]))).toBe(1);
  });

  it('counts a difference that is entirely below the shared range', () => {
    // The whole point of the underflow offset: A has a fifth of its mass below
    // `lo` and B has none, so the curves are already 0.2 apart at the first
    // edge -- and starting both at zero would report 0 for two cohorts that
    // plainly differ.
    const a = result([2, 2], {}, { underflow: 1 });
    const b = result([2, 2]);
    expect(cumulativeShares(a)[0]).toBe(0.2);
    expect(ksDistance(a, b)).toBeCloseTo(0.2, 12);
  });

  it('is null across different grids, and for an empty cohort', () => {
    expect(ksDistance(result([1, 2]), result([1, 2, 3]))).toBeNull();
    expect(ksDistance(result([1, 2]), result([0, 0]))).toBeNull();
  });
});

describe('cohortNumbers', () => {
  it('reads the six figures straight off the result', () => {
    const r = result([1, 1], { n: 42, mean: 3.5, stddev: 1.25 });
    expect(cohortNumbers(r)).toEqual({ n: 42, mean: 3.5, sd: 1.25, p05: 1, p50: 3, p95: 9 });
  });

  it('answers with nulls for a cohort the server found nothing for', () => {
    const empty = result([0], { n: 0, mean: null, stddev: null, quantiles: null });
    expect(cohortNumbers(empty)).toEqual({ n: 0, mean: null, sd: null, p05: null, p50: null, p95: null });
  });
});

describe('differenceNumbers', () => {
  it('subtracts the first cohort from the second, and scales by the first IQR', () => {
    // A: median 3, IQR 6 - 2 = 4, mean 4.  B: median 5, mean 7.
    // Median shift 5 - 3 = 2, which is 2 / 4 = 0.5 of A's IQR. Mean shift 3.
    const a = result([1, 1]);
    const b = result([1, 1], { mean: 7, quantiles: quantiles({ p50: 5 }) });
    const numbers = differenceNumbers(a, b, null, null);
    expect(numbers.medianShift).toBe(2);
    expect(numbers.medianShiftIqr).toBe(0.5);
    expect(numbers.meanShift).toBe(3);
    // The KS cell waits for step two; it is not an error that it is absent.
    expect(numbers.ks).toBeNull();
  });

  it('signs the shift, so the row says which cohort is higher', () => {
    const a = result([1, 1], { mean: 7, quantiles: quantiles({ p50: 5 }) });
    const b = result([1, 1]);
    const numbers = differenceNumbers(a, b, null, null);
    expect(numbers.medianShift).toBe(-2);
    expect(numbers.meanShift).toBe(-3);
  });

  it('fills the KS cell from the ranged pair', () => {
    const a = result([1, 1]);
    const b = result([1, 1]);
    const numbers = differenceNumbers(a, b, result([2, 2]), result([1, 3]));
    expect(numbers.ks).toBe(0.25);
  });

  it('leaves the IQR share out when the first cohort has no spread', () => {
    // A degenerate IQR would divide by zero and print Infinity, which reads as
    // a measurement rather than as "this cannot be scaled".
    const a = result([1, 1], { quantiles: quantiles({ p25: 3, p75: 3 }) });
    const b = result([1, 1], { quantiles: quantiles({ p50: 5 }) });
    const numbers = differenceNumbers(a, b, null, null);
    expect(numbers.medianShift).toBe(2);
    expect(numbers.medianShiftIqr).toBeNull();
  });

  it('answers nulls when either cohort has no quantiles at all', () => {
    const empty = result([0], { n: 0, mean: null, quantiles: null });
    const numbers = differenceNumbers(empty, result([1, 1]), null, null);
    expect(numbers.medianShift).toBeNull();
    expect(numbers.medianShiftIqr).toBeNull();
    expect(numbers.meanShift).toBeNull();
  });
});

/* ------------------------------------------------------------------ density */

describe('silvermanBandwidth', () => {
  it('is 0.9 * min(SD, IQR/1.34) * n^(-1/5)', () => {
    // SD 2, IQR 6 - 2 = 4 so IQR/1.34 = 2.985; the smaller is the SD.
    // n = 32, so n^(-1/5) = 0.5. Expect 0.9 * 2 * 0.5 = 0.9.
    const r = result([32], { n: 32, stddev: 2 });
    expect(silvermanBandwidth(r)).toBeCloseTo(0.9, 12);
  });

  it('takes the IQR estimate when it is the smaller of the two', () => {
    // The smaller of the pair on purpose: SD alone is inflated by the outliers
    // every MRIQC metric has, and would over-smooth the body away.
    // IQR 4 - 3 = 1 so IQR/1.34 = 0.7463; SD 2. n = 32 -> n^(-1/5) = 0.5.
    const r = result([32], { n: 32, stddev: 2, quantiles: quantiles({ p25: 3, p75: 4 }) });
    expect(silvermanBandwidth(r)).toBeCloseTo(0.9 * (1 / 1.34) * 0.5, 12);
  });

  it('has no bandwidth when there is nothing to smooth', () => {
    expect(silvermanBandwidth(result([1], { n: 1 }))).toBeNull();
    // A constant column: no spread by either estimate.
    expect(
      silvermanBandwidth(
        result([32], { n: 32, stddev: 0, quantiles: quantiles({ p25: 3, p75: 3 }) }),
      ),
    ).toBeNull();
  });
});

describe('densityPoints', () => {
  /** A histogram over `[0, 10)` whose whole mass is in one bin. */
  function spike(bins: number, at: number) {
    const counts = Array.from({ length: bins }, (_, i) => (i === at ? 100 : 0));
    return result(counts, { n: 100, stddev: 1 });
  }

  it('smooths a single spike into a Gaussian of exactly the chosen bandwidth', () => {
    // The property that says the kernel is the kernel it claims to be. With the
    // bandwidth given explicitly, the curve through the bin centres must be
    // `exp(-0.5 * (d / sigma)^2)` times its peak, where `d` is the distance
    // from the spike.
    const bins = 21;
    const r = spike(bins, 10);
    const width = 10 / bins;
    const sigma = 5 * width;
    const points = densityPoints(r, sigma);
    expect(points).toHaveLength(bins);
    const peak = points[10].share;
    expect(peak).toBeGreaterThan(0);
    for (const offset of [1, 2, 3, 5, 8]) {
      const expected = peak * Math.exp(-0.5 * (offset * width / sigma) ** 2);
      expect(points[10 + offset].share).toBeCloseTo(expected, 12);
      // Symmetric, because a Gaussian is.
      expect(points[10 - offset].share).toBeCloseTo(expected, 12);
    }
  });

  it('puts the peak where the mass is, not at the edge', () => {
    // The failure mode of normalizing by the kernel's mass over a finite grid:
    // the denominator shrinks towards the ends, so a spike in the second bin
    // came out taller in the first. A density whose peak is not where the mass
    // is is not a density.
    const points = densityPoints(spike(8, 1));
    const peak = points.reduce((best, p) => (p.share > best.share ? p : best));
    expect(peak.value).toBeCloseTo(points[1].value, 12);
  });

  it('scales to share per bin, so a smoothed curve reads on the bars\u2019 axis', () => {
    // A Gaussian's mass is 1; sampled at bin centres and multiplied by the bin
    // width, the points sum to 1 whenever the kernel fits inside the axis.
    const points = densityPoints(spike(41, 20), 3 * (10 / 41));
    const mass = points.reduce((sum, p) => sum + p.share, 0);
    expect(mass).toBeCloseTo(1, 3);
  });

  it('never smooths narrower than the grid it is smoothing', () => {
    // Below about one and a half bins the kernel is narrower than the bins, so
    // the "curve" is the histogram with ragged edges -- a picture of the
    // binning, which the reader did not choose.
    const bins = 20;
    const r = spike(bins, 10);
    const width = 10 / bins;
    const tiny = densityPoints(r, width / 100);
    const floored = densityPoints(r, MIN_BANDWIDTH_BINS * width);
    expect(tiny.map((p) => p.share)).toEqual(floored.map((p) => p.share));
  });

  it('is empty for a histogram with nothing in it', () => {
    expect(densityPoints(result([0, 0]))).toEqual([]);
    expect(densityPoints({ ...result([1]), histogram: { lo: 0, hi: 1, width: 0, counts: [1] } }))
      .toEqual([]);
  });
});

describe('outsideShare', () => {
  it('reports each tail as a share of the cohort', () => {
    // Not smoothed back into the edges: that would draw scans at values they do
    // not have. The card says so in words instead.
    expect(outsideShare(result([80], {}, { underflow: 10, overflow: 10 }))).toEqual({
      below: 0.1,
      above: 0.1,
    });
  });

  it('is zero when the histogram covers everything', () => {
    expect(outsideShare(result([1, 1]))).toEqual({ below: 0, above: 0 });
  });
});

describe('differencesFrom', () => {
  const a = result([1, 1], { quantiles: quantiles({ p50: 5 }) });
  const b = result([1, 1], { quantiles: quantiles({ p50: 7 }), mean: 6 });
  const c = result([1, 1], { quantiles: quantiles({ p50: 9 }), mean: 8 });

  it('measures every other cohort against the reference', () => {
    const rows = differencesFrom([a, b, c], [null, null, null], 0);
    expect(rows.map((row) => row.index)).toEqual([1, 2]);
    expect(rows[0].numbers.medianShift).toBe(2);
    expect(rows[1].numbers.medianShift).toBe(4);
  });

  it('flips sign with the reference, because the shift is "this minus it"', () => {
    const rows = differencesFrom([a, b, c], [null, null, null], 2);
    expect(rows.map((row) => row.index)).toEqual([0, 1]);
    expect(rows[0].numbers.medianShift).toBe(-4);
  });

  it('is empty when the reference itself has no result', () => {
    expect(differencesFrom([null, b], [null, null], 0)).toEqual([]);
  });
});

describe('allPairsKs and worstPair', () => {
  it('covers every unordered pair exactly once', () => {
    const r = result([1, 1]);
    expect(allPairsKs([r, r, r]).map((p) => [p.a, p.b])).toEqual([
      [0, 1],
      [0, 2],
      [1, 2],
    ]);
    // Nine cohorts is the palette's ceiling, so 36 pairs is the most this can be.
    expect(allPairsKs(Array.from({ length: 9 }, () => r))).toHaveLength(36);
  });

  it('finds the largest distance, which is the question a reference cannot answer', () => {
    const low = result([4, 0]);
    const mid = result([2, 2]);
    const high = result([0, 4]);
    const worst = worstPair(allPairsKs([low, mid, high]));
    // low against high do not overlap at all.
    expect([worst?.a, worst?.b]).toEqual([0, 2]);
    expect(worst?.ks).toBe(1);
  });

  it('has no worst pair when nothing can be computed', () => {
    expect(worstPair(allPairsKs([null, null]))).toBeNull();
  });
});
