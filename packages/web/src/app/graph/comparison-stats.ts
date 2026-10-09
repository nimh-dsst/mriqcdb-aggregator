/**
 * The arithmetic behind a comparison panel's statistics table.
 *
 * Pure, numeric, and deliberately separate from the view layer: every figure
 * here has a defensible definition and a fixture test with a hand-computed
 * answer, and none of it should have to be read through a projection to be
 * checked. Formatting stays in `view/stats.ts`, which is why nothing here
 * returns a string.
 *
 * See `docs/comparison-design.md`, "Comparison panel".
 */

import type { DistributionResult } from '@mriqc/shared';

/** One cohort's row of the table, before formatting. */
export interface CohortNumbers {
  /** How many scans of this cohort carried a value for the metric. */
  n: number;
  mean: number | null;
  sd: number | null;
  p05: number | null;
  p50: number | null;
  p95: number | null;
}

/** The six figures one row shows, straight off the result the chart is drawing. */
export function cohortNumbers(result: DistributionResult): CohortNumbers {
  const q = result.quantiles;
  return {
    n: result.n,
    mean: result.mean,
    sd: result.stddev,
    p05: q?.p05 ?? null,
    p50: q?.p50 ?? null,
    p95: q?.p95 ?? null,
  };
}

/**
 * How many finite values the histogram was computed over: the bins plus the two
 * tails an explicit range pushed out.
 *
 * `sum(counts) + underflow + overflow === n` by construction, so `n` is the
 * denominator every share divides by -- but it is read back off the histogram
 * rather than taken from `n` so that a result from a server that does not
 * report the tails still normalizes to its own bins and sums to 1 instead of to
 * something less than 1.
 */
export function histogramTotal(result: DistributionResult): number {
  const histogram = result.histogram;
  const inside = histogram.counts.reduce((sum, count) => sum + count, 0);
  const under = histogram.underflow ?? 0;
  const over = histogram.overflow ?? 0;
  return inside + under + over;
}

/**
 * The share-normalized cumulative histogram: `F(edge_k)` for every bin edge,
 * `counts.length + 1` values, the first carrying the underflow mass and the
 * last `1 - overflow / total`.
 *
 * The underflow offset is what makes two cohorts' curves comparable: over a
 * shared range one cohort can have mass below `lo` that the other does not, and
 * starting both curves at zero would hide exactly the difference a KS distance
 * is looking for. Empty when the histogram counted nothing.
 */
export function cumulativeShares(result: DistributionResult): readonly number[] {
  const total = histogramTotal(result);
  if (total <= 0) return [];
  const histogram = result.histogram;
  const out: number[] = [(histogram.underflow ?? 0) / total];
  let cumulative = histogram.underflow ?? 0;
  for (const count of histogram.counts) {
    cumulative += count;
    out.push(cumulative / total);
  }
  return out;
}

/**
 * The Kolmogorov-Smirnov distance between two cohorts, from their two
 * share-normalized cumulative histograms over the shared grid:
 * `max_k |F_a(edge_k) - F_b(edge_k)|`.
 *
 * An approximation of the real KS statistic at the histogram's resolution --
 * the true supremum can fall inside a bin -- which is why the table labels it
 * as one. With 200 bins it is close, and the error is bounded by the largest
 * share any single bin holds.
 *
 * Null unless both histograms were computed over the same grid and both counted
 * something: comparing curves over different edges would produce a number with
 * no meaning rather than an approximate one.
 */
export function ksDistance(a: DistributionResult, b: DistributionResult): number | null {
  if (!sameGrid(a, b)) return null;
  const fa = cumulativeShares(a);
  const fb = cumulativeShares(b);
  if (fa.length === 0 || fb.length === 0 || fa.length !== fb.length) return null;
  let worst = 0;
  for (let i = 0; i < fa.length; i += 1) worst = Math.max(worst, Math.abs(fa[i] - fb[i]));
  return worst;
}

