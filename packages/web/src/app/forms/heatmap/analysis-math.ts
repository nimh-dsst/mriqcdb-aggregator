import type { Density2dResult } from "@mriqc/shared";

export interface ContourPoint {
  mass: number;
  level: number;
  path: number;
  x: number;
  y: number;
  order: number;
}

interface Point {
  x: number;
  y: number;
}

interface Segment {
  a: string;
  b: string;
}

interface Crossing {
  key: string;
  point: Point;
}

const EDGE_BOTTOM = 0;
const EDGE_RIGHT = 1;
const EDGE_TOP = 2;
const EDGE_LEFT = 3;

/**
 * Returns the discrete highest-density cutoff that contains at least `mass`
 * of the histogram's observed grid mass.
 */
function densityLevel(values: readonly number[], mass: number): number | null {
  const positive = values.filter((value) => Number.isFinite(value) && value > 0);
  const total = positive.reduce((sum, value) => sum + value, 0);

  if (total <= 0 || !Number.isFinite(total)) {
    return null;
  }

  positive.sort((a, b) => b - a);
  const target = Math.min(1, Math.max(0, mass)) * total;
  let cumulative = 0;

  for (const value of positive) {
    cumulative += value;
    if (cumulative >= target) {
      return value;
    }
  }

  return positive[positive.length - 1] ?? null;
}

/**
 * Chooses an isovalue between density bands.  A histogram cutoff is inclusive,
 * so contouring at the cutoff itself would collapse a one-bin peak to a point.
 */
function contourLevel(values: readonly number[], cutoff: number): number {
  let nextLower = 0;

  for (const value of values) {
    if (Number.isFinite(value) && value >= 0 && value < cutoff && value > nextLower) {
      nextLower = value;
    }
  }

  return nextLower + (cutoff - nextLower) / 2;
}

function countAt(result: Density2dResult, x: number, y: number): number {
  const value = result.counts[y * result.x.bins + x] ?? 0;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function edgeKey(edge: number, x: number, y: number): string {
  switch (edge) {
    case EDGE_BOTTOM:
      return `h:${x}:${y}`;
    case EDGE_RIGHT:
      return `v:${x + 1}:${y}`;
    case EDGE_TOP:
      return `h:${x}:${y + 1}`;
    default:
      return `v:${x}:${y}`;
  }
}

function interpolate(a: Point, b: Point, aValue: number, bValue: number, level: number): Point {
  const denominator = bValue - aValue;
  const fraction = denominator === 0 ? 0.5 : (level - aValue) / denominator;
  const t = Math.min(1, Math.max(0, fraction));

  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  };
}

function saddleSegments(
  caseIndex: number,
  shifted: readonly [number, number, number, number],
): readonly [number, number][] {
  const determinant = shifted[0] * shifted[2] - shifted[1] * shifted[3];
  const highCornersConnect = determinant >= 0;

  if (caseIndex === 5) {
    return highCornersConnect
      ? [[EDGE_BOTTOM, EDGE_RIGHT], [EDGE_TOP, EDGE_LEFT]]
      : [[EDGE_LEFT, EDGE_BOTTOM], [EDGE_RIGHT, EDGE_TOP]];
  }

  return highCornersConnect
    ? [[EDGE_LEFT, EDGE_BOTTOM], [EDGE_RIGHT, EDGE_TOP]]
    : [[EDGE_BOTTOM, EDGE_RIGHT], [EDGE_TOP, EDGE_LEFT]];
}

function segmentsForCell(
  caseIndex: number,
  shifted: readonly [number, number, number, number],
): readonly [number, number][] {
  switch (caseIndex) {
    case 0:
    case 15:
      return [];
    case 1:
      return [[EDGE_LEFT, EDGE_BOTTOM]];
    case 2:
      return [[EDGE_BOTTOM, EDGE_RIGHT]];
    case 3:
      return [[EDGE_LEFT, EDGE_RIGHT]];
    case 4:
      return [[EDGE_RIGHT, EDGE_TOP]];
    case 5:
    case 10:
      return saddleSegments(caseIndex, shifted);
    case 6:
      return [[EDGE_BOTTOM, EDGE_TOP]];
    case 7:
      return [[EDGE_LEFT, EDGE_TOP]];
    case 8:
      return [[EDGE_TOP, EDGE_LEFT]];
    case 9:
      return [[EDGE_BOTTOM, EDGE_TOP]];
    case 11:
      return [[EDGE_RIGHT, EDGE_TOP]];
    case 12:
      return [[EDGE_RIGHT, EDGE_LEFT]];
    case 13:
      return [[EDGE_BOTTOM, EDGE_RIGHT]];
    case 14:
      return [[EDGE_LEFT, EDGE_BOTTOM]];
    default:
      return [];
  }
}

