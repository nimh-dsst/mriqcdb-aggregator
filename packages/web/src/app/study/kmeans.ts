export type Point = readonly [number, number];

export interface KMeansCluster {
  id: number;
  n: number;
  share: number;
  medianX: number;
  medianY: number;
}

export interface KMeansResult {
  /** One cluster id for each input point; non-finite points are -1. */
  assignments: number[];
  /** Cluster centres in the input coordinate system. */
  centroids: Array<[number, number]>;
  clusters: KMeansCluster[];
  /** Mean silhouette in standardised coordinate space, when it is defined. */
  silhouette: number | null;
  /** Number of observations on which the silhouette mean was evaluated. */
  silhouetteSampleSize: number;
  /** Number of observations used as distance anchors for the silhouette. */
  silhouetteSampleCount: number;
  /** True when either silhouette observations or anchors were sampled. */
  silhouetteApproximation: boolean;
  /** Number of finite input points used for clustering. */
  validPointCount: number;
  /** Number of input points excluded because at least one coordinate was non-finite. */
  invalidPointCount: number;
}

export interface KMeansWorkerRequest {
  id: string;
  points: Array<[number, number]>;
  k: number;
  seed: number;
}

export type KMeansWorkerResponse =
  | { id: string; result: KMeansResult }
  | { id: string; error: string };

export const KMEANS_RESTARTS = 20;
export const KMEANS_MIN_K = 2;
export const KMEANS_MAX_K = 8;

const MAX_LLOYD_ITERATIONS = 100;

interface IndexedPoint {
  sourceIndex: number;
  x: number;
  y: number;
  scaledX: number;
  scaledY: number;
}

interface StandardisedAxis {
  values: number[];
}

interface RunResult {
  assignments: number[];
  centroids: Array<[number, number]>;
  inertia: number;
}

/**
 * Deterministic Lloyd k-means with both dimensions standardised before fitting.
 * If there are fewer distinct finite observations than requested clusters, the
 * result contains one cluster per distinct observation instead of empty clusters.
 */
export function kmeans(
  points: readonly Point[],
  k: number,
  seed: number,
): KMeansResult {
  if (!Number.isInteger(k) || k < KMEANS_MIN_K || k > KMEANS_MAX_K) {
    throw new RangeError(`k must be an integer from ${KMEANS_MIN_K} to ${KMEANS_MAX_K}`);
  }

  const valid: IndexedPoint[] = [];
  const assignments = Array<number>(points.length).fill(-1);
  const xs: number[] = [];
  const ys: number[] = [];

  points.forEach((point, sourceIndex) => {
    const x = point?.[0];
    const y = point?.[1];
    if (Number.isFinite(x) && Number.isFinite(y)) {
      xs.push(x);
      ys.push(y);
      valid.push({ sourceIndex, x, y, scaledX: 0, scaledY: 0 });
    }
  });

  if (valid.length === 0) {
    return emptyResult(assignments, points.length);
  }

  const standardX = standardise(xs);
  const standardY = standardise(ys);
  valid.forEach((point, index) => {
    point.scaledX = standardX.values[index];
    point.scaledY = standardY.values[index];
  });

  const effectiveK = Math.min(k, countDistinctPoints(valid));
  const best = bestRun(valid, effectiveK, seed);
  const ordered = orderClusters(best, effectiveK);

  ordered.assignments.forEach((clusterId, validIndex) => {
    assignments[valid[validIndex].sourceIndex] = clusterId;
  });

  const clusters = buildClusters(valid, ordered.assignments, effectiveK);
  const silhouette = calculateSilhouette(valid, ordered.assignments, effectiveK);

  return {
    assignments,
    centroids: clusters.centroids,
    clusters: clusters.summaries,
    silhouette: silhouette.value,
    silhouetteSampleSize: silhouette.evaluationCount,
    silhouetteSampleCount: silhouette.anchorCount,
    silhouetteApproximation: silhouette.approximate,
    validPointCount: valid.length,
    invalidPointCount: points.length - valid.length,
  };
}

/** Creates the module worker used by the study panel. */
export function createKMeansWorker(): Worker {
  return new Worker(new URL('./kmeans.worker', import.meta.url), { type: 'module' });
}

function emptyResult(assignments: number[], invalidPointCount: number): KMeansResult {
  return {
    assignments,
    centroids: [],
    clusters: [],
    silhouette: null,
    silhouetteSampleSize: 0,
    silhouetteSampleCount: 0,
    silhouetteApproximation: false,
    validPointCount: 0,
    invalidPointCount,
  };
}

