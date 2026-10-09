import { asColumnId, continuousAxisExpr, correlationFragments, quoteIdent, type CorrelationResult, type Density2dResult } from '@mriqc/shared';
import type { StudyCorrelationQuery, StudyDensity2dQuery } from '../api/api';
import { compileStudyStatement, metricExpression, predicate, shapeMetricSummary, studyHistogramRange, type BoundStatement, type StudyRow } from './study-sql';

export function compileStudyDensity2d(query: StudyDensity2dQuery, columns: ReadonlySet<string>) {
  const sampleSize = query.sampleSize;
  const seed = query.seed ?? 42;
  if (!Number.isInteger(sampleSize) || sampleSize < 0 || sampleSize > 20000 ||
      !Number.isInteger(seed) || seed < 0 || seed > 2147483647 ||
      !Number.isInteger(query.bins) || query.bins < 10 || query.bins > 200 || query.x === query.y)
    throw new Error('Invalid density grid, sample size or seed');
  if (query.range && [query.range.x, query.range.y].some(range => range.length !== 2 || !range.every(Number.isFinite) || range[0] >= range[1]))
    throw new Error('Invalid density range');
  const compiled = predicate(query, columns);
  if ((query.x === 'created_at' || query.y === 'created_at') && !columns.has('created_at')) throw new Error('Time density requires created_at');
  const holes = { table: quoteIdent('study'), where: compiled.where,
    x: query.x === 'created_at' ? continuousAxisExpr(asColumnId('created_at'), 'time') : metricExpression(query.modality, query.x, columns),
    y: query.y === 'created_at' ? continuousAxisExpr(asColumnId('created_at'), 'time') : metricExpression(query.modality, query.y, columns),
    sample_size: String(sampleSize), seed: String(seed) };
  return {
    stats: compileStudyStatement('density2d', 'stats', holes, compiled.params),
    range(row: StudyRow | undefined): { x: [number, number]; y: [number, number] } {
      if (query.range) return query.range;
      const axis = (name: string): [number, number] => studyHistogramRange(shapeMetricSummary({
        n: row?.['n'], min: row?.[`${name}_min`], max: row?.[`${name}_max`], quantiles: row?.[`${name}_quantiles`],
      }), query.clip);
      return { x: axis('x'), y: axis('y') };
    },
    histogram(range: { x: [number, number]; y: [number, number] }): BoundStatement {
      const args = ([lo, hi]: [number, number]) => [lo, hi, query.bins, query.bins, lo, (hi - lo) / query.bins];
      return compileStudyStatement('density2d', 'histogram', holes, [...compiled.params, ...args(range.x), ...args(range.y)]);
    },
    sample(range: { x: [number, number]; y: [number, number] }): BoundStatement {
      return compileStudyStatement('density2d', 'sample', holes, [...compiled.params, ...range.x, ...range.y]);
    },
  };
}

const coefficient = (value: unknown): number | null => value == null || !Number.isFinite(Number(value)) ? null : Number(value);

export function shapeDensity2d(query: StudyDensity2dQuery, stats: StudyRow | undefined,
  rows: readonly StudyRow[], points: readonly StudyRow[], range: { x: [number, number]; y: [number, number] }): Density2dResult {
  const axis = ([lo, hi]: [number, number]) => ({ lo, width: (hi - lo) / query.bins, bins: query.bins, underflow: 0, overflow: 0 });
  const x = axis(range.x), y = axis(range.y);
  const counts = new Array<number>(query.bins ** 2).fill(0);
  for (const row of rows) {
    const bx = Number(row['bx']), by = Number(row['by']), n = Number(row['n']);
    if (bx < 0) x.underflow += n;
    else if (bx >= query.bins) x.overflow += n;
    else if (by < 0) y.underflow += n;
    else if (by >= query.bins) y.overflow += n;
    else counts[by * query.bins + bx] += n;
  }
  return { xKind: query.x === 'created_at' ? 'time' : 'metric', yKind: query.y === 'created_at' ? 'time' : 'metric', x, y, counts, n: Number(stats?.['n'] ?? 0), pearson: coefficient(stats?.['pearson']),
    spearman: coefficient(stats?.['spearman']), sample: points.map(row => [Number(row['x']), Number(row['y'])]) };
}

export function compileStudyCorrelation(query: StudyCorrelationQuery, columns: ReadonlySet<string>): BoundStatement {
  if (query.metrics.length < 2 || query.metrics.length > 24 || new Set(query.metrics).size !== query.metrics.length)
    throw new Error('Choose two to 24 distinct metrics');
  const compiled = predicate(query, columns);
  const expressions = query.metrics.map(metric => metricExpression(query.modality, metric, columns));
  return compileStudyStatement('correlation', 'matrix', { table: quoteIdent('study'), where: compiled.where,
    ...correlationFragments(expressions, query.method) }, compiled.params);
}

export function shapeCorrelation(query: StudyCorrelationQuery, row: StudyRow | undefined): CorrelationResult {
  const size = query.metrics.length;
  const matrix = (prefix: string): number[][] => Array.from({ length: size }, (_, i) =>
    Array.from({ length: size }, (_, j) => {
      const raw = row?.[`${prefix}${Math.min(i, j)}_${Math.max(i, j)}`];
      return prefix === 'n' ? Number(raw ?? 0) : coefficient(raw) ?? Number.NaN;
    }));
  const pairN = matrix('n');
  return { metrics: [...query.metrics], pairN, minPairN: Math.min(...pairN.flat()),
    ...(query.method !== 'spearman' ? { pearson: matrix('p') } : {}),
    ...(query.method !== 'pearson' ? { spearman: matrix('s') } : {}) };
}
