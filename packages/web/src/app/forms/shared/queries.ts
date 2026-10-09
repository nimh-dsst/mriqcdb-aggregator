import type { Query } from '../../api/api';
import type { Panel, State } from '../../graph/state';
import { axisType } from '../availability';
export type QueryServices = Pick<typeof import('../../graph/queries'), 'panelCohorts' | 'panelCohort' | 'scopedQuery' | 'samplePages' | 'groupingSeries' | 'countBandQuery' | 'cohortQuery' | 'panelSharedRange' | 'binnedQueries' | 'densityQueries'>;

export function countQueries(state: State, panel: Panel, services: QueryServices): readonly Query[] {
  const { panelCohorts, panelCohort, scopedQuery, samplePages, groupingSeries, countBandQuery, cohortQuery, panelSharedRange, binnedQueries, densityQueries } = services;
  const cohorts = panelCohorts(state, panel);
  const query = (cohort: typeof cohorts[number], proc: Query['proc']) => scopedQuery(state, panel, cohort, proc);
  if (axisType(panel.x) === 'time' || axisType(panel.x) === 'categorical') {
    const proc = axisType(panel.x) === 'categorical' ? 'groupedSummary' : 'coverage';
    const results = cohorts.flatMap(cohort => { const q = query(cohort, proc); return q ? [q] : []; });
    // groupedSummary counts finite metric values. Coverage supplies exact row counts, including missing metrics.
    if (axisType(panel.x) === 'categorical') results.push(...cohorts.flatMap(cohort => { const q = query(cohort, 'coverage'); return q ? [q] : []; }));
    if (groupingSeries(panel)) {
      const aggregate = query(panelCohort(state, panel), proc);
      if (aggregate) results.push(aggregate);
      if (axisType(panel.x) === 'categorical') {
        const count = query(panelCohort(state, panel), 'coverage');
        if (count) results.push(count);
      }
    }
    return results;
  }
  if (!panel.series.length) return [cohortQuery(state, panel, panelCohort(state, panel))];
  const base = cohorts.map(cohort => cohortQuery(state, panel, cohort));
  const range = panelSharedRange(state, panel, cohorts);
  const queries: Query[] = range ? [...base, ...cohorts.map(cohort => cohortQuery(state, panel, cohort, range))] : [...base];
  if (groupingSeries(panel)) queries.push(cohortQuery(state, panel, panelCohort(state, panel)));
  return queries;
}

export function tableQueries(state: State, panel: Panel, services: QueryServices): readonly Query[] {
  const { panelCohorts, panelCohort, scopedQuery, samplePages, groupingSeries, countBandQuery, cohortQuery, panelSharedRange, binnedQueries, densityQueries } = services;
  const cohorts = panelCohorts(state, panel);
  return [
    ...samplePages(state, panel).map(page => page.query),
    ...[...cohorts, ...(groupingSeries(panel) ? [panelCohort(state, panel)] : [])].flatMap(cohort => {
      const q = scopedQuery(state, panel, cohort, axisType(panel.x) === 'numeric' ? 'distribution' : 'coverage');
      return q ? [q] : [];
    }),
  ];
}
export function matrixQueries(state: State, panel: Panel, services: QueryServices): readonly Query[] {
  const { panelCohorts, panelCohort, scopedQuery, samplePages, groupingSeries, countBandQuery, cohortQuery, panelSharedRange, binnedQueries, densityQueries } = services;
  return panelCohorts(state, panel).flatMap(cohort => {
    const q = scopedQuery(state, panel, cohort, 'correlation'); return q ? [q] : [];
  });
}
export function pairedQueries(state: State, panel: Panel, services: QueryServices, binned = false): readonly Query[] {
  const { panelCohorts, panelCohort, scopedQuery, samplePages, groupingSeries, countBandQuery, cohortQuery, panelSharedRange, binnedQueries, densityQueries } = services;
  return [...(binned ? binnedQueries(state, panel) : densityQueries(state, panel)),
    ...(axisType(panel.x) === 'numeric' ? [cohortQuery(state, panel, panelCohort(state, panel))] : [])];
}
export function bandQueries(state: State, panel: Panel, services: QueryServices): readonly Query[] {
  const { panelCohorts, panelCohort, scopedQuery, samplePages, groupingSeries, countBandQuery, cohortQuery, panelSharedRange, binnedQueries, densityQueries } = services;
  if (panel.y === null && axisType(panel.x) === 'time') {
    return [...panelCohorts(state, panel), ...(groupingSeries(panel) ? [panelCohort(state, panel)] : [])]
      .flatMap(cohort => { const q = countBandQuery(state, panel, cohort); return q ? [q] : []; });
  }
  return pairedQueries(state, panel, services, true);
}
