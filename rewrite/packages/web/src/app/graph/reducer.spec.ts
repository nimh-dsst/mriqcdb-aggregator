import { asColumnId, isValidMetric, queryKey, type Filter } from '@mriqc/shared';
import type { Command } from './commands';
import { CATALOG_KEY, needed, neededQueries, referencedKeys } from './queries';
import { nextCohortColor } from './cohorts';
import { defaultDashboard, initialState, reduce } from './reducer';
import {
  EVICTION_KEEP,
  FIRST_PAGE,
  MAX_COHORTS,
  defaultPanelOptions,
  type Cohort,
  type DatasetEntry,
  type Panel,
  type State,
} from './state';

/* ---------------------------------------------------------------- fixtures */

describe('axis range commands', () => {
  it('sets and resets ranges without changing quantity, count mode or layout', () => {
    const state = fixture({ panels: [panel({ options: { ...defaultPanelOptions(), yMode: 'logCount' } })] });
    const ranged = run(state,
      { t: 'setPanelRange', id: 'p1', axis: 'x', range: [0.6, 0.1] },
      { t: 'setPanelRange', id: 'p1', axis: 'y', range: [10, 100] });
    expect(ranged.panels[0].options).toMatchObject({ xRange: [0.1, 0.6], yRange: [10, 100], yMode: 'logCount' });
    expect(ranged.layout).toEqual(state.layout);
    expect(ranged.panels[0].x).toBe('fd_mean');
    const reset = reduce(ranged, { t: 'resetPanelRanges', id: 'p1' });
    expect(reset.panels[0].options).toMatchObject({ xRange: 'auto', yRange: 'auto', yMode: 'logCount' });
    expect(reduce(ranged, { t: 'setPanelRange', id: 'p1', axis: 'x', range: 'auto' }).panels[0].options.yRange).toEqual([10, 100]);
  });

  it('zooms the brushing panel and clears its brush atomically', () => {
    const brushed = reduce(fixture(), { t: 'brush', from: 'p1', metric: asColumnId('fd_mean'), range: [0.1, 0.6] });
    const zoomed = reduce(brushed, { t: 'zoomToBrush', from: 'p1' });
    expect(zoomed.selections).toEqual([]);
    expect(zoomed.panels[0].options.xRange).toEqual([0.1, 0.6]);
    expect([...neededQueries(zoomed).values()].find(query => query.proc === 'distribution')).toMatchObject({ range: [0.1, 0.6] });
  });
});

function panel(overrides: Partial<Panel> = {}): Panel {
  return {
    id: 'p1',
    y: null,
    x: asColumnId('fd_mean'),
    form: 'histogram',
    series: [],

    options: defaultPanelOptions(),
    cursors: FIRST_PAGE,
    ...overrides,
  };
}

function fixture(overrides: Partial<State> = {}): State {
  return {
    ...initialState,
    dataVersion: 'v1',
    global: { modality: 'bold', view: 'raw', filters: [] },
    panels: [panel()],
    ...overrides,
  };
}

function ready(version: string, result: unknown = { n: 1 }): DatasetEntry {
  return { status: 'ready', version, result };
}

function run(state: State, ...commands: Command[]): State {
  return commands.reduce(reduce, state);
}

function cohort(id: string, name: string, color = 2, overrides: Partial<Cohort> = {}): Cohort {
  return {
    id,
    name,
    color,
    source: 'population',
    view: 'raw',
    filters: [],
    selections: [],
    ...overrides,
  };
}

/** The slot a component would read before dispatching `addCohort`. */
function nextColor(state: State): number {
  return nextCohortColor(state.cohorts);
}

const manufacturerFilter: Filter = {
  field: asColumnId('manufacturer'),
  op: 'in',
  values: ['SIEMENS'],
};

/* ------------------------------------------------------------------- tests */

