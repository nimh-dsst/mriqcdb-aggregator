import { asColumnId, statementsOf, binnedSummaryFragments, continuousAxisExpr, type BinnedSummaryQuery, type MetricSummary } from '@mriqc/shared';
import { compileStudyBinnedSummary, shapeBinnedSummary } from './study-binned-summary';
import { compileStudyDensity2d, shapeDensity2d } from './study-analysis';
import type { StudyDistributionQuery, StudyGroupedSummaryQuery } from '../api/api';
import {
  MAX_STUDY_GROUPS,
  compileStudyDistribution,
  compileStudyGroupedSummary,
  shapeDistributionResult,
  shapeGroupedSummaryResult,
  studyGroupExpression,
} from './study-sql';

const columns = new Set(['fd_mean', 'manufacturer', 'echo_time']);

const distributionQuery: StudyDistributionQuery = {
  source: 'study',
  proc: 'distribution',
  modality: 'bold',
  view: 'raw',
  metric: asColumnId('fd_mean'),
  bins: 4,
  clip: 'none',
  filters: [{ field: asColumnId('manufacturer'), op: 'in', values: ['Siemens'] }],
  selections: [{ metric: asColumnId('fd_mean'), range: [0.1, 0.5] }],
};

describe('study SQL compilation', () => {
  for (const orientation of ['metrics', 'time-x', 'time-y']) {
    const time = orientation === 'time-x';
    const timeY = orientation === 'time-y';
    it(`compiles byte-identical shared binned-summary statements for ${orientation}`, () => {
      const query: BinnedSummaryQuery = { source: 'study', proc: 'binnedSummary', modality: 'bold', view: 'raw', filters: [],
        x: time ? 'created_at' : asColumnId('fd_mean'), y: asColumnId(timeY ? 'created_at' : 'tsnr'), bins: time ? 'month' : 12 };
      const plan = compileStudyBinnedSummary(query, new Set(['created_at', 'fd_mean', 'tsnr']));
      const holes: Record<string, string> = { table: '"study"', where: 'TRUE',
        x: time ? continuousAxisExpr(asColumnId('created_at'), 'time') : 'CAST("fd_mean" AS DOUBLE)',
        y: timeY ? continuousAxisExpr(asColumnId('created_at'), 'time') : 'CAST("tsnr" AS DOUBLE)', group_expr: 'NULL', group_numeric: 'FALSE', group_bins: '10', max_groups: '50',
        ...binnedSummaryFragments(query.bins) };
      for (const bound of [plan.stats, plan.buckets([0, 30])]) {
        const expected = statementsOf('binned_summary').get(bound.statement)!
          .replace(/\{\{(\w+)\}\}/g, (_, name: string) => holes[name]);
        expect(bound.sql).toBe(expected);
      }
      expect(plan.buckets([0, 30]).params).toEqual([0, 30, time ? 1 : 12]);
      expect(shapeBinnedSummary([], query, [0, 30])).toMatchObject({ xKind: time ? 'time' : 'metric', yKind: timeY ? 'time' : 'metric' });
      if (timeY) expect(() => compileStudyBinnedSummary(query, new Set(['fd_mean']))).toThrow('created_at');
    });
  }

  it.each(['x', 'y'])('compiles byte-identical density statements for upload-time %s', axis => {
    const query = { source: 'study' as const, proc: 'density2d' as const, modality: 'bold' as const, view: 'raw' as const, filters: [],
      x: asColumnId(axis === 'x' ? 'created_at' : 'fd_mean'), y: asColumnId(axis === 'y' ? 'created_at' : 'fd_mean'), bins: 20, sampleSize: 300, seed: 42, clip: 'none' as const };
    const plan = compileStudyDensity2d(query, new Set(['created_at', 'fd_mean']));
    const range = { x: [0, 31] as [number, number], y: [0, 1] as [number, number] };
    const holes: Record<string, string> = { table: '"study"', where: 'TRUE',
      x: axis === 'x' ? continuousAxisExpr(asColumnId('created_at'), 'time') : 'CAST("fd_mean" AS DOUBLE)',
      y: axis === 'y' ? continuousAxisExpr(asColumnId('created_at'), 'time') : 'CAST("fd_mean" AS DOUBLE)', sample_size: '300', seed: '42' };
    for (const bound of [plan.stats, plan.histogram(range), plan.sample(range)]) {
      expect(bound.sql).toBe(statementsOf('density2d').get(bound.statement)!.replace(/\{\{(\w+)\}\}/g, (_, name: string) => holes[name]));
    }
    expect(shapeDensity2d(query, undefined, [], [], range)).toMatchObject({ xKind: axis === 'x' ? 'time' : 'metric', yKind: axis === 'y' ? 'time' : 'metric' });
    expect(() => compileStudyDensity2d(query, new Set(['fd_mean']))).toThrow('created_at');
  });

  it('fills the shared distribution statement without changing its SQL identity', () => {
    const plan = compileStudyDistribution(distributionQuery, columns);
    const expected = (statementsOf('distribution').get('stats') as string)
      .replaceAll('{{table}}', '"study"')
      .replaceAll('{{metric}}', 'CAST("fd_mean" AS DOUBLE)')
      .replaceAll(
        '{{where}}',
        'TRUE AND ("manufacturer" IN (?)) AND isfinite(CAST("fd_mean" AS DOUBLE)) AND CAST("fd_mean" AS DOUBLE) BETWEEN ? AND ?',
      );

    expect(plan.stats.sql).toBe(expected);
    expect(plan.stats.params).toEqual(['Siemens', 0.1, 0.5]);
    expect(plan.histogram(0, 1, 4, true).params).toEqual([
      'Siemens',
      0.1,
      0.5,
      0,
      1,
      4,
      4,
      0,
      0.25,
    ]);
  });

  it('orders numeric-group expression values before filters and template values', () => {
    const query: StudyGroupedSummaryQuery = {
      source: 'study',
      proc: 'groupedSummary',
      modality: 'bold',
      view: 'raw',
      metric: asColumnId('fd_mean'),
      group: asColumnId('echo_time'),
      filters: [{ field: asColumnId('manufacturer'), op: 'in', values: ['GE'] }],
    };
    const plan = compileStudyGroupedSummary(query, columns);
    const compiled = plan.statements({ lo: 0.01, width: 0.002 });

    expect(plan.groupRange?.params).toEqual(['GE']);
    expect(compiled.stats.params).toEqual([0.01, 0.002, 'GE', MAX_STUDY_GROUPS, MAX_STUDY_GROUPS]);
    expect(compiled.stats.sql).toContain(
      (statementsOf('grouped_summary').get('stats') as string).split('{{group_expr}}')[0],
    );
  });

  it('refuses authored fields that the uploaded schema does not contain', () => {
    expect(() => compileStudyDistribution(distributionQuery, new Set(['fd_mean']))).toThrowError(
      'The uploaded study has no column "manufacturer"',
    );
  });
});

