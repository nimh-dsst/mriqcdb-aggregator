import { kmeans } from './kmeans';

describe('kmeans', () => {
  it('computes the exact mean silhouette of separated one-dimensional pairs', () => {
    const result = kmeans([[0,0],[2,0],[10,0],[12,0]],2,42);
    expect(result.silhouette).toBeCloseTo((9/11 + 7/9)/2, 12);
    expect(result.silhouetteApproximation).toBe(false);
    expect(result.silhouetteSampleSize).toBe(4);
  });
  it('is deterministic for a seed and separates distant blobs', () => {
    const points: Array<[number, number]> = [
      [-10, -10], [-9, -11], [-11, -9], [10, 10], [11, 9], [9, 11],
    ];

    const first = kmeans(points, 2, 73);
    const second = kmeans(points, 2, 73);

    expect(first).toEqual(second);
    expect(new Set(first.assignments.slice(0, 3)).size).toBe(1);
    expect(new Set(first.assignments.slice(3)).size).toBe(1);
    expect(first.assignments[0]).not.toBe(first.assignments[3]);
    expect(first.centroids).toEqual([[-10, -10], [10, 10]]);
  });

  it('reports invalid observations and collapses duplicate constants honestly', () => {
    const result = kmeans([[5, -2], [5, -2], [Number.NaN, 1], [2, Infinity]], 2, 1);

    expect(result.assignments).toEqual([0, 0, -1, -1]);
    expect(result.centroids).toEqual([[5, -2]]);
    expect(result.clusters).toEqual([{ id: 0, n: 2, share: 1, medianX: 5, medianY: -2 }]);
    expect(result.silhouette).toBeNull();
    expect(result.validPointCount).toBe(2);
    expect(result.invalidPointCount).toBe(2);
  });

  it('returns original-unit centroids and medians', () => {
    const result = kmeans([[0, 0], [0, 2], [0, 4], [10, 10], [10, 12], [10, 14]], 2, 9);

    expect(result.centroids).toEqual([[0, 2], [10, 12]]);
    expect(result.clusters.map((cluster) => [cluster.medianX, cluster.medianY])).toEqual([[0, 2], [10, 12]]);
  });
});
