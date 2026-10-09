import { asColumnId } from '@mriqc/shared';
import { Subject, scan } from 'rxjs';
import type { Command } from './commands';
import { expand } from './expand';
import { defaultDashboard, initialState, reduce } from './reducer';
import { compose } from './reducer';
import type { State } from '../graph/state';
import { reducePanels } from '../slices/panels/reducer';
import { reduceSeries } from '../slices/series/reducer';
import { reduceLayout } from '../slices/layout/reducer';
import { reduceFilters } from '../slices/filters/reducer';
import { reduceCohorts } from '../slices/cohorts/reducer';
import { reduceStudy } from '../slices/study/reducer';
import { reduceHistory } from '../slices/history/reducer';

describe('ordered command fan-out', () => {
  const dashboard = () => reduce(initialState, { t: 'hydrate', url: defaultDashboard() });

  it('removes a panel, its brush, geometry and maximization in one emission', () => {
    let state = reduce(dashboard(), { t: 'resizePanel', id: 'p1', w: 6, h: 8 });
    state = reduce(state, { t: 'maximizePanel', id: 'p1' });
    state = reduce(state, { t: 'brush', from: 'p1', metric: asColumnId('fd_mean'), range: [0, 1] });
    const commands = new Subject<Command>();
    const seen: State[] = [];
    const sub = commands.pipe(scan(reduce, state)).subscribe(next => seen.push(next));
    commands.next({ t: 'removePanel', id: 'p1' });
    expect(seen).toHaveLength(1);
    expect(seen[0].panels.some(panel => panel.id === 'p1')).toBe(false);
    expect(seen[0].selections).toEqual([]);
    expect(seen[0].layout?.['p1']).toBeUndefined();
    expect(seen[0].maximizedPanel).toBeNull();
    expect(expand({ t: 'removePanel', id: 'p1' }).map(command => command.t)).toEqual([
      'removePanel', 'dropPanelSelections', 'reconcilePanelLayout', 'unmaximizeRemoved', 'evictDatasets',
    ]);
    sub.unsubscribe();
  });

  it('preserves no-op identity and does not run removal reactions for a missing panel', () => {
    const state = dashboard();
    expect(reduce(state, { t: 'removePanel', id: 'missing' })).toBe(state);
    expect(reduce(state, { t: 'setModality', modality: state.global.modality })).toBe(state);
  });

  it('clears brushes on modality changes while ordinary filter changes retain them', () => {
    const state = reduce(dashboard(), { t: 'brush', from: 'p1', metric: asColumnId('fd_mean'), range: [0, 1] });
    const filtered = reduce(state, { t: 'setFilters', filters: [{ field: asColumnId('manufacturer'), op: 'in', values: ['Siemens'] }] });
    expect(filtered.selections).toBe(state.selections);
    expect(reduce(filtered, { t: 'setModality', modality: 'T1w' }).selections).toEqual([]);
  });

  it('all slice reducers ignore a foreign command by identity', () => {
    const command = { t: 'foreign' } as unknown as Command;
    for (const slice of [reducePanels, reduceSeries, reduceLayout, reduceFilters, reduceCohorts, reduceStudy, reduceHistory]) {
      expect(slice(initialState, command)).toBe(initialState);
    }
    expect(compose(initialState, command)).toBe(initialState);
  });
});
