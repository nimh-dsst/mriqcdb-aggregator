import type { ClipMode, DistributionResult, MetricSummary, Histogram } from '@mriqc/shared';
import {
  CATEGORY_PALETTE,
  CATEGORY_RANGE,
  MAX_CATEGORIES,
  MAX_LEGEND_ENTRIES,
  SERIES_LEGEND,
  OTHER_COLOR,
  batlowRange,
  groupColor,
  groupRange,
} from './palette';
import {
  OTHER_GROUP,
  boxNeedsSymlog,
  cohortBinRows,
  cohortBoxRows,
  cohortDensityRows,
  cohortEcdfRows,
  coverageModeRows,
  degenerateHistogramRows,
  degenerateSpike,
  ecdfRows,
  foldBoxRows,
  foldOther,
  type BoxRow,
  type CohortResult,
} from './rows';
import { cohortColor } from './palette';

/**
 * A uniform sample on [0, 1], binned the way the `distribution` procedure bins
 * it: over the clipped range only, so the histogram counts fewer rows than `n`.
 * Bin width 0.02 puts a boundary exactly on p25, which is where mixing a
 * quantile point with a differently normalized cumulative shows up.
 */
function uniformSummary(clip: Exclude<ClipMode, 'none'>): MetricSummary & { histogram: Histogram } {
  const n = 1000;
  const [lo, hi] = clip === 'p05p95' ? [0.05, 0.95] : [0.01, 0.99];
  const width = 0.02;
  const bins = Math.round((hi - lo) / width);
  return {
    n,
    min: 0,
    max: 1,
    mean: 0.5,
    stddev: 0.2887,
    quantiles: { p01: 0.01, p05: 0.05, p25: 0.25, p50: 0.5, p75: 0.75, p95: 0.95, p99: 0.99 },
    histogram: { lo, hi, width, counts: Array.from({ length: bins }, () => width * n) },
  } as MetricSummary & { histogram: Histogram };
}

describe('ecdfRows', () => {
  for (const clip of ['p01p99', 'p05p95'] as const) {
    it(`is non-decreasing in cumulative probability under ${clip}`, () => {
      const rows = ecdfRows(uniformSummary(clip), clip);
      expect(rows.length).toBeGreaterThan(10);
      let previous = 0;
      for (const row of rows) {
        expect(row.p).toBeGreaterThanOrEqual(previous - 1e-9);
        expect(row.p).toBeLessThanOrEqual(1 + 1e-9);
        previous = row.p;
      }
    });

    it(`puts the histogram curve on the same scale as the quantile points under ${clip}`, () => {
      const rows = ecdfRows(uniformSummary(clip), clip);
      // The sample is uniform, so the true CDF is the identity: every point,
      // from either half, has to sit on it.
      for (const row of rows) expect(row.p).toBeCloseTo(row.value, 6);
    });
  }

  it('normalizes by the bin total when the histogram already covers the sample', () => {
    const unclipped: MetricSummary & { histogram: Histogram } = {
      n: 100,
      min: 0,
      max: 1,
      mean: 0.5,
      stddev: 0.3,
      quantiles: null,
      histogram: { lo: 0, hi: 1, width: 0.5, counts: [50, 50] },
    } as MetricSummary & { histogram: Histogram };
    expect(ecdfRows(unclipped).map((row) => row.p)).toEqual([0.5, 1]);
  });
});

/* ------------------------------------------------------- folding the tail */

/** One coverage cell per group, so the fold ranks on summed `n`. */
function cell(group: string, n: number): { start: string; group: string; n: number } {
  return { start: '2025-01-01', group, n };
}

