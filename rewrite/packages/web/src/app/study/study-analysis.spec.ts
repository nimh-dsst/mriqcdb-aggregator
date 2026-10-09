import {
  compileStudyCorrelation,
  compileStudyDensity2d,
  shapeCorrelation,
  shapeDensity2d,
} from './study-analysis';
import {
  asColumnId,
  correlationFragments,
  quoteIdent,
  statementsOf,
} from '@mriqc/shared';
import {
  type StudyCorrelationQuery,
  type StudyDensity2dQuery,
} from '../api/api';

const densityQuery: StudyDensity2dQuery = {
  source: 'study',
  proc: 'density2d',
  modality: 'bold',
  view: 'raw',
  filters: [],
  x: asColumnId('fd_mean'),
  y: asColumnId('tsnr'),
  bins: 120,
  clip: 'p01p99',
  sampleSize: 2000,
  seed: 42,
};

const correlationQuery: StudyCorrelationQuery = {
  source: 'study',
  proc: 'correlation',
  modality: 'bold',
  view: 'raw',
  filters: [],
  metrics: [asColumnId('fd_mean'), asColumnId('tsnr')],
  method: 'both',
};

const columns = new Set([
  asColumnId('fd_mean'),
  asColumnId('tsnr'),
  asColumnId('manufacturer'),
]);

describe('study analysis SQL compilers', () => {
  it('binds the density2d statements from the shared templates', () => {
    const compiled = compileStudyDensity2d(densityQuery, columns);
    expect(compiled.stats.template).toBe('density2d');
    expect(compiled.stats.statement).toBe('stats');
    expect(compiled.stats.sql).toContain('CAST("fd_mean" AS DOUBLE)');
    expect(compiled.stats.sql).toContain('CAST("tsnr" AS DOUBLE)');
    expect(compiled.stats.sql).toContain('"study"');

    const range = { x: [-1.25, 2.5] as [number, number], y: [4, 9] as [number, number] };
    const histogram = compiled.histogram(range);
    const sample = compiled.sample(range);
    expect(histogram.params).toEqual([-1.25, 2.5, 120, 120, -1.25, 3.75 / 120, 4, 9, 120, 120, 4, 5 / 120]);
    expect(sample.params).toEqual([-1.25, 2.5, 4, 9]);
    expect(histogram.sql).toContain('"fd_mean"');
    expect(histogram.sql).toContain('"tsnr"');
    expect(sample.sql).toContain('"study"');
    for (const statement of [compiled.stats, histogram, sample]) {
      const expected = statementsOf('density2d').get(statement.statement)!
        .replaceAll('{{table}}', '"study"').replaceAll('{{where}}', 'TRUE')
        .replaceAll('{{x}}', 'CAST("fd_mean" AS DOUBLE)').replaceAll('{{y}}', 'CAST("tsnr" AS DOUBLE)')
        .replaceAll('{{sample_size}}', '2000').replaceAll('{{seed}}', '42');
      expect(statement.sql).toBe(expected);
    }
  });

  it('uses p01 and p99 quantiles for the density range', () => {
    const compiled = compileStudyDensity2d(densityQuery, columns);
    const stats = {
      n: 100,
      pearson: 0.4,
      spearman: 0.3,
      x_min: -8,
      x_max: 12,
      x_quantiles: [-2, -1, 0, 2, 3, 5, 7],
      y_min: -4,
      y_max: 14,
      y_quantiles: [-1, 0, 3, 5, 7, 9, 11],
    };
    expect(compiled.range(stats)).toEqual({ x: [-2, 7], y: [-1, 11] });
  });

  it('rejects unknown density metrics and invalid sampling seeds', () => {
    expect(() =>
      compileStudyDensity2d(
        { ...densityQuery, x: asColumnId('not_a_column') },
        columns,
      ),
    ).toThrow();
    expect(() =>
      compileStudyDensity2d({ ...densityQuery, seed: -1 }, columns),
    ).toThrow();
    expect(() =>
      compileStudyDensity2d({ ...densityQuery, seed: 1.5 }, columns),
    ).toThrow();
  });

  it('quotes identifiers as SQL identifiers, including embedded quotes', () => {
    expect(quoteIdent('manufacturer')).toBe('"manufacturer"');
    expect(quoteIdent('a"b')).toBe('"a""b"');
  });
});