/**
 * True when two histograms were binned over the same edges.
 *
 * The comparison panel asks for that explicitly -- one `range` for every cohort
 * -- so this is the assertion that the results on the client are the ones that
 * were asked for, and not a step-one result standing in for a step-two one.
 */
export function sameGrid(a: DistributionResult, b: DistributionResult): boolean {
  const x = a.histogram;
  const y = b.histogram;
  return (
    x.counts.length === y.counts.length &&
    closeEnough(x.lo, y.lo) &&
    closeEnough(x.hi, y.hi) &&
    closeEnough(x.width, y.width)
  );
}

/**
 * Equal to within a relative 1e-9.
 *
 * The two edges came back from two separate server round trips over the same
 * requested range, so they agree to the last bit in practice -- but `lo + n *
 * width` is floating-point arithmetic on both sides, and an exact compare would
 * make the KS cell blank for a reason no reader could see.
 */
function closeEnough(a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (a === b) return true;
  // Relative, with no floor: a floor of 1 would make the test *absolute* for
  // small magnitudes, so over a narrow range -- 200 bins across 1e-6 gives a
  // 5e-9 bin width -- two genuinely different grids would compare equal and the
  // KS cell would report a number computed off mismatched edges.
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= scale * 1e-9;
}

/** The differences row, for exactly two cohorts. Every field is null when it cannot be computed. */
export interface DifferenceNumbers {
  /** `b.p50 - a.p50`: how far the second cohort's middle sits from the first's. */
  medianShift: number | null;
  /**
   * The same shift as a share of the *first* cohort's interquartile range, which
   * is what makes it readable: 0.2 mm means nothing until it is "a fifth of the
   * spread of the cohort we are comparing against".
   */
  medianShiftIqr: number | null;
  meanShift: number | null;
  /** From the two ranged histograms; null until the shared-range fetch lands. */
  ks: number | null;
}

/**
 * The differences between two cohorts: the quantile and mean shifts off their
 * own summaries, and the KS distance off their shared-grid histograms.
 *
 * Two sources on purpose. The shifts come from step one -- each cohort's own
 * distribution -- so the table is complete the moment the panel has its cohorts,
 * and the KS cell fills in when the shared-range histograms arrive. Passing the
 * ranged pair as `null` is the normal state for the first instant of a new
 * comparison, not an error.
 */
export function differenceNumbers(
  a: DistributionResult,
  b: DistributionResult,
  rangedA: DistributionResult | null,
  rangedB: DistributionResult | null,
): DifferenceNumbers {
  const medianA = a.quantiles?.p50 ?? null;
  const medianB = b.quantiles?.p50 ?? null;
  const medianShift = medianA !== null && medianB !== null ? medianB - medianA : null;
  // Falsy and not `=== null`, for the reason `clipBounds` is: a result whose
  // `quantiles` is `undefined` -- an entry whose `result` came from somewhere
  // unexpected -- would otherwise read `.p75` off nothing and throw out of
  // `panelView`, which has no `catchError` and would kill that card's view for
  // the rest of the session.
  const iqr = a.quantiles ? a.quantiles.p75 - a.quantiles.p25 : null;
  const medianShiftIqr =
    medianShift !== null && iqr !== null && Number.isFinite(iqr) && iqr > 0
      ? medianShift / iqr
      : null;
  const meanShift =
    a.mean !== null && b.mean !== null && Number.isFinite(a.mean) && Number.isFinite(b.mean)
      ? b.mean - a.mean
      : null;
  const ks = rangedA !== null && rangedB !== null ? ksDistance(rangedA, rangedB) : null;
  return { medianShift, medianShiftIqr, meanShift, ks };
}


/* ------------------------------------------------- differences for n cohorts */

/** One cohort measured against the reference. */
export interface CohortDifference {
  /** Which cohort this row is about. */
  index: number;
  numbers: DifferenceNumbers;
}