describe('foldOther', () => {
  it('leaves a list inside the cap untouched', () => {
    const rows = [cell('a', 3), cell('b', 2)];
    expect(foldOther(rows, 8)).toEqual(rows);
  });

  it('keeps the biggest groups and renames the rest', () => {
    const rows = [cell('big', 100), cell('mid', 50), cell('small', 1), cell('tiny', 2)];
    expect(foldOther(rows, 2).map((row) => row.group)).toEqual([
      'big',
      'mid',
      OTHER_GROUP,
      OTHER_GROUP,
    ]);
  });

  it('ranks on the total across buckets, not on one row', () => {
    // `steady` never has the biggest single bucket but is the biggest group.
    const rows = [cell('spike', 30), cell('steady', 20), cell('steady', 20), cell('steady', 20)];
    expect(foldOther(rows, 1).map((row) => row.group)).toEqual([
      OTHER_GROUP,
      'steady',
      'steady',
      'steady',
    ]);
  });

  it('breaks a tie on the label, so the fold is stable across refetches', () => {
    const rows = [cell('b', 5), cell('a', 5), cell('c', 1)];
    expect(foldOther(rows, 2).map((row) => row.group)).toEqual(['b', 'a', OTHER_GROUP]);
  });

  it('loses no records: the counts are untouched', () => {
    const rows = [cell('a', 3), cell('b', 2), cell('c', 1)];
    const total = (list: readonly { n: number }[]) => list.reduce((sum, row) => sum + row.n, 0);
    expect(total(foldOther(rows, 1))).toBe(total(rows));
  });

  it('caps a 26-spelling manufacturer field at nine legend entries', () => {
    const rows = Array.from({ length: 26 }, (_, i) => cell(`vendor-${i}`, 26 - i));
    expect(new Set(foldOther(rows, 8).map((row) => row.group)).size).toBe(9);
  });
});

function box(group: string, p50: number, n: number): BoxRow {
  return { group, p05: p50 - 2, p25: p50 - 1, p50, p75: p50 + 1, p95: p50 + 2, n };
}

describe('foldBoxRows', () => {
  it('leaves a list inside the cap untouched', () => {
    const rows = [box('a', 5, 10), box('b', 6, 9)];
    expect(foldBoxRows(rows, 8)).toEqual(rows);
  });

  it('merges the tail into one box rather than drawing several called "Other"', () => {
    const rows = [box('a', 10, 100), box('b', 4, 5), box('c', 6, 15)];
    const folded = foldBoxRows(rows, 1);
    expect(folded.map((row) => row.group)).toEqual(['a', OTHER_GROUP]);
    const other = folded[1];
    // The merged box spans everything the folded groups spanned, carries their
    // combined record count, and its median is weighted by it.
    expect(other.n).toBe(20);
    expect(other.p05).toBe(2);
    expect(other.p95).toBe(8);
    expect(other.p50).toBeCloseTo((4 * 5 + 6 * 15) / 20, 6);
  });
});

describe('the categorical palette', () => {
  it('uses exactly six Okabe–Ito slots and reserves grey for Other', () => {
    expect(CATEGORY_PALETTE).toEqual(['#0072b2', '#009e73', '#56b4e9', '#d55e00', '#cc79a7', '#e69f00']);
    expect(OTHER_COLOR).toBe('#8c9196');
    expect(CATEGORY_RANGE.at(-1)).toBe(OTHER_COLOR);
    expect(MAX_CATEGORIES).toBe(6);
    expect(MAX_LEGEND_ENTRIES).toBe(7);
  });

  it('resamples original batlow through index 199, including the exact six-step ramp', () => {
    expect(batlowRange(6)).toEqual(['#011959', '#134b61', '#356a59', '#737e38', '#be9035', '#f8a27e']);
    expect(batlowRange(2)).toEqual(['#011959', '#f8a27e']);
    expect(batlowRange(0)).toEqual([]);
    expect(new Set(batlowRange(12)).size).toBe(12);
  });

  it('gives six displayed groups distinct colours regardless of their draw order', () => {
    const labels = ['F', 'A', 'E', 'B', 'D', 'C', 'Other'];
    const range = groupRange(labels);
    expect(new Set(range).size).toBe(7);
    expect(range.at(-1)).toBe(OTHER_COLOR);
    const reversed = groupRange([...labels].reverse());
    expect([...range].reverse()).toEqual(reversed);
  });

  it('has one colour per drawable category and no more', () => {
    expect(CATEGORY_PALETTE).toHaveLength(MAX_CATEGORIES);
    expect(CATEGORY_RANGE).toHaveLength(MAX_LEGEND_ENTRIES);
    expect(new Set(CATEGORY_RANGE).size).toBe(MAX_LEGEND_ENTRIES);
  });

  it('caps the legend at the categories a chart can actually draw', () => {
    expect(SERIES_LEGEND.symbolLimit).toBe(MAX_LEGEND_ENTRIES);
  });

  it('keeps a group hue when a peer is removed or filtered out', () => {
    expect(groupColor('Siemens')).toBe(groupColor('Siemens'));
    expect(groupColor(OTHER_GROUP)).toBe(OTHER_COLOR);
  });

  it('samples batlow from light to dark for ordinal groups', () => {
    const range = batlowRange(4);
    expect(range).toHaveLength(4);
    expect(range[0]).not.toBe(range[3]);
  });

  it('keeps Other grey while sampling ordered groups from batlow', () => {
    const range = groupRange(['1.5 T', '3 T', 'Other'], true);
    expect(range.slice(0, 2)).toEqual(batlowRange(2));
    expect(range[2]).toBe(OTHER_COLOR);
  });
});

