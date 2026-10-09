import { asColumnId, type DistributionResult } from '@mriqc/shared';
import { BehaviorSubject, EMPTY, Observable, of } from 'rxjs';
import { TestScheduler } from 'rxjs/testing';
import { queryKey, type Api, type DistributionQuery, type StudyApi } from '../api/api';
import type { Command } from '../slices/commands';
import { defaultDashboard, initialState, reduce } from '../slices/reducer';
import type { State } from '../graph/state';
import { CATALOG_KEY } from '../slices/history/results';
import { runQueryEffects } from './queries';

function dashboard(): State {
  const state = reduce(initialState, { t: 'hydrate', url: defaultDashboard() });
  return { ...state, panels: state.panels.slice(0, 2), dataVersion: 'v1',
    datasets: { [CATALOG_KEY]: { status: 'ready', version: 'v1', result: {} } } };
}
function api(distribution: Api['distribution']): Api {
  return { distribution, catalog: () => EMPTY, dataVersion: () => EMPTY,
    coverage: () => EMPTY, sample: () => EMPTY, groupedSummary: () => EMPTY,
    binnedSummary: () => EMPTY, density2d: () => EMPTY, correlation: () => EMPTY };
}
function result(lo = 0, hi = 10): DistributionResult {
  return { n: 10, min: lo, max: hi, mean: (lo + hi) / 2, stddev: 1,
    quantiles: { p01: lo, p05: lo, p25: lo, p50: (lo + hi) / 2, p75: hi, p95: hi, p99: hi },
    histogram: { lo, hi, width: hi - lo, counts: [10] } };
}
const scheduler = () => new TestScheduler((actual, expected) => expect(actual).toEqual(expected));