/**
 * Every non-reference cohort's differences from the reference.
 *
 * With two cohorts this is the one row `comparison-design.md` asks for. With
 * more it is one row each, all against the same reference, which is the only
 * reading that stays a *number* rather than a matrix -- and the reference is the
 * reader's choice, because which cohort is "the baseline" is a question about
 * their study and not about the data.
 */
export function differencesFrom(
  results: readonly (DistributionResult | null)[],
  ranged: readonly (DistributionResult | null)[],
  reference: number,
): readonly CohortDifference[] {
  const base = results[reference] ?? null;
  if (base === null) return [];
  const out: CohortDifference[] = [];
  for (let i = 0; i < results.length; i += 1) {
    if (i === reference) continue;
    const other = results[i];
    if (other === null) continue;
    out.push({
      index: i,
      numbers: differenceNumbers(base, other, ranged[reference] ?? null, ranged[i] ?? null),
    });
  }
  return out;
}

/** One cell of the all-pairs KS table. */
export interface KsPair {
  a: number;
  b: number;
  ks: number | null;
}

/**
 * The KS distance for every unordered pair of cohorts, from the shared-range
 * histograms.
 *
 * The matrix answers the question a single reference cannot: which two of these
 * cohorts are furthest apart. It is bounded by the palette -- at most nine
 * cohorts, so at most 36 pairs -- which is why it can be a plain table rather
 * than a sampled or summarised one.
 */
export function allPairsKs(ranged: readonly (DistributionResult | null)[]): readonly KsPair[] {
  const out: KsPair[] = [];
  for (let a = 0; a < ranged.length; a += 1) {
    for (let b = a + 1; b < ranged.length; b += 1) {
      const x = ranged[a];
      const y = ranged[b];
      out.push({ a, b, ks: x !== null && y !== null ? ksDistance(x, y) : null });
    }
  }
  return out;
}

/** The largest KS in the table, which the view emphasises. Null when none is computable. */
export function worstPair(pairs: readonly KsPair[]): KsPair | null {
  let worst: KsPair | null = null;
  for (const pair of pairs) {
    if (pair.ks === null) continue;
    if (worst === null || pair.ks > (worst.ks as number)) worst = pair;
  }
  return worst;
}

/* ------------------------------------------------------------------ density */

/** One point of a smoothed density curve: a value and the share per bin at it. */
export interface DensityPoint {
  value: number;
  share: number;
}

/**
 * Silverman's rule of thumb for a Gaussian kernel bandwidth:
 * `0.9 * min(SD, IQR / 1.34) * n^(-1/5)`.
 *
 * Both spread estimates, because the smaller of them is what keeps a heavy tail
 * from over-smoothing the body: SD alone is inflated by the outliers every MRIQC
 * metric has, and the IQR alone collapses on a near-constant column. Computed
 * from the summary the `distribution` procedure already returns, so the curve
 * costs no extra request.
 *
 * Null when there is nothing to smooth -- no rows, or no usable spread -- which
 * the caller renders as an un-smoothed histogram rather than as a flat line.
 */
export function silvermanBandwidth(result: DistributionResult): number | null {
  const n = result.n;
  if (!Number.isFinite(n) || n < 2) return null;
  const sd = Number.isFinite(result.stddev ?? NaN) ? (result.stddev as number) : null;
  const q = result.quantiles;
  const iqr = q && Number.isFinite(q.p75 - q.p25) ? (q.p75 - q.p25) / 1.34 : null;
  const spreads = [sd, iqr].filter((value): value is number => value !== null && value > 0);
  if (spreads.length === 0) return null;
  const bandwidth = 0.9 * Math.min(...spreads) * n ** (-1 / 5);
  return Number.isFinite(bandwidth) && bandwidth > 0 ? bandwidth : null;
}