function standardise(values: readonly number[]): StandardisedAxis {
  let maxMagnitude = 0;
  for (const value of values) {
    maxMagnitude = Math.max(maxMagnitude, Math.abs(value));
  }
  if (maxMagnitude === 0) {
    return { values: values.map(() => 0) };
  }

  const normalised = values.map((value) => value / maxMagnitude);
  const mean = normalised.reduce((total, value) => total + value, 0) / normalised.length;
  const variance = normalised.reduce((total, value) => {
    const delta = value - mean;
    return total + delta * delta;
  }, 0) / normalised.length;
  const deviation = Math.sqrt(variance);

  if (deviation === 0 || !Number.isFinite(deviation)) {
    return { values: values.map(() => 0) };
  }
  return { values: normalised.map((value) => (value - mean) / deviation) };
}

function countDistinctPoints(points: readonly IndexedPoint[]): number {
  const seen = new Set<string>();
  for (const point of points) {
    seen.add(`${point.scaledX},${point.scaledY}`);
  }
  return seen.size;
}

function bestRun(points: readonly IndexedPoint[], k: number, seed: number): RunResult {
  let best: RunResult | undefined;
  for (let restart = 0; restart < KMEANS_RESTARTS; restart += 1) {
    const restartSeed = (normaliseSeed(seed) + Math.imul(restart + 1, 0x9e3779b9)) >>> 0;
    const run = lloyd(points, k, restartSeed);
    if (best === undefined || run.inertia < best.inertia) {
      best = run;
    }
  }
  // k is bounded by the distinct finite points, so each run is well defined.
  return best as RunResult;
}

function lloyd(points: readonly IndexedPoint[], k: number, seed: number): RunResult {
  let centroids = initialisePlusPlus(points, k, seed);
  let assignments = Array<number>(points.length).fill(-1);

  for (let iteration = 0; iteration < MAX_LLOYD_ITERATIONS; iteration += 1) {
    const nextAssignments = assignPoints(points, centroids);
    const nextCentroids = recomputeCentroids(points, nextAssignments, k, centroids);
    const changed = nextAssignments.some((assignment, index) => assignment !== assignments[index]);
    assignments = nextAssignments;
    centroids = nextCentroids;
    if (!changed) {
      break;
    }
  }

  const inertia = points.reduce((total, point, index) => {
    const centroid = centroids[assignments[index]];
    return total + squaredDistance(point.scaledX, point.scaledY, centroid[0], centroid[1]);
  }, 0);
  return { assignments, centroids, inertia };
}

function initialisePlusPlus(
  points: readonly IndexedPoint[],
  k: number,
  seed: number,
): Array<[number, number]> {
  const random = mulberry32(seed);
  const first = Math.floor(random() * points.length);
  const selected = new Set<number>([first]);
  const centroids: Array<[number, number]> = [[points[first].scaledX, points[first].scaledY]];

  while (centroids.length < k) {
    const distances = points.map((point) => nearestSquaredDistance(point, centroids));
    const total = distances.reduce((sum, distance) => sum + distance, 0);
    let next = -1;
    if (total > 0 && Number.isFinite(total)) {
      let threshold = random() * total;
      for (let index = 0; index < distances.length; index += 1) {
        if (selected.has(index)) {
          continue;
        }
        threshold -= distances[index];
        if (threshold <= 0) {
          next = index;
          break;
        }
      }
    }
    if (next < 0 || selected.has(next)) {
      next = firstUnselectedFarthest(distances, selected);
    }
    selected.add(next);
    centroids.push([points[next].scaledX, points[next].scaledY]);
  }
  return centroids;
}

function firstUnselectedFarthest(distances: readonly number[], selected: ReadonlySet<number>): number {
  let candidate = -1;
  let farthest = -1;
  distances.forEach((distance, index) => {
    if (!selected.has(index) && distance > farthest) {
      candidate = index;
      farthest = distance;
    }
  });
  return candidate;
}

function assignPoints(
  points: readonly IndexedPoint[],
  centroids: readonly (readonly [number, number])[],
): number[] {
  return points.map((point) => {
    let cluster = 0;
    let distance = nearestSquaredDistance(point, [centroids[0]]);
    for (let index = 1; index < centroids.length; index += 1) {
      const candidate = squaredDistance(
        point.scaledX,
        point.scaledY,
        centroids[index][0],
        centroids[index][1],
      );
      if (candidate < distance) {
        cluster = index;
        distance = candidate;
      }
    }
    return cluster;
  });
}

function recomputeCentroids(
  points: readonly IndexedPoint[],
  assignments: readonly number[],
  k: number,
  previous: readonly (readonly [number, number])[],
): Array<[number, number]> {
  const sums = Array.from({ length: k }, () => [0, 0, 0]);
  points.forEach((point, index) => {
    const sum = sums[assignments[index]];
    sum[0] += point.scaledX;
    sum[1] += point.scaledY;
    sum[2] += 1;
  });
  return sums.map((sum, index) => {
    if (sum[2] === 0) {
      return [previous[index][0], previous[index][1]];
    }
    return [sum[0] / sum[2], sum[1] / sum[2]];
  });
}