describe('reduce', () => {
  it('leaves state untouched for a command that changes nothing', () => {
    const state = fixture();
    expect(reduce(state, { t: 'setModality', modality: 'bold' })).toBe(state);
  });

  describe('setModality', () => {
    it('resets filters and selection', () => {
      const state = fixture({
        global: { modality: 'bold', view: 'raw', filters: [manufacturerFilter] },
        selections: [{ from: 'p1', metric: asColumnId('fd_mean'), range: [0, 1] }],
      });
      const next = reduce(state, { t: 'setModality', modality: 'T1w' });
      expect(next.global.filters).toEqual([]);
      expect(next.selections).toEqual([]);
      expect(next.global.modality).toBe('T1w');
    });

    it('retargets every panel metric the new modality does not have, and nulls a bad group', () => {
      const state = fixture({
        panels: [
          panel({ id: 'p1', x: asColumnId('fd_mean'), series: [{ kind: 'field' as const, field: asColumnId('task_id') }] }),
          panel({ id: 'p2', x: asColumnId('efc'), series: [{ kind: 'field' as const, field: asColumnId('manufacturer') }] }),
        ],
      });
      const next = reduce(state, { t: 'setModality', modality: 'T1w' });
      // fd_mean is Motion, a family T1w has no metric in, so the panel takes the
      // first T1w metric rather than being left with nothing to show.
      expect(next.panels[0].x).toBe('qi_1');
      // task_id is bold-only, and a group has no equivalent fallback.
      expect((next.panels[0].series.find(item => item.kind === 'field')?.field ?? null)).toBeNull();
      // efc and manufacturer exist for T1w, so this panel keeps both.
      expect(next.panels[1].x).toBe('efc');
      expect((next.panels[1].series.find(item => item.kind === 'field')?.field ?? null)).toBe('manufacturer');
    });

    it('prefers a metric of the same family when the new modality has one', () => {
      // snr is Signal Quality on bold; T1w's first Signal Quality metric is snrd_csf.
      const state = fixture({ panels: [panel({ x: asColumnId('snr') })] });
      expect(reduce(state, { t: 'setModality', modality: 'T1w' }).panels[0].x).toBe(
        'snrd_csf',
      );
    });

    it('leaves a metricless panel kind alone', () => {
      const state = fixture({
        panels: [panel({ y: null, x: 'created_at', series: [{ kind: 'field' as const, field: asColumnId('manufacturer') }] })],
      });
      expect(reduce(state, { t: 'setModality', modality: 'T1w' }).panels[0].x).toBe('created_at');
    });

    it('leaves no panel without a metric, so no card asks the user to pick one', () => {
      const state = fixture({
        panels: [
          panel({ id: 'p1', x: asColumnId('fd_mean') }),
          panel({ id: 'p2', x: asColumnId('tsnr') }),
          panel({ id: 'p3', x: asColumnId('dvars_std') }),
          panel({ id: 'p4', x: asColumnId('size_t') }),
        ],
      });
      for (const modality of ['T1w', 'T2w'] as const) {
        const next = reduce(state, { t: 'setModality', modality });
        for (const p of next.panels) {
          expect(p.x).not.toBeNull();
          expect(isValidMetric(modality, p.x as string)).toBe(true);
        }
      }
    });

    it('does not touch datasets; entries simply stop being needed', () => {
      const key = 'population/distribution?m=bold';
      const state = fixture({ datasets: { [key]: ready('v1') } });
      const next = reduce(state, { t: 'setModality', modality: 'T2w' });
      expect(next.datasets[key]).toBe(state.datasets[key]);
    });

    it("falls back to the new modality's canonical view when it lacks the current one", () => {
      const state = fixture({ global: { modality: 'bold', view: 'k4plus', filters: [] } });
      expect(reduce(state, { t: 'setModality', modality: 'T1w' }).global.view).toBe('k3pp');
    });

    it('keeps the raw view across a switch, because every modality has it', () => {
      const state = fixture({ global: { modality: 'bold', view: 'raw', filters: [] } });
      expect(reduce(state, { t: 'setModality', modality: 'T2w' }).global.view).toBe('raw');
    });
  });

  describe('brush', () => {
    it('sets the selection, and null clears it', () => {
      const brushed = reduce(fixture(), {
        t: 'brush',
        from: 'p1',
        metric: asColumnId('fd_mean'),
        range: [0.2, 0.8],
      });
      expect(brushed.selections).toEqual([{ from: 'p1', metric: 'fd_mean', range: [0.2, 0.8] }]);
      const cleared = reduce(brushed, {
        t: 'brush',
        from: 'p1',
        metric: asColumnId('fd_mean'),
        range: null,
      });
      expect(cleared.selections).toEqual([]);
    });

    it('orders an inverted drag', () => {
      const brushed = reduce(fixture(), {
        t: 'brush',
        from: 'p1',
        metric: asColumnId('fd_mean'),
        range: [9, 1],
      });
      expect(brushed.selections[0]?.range).toEqual([1, 9]);
    });

    it('keeps the originating panel out of its own query key', () => {
      const state = run(fixture({ panels: [panel({ id: 'p1' }), panel({ id: 'p2' })] }), {
        t: 'brush',
        from: 'p1',
        metric: asColumnId('fd_mean'),
        range: [0, 1],
      });
      const keys = [...referencedKeys(state)].filter((key) => key !== CATALOG_KEY);
      const withSelection = keys.filter((key) => key.includes('sel='));
      expect(withSelection).toHaveLength(1);
      expect(keys).toHaveLength(2);
    });

    it('does not filter a panel that opted out of the selection', () => {
      const state = run(
        fixture({
          panels: [
            panel({ id: 'p1' }),
            panel({ id: 'p2', options: { ...defaultPanelOptions(), useSelection: false } }),
          ],
        }),
        { t: 'brush', from: 'p1', metric: asColumnId('fd_mean'), range: [0, 1] },
      );
      const keys = [...referencedKeys(state)].filter((key) => key.includes('sel='));
      expect(keys).toHaveLength(0);
    });

    it('clears the selection when the origin panel changes metric', () => {
      const state = run(
        fixture({ panels: [panel({ id: 'p1' }), panel({ id: 'p2' })] }),
        { t: 'brush', from: 'p1', metric: asColumnId('fd_mean'), range: [0, 1] },
        { t: 'setPanelMetric', id: 'p1', metric: asColumnId('tsnr') },
      );
      expect(state.selections).toEqual([]);
    });

    it('clears the selection when the origin panel stops being brushable', () => {
      const grouped = run(
        fixture({ panels: [panel({ id: 'p1' }), panel({ id: 'p2' })] }),
        { t: 'brush', from: 'p1', metric: asColumnId('fd_mean'), range: [0, 1] },
        { t: 'setPanelForm', id: 'p1', form: 'box' },
      );
      expect(grouped.selections).toEqual([]);
    });

    it('keeps the selection when an unrelated panel changes', () => {
      const state = run(
        fixture({ panels: [panel({ id: 'p1' }), panel({ id: 'p2' })] }),
        { t: 'brush', from: 'p1', metric: asColumnId('fd_mean'), range: [0, 1] },
        { t: 'setPanelMetric', id: 'p2', metric: asColumnId('tsnr') },
        { t: 'setPanelOptions', id: 'p1', options: { bins: 80 } },
      );
      expect(state.selections).toEqual([{ from: 'p1', metric: 'fd_mean', range: [0, 1] }]);
    });

    it('clears the selection when its originating panel is removed', () => {
      const state = run(
        fixture({ panels: [panel({ id: 'p1' }), panel({ id: 'p2' })] }),
        { t: 'brush', from: 'p1', metric: asColumnId('fd_mean'), range: [0, 1] },
        { t: 'removePanel', id: 'p1' },
      );
      expect(state.selections).toEqual([]);
    });
  });

  describe('dataVersionChanged and dataArrived', () => {
    it('sets the version and nothing else', () => {
      const state = fixture({ datasets: { k: ready('v1') } });
      const next = reduce(state, { t: 'dataVersionChanged', version: 'v2' });
      expect(next.dataVersion).toBe('v2');
      expect(next.datasets).toBe(state.datasets);
      expect(next.panels).toBe(state.panels);
    });

    it('tags each entry with the version it was fetched at', () => {
      const next = reduce(fixture(), { t: 'dataArrived', key: 'k', result: 42, version: 'v1' });
      expect(next.datasets['k']).toEqual({ status: 'ready', version: 'v1', result: 42 });
    });

    it('drops an arrival from a superseded version', () => {
      const state = fixture({ dataVersion: 'v2', datasets: { k: ready('v2', 'current') } });
      const next = reduce(state, { t: 'dataArrived', key: 'k', result: 'stale', version: 'v1' });
      expect(next).toBe(state);
    });

    it('lets a fresh arrival replace a stale entry', () => {
      const state = fixture({ dataVersion: 'v2', datasets: { k: ready('v1', 'old') } });
      const next = reduce(state, { t: 'dataArrived', key: 'k', result: 'new', version: 'v2' });
      expect(next.datasets['k']).toEqual({ status: 'ready', version: 'v2', result: 'new' });
    });

    it('records a failure as an entry at the current version', () => {
      const next = reduce(fixture(), { t: 'dataFailed', key: 'k', error: 'boom' });
      expect(next.datasets['k']).toEqual({ status: 'error', version: 'v1', error: 'boom' });
    });

    it('promotes the catalog result into its own slot', () => {
      const catalog = { version: '0.2.0' } as never;
      const next = reduce(fixture(), {
        t: 'dataArrived',
        key: CATALOG_KEY,
        result: catalog,
        version: 'v1',
      });
      expect(next.catalog).toBe(catalog);
    });
  });

  describe('hydrate', () => {
    it('replaces global, panels and selection and leaves everything else alone', () => {
      const state = fixture({
        datasets: { k: ready('v1') },
        study: {
          status: 'ready',
          name: 'study.tsv',
          rows: 10,
          metrics: [],
          totalMetrics: 0,
          ignoredColumns: [],
          missingMetrics: [],
        },
        export: { status: 'running', rows: 5 },
      });
      const next = reduce(state, { t: 'hydrate', url: defaultDashboard() });
      expect(next.panels).toHaveLength(5);
      expect(next.global).toEqual({ modality: 'bold', view: 'k4plus', filters: [] });
      expect(next.selections).toEqual([]);
      expect(next.datasets['k']).toBe(state.datasets['k']);
      expect(next.study).toBe(state.study);
      expect(next.export).toBe(state.export);
      expect(next.dataVersion).toBe('v1');
    });

    it('validates against the catalog before replacing', () => {
      const next = reduce(fixture(), {
        t: 'hydrate',
        url: {
          global: {
            modality: 'T2w',
            view: 'raw',
            filters: [{ field: asColumnId('task_id'), op: 'in', values: ['rest'] }],
          },
          cohorts: [],
          panels: [{ ...panel(), x: asColumnId('fd_mean') }],
          selections: [{ from: 'p1', metric: asColumnId('fd_mean'), range: [0, 1] }],
        },
      });
      // fd_mean and task_id are bold-only.
      expect(next.global.filters).toEqual([]);
      expect(next.panels[0].x).toBe('qi_1');
      expect(next.selections).toEqual([]);
    });

    it('drops a study reference from a shared link and explains why', () => {
      const url = defaultDashboard();
      const comparison = panel({
        y: null,
        form: 'histogram',
        series: [{ kind: 'study' as const }],
      });
      const next = reduce(fixture(), {
        t: 'hydrate',
        url: { ...url, panels: [comparison] },
      });
      expect(next.panels[0]!.series).toEqual([]);
      expect(next.notice).toBe('This view compared against a study that is not in the link.');
    });
  });

  describe('eviction', () => {
    function withUnreferenced(count: number): State {
      const datasets: Record<string, DatasetEntry> = {};
      for (let i = 0; i < count; i++) datasets[`stale-${i}`] = ready('v1', i);
      return fixture({ panels: [], datasets });
    }

    it('keeps the most recent N unreferenced entries', () => {
      const state = withUnreferenced(EVICTION_KEEP + 8);
      const next = reduce(state, { t: 'setFilters', filters: [manufacturerFilter] });
      const keys = Object.keys(next.datasets);
      expect(keys).toHaveLength(EVICTION_KEEP);
      expect(keys[0]).toBe('stale-8');
      expect(keys.at(-1)).toBe(`stale-${EVICTION_KEEP + 7}`);
    });

    it('never evicts an entry a panel still references', () => {
      const referenced = queryKey({
        source: 'population',
        proc: 'distribution',
        modality: 'bold',
        view: 'raw',
        filters: [],
        selections: [],
        metric: asColumnId('fd_mean'),
        bins: defaultPanelOptions().bins,
        clip: defaultPanelOptions().clip,
      });
      const datasets: Record<string, DatasetEntry> = { [referenced]: ready('v1', 'keep me') };
      for (let i = 0; i < 40; i++) datasets[`stale-${i}`] = ready('v1', i);
      const state = fixture({ datasets });
      const next = reduce(state, { t: 'addPanel', x: 'created_at' });
      expect(next.datasets[referenced]).toBeDefined();
      expect(Object.keys(next.datasets)).toHaveLength(EVICTION_KEEP + 1);
    });

    it('spares an entry that was just re-written, however old its key is', () => {
      const state = withUnreferenced(EVICTION_KEEP + 8);
      // `stale-0` is the oldest key in insertion order, and the first eviction
      // would take it; re-writing it has to move it to the back.
      const rewritten = reduce(state, {
        t: 'dataArrived',
        key: 'stale-0',
        result: 'fresh',
        version: 'v1',
      });
      const next = reduce(rewritten, { t: 'setFilters', filters: [manufacturerFilter] });
      expect(next.datasets['stale-0']).toEqual({ status: 'ready', version: 'v1', result: 'fresh' });
      expect(Object.keys(next.datasets)).toHaveLength(EVICTION_KEEP);
    });

    it('does not evict on a data arrival', () => {
      const state = withUnreferenced(EVICTION_KEEP + 5);
      const next = reduce(state, { t: 'dataArrived', key: 'fresh', result: 1, version: 'v1' });
      expect(Object.keys(next.datasets)).toHaveLength(EVICTION_KEEP + 6);
    });
  });

  describe('panels', () => {
    it('mints an id that cannot clash with one already present', () => {
      const state = fixture({ panels: [panel({ id: 'p3' })] });
      expect(reduce(state, { t: 'addPanel', x: 'created_at' }).panels[1].id).toBe('p4');
    });

    it('gives a time panel no comparison and the counts form', () => {
      const added = reduce(fixture(), { t: 'addPanel', x: 'created_at' }).panels[1];
      expect(added.x).toBe('created_at');
      expect(added.series).toEqual([]);
      expect(added.form).toBe('histogram');
    });

    it('refuses a chart the panel kind does not allow', () => {
      const next = reduce(fixture(), { t: 'setPanelChart', id: 'p1', form: 'bars' });
      expect(next.panels[0].form).toBe('histogram');
    });

    it('keeps the selected form when a grouping is added', () => {
      const split = reduce(fixture(), {
        t: 'setPanelGroup',
        id: 'p1',
        group: asColumnId('manufacturer'),
      });
      expect(split.panels[0].form).toBe('histogram');
      const ecdf = fixture({ panels: [panel({ form: 'ecdf' })] });
      expect(
        reduce(ecdf, { t: 'setPanelGroup', id: 'p1', group: asColumnId('manufacturer') }).panels[0]
          .form,
      ).toBe('ecdf');
    });

    it('refuses a metric the modality does not have', () => {
      const next = reduce(fixture(), { t: 'setPanelMetric', id: 'p1', metric: asColumnId('cjv') });
      expect(next.panels[0].x).toBe('fd_mean');
    });

    it('clamps bins into 10..200', () => {
      expect(
        reduce(fixture(), { t: 'setPanelOptions', id: 'p1', options: { bins: 9999 } }).panels[0]
          .options.bins,
      ).toBe(200);
      expect(
        reduce(fixture(), { t: 'setPanelOptions', id: 'p1', options: { bins: 1 } }).panels[0]
          .options.bins,
      ).toBe(10);
    });

    it('keeps minting fresh ids next to an absurd numeric id from a link', () => {
      const state = fixture({ panels: [panel({ id: `p${Number.MAX_SAFE_INTEGER}0` })] });
      const once = reduce(state, { t: 'addPanel', x: 'created_at' });
      const twice = reduce(once, { t: 'addPanel', x: 'created_at' });
      const ids = twice.panels.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('moves a panel by geometry without changing list order', () => {
      const state = fixture({
        panels: [panel({ id: 'p1' }), panel({ id: 'p2' }), panel({ id: 'p3' })],
      });
      const next = reduce(state, { t: 'movePanel', id: 'p1', x: 8, y: 0 });
      expect(next.panels.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
      expect(next.layout?.['p1']).toMatchObject({x:8,y:0});
    });
  });

  describe('study and export', () => {
    it('never puts rows in state', () => {
      const file = { name: 'study.tsv' } as File;
      const chosen = reduce(fixture(), { t: 'studyChosen', file });
      expect(chosen.study).toEqual({ status: 'loading' });
      const loaded = reduce(chosen, {
        t: 'studyLoaded',
        name: 'study.tsv',
        rows: 120,
        metrics: [asColumnId('fd_mean')],
        totalMetrics: 2,
        ignoredColumns: ['unknown'],
        missingMetrics: [asColumnId('tsnr')],
      });
      expect(loaded.study).toEqual({
        status: 'ready',
        name: 'study.tsv',
        rows: 120,
        metrics: ['fd_mean'],
        totalMetrics: 2,
        ignoredColumns: ['unknown'],
        missingMetrics: ['tsnr'],
      });
      expect(JSON.stringify(loaded.study)).not.toContain('rows":[');
    });

    it('purges local query results when a study is replaced and collapses comparisons when cleared', () => {
      const comparison = panel({
        y: null,
        form: 'histogram',
        series: [{ kind: 'study' as const }],
      });
      const state = fixture({
        study: {
          status: 'ready',
          name: 'old.csv',
          rows: 1,
          metrics: [asColumnId('fd_mean')],
          totalMetrics: 1,
          ignoredColumns: [],
          missingMetrics: [],
        },
        panels: [comparison],
        datasets: {
          'study/distribution?metric=fd_mean': ready('v1'),
          'population/distribution?metric=fd_mean': ready('v1'),
        },
      });
      const replacing = reduce(state, { t: 'studyChosen', file: { name: 'new.csv' } as File });
      expect(replacing.datasets['study/distribution?metric=fd_mean']).toBeUndefined();
      expect(replacing.datasets['population/distribution?metric=fd_mean']).toBeDefined();
      expect(replacing.panels[0]!.series.length).toBeGreaterThan(0);

      const cleared = reduce(state, { t: 'clearStudy' });
      expect(cleared.study).toBe('none');
      expect(cleared.panels[0]!.series).toEqual([]);
      expect(cleared.panels[0].series).toEqual([]);
    });

    it('tracks export progress and clears on finish', () => {
      const running = run(
        fixture(),
        { t: 'requestExport', columns: [] },
        { t: 'exportProgress', rows: 99 },
      );
      expect(running.export).toMatchObject({ status: 'running', rows: 99,
        request: { format: 'arrow', modality: 'bold' } });
      expect(reduce(running, { t: 'exportFinished' }).export).toBe('idle');
    });
  });

  describe('invariants over arbitrary command sequences', () => {
    const metrics = ['fd_mean', 'tsnr', 'dvars_std', 'efc'];
    const pool: Command[] = [
      { t: 'setModality', modality: 'bold' },
      { t: 'setModality', modality: 'T1w' },
      { t: 'setModality', modality: 'T2w' },
      { t: 'setView', view: 'k4plus' },
      { t: 'setView', view: 'raw' },
      { t: 'setFilters', filters: [manufacturerFilter] },
      { t: 'setFilters', filters: [] },
      { t: 'addPanel',  },
      { t: 'addPanel', series: [{kind:'field',field:asColumnId('manufacturer')}] },
      { t: 'addPanel', x: 'created_at' },
      { t: 'addPanel', form: 'table' },
      { t: 'addPanel', series: [{kind:'population'}] },
      { t: 'removePanel', id: 'p1' },
      { t: 'removePanel', id: 'p2' },
      { t: 'movePanel', id: 'p2', x: 0, y: 0 },
      { t: 'setPanelChart', id: 'p1', form: 'ecdf' },
      { t: 'setPanelGroup', id: 'p2', group: asColumnId('manufacturer') },
      { t: 'setPanelGroup', id: 'p2', group: null },
      { t: 'setPanelOptions', id: 'p1', options: { bins: 80 } },
      { t: 'setPanelOptions', id: 'p3', options: { useSelection: false } },
      { t: 'requestPage', id: 'p4', cursor: 'page-1' },
      { t: 'brush', from: 'p1', metric: asColumnId('fd_mean'), range: [0.1, 0.4] },
      { t: 'brush', from: 'p2', metric: asColumnId('tsnr'), range: null },
      { t: 'dataVersionChanged', version: 'v2' },
      { t: 'clearStudy' },
      { t: 'hydrate', url: defaultDashboard() },
      // Cohorts are in the pool because the comparison panel's query keys are
      // computed *from results* (the shared range), which means `referencedKeys`
      // -- and so the reducer's own `evict` -- reads the datasets map. A fuzz
      // sequence is the only thing that covers that at the states it can reach.
      { t: 'addCohort', cohort: cohort('c1', 'Siemens') },
      { t: 'addCohort', cohort: cohort('c2', 'Philips', 3) },
      { t: 'updateCohort', id: 'c1', patch: { name: 'Siemens 3T' } },
      { t: 'updateCohort', id: 'c1', patch: { filters: [manufacturerFilter] } },
      { t: 'removeCohort', id: 'c1' },
      { t: 'removeCohort', id: 'c2' },
      { t: 'convertToComparison', panelId: 'p1', with: 'all' },
      { t: 'convertToComparison', panelId: 'p1', with: 'c1' },
      { t: 'convertToComparison', panelId: 'p2', with: 'c2' },
      { t: 'convertToComparison', panelId: 'p1', with: ['all', 'c1', 'c2'] },
      { t: 'setPanelReference', id: 'p1', cohort: 'all' },
      { t: 'removePanelCohort', panelId: 'p1', cohort: 'all' },
      { t: 'revertPanelToSingle', id: 'p1' },
      { t: 'restorePanel', panel: panel({ id: 'p7' }), at: 0 },
      ...metrics.map((metric): Command => ({
        t: 'setPanelMetric',
        id: 'p1',
        metric: asColumnId(metric),
      })),
    ];

    it('leaves exactly one entry per key, and one panel per id', () => {
      let seed = 12345;
      const next = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      for (let trial = 0; trial < 200; trial++) {
        let state = initialState;
        const seen = new Set<string>();
        for (let step = 0; step < 24; step++) {
          const command = pool[Math.floor(next() * pool.length)];
          state = reduce(state, command);
          // Every referenced key is fetchable, so arrivals are part of the sequence.
          for (const key of referencedKeys(state)) {
            if (next() < 0.4 && !seen.has(key)) {
              seen.add(key);
              state = reduce(state, {
                t: 'dataArrived',
                key,
                result: step,
                version: state.dataVersion ?? '',
              });
            }
          }
        }
        const keys = Object.keys(state.datasets);
        expect(new Set(keys).size).toBe(keys.length);
        for (const key of keys) expect(state.datasets[key]).toBeDefined();
        const ids = state.panels.map((p) => p.id);
        expect(new Set(ids).size).toBe(ids.length);
        // One cohort per id, and no panel referencing a cohort that is gone.
        const cohortIds = state.cohorts.map((c) => c.id);
        expect(new Set(cohortIds).size).toBe(cohortIds.length);
        const known = new Set(['current', 'all', ...cohortIds]);
        for (const p of state.panels) {
          for (const item of p.series) {
            if (item.kind === 'cohort') expect(known.has(item.id)).toBe(true);
          }
        }
      }
    });
  });
});

/* ---------------------------------------------------------------- cohorts */

describe('cohort commands', () => {
  it('adds a cohort, validated against the catalog', () => {
    const state = reduce(fixture(), {
      t: 'addCohort',
      cohort: {
        id: 'c1',
        name: '  Siemens 3T  ',
        color: 2,
        source: 'population',
        view: 'k4plus',
        // `task_id` is bold-only and this fixture is bold, so it survives;
        // a field the view has no column for would not.
        filters: [manufacturerFilter],
        selections: [{ metric: asColumnId('fd_mean'), range: [0.1, 0.9] }],
      },
    });
    expect(state.cohorts).toHaveLength(1);
    expect(state.cohorts[0]).toMatchObject({
      id: 'c1',
      // Trimmed: a name with leading space sorts and reads as a different name.
      name: 'Siemens 3T',
      color: 2,
      view: 'k4plus',
    });
    expect(state.cohorts[0].filters).toEqual([manufacturerFilter]);
  });

  it('drops a cohort filter the catalog does not have for its view', () => {
    const state = reduce(fixture(), {
      t: 'addCohort',
      cohort: cohort('c1', 'Bad', 0, {
        view: 'raw',
        // `canonical_hmc_mode` is a canonical-only column, so on `raw` it is
        // not a filter the server would accept.
        filters: [{ field: asColumnId('canonical_hmc_mode'), op: 'in', values: ['afni'] }],
      }),
    });
    expect(state.cohorts[0].filters).toEqual([]);
  });

  it('re-mints an id that collides with another cohort or with a derived one', () => {
    const first = reduce(fixture(), { t: 'addCohort', cohort: cohort('c1', 'A') });
    const second = reduce(first, { t: 'addCohort', cohort: cohort('c1', 'B') });
    expect(second.cohorts.map((c) => c.id)).toEqual(['c1', 'c2']);
    // `current` and `all` are derived, so a cohort claiming one of their ids
    // would make every lookup by id ambiguous.
    const reserved = reduce(second, { t: 'addCohort', cohort: cohort('current', 'C') });
    expect(reserved.cohorts.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
  });

  it('assigns the lowest free palette slot, skipping the two derived ones', () => {
    // `current` holds 0 and `all` holds 1, so the first user cohort is 2.
    const a = reduce(fixture(), {
      t: 'addCohort',
      cohort: { ...cohort('c1', 'A'), color: nextColor(fixture()) },
    });
    expect(a.cohorts[0].color).toBe(2);
    const b = reduce(a, { t: 'addCohort', cohort: { ...cohort('c2', 'B'), color: nextColor(a) } });
    expect(b.cohorts[1].color).toBe(3);
    // Removing the first releases its slot; the colour of the one that stayed
    // is untouched, which is the whole of "never re-ranked".
    const removed = reduce(b, { t: 'removeCohort', id: 'c1' });
    expect(removed.cohorts[0].color).toBe(3);
    const c = reduce(removed, {
      t: 'addCohort',
      cohort: { ...cohort('c3', 'C'), color: nextColor(removed) },
    });
    expect(c.cohorts.map((x) => x.color)).toEqual([3, 2]);
  });

  it('caps the cohort list', () => {
    let state = fixture();
    for (let i = 0; i < MAX_COHORTS + 5; i += 1) {
      state = reduce(state, { t: 'addCohort', cohort: cohort(`c${i + 1}`, `C${i}`) });
    }
    expect(state.cohorts).toHaveLength(MAX_COHORTS);
  });

  it('patches a cohort, and returns the same state for a patch that changes nothing', () => {
    const state = reduce(fixture(), { t: 'addCohort', cohort: cohort('c1', 'A') });
    const renamed = reduce(state, { t: 'updateCohort', id: 'c1', patch: { name: 'B' } });
    expect(renamed.cohorts[0].name).toBe('B');
    // The editor writes its whole value on Save, so an unchanged save must not
    // re-derive every panel.
    expect(reduce(renamed, { t: 'updateCohort', id: 'c1', patch: { name: 'B' } })).toBe(renamed);
  });

  it('ignores an update or a removal aimed at a derived cohort', () => {
    const state = fixture();
    expect(reduce(state, { t: 'updateCohort', id: 'current', patch: { name: 'Mine' } })).toBe(
      state,
    );
    expect(reduce(state, { t: 'removeCohort', id: 'all' })).toBe(state);
  });

  describe('convertToComparison', () => {
    it('turns a distribution panel into `current` plus the chosen cohort', () => {
      const state = reduce(fixture(), { t: 'convertToComparison', panelId: 'p1', with: 'all' });
      const [converted] = state.panels;
      expect(converted!.series.length).toBeGreaterThan(0);
      expect(converted.series).toEqual([{kind:'population'}]);
      // Both kinds expose the same list, so the selected chart survives.
      expect(converted.form).toBe('histogram');
      // The metric and the options the card already had are the comparison's.
      expect(converted.x).toBe('fd_mean');
    });

    it('keeps a grouping and reports the cap when an against series will not fit', () => {
      const grouped = fixture({ panels: [panel({ series: [{ kind: 'field' as const, field: asColumnId('manufacturer') }] })] });
      const state = reduce(grouped, { t: 'convertToComparison', panelId: 'p1', with: 'all' });
      expect(state.panels[0].series).toEqual(grouped.panels[0].series);
      expect(state.notice).toContain('Six');
    });

    it('appends to a panel that is already a comparison, and never twice', () => {
      const withCohort = run(
        fixture(),
        { t: 'addCohort', cohort: cohort('c1', 'Philips') },
        { t: 'convertToComparison', panelId: 'p1', with: 'all' },
        { t: 'convertToComparison', panelId: 'p1', with: 'c1' },
      );
      expect(withCohort.panels[0].series).toEqual([{kind:'population'}, {kind:'cohort',id:'c1'}]);
      const again = reduce(withCohort, { t: 'convertToComparison', panelId: 'p1', with: 'c1' });
      expect(again.panels).toBe(withCohort.panels);
      expect(again.notice).toContain('already');
    });

    it('refuses a cohort that does not exist, and `current` against itself', () => {
      const state = fixture();
      expect(reduce(state, { t: 'convertToComparison', panelId: 'p1', with: 'nope' }).panels).toBe(state.panels);
      // A comparison of this dashboard with this dashboard is one cohort.
      expect(reduce(state, { t: 'convertToComparison', panelId: 'p1', with: 'current' })).toBe(
        state,
      );
    });

    it('adds series to tables and time without changing an allowed form', () => {
      for (const p of [panel({form:'table'}),panel({x:'created_at',form:'line'})]) {
        const next=reduce(fixture({panels:[p]}),{t:'addPanelSeries',id:p.id,series:{kind:'population'}});
        expect(next.panels[0].form).toBe(p.form);
        expect(next.panels[0].series).toEqual([{kind:'population'}]);
      }
    });
  });

  describe('removeCohort', () => {
    it('removes the id from every panel that drew it', () => {
      const state = run(
        fixture(),
        { t: 'addCohort', cohort: cohort('c1', 'Philips') },
        { t: 'convertToComparison', panelId: 'p1', with: 'all' },
        { t: 'convertToComparison', panelId: 'p1', with: 'c1' },
        { t: 'removeCohort', id: 'c1' },
      );
      expect(state.cohorts).toEqual([]);
      expect(state.panels[0]!.series.length).toBeGreaterThan(0);
      expect(state.panels[0].series).toEqual([{kind:'population'}]);
    });

    it('reverts a panel left with fewer than two cohorts to a distribution', () => {
      const state = run(
        fixture(),
        { t: 'addCohort', cohort: cohort('c1', 'Philips') },
        { t: 'convertToComparison', panelId: 'p1', with: 'c1' },
      );
      expect(state.panels[0].series).toEqual([{kind:'cohort',id:'c1'}]);
      const reverted = reduce(state, { t: 'removeCohort', id: 'c1' });
      const [p] = reverted.panels;
      // A comparison of one cohort *is* a distribution, so the card keeps its
      // metric and its options rather than becoming an empty panel.
      expect(p!.series).toEqual([]);
      // `histogram` is in both kinds' chart lists, so the chart the comparison was
      // on carries straight back.
      expect(p.form).toBe('histogram');
      expect(p.x).toBe('fd_mean');
      expect(p.series).toEqual([]);
      expect(p.reference).toBeUndefined();
    });

    it('keeps ECDF after the last saved group is removed', () => {
      const compared = run(
        fixture(),
        { t: 'addCohort', cohort: cohort('c1', 'Philips') },
        { t: 'convertToComparison', panelId: 'p1', with: 'c1' },
      );
      const state = reduce(
        { ...compared, panels: [{ ...compared.panels[0], form: 'ecdf' }] },
        { t: 'removeCohort', id: 'c1' },
      );
      expect(state.panels[0].form).toBe('ecdf');
    });

    it('keeps a chart both kinds have', () => {
      const state = run(
        fixture(),
        { t: 'addCohort', cohort: cohort('c1', 'Philips') },
        { t: 'convertToComparison', panelId: 'p1', with: 'c1' },
        { t: 'setPanelChart', id: 'p1', form: 'density' },
        { t: 'removeCohort', id: 'c1' },
      );
      expect(state.panels[0].form).toBe('density');
    });
  });

  describe('the brush on a comparison panel', () => {
    function brushed(): State {
      return run(
        fixture(),
        { t: 'convertToComparison', panelId: 'p1', with: 'all' },
        { t: 'brush', from: 'p1', metric: asColumnId('fd_mean'), range: [0.1, 0.4] },
      );
    }

    it('is a brush source on the two overlaid charts', () => {
      const state = brushed();
      expect(state.selections).toMatchObject([{ from: 'p1', range: [0.1, 0.4] }]);
      expect(
        reduce(state, { t: 'setPanelChart', id: 'p1', form: 'ecdf' }).selections,
      ).not.toEqual([]);
    });

    it('drops the brush when the panel switches to the box chart', () => {
      // A box is a summary per cohort row, not a distribution over the value
      // axis: there is no interval on it to drag, so a brush left in force
      // would filter the whole dashboard from a card that does not show it.
      const boxed = reduce(brushed(), { t: 'setPanelChart', id: 'p1', form: 'box' });
      expect(boxed.panels[0].form).toBe('box');
      expect(boxed.selections).toEqual([]);
    });
  });

  describe('setPanelReference', () => {
    it('re-anchors the differences and leaves every key alone', () => {
      const state = reduce(fixture(), { t: 'convertToComparison', panelId: 'p1', with: 'all' });
      const keys = [...referencedKeys(state)];
      const anchored = reduce(state, { t: 'setPanelReference', id: 'p1', cohort: 'all' });
      expect(anchored.panels[0].reference).toBe('all');
      // Which cohort the differences subtract from changes no query.
      expect([...referencedKeys(anchored)]).toEqual(keys);
    });

    it('stores nothing when the reference is already the default', () => {
      // The first cohort *is* the default, so naming it must not change the
      // link -- a panel nobody re-anchored carries nothing extra.
      const state = reduce(fixture(), { t: 'convertToComparison', panelId: 'p1', with: 'all' });
      expect(reduce(state, { t: 'setPanelReference', id: 'p1', cohort: 'current' })).toBe(state);
    });

    it('ignores a cohort the panel is not drawing', () => {
      const state = run(
        fixture(),
        { t: 'addCohort', cohort: cohort('c1', 'Philips') },
        { t: 'convertToComparison', panelId: 'p1', with: 'all' },
      );
      // "vs" something off-screen is not a difference a reader can check.
      expect(reduce(state, { t: 'setPanelReference', id: 'p1', cohort: 'c1' })).toBe(state);
    });
  });

  describe('removePanelCohort and revertPanelToSingle', () => {
    function threeCohorts(): State {
      return run(
        fixture(),
        { t: 'addCohort', cohort: cohort('c1', 'Philips') },
        { t: 'convertToComparison', panelId: 'p1', with: ['current', 'all', 'c1'] },
      );
    }

    it('takes one cohort off the panel and leaves the cohort list alone', () => {
      const state = reduce(threeCohorts(), {
        t: 'removePanelCohort',
        panelId: 'p1',
        cohort: 'c1',
      });
      expect(state.panels[0].series).toEqual([{kind:'population'}]);
      // The ✕ on a panel chip is a change to the panel, not to the dashboard.
      expect(state.cohorts.map((c) => c.id)).toEqual(['c1']);
    });

    it('can take a built-in off a panel, though it can never be deleted', () => {
      const state = reduce(threeCohorts(), {
        t: 'removePanelCohort',
        panelId: 'p1',
        cohort: 'current',
      });
      expect(state.panels[0].series).toEqual([{kind:'population'}, {kind:'cohort',id:'c1'}]);
      expect(reduce(state, { t: 'removeCohort', id: 'current' })).toBe(state);
    });

    it('reverts the panel when the last removal drops it below two', () => {
      const two = reduce(threeCohorts(), { t: 'removePanelCohort', panelId: 'p1', cohort: 'c1' });
      const one = reduce(two, { t: 'removePanelCohort', panelId: 'p1', cohort: 'all' });
      expect(one.panels[0]!.series).toEqual([]);
      expect(one.panels[0].x).toBe('fd_mean');
      expect(one.panels[0].series).toEqual([]);
    });

    it('drops a reference that is no longer on the panel', () => {
      const anchored = reduce(threeCohorts(), {
        t: 'setPanelReference',
        id: 'p1',
        cohort: 'c1',
      });
      expect(anchored.panels[0].reference).toBe('c1');
      const removed = reduce(anchored, {
        t: 'removePanelCohort',
        panelId: 'p1',
        cohort: 'c1',
      });
      expect(removed.panels[0].reference).toBeUndefined();
    });

    it('"Back to single distribution" reverts in one command', () => {
      const state = reduce(threeCohorts(), { t: 'revertPanelToSingle', id: 'p1' });
      const [p] = state.panels;
      expect(p!.series).toEqual([]);
      expect(p.x).toBe('fd_mean');
      expect(p.series).toEqual([]);
      // The cohorts themselves survive: reverting a panel deletes nothing.
      expect(state.cohorts.map((c) => c.id)).toEqual(['c1']);
      expect(reduce(state, { t: 'revertPanelToSingle', id: 'p1' })).toBe(state);
    });
  });

  describe('split groups as cohorts', () => {
    const siemens = `g\u0000manufacturer\u0000Siemens`;
    const ge = `g\u0000manufacturer\u0000GE`;

    function split(): State {
      return fixture({
        global: { modality: 'bold', view: 'k4plus', filters: [] },
        panels: [panel({ series: [{ kind: 'field' as const, field: asColumnId('manufacturer') }] })],
      });
    }

    it('replaces a field descriptor with precisely the chosen values', () => {
      const next=reduce(split(),{t:'patchPanel',id:'p1',patch:{series:[{kind:'values',field:asColumnId('manufacturer'),values:['Siemens','GE']}]}});
      expect(next.panels[0].series).toEqual([{kind:'values',field:'manufacturer',values:['Siemens','GE']}]);
      expect(next.cohorts).toEqual([]);
    });
    it('refuses chosen values for a field absent from the current view', () => {
      const before=fixture();
      const next=reduce(before,{t:'addPanelSeries',id:'p1',series:{kind:'values',field:asColumnId('not_a_column'),values:['x']}});
      expect(next).toBe(before);
    });

    it('never stores a group cohort, because its id is its definition', () => {
      const state = reduce(fixture(), {
        t: 'addCohort',
        cohort: cohort(siemens, 'Manufacturer: Siemens'),
      });
      expect(state.cohorts).toEqual([]);
    });
  });

  it('keeps cohorts across a modality switch, retargeting what the modality lacks', () => {
    const state = run(
      fixture({ global: { modality: 'bold', view: 'k4plus', filters: [] } }),
      {
        t: 'addCohort',
        cohort: cohort('c1', 'Siemens', 2, {
          view: 'k4plus',
          filters: [manufacturerFilter],
          selections: [{ metric: asColumnId('fd_mean'), range: [0, 1] }],
        }),
      },
      { t: 'setModality', modality: 'T1w' },
    );
    const [c] = state.cohorts;
    // The cohort keeps its identity -- the panels reference it by id -- and its
    // view falls back to the new modality's canonical one, like the top bar's.
    expect(c.id).toBe('c1');
    expect(c.name).toBe('Siemens');
    expect(c.color).toBe(2);
    expect(c.view).toBe('k3pp');
    // `fd_mean` is bold-only, so a range on it means nothing on T1w.
    expect(c.selections).toEqual([]);
    expect(isValidMetric('T1w', asColumnId('fd_mean'))).toBe(false);
  });
});

describe('retryKey', () => {
  it('forgets a failed entry so the key is asked for again', () => {
    const key = [...referencedKeys(fixture())].find((k) => k !== CATALOG_KEY) as string;
    const failed = fixture({
      datasets: { [key]: { status: 'error', version: 'v1', error: 'the server could not answer' } },
    });
    // An error entry satisfies its key, which is what stops the runner
    // spinning; forgetting it is the only way back into `needed`.
    expect(needed(failed).has(key)).toBe(false);
    const retried = reduce(failed, { t: 'retryKey', key });
    expect(retried.datasets[key]).toBeUndefined();
    expect(needed(retried).has(key)).toBe(true);
  });

  it('re-asks for a failed catalogue', () => {
    const failed = fixture({
      panels: [],
      datasets: { [CATALOG_KEY]: { status: 'error', version: 'v1', error: 'boom' } },
    });
    expect(needed(failed).has(CATALOG_KEY)).toBe(false);
    expect(needed(reduce(failed, { t: 'retryKey', key: CATALOG_KEY })).has(CATALOG_KEY)).toBe(true);
  });

  it('is a no-op for a key with no entry', () => {
    const state = fixture();
    expect(reduce(state, { t: 'retryKey', key: 'nothing-here' })).toBe(state);
  });
});

describe('restorePanel', () => {
  it('puts the panel back exactly as it was, where it was', () => {
    const panels = [
      panel({ id: 'p1' }),
      panel({ id: 'p2', x: asColumnId('tsnr') }),
      panel({ id: 'p3' }),
    ];
    const state = fixture({ panels });
    const removed = reduce(state, { t: 'removePanel', id: 'p2' });
    expect(removed.panels.map((p) => p.id)).toEqual(['p1', 'p3']);

    const undone = reduce(removed, { t: 'restorePanel', panel: panels[1], at: 1 });
    expect(undone.panels.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    expect(undone.panels[1]).toEqual({ ...panels[1], cursors: FIRST_PAGE });
  });

  it('refuses to duplicate an id that is already on the board', () => {
    const state = fixture();
    expect(reduce(state, { t: 'restorePanel', panel: panel({ id: 'p1' }), at: 0 })).toBe(state);
  });

  it('clamps an index past either end', () => {
    const state = fixture({ panels: [panel({ id: 'p1' })] });
    const far = reduce(state, { t: 'restorePanel', panel: panel({ id: 'p9' }), at: 99 });
    expect(far.panels.map((p) => p.id)).toEqual(['p1', 'p9']);
    const under = reduce(state, { t: 'restorePanel', panel: panel({ id: 'p9' }), at: -4 });
    expect(under.panels.map((p) => p.id)).toEqual(['p9', 'p1']);
  });
});

describe('saveCurrentAsCohort', () => {
  it('snapshots the view, the filters and the brush, named after them', () => {
    const state = reduce(
      fixture({
        global: { modality: 'bold', view: 'k4plus', filters: [manufacturerFilter] },
        selections: [{ from: 'p1', metric: asColumnId('fd_mean'), range: [0.1, 0.4] }],
      }),
      { t: 'saveCurrentAsCohort' },
    );
    expect(state.cohorts).toHaveLength(1);
    const [saved] = state.cohorts;
    expect(saved.view).toBe('k4plus');
    expect(saved.filters).toEqual([manufacturerFilter]);
    expect(saved.selections).toEqual([{ metric: 'fd_mean', range: [0.1, 0.4] }]);
    // The name is the whole of what makes this slice different from any other.
    expect(saved.name).toBe('K4+ \u00b7 SIEMENS \u00b7 FD mean 0.1\u20130.4');
  });

  it('is a snapshot: later changes to the dashboard do not reach it', () => {
    const saved = reduce(
      fixture({ global: { modality: 'bold', view: 'k4plus', filters: [manufacturerFilter] } }),
      { t: 'saveCurrentAsCohort' },
    );
    const moved = reduce(saved, { t: 'setFilters', filters: [] });
    expect(moved.cohorts[0].filters).toEqual([manufacturerFilter]);
    expect(moved.global.filters).toEqual([]);
  });

  it('takes the next free palette slot, skipping the two built-ins', () => {
    const first = reduce(fixture(), { t: 'saveCurrentAsCohort' });
    expect(first.cohorts[0].color).toBe(2);
    const second = reduce(first, { t: 'saveCurrentAsCohort' });
    expect(second.cohorts[1].color).toBe(3);
  });

  it('makes a repeated snapshot a distinguishable name', () => {
    const twice = run(fixture(), { t: 'saveCurrentAsCohort' }, { t: 'saveCurrentAsCohort' });
    expect(twice.cohorts.map((c) => c.name)).toEqual(['raw \u00b7 all', 'raw \u00b7 all (2)']);
  });

  it('refuses past the cohort cap', () => {
    let state = fixture();
    for (let i = 0; i < MAX_COHORTS + 3; i += 1) {
      state = reduce(state, { t: 'saveCurrentAsCohort' });
    }
    expect(state.cohorts).toHaveLength(MAX_COHORTS);
  });
});