describe('panel query operators', () => {
  it('switches A with one request in flight and leaves B subscribed exactly once', () => {
    scheduler().run(({ hot, cold, expectSubscriptions, flush }) => {
      const oldA = cold<DistributionResult>('------x|', { x: result() });
      const newA = cold<DistributionResult>('------x|', { x: result() });
      const b = cold<DistributionResult>('------x|', { x: result() });
      const first = dashboard();
      const second = reduce(first, { t: 'setPanelMetric', id: 'p1', metric: asColumnId('snr') });
      let activeA = 0, peakA = 0;
      const fetch = vi.fn((query: DistributionQuery) => {
        if (query.metric === 'tsnr') return b;
        return new Observable<DistributionResult>(subscriber => {
          peakA = Math.max(peakA, ++activeA);
          const sub = (query.metric === 'fd_mean' ? oldA : newA).subscribe(subscriber);
          return () => { activeA--; sub.unsubscribe(); };
        });
      });
      const commands: Command[] = [];
      runQueryEffects(hot('a-b-------|', { a: first, b: second }), api(fetch)).subscribe(command => commands.push(command));
      expectSubscriptions(oldA.subscriptions).toBe('^-!');
      expectSubscriptions(newA.subscriptions).toBe('--^-----!');
      expectSubscriptions(b.subscriptions).toBe('^-----!');
      flush();
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(peakA).toBe(1);
      expect(activeA).toBe(0);
      expect(commands.filter(command => command.t === 'dataArrived')).toHaveLength(2);
    });
  });

  it('shares a key across panels, retains it for the remaining owner, and recreates a removed group', () => {
    scheduler().run(({ hot, cold, expectSubscriptions, flush }) => {
      const pending = cold<DistributionResult>('----------x|', { x: result() });
      const first = dashboard();
      first.panels = [first.panels[0], { ...first.panels[0], id: 'p2' }];
      const second = reduce(first, { t: 'removePanel', id: 'p1' });
      const empty = reduce(second, { t: 'removePanel', id: 'p2' });
      const fetch = vi.fn(() => pending);
      const sub = runQueryEffects(hot('a-b-c-d---', { a: first, b: second, c: empty, d: first }), api(fetch)).subscribe();
      expectSubscriptions(pending.subscriptions).toBe(['^---!', '------^---------!']);
      flush();
      expect(fetch).toHaveBeenCalledTimes(2);
      sub.unsubscribe();
    });
  });

  it('does not restart a sibling query when a fast result re-enters the loop', () => {
    scheduler().run(({ cold, flush }) => {
      let state = dashboard();
      state = { ...state, panels: [{ ...state.panels[0], form: 'table' }] };
      const states = new BehaviorSubject(state);
      const distribution = vi.fn(() => cold<DistributionResult>('------x|', { x: result() }));
      const backend = api(distribution);
      backend.sample = vi.fn(() => cold('--x|', { x: { rows: [], columns: [], nextCursor: null } }));
      const sub = runQueryEffects(states, backend).subscribe(command => states.next(state = reduce(state, command)));
      flush();
      expect(backend.sample).toHaveBeenCalledTimes(1);
      expect(distribution).toHaveBeenCalledTimes(1);
      expect(Object.values(state.datasets).filter(entry => entry.status === 'ready')).toHaveLength(3);
      sub.unsubscribe();
    });
  });

  it('waits for every base range before requesting the common cohort grid', () => {
    const clock = scheduler();
    clock.run(({ cold, flush }) => {
      let state = dashboard();
      state = { ...state, panels: [{ ...state.panels[0], options: { ...state.panels[0].options, clip: 'none' } }] };
      state = reduce(state, { t: 'setFilters', filters: [{ field: asColumnId('manufacturer'), op: 'in', values: ['Siemens'] }] });
      state = reduce(state, { t: 'addPanelSeries', id: 'p1', series: { kind: 'population' } });
      const states = new BehaviorSubject(state);
      const starts: { at: number; query: DistributionQuery }[] = [];
      const fetch = (query: DistributionQuery) => {
        starts.push({ at: clock.frame, query });
        return query.range ? cold('--x|', { x: result(0, 20) })
          : query.filters.length ? cold('--x|', { x: result(0, 10) }) : cold('----x|', { x: result(5, 20) });
      };
      const sub = runQueryEffects(states, api(fetch)).subscribe(command => states.next(state = reduce(state, command)));
      flush();
      expect(starts.filter(start => !start.query.range)).toHaveLength(2);
      const ranged = starts.filter(start => start.query.range);
      expect(ranged).toHaveLength(2);
      expect(ranged.map(start => start.at)).toEqual([4, 4]);
      expect(ranged.map(start => start.query.range)).toEqual([[0, 20], [0, 20]]);
      expect(new Set(starts.map(start => queryKey(start.query))).size).toBe(4);
      sub.unsubscribe();
    });
  });

  it('uses the same cancellation pipeline for WASM queries', () => {
    scheduler().run(({ hot, cold, expectSubscriptions, flush }) => {
      let state = dashboard();
      state = { ...state, panels: [state.panels[0]] };
      state = reduce(state, { t: 'studyLoaded', name: 'study', rows: 10, metrics: [asColumnId('fd_mean'), asColumnId('snr')], totalMetrics: 2, ignoredColumns: [], missingMetrics: [], addToAll: true });
      const changed = reduce(state, { t: 'setPanelMetric', id: 'p1', metric: asColumnId('snr') });
      const oldLocal = cold<DistributionResult>('--------x|', { x: result() });
      const newLocal = cold<DistributionResult>('--------x|', { x: result() });
      const local = { distribution: vi.fn((query: DistributionQuery) => query.metric === 'fd_mean' ? oldLocal : newLocal) } as unknown as StudyApi;
      const sub = runQueryEffects(hot('a-b---------', { a: state, b: changed }), api(() => EMPTY), local).subscribe();
      expectSubscriptions(oldLocal.subscriptions).toBe('^-!');
      expectSubscriptions(newLocal.subscriptions).toBe('--^-------!');
      flush();
      expect(local.distribution).toHaveBeenCalledTimes(2);
      sub.unsubscribe();
    });
  });

  it('handles synchronous feedback without starting obsolete or duplicate requests', () => {
    let state = dashboard();
    state = { ...state, panels: [state.panels[0], { ...state.panels[0], id: 'p2' }] };
    const states = new BehaviorSubject(state);
    const fetch = vi.fn(() => of(result()));
    const commands: Command[] = [];
    const sub = runQueryEffects(states, api(fetch)).subscribe(command => {
      commands.push(command);
      states.next(state = reduce(state, command));
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(commands).toHaveLength(1);
    sub.unsubscribe();
  });

  it('drains a large synchronous batch without recursive feedback growth', () => {
    let state = dashboard();
    const panel = state.panels[0];
    state = { ...state, panels: Array.from({ length: 120 }, (_, i) => ({
      ...panel, id: `batch-${i}`, options: { ...panel.options, bins: 10 + i },
    })) };
    const states = new BehaviorSubject(state);
    const fetch = vi.fn(() => of(result()));
    const sub = runQueryEffects(states, api(fetch)).subscribe(command => states.next(state = reduce(state, command)));
    expect(fetch).toHaveBeenCalledTimes(120);
    expect(Object.keys(state.datasets)).toHaveLength(121);
    sub.unsubscribe();
  });
});
