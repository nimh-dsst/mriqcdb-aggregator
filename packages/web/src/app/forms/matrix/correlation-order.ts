/**
 * Orders matrix dimensions by average-linkage clustering with distance 1 - |r|.
 * A missing, non-finite, or out-of-range correlation is treated as r = 0, so it
 * remains maximally distant without making the ordering non-deterministic.
 */
export function correlationOrder(matrix: readonly (readonly (number | null)[])[]): number[] {
  const size = matrix.length;
  if (size < 2) {
    return Array.from({ length: size }, (_, index) => index);
  }

  interface Cluster {
    id: number;
    members: number[];
  }

  const distances = new Map<string, number>();
  const getDistance = (left: number, right: number): number => distances.get(pairKey(left, right)) ?? 1;
  const setDistance = (left: number, right: number, distance: number): void => {
    distances.set(pairKey(left, right), distance);
  };
  const clusters: Cluster[] = Array.from({ length: size }, (_, index) => ({ id: index, members: [index] }));
  let nextId = size;

  for (let left = 0; left < size; left += 1) {
    for (let right = left + 1; right < size; right += 1) {
      setDistance(left, right, 1 - Math.abs(symmetricCorrelation(matrix, left, right)));
    }
  }

  while (clusters.length > 1) {
    let bestLeft = 0;
    let bestRight = 1;
    for (let left = 0; left < clusters.length; left += 1) {
      for (let right = left + 1; right < clusters.length; right += 1) {
        if (comparePair(clusters[left], clusters[right], clusters[bestLeft], clusters[bestRight], getDistance) < 0) {
          bestLeft = left;
          bestRight = right;
        }
      }
    }

    const first = clusters[bestLeft];
    const second = clusters[bestRight];
    const [left, right] = compareMembers(first.members, second.members) <= 0 ? [first, second] : [second, first];
    const merged: Cluster = { id: nextId, members: [...left.members, ...right.members] };
    nextId += 1;
    const remaining = clusters.filter((_, index) => index !== bestLeft && index !== bestRight);

    for (const other of remaining) {
      const weightedDistance = (
        getDistance(first.id, other.id) * first.members.length
        + getDistance(second.id, other.id) * second.members.length
      ) / (first.members.length + second.members.length);
      setDistance(merged.id, other.id, weightedDistance);
    }
    clusters.length = 0;
    clusters.push(...remaining, merged);
  }

  return clusters[0].members;
}

function comparePair(
  left: { id: number; members: readonly number[] },
  right: { id: number; members: readonly number[] },
  currentLeft: { id: number; members: readonly number[] },
  currentRight: { id: number; members: readonly number[] },
  getDistance: (left: number, right: number) => number,
): number {
  const distanceDifference = getDistance(left.id, right.id) - getDistance(currentLeft.id, currentRight.id);
  if (distanceDifference !== 0) {
    return distanceDifference;
  }
  const firstDifference = compareMembers(left.members, currentLeft.members);
  if (firstDifference !== 0) {
    return firstDifference;
  }
  return compareMembers(right.members, currentRight.members);
}

function symmetricCorrelation(
  matrix: readonly (readonly (number | null)[])[],
  left: number,
  right: number,
): number {
  const forward = finiteCorrelation(matrix[left]?.[right]);
  const backward = finiteCorrelation(matrix[right]?.[left]);
  if (forward === null && backward === null) {
    return 0;
  }
  if (forward === null) {
    return backward as number;
  }
  if (backward === null) {
    return forward;
  }
  return forward / 2 + backward / 2;
}

function finiteCorrelation(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1 ? value : null;
}

function compareMembers(left: readonly number[], right: readonly number[]): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return left.length - right.length;
}

function pairKey(left: number, right: number): string {
  return left < right ? `${left}:${right}` : `${right}:${left}`;
}