describe('study result shaping', () => {
  const summary: MetricSummary = {
    n: 7,
    min: -1,
    max: 5,
    mean: 2,
    stddev: 1,
    quantiles: { p01: -0.5, p05: 0, p25: 1, p50: 2, p75: 3, p95: 4, p99: 4.5 },
  };

  it('densifies explicit-range histograms and preserves underflow and overflow', () => {
    expect(
      shapeDistributionResult(
        summary,
        [
          { bin: -1, n: 1 },
          { bin: 0, n: 2 },
          { bin: 2, n: 3 },
          { bin: 4, n: 1 },
        ],
        4,
        0,
        4,
        true,
      ).histogram,
    ).toEqual({
      lo: 0,
      hi: 4,
      width: 1,
      counts: [2, 0, 3, 0],
      underflow: 1,
      overflow: 1,
    });
  });

  it('keeps a genuine null group separate from the folded other result', () => {
    const group = studyGroupExpression(
      {
        id: asColumnId('manufacturer'),
        label: 'Manufacturer',
        kind: 'categorical',
        modalities: ['bold'],
        filterable: true,
        groupable: true,
        exportable: true,
      },
      null,
    );
    const result = shapeGroupedSummaryResult(
      [
        { is_other: false, value: null, ...summary, n: 2 },
        { is_other: false, value: 'Siemens', ...summary, n: 3 },
        { is_other: true, value: null, ...summary, n: 2 },
      ],
      [
        { is_other: false, value: null, bin: 0, n: 2 },
        { is_other: false, value: 'Siemens', bin: 1, n: 3 },
        { is_other: true, value: null, bin: 1, n: 2 },
      ],
      group,
      0,
      2,
      2,
    );

    expect(result.groups.map((entry) => [entry.value, entry.histogram.counts])).toEqual([
      [null, [2, 0]],
      ['Siemens', [0, 3]],
    ]);
    expect(result.other?.value).toBe('other');
    expect(result.other?.histogram.counts).toEqual([0, 2]);
  });
});
