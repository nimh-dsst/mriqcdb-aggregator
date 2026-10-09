import { asColumnId, statementsOf, type MetricSummary } from '@mriqc/shared';
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