describe('degenerate distributions', () => {
  const result: DistributionResult = {
    n: 100,
    min: 0,
    max: 4,
    mean: 0.5,
    stddev: 1,
    quantiles: { p01: 0, p05: 0, p25: 0, p50: 0, p75: 1, p95: 3, p99: 4 },
    histogram: { lo: 0, hi: 4, width: 1, counts: [71, 9, 12, 8] },
  };

  it('recognizes a majority exact value, not merely a tall ordinary bin', () => {
    expect(degenerateSpike(result)).toMatchObject({ index: 0, value: 0, count: 71, share: 0.71 });
    expect(
      degenerateSpike({ ...result, quantiles: { ...result.quantiles!, p25: -1, p75: 1 } }),
    ).toBeNull();
  });

  it('draws the remaining histogram with a separately labelled left-edge spike', () => {
    const spike = degenerateSpike(result)!;
    const rows = degenerateHistogramRows(result, spike);
    expect(rows[0]).toMatchObject({ spike: true, count: 71, spikeLabel: '71% exactly 0' });
    expect(rows.slice(1).map((row) => row.count)).toEqual([9, 12, 8]);
    expect(rows[0].hi).toBeLessThanOrEqual(rows[1].lo);
  });
});

describe('box scaling', () => {
  it('uses symlog for a zero p05 or a p95/p05 ratio above fifty', () => {
    expect(boxNeedsSymlog([{ p05: 0, p95: 1 }])).toBe(true);
    expect(boxNeedsSymlog([{ p05: 1, p95: 51 }])).toBe(true);
    expect(boxNeedsSymlog([{ p05: 1, p95: 50 }])).toBe(false);
  });
});

describe('coverage modes', () => {
  const rows = [
    { start: '2025-01-01', group: 'A', n: 2 },
    { start: '2025-01-01', group: 'B', n: 6 },
    { start: '2025-02-01', group: 'A', n: 2 },
    { start: '2025-02-01', group: 'B', n: 2 },
  ];

  it('can accumulate and then normalize each time bucket to 100%', () => {
    const output = coverageModeRows(rows, { cumulative: true, share: true });
    expect(output.filter((row) => row.start === '2025-02-01').map((row) => row.n)).toEqual([
      1 / 3,
      2 / 3,
    ]);
  });
});

/* ------------------------------------------------------- comparison cohorts */