function orderClusters(
  result: RunResult,
  k: number,
): RunResult {
  const order = Array.from({ length: k }, (_, index) => index).sort((left, right) => {
    const a = result.centroids[left];
    const b = result.centroids[right];
    return a[0] - b[0] || a[1] - b[1] || left - right;
  });
  const renumber = Array<number>(k);
  order.forEach((oldId, newId) => {
    renumber[oldId] = newId;
  });
  return {
    assignments: result.assignments.map((assignment) => renumber[assignment]),
    centroids: order.map((index) => result.centroids[index]),
    inertia: result.inertia,
  };
}

function buildClusters(
  points: readonly IndexedPoint[],
  assignments: readonly number[],
  k: number,
): { centroids: Array<[number, number]>; summaries: KMeansCluster[] } {
  const members = Array.from({ length: k }, () => [] as IndexedPoint[]);
  points.forEach((point, index) => {
    members[assignments[index]].push(point);
  });
  const centroids = members.map((cluster) => [
    stableMean(cluster.map((point) => point.x)),
    stableMean(cluster.map((point) => point.y)),
  ] as [number, number]);
  const summaries = members.map((cluster, id) => ({
    id,
    n: cluster.length,
    share: cluster.length / points.length,
    medianX: median(cluster.map((point) => point.x)),
    medianY: median(cluster.map((point) => point.y)),
  }));
  return { centroids, summaries };
}

function calculateSilhouette(
  points: readonly IndexedPoint[],
  assignments: readonly number[],
  k: number,
): { value: number | null; evaluationCount: number; anchorCount: number; approximate: boolean } {
  if (k < 2) {
    return { value: null, evaluationCount: 0, anchorCount: 0, approximate: false };
  }
  const members = Array.from({ length: k }, () => [] as number[]);
  assignments.forEach((cluster, index) => members[cluster].push(index));
  if (members.some((cluster) => cluster.length === 0)) {
    return { value: null, evaluationCount: 0, anchorCount: 0, approximate: false };
  }

  // Exact mean silhouette on the retained sample. Accumulate each pair once;
  // O(n*k) storage avoids a 20,000-square distance matrix in the worker.
  const sums = new Float64Array(points.length * k);
  const xs = Float64Array.from(points, p => p.scaledX);
  const ys = Float64Array.from(points, p => p.scaledY);
  for (let i = 0; i < points.length; i++) {
    const row = i * k, own = assignments[i], x = xs[i], y = ys[i];
    for (let j = i + 1; j < points.length; j++) {
      const dx = x - xs[j], dy = y - ys[j];
      const distance = Math.sqrt(dx * dx + dy * dy);
      sums[row + assignments[j]] += distance;
      sums[j * k + own] += distance;
    }
  }
  let total = 0;
  for (let pointIndex = 0; pointIndex < points.length; pointIndex++) {
    const ownCluster = assignments[pointIndex];
    if (members[ownCluster].length === 1) {
      continue;
    }
    const within = sums[pointIndex * k + ownCluster] / (members[ownCluster].length - 1);
    let nearestOther = Number.POSITIVE_INFINITY;
    for (let cluster = 0; cluster < k; cluster += 1) {
      if (cluster !== ownCluster) {
        nearestOther = Math.min(nearestOther, sums[pointIndex * k + cluster] / members[cluster].length);
      }
    }
    const denominator = Math.max(within, nearestOther);
    total += denominator === 0 ? 0 : (nearestOther - within) / denominator;
  }
  return {
    value: points.length === 0 ? null : total / points.length,
    evaluationCount: points.length,
    anchorCount: points.length,
    approximate: false,
  };
}

function nearestSquaredDistance(
  point: IndexedPoint,
  centroids: readonly (readonly [number, number])[],
): number {
  return centroids.reduce((nearest, centroid) => Math.min(
    nearest,
    squaredDistance(point.scaledX, point.scaledY, centroid[0], centroid[1]),
  ), Number.POSITIVE_INFINITY);
}

function squaredDistance(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

function stableMean(values: readonly number[]): number {
  let maxMagnitude = 0;
  values.forEach((value) => {
    maxMagnitude = Math.max(maxMagnitude, Math.abs(value));
  });
  if (maxMagnitude === 0) {
    return 0;
  }
  return (values.reduce((total, value) => total + value / maxMagnitude, 0) / values.length) * maxMagnitude;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }
  return sorted[middle - 1] / 2 + sorted[middle] / 2;
}

function normaliseSeed(seed: number): number {
  return Number.isFinite(seed) ? Math.trunc(seed) >>> 0 : 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
