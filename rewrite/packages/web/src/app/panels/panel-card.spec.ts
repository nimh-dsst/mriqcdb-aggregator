import { asColumnId } from '@mriqc/shared';
import { STUDY_COHORT, type StudyState } from '../graph/state';
import { chartName, chartLabel, metricMissingFromStudy, studyHasMetric } from './panel-card';

it('uses the shared Histogram name for a split in both the trigger and menu', () => {
  expect(chartName('grouped', 'histogram')).toBe(chartName('distribution', 'histogram'));
  expect(chartLabel('grouped', 'histogram')).toBe('Histogram');
});

const readyStudy = {
  status: 'ready',
  name: 'study.tsv',
  rows: 20,
  metrics: [asColumnId('cjv'), asColumnId('cnr')],
  totalMetrics: 3,
  ignoredColumns: ['participant_id'],
  missingMetrics: [asColumnId('efc')],
} as StudyState;

describe('study metric availability', () => {
  it('offers the one-click study comparison only for a metric the study contains', () => {
    expect(studyHasMetric(readyStudy, 'cjv')).toBe(true);
    expect(studyHasMetric(readyStudy, 'efc')).toBe(false);
    expect(studyHasMetric({ status: 'loading' }, 'cjv')).toBe(false);
  });

  it('disables missing metrics only when the comparison includes the study', () => {
    expect(metricMissingFromStudy(readyStudy, ['current', STUDY_COHORT], 'efc')).toBe(true);
    expect(metricMissingFromStudy(readyStudy, ['current', STUDY_COHORT], 'cjv')).toBe(false);
    expect(metricMissingFromStudy(readyStudy, ['current', 'all'], 'efc')).toBe(false);
  });
});