/**
 * How narrow a bandwidth is allowed to get, in bin widths.
 *
 * Below about one and a half bins the kernel is narrower than the grid it is
 * smoothing, so the "curve" is the histogram with ragged edges -- a picture of
 * the binning rather than of the distribution. Clamping up is honest in a way
 * that drawing the raggedness is not, because the bins are an artefact of the
 * request and the reader did not choose them.
 */
export const MIN_BANDWIDTH_BINS = 1.5;

/**
 * A share-normalized histogram smoothed with a Gaussian kernel, as one point
 * per bin centre.
 *
 * Pure, and a function of the histogram alone: the kernel is evaluated at each
 * bin centre against every other bin centre, weighted by that bin's share, and
 * the result is rescaled back to shares per bin so the curve integrates to the
 * same mass the bars did. A single spike therefore smooths to a Gaussian of
 * exactly the chosen bandwidth, which is the test.
 *
 * The two tails an explicit range pushed out are **not** smoothed into the
 * edges. Spreading mass the server reported as outside the range back inside it
 * would draw scans at values they do not have; `outsideShare` reports it instead,
 * and the card says so in words.
 */
export function densityPoints(
  result: DistributionResult,
  bandwidth: number | null = silvermanBandwidth(result),
): readonly DensityPoint[] {
  const h = result.histogram;
  const bins = h.counts.length;
  if (bins === 0 || !Number.isFinite(h.width) || h.width <= 0) return [];
  const total = histogramTotal(result);
  if (total <= 0) return [];
  const sigma = Math.max(bandwidth ?? 0, MIN_BANDWIDTH_BINS * h.width);
  const centres = Array.from({ length: bins }, (_, i) => h.lo + (i + 0.5) * h.width);
  const shares = h.counts.map((count) => count / total);
  return centres.map((value, i) => ({
    value,
    share: smoothedShare(shares, centres, i, sigma, h.width),
  }));
}

/**
 * One point of the smoothed curve, on the same "share per bin" scale as the
 * bars it replaces.
 *
 * A plain discrete convolution with a Gaussian of standard deviation `sigma`,
 * normalized analytically by `width / (sigma * sqrt(2*pi))` -- the textbook
 * kernel density estimate, read at a bin centre and expressed per bin.
 *
 * Analytic and not "normalized by the kernel's mass over this grid". The grid
 * normalization has one attractive property -- a flat histogram smooths to
 * exactly itself, with no droop at the ends -- and one disqualifying one: the
 * denominator shrinks towards the edges, so a spike in the second bin comes out
 * *taller* in the first than where the data is. A density whose peak is not
 * where the mass is is not a density. The price is that mass smoothed past
 * either end of the axis is drawn as leaving, which is true: it did.
 *
 * The property this buys is the one worth testing -- a single spike smooths to
 * a Gaussian of exactly the chosen bandwidth.
 */
function smoothedShare(
  shares: readonly number[],
  centres: readonly number[],
  at: number,
  sigma: number,
  width: number,
): number {
  const scale = width / (sigma * Math.sqrt(2 * Math.PI));
  let total = 0;
  for (let j = 0; j < shares.length; j += 1) {
    if (shares[j] === 0) continue;
    const z = (centres[at] - centres[j]) / sigma;
    total += shares[j] * Math.exp(-0.5 * z * z);
  }
  return total * scale;
}

/**
 * The share of a cohort that fell outside the range its histogram covers, split
 * below and above.
 *
 * Zero on a plain distribution panel, where the server chose the range from the
 * cohort's own quantiles and reports no tails. On a comparison panel the range
 * is shared, so one cohort can have real mass outside it -- and a curve that did
 * not say so would read as the whole cohort.
 */
export function outsideShare(result: DistributionResult): { below: number; above: number } {
  const total = histogramTotal(result);
  if (total <= 0) return { below: 0, above: 0 };
  return {
    below: (result.histogram.underflow ?? 0) / total,
    above: (result.histogram.overflow ?? 0) / total,
  };
}