/** A ranged result over `[0, 10)` in `counts.length` equal bins. */
function ranged(counts: readonly number[], tails: { underflow?: number; overflow?: number } = {}) {
  const inside = counts.reduce((a, b) => a + b, 0);
  return {
    n: inside + (tails.underflow ?? 0) + (tails.overflow ?? 0),
    min: 0,
    max: 10,
    mean: 5,
    stddev: 1,
    quantiles: { p01: 0, p05: 1, p25: 2, p50: 5, p75: 6, p95: 9, p99: 10 },
    histogram: { lo: 0, hi: 10, width: 10 / counts.length, counts, ...tails },
  };
}

function series(name: string, counts: readonly number[], tails = {}): CohortResult {
  const result = ranged(counts, tails);
  return { id: name.toLowerCase(), name, base: result, ranged: result };
}

describe('cohortBinRows', () => {
  it('emits one point per bin at its lower edge, plus a closing point', () => {
    // `step-after` over the lower edges *is* the histogram outline: each value
    // holds across its own bin. The closing point at the final upper edge is
    // what draws the last bin full width and shuts the area against the
    // baseline, and it repeats the last bin so a tooltip on it is true.
    const rows = cohortBinRows([series('A', [1, 3])]);
    expect(rows.map((row) => [row.lo, row.share])).toEqual([
      [0, 0.25],
      [5, 0.75],
      [10, 0.75],
    ]);
    expect(rows[2].range).toBe(rows[1].range);
    expect(rows[2].count).toBe(rows[1].count);
  });

  it('draws every cohort over the same edges, with no offsetting', () => {
    // No slicing and no grouping: both silhouettes span the full bin, which is
    // what lets them be compared shape against shape rather than bar against
    // bar.
    const rows = cohortBinRows([series('A', [1, 3]), series('B', [2, 2])]);
    expect(rows.filter((row) => row.cohort === 'a').map((row) => row.lo)).toEqual([0, 5, 10]);
    expect(rows.filter((row) => row.cohort === 'b').map((row) => row.lo)).toEqual([0, 5, 10]);
  });

  it('keys rows on the cohort id and labels them with the name', () => {
    // Two cohorts can share a name; keying on it merged them into one series.
    const rows = cohortBinRows([
      { id: 'c1', name: 'Cohort', base: ranged([1, 1]), ranged: ranged([1, 1]) },
      { id: 'c2', name: 'Cohort', base: ranged([1, 1]), ranged: ranged([1, 1]) },
    ]);
    expect(new Set(rows.map((row) => row.cohort))).toEqual(new Set(['c1', 'c2']));
    expect(new Set(rows.map((row) => row.label))).toEqual(new Set(['Cohort']));
  });

  it('normalizes to a share of the whole, so a small series stays small', () => {
    // 4 scans against 4000: shares are of all 4004 scans, so the two series
    // sum to 1 together and the small one is drawn at its true weight.
    // (Owner, 2026-10-09: "percent of group should really be percent of whole".)
    const rows = cohortBinRows([series('A', [1, 3]), series('B', [1000, 3000])]);
    const a = rows.filter((row) => row.cohort === 'a').map((row) => row.share);
    const b = rows.filter((row) => row.cohort === 'b').map((row) => row.share);
    expect(a.map((v) => +v.toFixed(6))).toEqual([1 / 4004, 3 / 4004, 3 / 4004].map((v) => +v.toFixed(6)));
    expect(b.map((v) => +v.toFixed(6))).toEqual([1000 / 4004, 3000 / 4004, 3000 / 4004].map((v) => +v.toFixed(6)));
    expect(a[0] + a[1] + b[0] + b[1]).toBeCloseTo(1, 9);
  });

  it('divides by the tails too, so a long tail is not drawn as concentrated', () => {
    // 2 in-range, 8 outside: the in-range bins are a fifth of the cohort, not
    // all of it. Dividing by the bins alone would draw this cohort as though
    // every scan it has were inside the shared range.
    const rows = cohortBinRows([series('A', [1, 1], { overflow: 8 })]);
    expect(rows.map((row) => row.share)).toEqual([0.1, 0.1, 0.1]);
  });

  it('writes the bin\u2019s own bounds for the tooltip', () => {
    const rows = cohortBinRows([series('A', [1, 3])]);
    expect(rows[0].range).toBe('0\u20135');
    expect(rows[0].hi).toBe(5);
    expect(rows[0].count).toBe(1);
  });

  it('leaves the other cohorts alone while one is pending', () => {
    const pending: CohortResult = { id: 'b', name: 'B', base: null, ranged: null };
    const rows = cohortBinRows([series('A', [1, 3]), pending]);
    expect(rows.every((row) => row.cohort === 'a')).toBe(true);
    expect(rows).toHaveLength(3);
  });

  it('is empty for no cohorts, and for a cohort that counted nothing', () => {
    expect(cohortBinRows([])).toEqual([]);
    expect(cohortBinRows([series('A', [0, 0])])).toEqual([]);
  });
});