function traceClosedPaths(segments: readonly Segment[], crossings: ReadonlyMap<string, Point>): Point[][] {
  const incident = new Map<string, number[]>();

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    for (const key of [segment.a, segment.b]) {
      const attached = incident.get(key);
      if (attached) {
        attached.push(index);
      } else {
        incident.set(key, [index]);
      }
    }
  }

  const used = new Set<number>();
  const paths: Point[][] = [];

  for (let startSegment = 0; startSegment < segments.length; startSegment += 1) {
    if (used.has(startSegment)) {
      continue;
    }

    const initial = segments[startSegment]!;
    const keys = [initial.a, initial.b];
    used.add(startSegment);
    let previousSegment = startSegment;
    let currentKey = initial.b;
    let closed = currentKey === initial.a;

    while (!closed) {
      const candidates = (incident.get(currentKey) ?? []).filter((index) => index !== previousSegment && !used.has(index));
      const nextSegment = candidates[0];

      if (nextSegment === undefined) {
        break;
      }

      used.add(nextSegment);
      const next = segments[nextSegment]!;
      currentKey = next.a === currentKey ? next.b : next.a;
      keys.push(currentKey);
      previousSegment = nextSegment;
      closed = currentKey === initial.a;
    }

    if (!closed || keys.length < 4) {
      continue;
    }

    const path = keys.map((key) => crossings.get(key)).filter((point): point is Point => point !== undefined);
    if (path.length === keys.length) {
      paths.push(path);
    }
  }

  return paths;
}

function contourPaths(result: Density2dResult, level: number): Point[][] {
  const xBins = result.x.bins;
  const yBins = result.y.bins;
  const paddedWidth = xBins + 2;
  const paddedHeight = yBins + 2;
  const values: number[] = [];
  const nodes: Point[] = [];

  for (let y = 0; y < paddedHeight; y += 1) {
    for (let x = 0; x < paddedWidth; x += 1) {
      const sourceX = x - 1;
      const sourceY = y - 1;
      values.push(sourceX >= 0 && sourceX < xBins && sourceY >= 0 && sourceY < yBins
        ? countAt(result, sourceX, sourceY)
        : 0);
      nodes.push({
        x: result.x.lo + (x - 0.5) * result.x.width,
        y: result.y.lo + (y - 0.5) * result.y.width,
      });
    }
  }

  const valueAt = (x: number, y: number): number => values[y * paddedWidth + x] ?? 0;
  const pointAt = (x: number, y: number): Point => nodes[y * paddedWidth + x]!;
  const crossings = new Map<string, Point>();
  const segments: Segment[] = [];

  for (let y = 0; y < paddedHeight - 1; y += 1) {
    for (let x = 0; x < paddedWidth - 1; x += 1) {
      const cellValues: [number, number, number, number] = [
        valueAt(x, y),
        valueAt(x + 1, y),
        valueAt(x + 1, y + 1),
        valueAt(x, y + 1),
      ];
      const cellPoints: [Point, Point, Point, Point] = [
        pointAt(x, y),
        pointAt(x + 1, y),
        pointAt(x + 1, y + 1),
        pointAt(x, y + 1),
      ];
      const caseIndex = cellValues.reduce(
        (mask, value, index) => mask | (value >= level ? 1 << index : 0),
        0,
      );
      const shifted: [number, number, number, number] = [
        cellValues[0] - level,
        cellValues[1] - level,
        cellValues[2] - level,
        cellValues[3] - level,
      ];
      const cellSegments = segmentsForCell(caseIndex, shifted);

      const crossing = (edge: number): Crossing => {
        const existingKey = edgeKey(edge, x, y);
        const existing = crossings.get(existingKey);
        if (existing) {
          return { key: existingKey, point: existing };
        }

        const start = edge;
        const end = (edge + 1) % 4;
        const point = interpolate(
          cellPoints[start]!,
          cellPoints[end]!,
          cellValues[start]!,
          cellValues[end]!,
          level,
        );
        crossings.set(existingKey, point);
        return { key: existingKey, point };
      };

      for (const [firstEdge, secondEdge] of cellSegments) {
        const first = crossing(firstEdge);
        const second = crossing(secondEdge);
        if (first.key !== second.key) {
          segments.push({ a: first.key, b: second.key });
        }
      }
    }
  }

  return traceClosedPaths(segments, crossings);
}

/**
 * Builds closed, deterministic marching-squares paths for discrete
 * highest-density regions in a 2D histogram.
 */
export function massContours(
  result: Density2dResult,
  masses: readonly number[] = [0.25, 0.5, 0.75],
): ContourPoint[] {
  if (
    result.x.bins <= 0
    || result.y.bins <= 0
    || !Number.isFinite(result.x.width)
    || !Number.isFinite(result.y.width)
    || result.x.width <= 0
    || result.y.width <= 0
  ) {
    return [];
  }

  const values = result.counts.map((value) => Number.isFinite(value) && value > 0 ? value : 0);
  const points: ContourPoint[] = [];
  let pathId = 0;

  for (const mass of masses) {
    if (!Number.isFinite(mass) || mass < 0 || mass > 1) {
      continue;
    }

    const cutoff = densityLevel(values, mass);
    if (cutoff === null) {
      continue;
    }

    const level = contourLevel(values, cutoff);
    const paths = contourPaths(result, level);

    for (const path of paths) {
      path.forEach((coordinate, order) => {
        points.push({
          mass,
          level: cutoff,
          path: pathId,
          x: coordinate.x,
          y: coordinate.y,
          order,
        });
      });
      pathId += 1;
    }
  }

  return points;
}

/** Returns a two-sided Fisher z-transform 95% confidence interval. */
export function fisherInterval(r: number | null, n: number): [number, number] | null {
  if (r === null || !Number.isFinite(r) || !Number.isFinite(n) || n <= 3 || r < -1 || r > 1) {
    return null;
  }

  if (r === -1 || r === 1) {
    return [r, r];
  }

  const standardError = 1 / Math.sqrt(n - 3);
  const z = Math.atanh(r);
  const delta = 1.959963984540054 * standardError;

  return [Math.tanh(z - delta), Math.tanh(z + delta)];
}