describe('study correlation compiler and shaping', () => {
  it('uses the matrix template and both-method fragments', () => {
    const compiled = compileStudyCorrelation(correlationQuery, columns);
    expect(compiled.template).toBe('correlation');
    expect(compiled.statement).toBe('matrix');
    expect(compiled.sql).toContain('"fd_mean"');
    expect(compiled.sql).toContain('"tsnr"');
    expect(compiled.params).toEqual([]);
    const fragments = correlationFragments(
      correlationQuery.metrics.map((metric) => `CAST(${quoteIdent(metric)} AS DOUBLE)`),
      correlationQuery.method,
    );
    for (const fragment of Object.values(fragments)) {
      expect(compiled.sql).toContain(String(fragment));
    }
    let expected = statementsOf('correlation').get('matrix')!.replaceAll('{{table}}', '"study"').replaceAll('{{where}}', 'TRUE');
    for (const [key, value] of Object.entries(fragments)) expected = expected.replaceAll(`{{${key}}}`, value);
    expect(compiled.sql).toBe(expected);
  });

  it('rejects correlation metrics outside the advertised column set', () => {
    expect(() =>
      compileStudyCorrelation(
        {
          ...correlationQuery,
          metrics: [asColumnId('fd_mean'), asColumnId('not_a_column')],
        },
        columns,
      ),
    ).toThrow();
  });

  it('keeps density bins x-first and counts exclusive overflow rows', () => {
    const range = { x: [0, 10] as [number, number], y: [0, 20] as [number, number] };
    const result = shapeDensity2d(
      densityQuery,
      {
        n: 8,
        pearson: 0.5,
        spearman: 0.4,
        x_min: 0,
        x_max: 10,
        x_quantiles: [0, 1, 2, 5, 8, 9, 10],
        y_min: 0,
        y_max: 20,
        y_quantiles: [0, 2, 4, 10, 16, 18, 20],
      },
      [
        { bx: 2, by: 3, n: 7 },
        { bx: 0, by: 1, n: 1 },
        { bx: -1, by: 2, n: 4 },
        { bx: 120, by: 2, n: 5 },
        { bx: 2, by: -1, n: 6 },
        { bx: 2, by: 120, n: 8 },
        { bx: -1, by: -1, n: 99 },
      ],
      [{ x: 1, y: 2 }, { x: 9, y: 19 }],
      range,
    );

    expect(result.x).toMatchObject({
      lo: 0,
      width: 10 / 120,
      bins: 120,
      underflow: 103,
      overflow: 5,
    });
    expect(result.y).toMatchObject({
      lo: 0,
      width: 20 / 120,
      bins: 120,
      underflow: 6,
      overflow: 8,
    });
    expect(result.counts).toHaveLength(120 * 120);
    expect(result.counts[3 * 120 + 2]).toBe(7);
    expect(result.counts[1 * 120 + 0]).toBe(1);
    expect(result.n).toBe(8);
    expect(result.pearson).toBe(0.5);
    expect(result.spearman).toBe(0.4);
    expect(result.sample).toEqual([[1, 2], [9, 19]]);
  });

  it('returns a symmetric correlation matrix and undefined coefficients for nulls', () => {
    const result = shapeCorrelation(
      correlationQuery,
      {
        n0_0: 12,
        n0_1: 10,
        n1_1: 12,
        p0_0: 1,
        p1_1: 1,
        s0_0: 1,
        s0_1: 0.75,
        s1_1: 1,
      },
    );
    expect(result.metrics).toEqual(['fd_mean', 'tsnr']);
    expect(result.pairN).toEqual([[12, 10], [10, 12]]);
    expect(result.minPairN).toBe(10);
    expect(result.pearson).toEqual([[1, NaN], [NaN, 1]]);
    expect(result.spearman).toEqual([[1, 0.75], [0.75, 1]]);
  });
});