describe('cohortDensityRows', () => {
  it('smooths each cohort over the shared grid, one point per bin', () => {
    const rows = cohortDensityRows([series('A', [0, 4, 0, 0])]);
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.cohort === 'a' && row.label === 'A')).toBe(true);
    // A spike smooths to a hump: the peak stays where the mass was.
    const peak = rows.reduce((best, row) => (row.share > best.share ? row : best));
    expect(peak.value).toBeCloseTo(rows[1].value, 10);
  });

  it('waits for the ranged result, because the grid is what makes curves comparable', () => {
    const stepOneOnly: CohortResult = { id: 'a', name: 'A', base: ranged([1, 3]), ranged: null };
    expect(cohortDensityRows([stepOneOnly])).toEqual([]);
  });
});

describe('cohortEcdfRows and cohortBoxRows', () => {
  it('draw from each cohort\u2019s own summary, so they need no shared range', () => {
    // Step one answers both, which is why the panel has its ECDF and its boxes
    // before the curves.
    const stepOneOnly: CohortResult = { id: 'a', name: 'A', base: ranged([1, 3]), ranged: null };
    expect(cohortEcdfRows([stepOneOnly]).length).toBeGreaterThan(0);
    expect(cohortEcdfRows([stepOneOnly]).every((row) => row.cohort === 'a')).toBe(true);
    expect(cohortBoxRows([stepOneOnly])).toEqual([
      { cohort: 'a', label: 'A', p05: 1, p25: 2, p50: 5, p75: 6, p95: 9, n: 4 },
    ]);
  });

  it('leave out a cohort with no summary rather than drawing an empty box', () => {
    const pending: CohortResult = { id: 'b', name: 'B', base: null, ranged: null };
    expect(cohortBoxRows([pending])).toEqual([]);
    expect(cohortEcdfRows([pending])).toEqual([]);
  });

  it('keep two cohorts that share a name on two box rows', () => {
    const rows = cohortBoxRows([
      { id: 'c1', name: 'Cohort', base: ranged([1, 1]), ranged: null },
      { id: 'c2', name: 'Cohort', base: ranged([2, 2]), ranged: null },
    ]);
    expect(rows.map((row) => row.cohort)).toEqual(['c1', 'c2']);
  });
});

describe('cohortColor', () => {
  it('reads the palette by index', () => {
    expect(cohortColor(0)).toBe(CATEGORY_PALETTE[0]);
    expect(cohortColor(MAX_CATEGORIES - 1)).toBe(CATEGORY_PALETTE[MAX_CATEGORIES - 1]);
  });

  it('answers for any integer, because an index arrives from a link', () => {
    // Total on purpose: a `Cohort.color` is hostile input like anything else,
    // and handing a spec `undefined` for a scale range is a broken chart.
    expect(cohortColor(MAX_CATEGORIES)).toBe(CATEGORY_PALETTE[0]);
    expect(cohortColor(-1)).toBe(CATEGORY_PALETTE[MAX_CATEGORIES - 1]);
    expect(cohortColor(Number.NaN)).toBe(CATEGORY_PALETTE[0]);
    expect(CATEGORY_PALETTE).toContain(cohortColor(1e308));
  });
});
