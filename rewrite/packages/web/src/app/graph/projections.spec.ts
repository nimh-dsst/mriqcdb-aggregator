import { queryKey } from '../api/api';
import {
  asColumnId,
  fieldsFor,
  metricsFor,
  viewsFor,
  type CompletedCatalog,
  type Modality,
  type View,
  type ViewDef,
} from '@mriqc/shared';
import { FILTER_SEARCH_THRESHOLD, chrome } from '../view/chrome-view';
import { panelView, resetPanelViewMemo } from '../view/panel-view';
import { DARK_THEME } from '../panels/specs/palette';
import { comparisonStats } from '../view/stats';
import {
  clipChip,
  countAxisTitle,
  metricPhrase,
  panelMeaning,
  panelNotes,
  significant,
  statUnitLabel,
  unitNoun,
  viewNoun,
} from '../view/text';
import {
  ALL_COHORT_NAME,
  CURRENT_COHORT_NAME,
  allCohort,
  cohortById,
  cohortList,
  cohortsOf,
  currentCohort,
  studyCohort,
} from './cohorts';
import {
  CATALOG_KEY,
  cohortRange,
  coverageFilters,
  needed,
  panelCohorts,
  panelKeys,
  panelQueries,
  panelSharedRange,
  sharedRange,
  splitDistributionCohorts,
} from './queries';
import { defaultDashboard, initialState, reduce } from './reducer';
import {
  FIRST_PAGE,
  STUDY_COHORT,
  defaultPanelOptions,
  type Cohort,
  type DatasetEntry,
  type Panel,
  type State,
} from './state';
import { decodeUrlState, encodeUrlState, urlState } from './url';

function panel(overrides: Partial<Panel> = {}): Panel {
  return {
    id: 'p1',
    y: 'count', aggregate: 'median',
    x: asColumnId('fd_mean'),
    form: 'histogram',
    series: [],

    options: defaultPanelOptions(),
    cursors: FIRST_PAGE,
    ...overrides,
  };
}

const catalog = {
  version: '0.2.0',
  fieldValues: {},
  numericRange: {},
  dateRange: {},
  metricCounts: {},
  availableViews: {},
} as unknown as CompletedCatalog;

/**
 * A populated catalog always has its dataset entry too -- `dataArrived` writes
 * both -- and the catalog key is needed again whenever that entry is not at the
 * current version, so the fixture has to carry it or every `needed` assertion
 * would be about a state the reducer cannot produce.
 */
function fixture(overrides: Partial<State> = {}): State {
  const base: State = {
    ...initialState,
    dataVersion: 'v1',
    catalog,
    global: { modality: 'bold', view: 'raw', filters: [] },
    panels: [panel()],
    ...overrides,
  };
  if (base.catalog === null) return base;
  return {
    ...base,
    datasets: { [CATALOG_KEY]: ready(base.dataVersion ?? 'v1', base.catalog), ...base.datasets },
  };
}

function ready(version: string, result: unknown): DatasetEntry {
  return { status: 'ready', version, result };
}

const distributionResult = {
  n: 300,
  min: 0,
  max: 1,
  mean: 0.4,
  stddev: 0.2,
  quantiles: { p01: 0.05, p05: 0.1, p25: 0.2, p50: 0.4, p75: 0.6, p95: 0.8, p99: 0.95 },
  histogram: { lo: 0, hi: 1, width: 0.25, counts: [10, 40, 30, 20] },
};

beforeEach(() => resetPanelViewMemo());

const readyStudy = {
  status: 'ready' as const,
  name: 'study.csv',
  rows: 300,
  metrics: [asColumnId('fd_mean')],
  totalMetrics: 4,
  ignoredColumns: [],
  missingMetrics: [asColumnId('tsnr')],
};

describe('study cohort', () => {
  it('is derived only while a study is ready and plans local-source comparison queries', () => {
    expect(studyCohort(fixture())).toBeNull();
    const comparison = panel({
      y: 'count', aggregate: 'median',
      form: 'histogram',
      series: [{ kind: 'study' as const }],
    });
    const state = fixture({ study: readyStudy, panels: [comparison] });
    expect(cohortsOf(state).map((entry) => entry.id)).toContain(STUDY_COHORT);
    expect(panelQueries(state, comparison).map((query) => query.source)).toEqual([
      'population',
      'study',
    ]);
  });
});

describe('needed', () => {
  it('always contains the catalog key while the catalog is null', () => {
    expect(needed(fixture({ catalog: null, panels: [] }))).toEqual(new Set([CATALOG_KEY]));
  });

  it('drops the catalog key once the catalog arrived', () => {
    expect(needed(fixture({ panels: [] }))).toEqual(new Set());
  });

  it('asks for one shared key however many panels want it', () => {
    const state = fixture({ panels: [panel({ id: 'p1' }), panel({ id: 'p2' })] });
    expect(needed(state).size).toBe(1);
  });

  it('asks for nothing when a correlation set has fewer than two metrics', () => {
    expect(needed(fixture({ panels: [panel({ form: 'matrix', options: { ...defaultPanelOptions(), family: 'custom', metrics: [] } })] }))).toEqual(new Set());
  });

  it('stops asking once an entry exists at the current version', () => {
    const key = panelKeys(fixture(), panel())[0];
    expect(needed(fixture({ datasets: { [key]: ready('v1', distributionResult) } }))).toEqual(
      new Set(),
    );
  });

  it('asks again after a version change, for the on-screen keys only', () => {
    const key = panelKeys(fixture(), panel())[0];
    const state = fixture({
      datasets: { [key]: ready('v1', distributionResult), 'off-screen': ready('v1', 1) },
    });
    expect(needed(state)).toEqual(new Set());
    const bumped = reduce(state, { t: 'dataVersionChanged', version: 'v2' });
    // The catalog is per-ingest too: its value lists and date range move with
    // the data, so a version change makes it needed again like any other key.
    expect(needed(bumped)).toEqual(new Set([CATALOG_KEY, key]));
  });

  it('keeps an errored key out of the set, so a failure does not retry forever', () => {
    const key = panelKeys(fixture(), panel())[0];
    const state = fixture({
      datasets: { [key]: { status: 'error', version: 'v1', error: 'boom' } },
    });
    expect(needed(state)).toEqual(new Set());
  });

  it('plans a single distribution when only one cohort remains', () => {
    // A link can carry a comparison panel whose cohorts no longer exist. The
    // reducer reverts such a panel, but the projection has to be total for the
    // instant before it does.
    const comparison = panel({
      y: 'count', aggregate: 'median',
      form: 'histogram',
      series: [],
    });
    const state = fixture({ panels: [comparison] });
    expect(panelQueries(state, comparison).map(query => query.proc)).toEqual(['distribution']);
    expect(needed(state).size).toBe(1);
  });

  it('asks for one distribution per cohort, with no range, in step one', () => {
    const comparison = panel({
      y: 'count', aggregate: 'median',
      form: 'histogram',
      series: [{ kind: 'population' as const }],
    });
    const state = fixture({
      panels: [comparison],
      global: {
        modality: 'bold',
        view: 'k4plus',
        filters: [{ field: asColumnId('manufacturer'), op: 'in', values: ['SIEMENS'] }],
      },
    });
    const queries = panelQueries(state, comparison);
    expect(queries).toHaveLength(2);
    for (const query of queries) {
      expect(query).toMatchObject({ proc: 'distribution', source: 'population' });
      expect((query as { range?: unknown }).range).toBeUndefined();
    }
    expect(needed(state).size).toBe(2);
  });

  it('shares one key between two cohorts that mean the same thing', () => {
    // With no global filters, "This dashboard" and "Whole population" *are* the
    // same slice, and the query key is a function of a query's meaning. Two
    // cohorts, one request -- which is the same rule that makes two panels
    // comparing the same cohort share an entry.
    const comparison = panel({
      y: 'count', aggregate: 'median',
      form: 'histogram',
      series: [{ kind: 'population' as const }],
    });
    const state = fixture({ panels: [comparison] });
    expect(panelQueries(state, comparison)).toHaveLength(2);
    expect(needed(state).size).toBe(1);
  });
});

describe('panelQueries', () => {
  it.each(['stacked', 'stacked100'] as const)('plans the parent clip query before rebinning a %s split', (layout) => {
    const split = panel({ series: [{ kind: 'field' as const, field: asColumnId('manufacturer') }], options: { ...defaultPanelOptions(), layout } });
    const state = fixture({ panels: [split], catalog: { ...catalog,
      fieldValues: { manufacturer: { bold: { raw: [{ value: 'A', n: 20 }, { value: 'B', n: 10 }] } } },
    } as unknown as CompletedCatalog });
    const queries = panelQueries(state, split);
    expect(queries).toHaveLength(3);
    expect(queries.at(-1)).toEqual(panelQueries(state, { ...split, series: [] })[0]);
    const answeredState = answered(state, (_key, index) => index === 2
      ? dist({ lo: 1.5, hi: 8.5 }) : dist({ lo: 0, hi: 10 }));
    const ranged = panelQueries(answeredState, split).filter(query => 'range' in query);
    expect(ranged).toHaveLength(2);
    expect(ranged.every(query => 'range' in query && JSON.stringify(query.range) === '[1.5,8.5]')).toBe(true);
  });

  it('uses cohort distributions for split box charts', () => {
    const grouped = panel({ series: [{ kind: 'field' as const, field: asColumnId('manufacturer') }], form: 'box' });
    expect(panelQueries(fixture({ panels: [grouped] }), grouped)[0].proc).toBe('distribution');
  });

  it('plans split densities as top-five plus Other cohort distributions', () => {
    const values = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((value, index) => ({
      value,
      n: 70 - index * 10,
    }));
    const split = panel({ series: [{ kind: 'field' as const, field: asColumnId('manufacturer') }], form: 'density' });
    const state = fixture({
      panels: [split],
      catalog: {
        ...catalog,
        fieldValues: { manufacturer: { bold: { raw: values } } },
      } as unknown as CompletedCatalog,
    });
    const cohorts = splitDistributionCohorts(state, split);
    expect(cohorts.map((cohort) => cohort.name)).toEqual(['A', 'B', 'C', 'D', 'E', 'Other']);
    expect(cohorts.at(-1)?.filters.at(-1)).toEqual({
      field: 'manufacturer',
      op: 'in',
      values: ['F', 'G'],
    });
    const queries = panelQueries(state, split);
    expect(queries).toHaveLength(7);
    expect(queries.every((query) => query.proc === 'distribution')).toBe(true);
    expect(queries.every((query) => query.proc !== 'distribution' || query.bins === 200)).toBe(
      true,
    );
    expect(queries.every((query) => !('range' in query))).toBe(true);
  });

  it('rebins every split density over the groups p01-p99 union, not min-max outliers', () => {
    const values = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((value, index) => ({
      value,
      n: 70 - index * 10,
    }));
    const split = panel({ series: [{ kind: 'field' as const, field: asColumnId('manufacturer') }], form: 'density' });
    const state = fixture({
      panels: [split],
      catalog: {
        ...catalog,
        fieldValues: { manufacturer: { bold: { raw: values } } },
      } as unknown as CompletedCatalog,
    });
    const stepOne = answered(state, (_key, index) =>
      dist({ p01: index + 1, p99: index + 10, min: 0, max: 640 }),
    );
    const queries = panelQueries(stepOne, split);
    expect(queries).toHaveLength(13);
    expect(queries.slice(6,12).map((query) => ('range' in query ? query.range : null))).toEqual(
      Array.from({ length: 6 }, () => [1, 15]),
    );
  });

  it('renders Other as the queried tail cohort and includes its count once', () => {
    const values = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((value, index) => ({
      value,
      n: 70 - index * 10,
    }));
    const split = panel({ series: [{ kind: 'field' as const, field: asColumnId('manufacturer') }], form: 'density' });
    const state = fixture({
      panels: [split],
      catalog: {
        ...catalog,
        fieldValues: { manufacturer: { bold: { raw: values } } },
      } as unknown as CompletedCatalog,
    });
    const counts = [50, 40, 30, 20, 10, 7, 157];
    const stepOne = answered(state, (_key, index) => dist({ n: counts[index] }));
    const complete = answered(stepOne, (_key, index) => dist({ n: index === 12 ? 157 : counts[index % 6] }));
    const view = panelView(complete, 'p1');
    const labels = new Set(
      (view?.datasets['cohorts'] ?? []).map((row) => (row as { label: string }).label),
    );
    expect([...labels]).toEqual(['A', 'B', 'C', 'D', 'E', 'Other']);
    expect(view?.n).toBe(157);
  });

  it('keeps the dashboard first and gives a saved-group series its saved rows', () => {
    const saved = cohort('c1', 'Saved', {
      view: 'k4plus',
      filters: [{ field: asColumnId('manufacturer'), op: 'in', values: ['SIEMENS'] }],
      selections: [{ metric: asColumnId('fd_mean'), range: [0.1, 0.4] }],
    });
    const bound = panel({ series: [{ kind: 'cohort' as const, id: 'c1' }] });
    const state = fixture({
      panels: [bound],
      cohorts: [saved],
      global: { modality: 'bold', view: 'raw', filters: [] },
    });
    expect(panelQueries(state, bound)[1]).toMatchObject({
      view: 'k4plus',
      filters: saved.filters,
      selections: saved.selections,
    });
  });

  it('applies card-local coverage windows without losing other cohort filters', () => {
    const coverage = panel({
      y: 'count', aggregate: 'median',
      x: 'created_at',
      form: 'area',
      series: [{ kind: 'field' as const, field: asColumnId('manufacturer') }],
      options: { ...defaultPanelOptions(), coverageWindow: '5y' },
    });
    const manufacturer = {
      field: asColumnId('manufacturer'),
      op: 'in' as const,
      values: ['SIEMENS'],
    };
    const filtered = coverageFilters([manufacturer], coverage, new Date('2026-10-07T00:00:00Z'));
    expect(filtered).toEqual([
      manufacturer,
      { field: 'created_at', op: 'between', lo: '2021-10-07', hi: '2026-10-07' },
    ]);
  });

  it('does not apply the brush to the panel that set it', () => {
    const state = fixture({
      panels: [panel({ id: 'p1' }), panel({ id: 'p2' })],
      selections: [{ from: 'p1', metric: asColumnId('fd_mean'), range: [0.1, 0.9] }],
    });
    const [origin, other] = state.panels;
    expect(panelQueries(state, origin)[0]).toMatchObject({ selections: [] });
    expect(panelQueries(state, other)[0]).toMatchObject({
      selections: [{ metric: 'fd_mean', range: [0.1, 0.9] }],
    });
  });

  it('keeps the earlier pages of a sample panel on screen', () => {
    const sample = panel({ y: 'count', aggregate: 'median', form: 'table', x: asColumnId('fd_mean') });
    const first = fixture({ panels: [sample] });
    const paged = reduce(first, { t: 'requestPage', id: 'p1', cursor: 'page-2' });
    const keys = panelKeys(paged, paged.panels[0]);
    expect(keys).toHaveLength(3);
    const withRows = {
      ...paged,
      datasets: {
        ...paged.datasets,
        [keys[0]]: ready('v1', { rows: [{ id: 'a' }], nextCursor: 'page-2' }),
        [keys[1]]: ready('v1', { rows: [{ id: 'b' }], nextCursor: null }),
        [keys[2]]: ready('v1', dist()),
      },
    };
    const table = panelView(withRows, 'p1')?.table;
    expect(table?.rows).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(table?.nextCursor).toBeNull();
  });

  it('gives the sample panel every exportable column', () => {
    const sample = panel({ y: 'count', aggregate: 'median', form: 'table', x: asColumnId('fd_mean') });
    const query = panelQueries(fixture({ panels: [sample] }), sample)[0];
    expect(query.proc).toBe('sample');
    expect(query).toMatchObject({ cursor: null });
  });

  it('paginates Table series independently and labels their rows', () => {
    const table = panel({ form: 'table', series: [{ kind: 'values', field: asColumnId('manufacturer'), values: ['A', 'B'] }] });
    let state = fixture({ panels: [table] });
    const samples = panelQueries(state, table).filter(query => query.proc === 'sample');
    expect(samples).toHaveLength(2);
    state = { ...state, datasets: {
      ...state.datasets,
      [queryKey(samples[0])]: ready('v1', { rows: [{ id: 'a' }], nextCursor: 'a-next' }),
      [queryKey(samples[1])]: ready('v1', { rows: [{ id: 'b' }], nextCursor: null }),
    } };
    const view = panelView(state, table.id)!;
    expect(view.table?.headers[0]).toBe('Series');
    expect(view.table?.rows.map(row => row['__series'])).toEqual(['A', 'B']);
    const paged = reduce(state, { t: 'requestPage', id: table.id, cursor: view.table!.nextCursor });
    const pages = panelQueries(paged, paged.panels[0]).filter(query => query.proc === 'sample');
    expect(pages.map(query => query.cursor)).toEqual([null, null, 'a-next']);
    const complete = { ...paged, datasets: { ...paged.datasets,
      [queryKey(pages[2])]: ready('v1', { rows: [{ id: 'a2' }], nextCursor: null }),
    } };
    expect(panelView(complete, table.id)?.table?.rows.map(row => row['id'])).toEqual(['a', 'b', 'a2']);
    expect(panelView(complete, table.id)?.table?.nextCursor).toBeNull();
  });
});

describe('panelView', () => {
  it('returns the same reference when its slice is unchanged', () => {
    const state = fixture();
    const other: State = { ...state, export: { status: 'running', rows: 3 } };
    const first = panelView(state, 'p1');
    const second = panelView(other, 'p1');
    expect(second).toBe(first);
  });

  it('returns a new reference when its dataset entry changes', () => {
    const key = panelKeys(fixture(), panel())[0];
    const before = panelView(fixture(), 'p1');
    const after = panelView(
      fixture({ datasets: { [key]: ready('v1', distributionResult) } }),
      'p1',
    );
    expect(after).not.toBe(before);
    expect(after?.status).toEqual({ kind: 'ready', stale: false });
  });

  it('is loading while no entry exists', () => {
    expect(panelView(fixture(), 'p1')?.status).toEqual({ kind: 'loading' });
  });

  it('is empty, not loading, for an incomplete correlation set', () => {
    expect(panelView(fixture({ panels: [panel({ form: 'matrix', options: { ...defaultPanelOptions(), family: 'custom', metrics: [] } })] }), 'p1')?.status.kind).toBe(
      'empty',
    );
  });

  it('reports an error entry at the current version', () => {
    const key = panelKeys(fixture(), panel())[0];
    const state = fixture({
      datasets: { [key]: { status: 'error', version: 'v1', error: 'timeout' } },
    });
    // The key comes back with the message, because "Try again" has to know
    // which entry to forget.
    expect(panelView(state, 'p1')?.status).toEqual({
      kind: 'error',
      message: 'timeout',
      retryKeys: [key],
    });
  });

  it('keeps rendering a stale entry while its replacement is in flight', () => {
    const key = panelKeys(fixture(), panel())[0];
    const state = fixture({
      dataVersion: 'v2',
      datasets: { [key]: ready('v1', distributionResult) },
    });
    const view = panelView(state, 'p1');
    expect(view?.status).toEqual({ kind: 'ready', stale: true });
    expect(view?.datasets['population']).toHaveLength(4);
  });

  it('shapes histogram rows for a histogram and ECDF rows for an ECDF', () => {
    const key = panelKeys(fixture(), panel())[0];
    const datasets = { [key]: ready('v1', distributionResult) };
    const bars = panelView(fixture({ datasets }), 'p1');
    expect(bars?.datasets['population'][0]).toEqual({ lo: 0, hi: 0.25, count: 10 });
    resetPanelViewMemo();
    const steps = panelView(fixture({ datasets, panels: [panel({ form: 'ecdf' })] }), 'p1');
    expect(steps?.datasets['population'][0]).toMatchObject({ p: expect.any(Number) });
  });

  it('sends the clip mode to the server, so changing it is a different query', () => {
    const clipped = panel({ options: { ...defaultPanelOptions(), clip: 'p05p95' } });
    const query = panelQueries(fixture(), panel())[0];
    expect(query).toMatchObject({ proc: 'distribution', clip: 'p01p99' });
    expect(panelKeys(fixture(), clipped)[0]).not.toBe(panelKeys(fixture(), panel())[0]);
  });

  it('draws every bin the server sent, because the server clipped them already', () => {
    const wide = {
      ...distributionResult,
      histogram: { lo: 0.25, hi: 0.75, width: 0.05, counts: [1, 2, 3, 4, 5, 5, 4, 3, 2, 1] },
      quantiles: { p01: 0.05, p05: 0.25, p25: 0.3, p50: 0.5, p75: 0.7, p95: 0.75, p99: 0.95 },
    };
    const clipped = panel({ options: { ...defaultPanelOptions(), clip: 'p05p95' } });
    const key = panelKeys(fixture(), clipped)[0];
    const view = panelView(
      fixture({ panels: [clipped], datasets: { [key]: ready('v1', wide) } }),
      'p1',
    );
    expect(view?.datasets['population']).toHaveLength(10);
    expect(view?.datasets['population'][0]).toEqual({ lo: 0.25, hi: 0.3, count: 1 });
  });

  it('still clips an ECDF, whose quantile points are not clipped server-side', () => {
    const wide = {
      ...distributionResult,
      histogram: { lo: 0.25, hi: 0.75, width: 0.25, counts: [1, 2] },
      quantiles: { p01: 0.05, p05: 0.25, p25: 0.3, p50: 0.5, p75: 0.7, p95: 0.75, p99: 0.95 },
    };
    const clipped = panel({ form: 'ecdf', options: { ...defaultPanelOptions(), clip: 'p05p95' } });
    const key = panelKeys(fixture(), clipped)[0];
    const view = panelView(
      fixture({ panels: [clipped], datasets: { [key]: ready('v1', wide) } }),
      'p1',
    );
    const steps = view?.datasets['population'] as readonly { value: number }[];
    expect(steps.every((step) => step.value >= 0.25 && step.value <= 0.75)).toBe(true);
  });

  it('keeps specKey stable across a data-only change', () => {
    const key = panelKeys(fixture(), panel())[0];
    const empty = panelView(fixture(), 'p1')?.specKey;
    const filled = panelView(
      fixture({ datasets: { [key]: ready('v1', distributionResult) } }),
      'p1',
    )?.specKey;
    expect(filled).toBe(empty);
  });

  it('changes specKey when the chart type changes', () => {
    const bars = panelView(fixture(), 'p1')?.specKey;
    const steps = panelView(fixture({ panels: [panel({ form: 'ecdf' })] }), 'p1')?.specKey;
    expect(steps).not.toBe(bars);
  });

  it('changes specKey when a split switches between overlay and facets', () => {
    const grouped = panel({ series: [{ kind: 'field' as const, field: asColumnId('manufacturer') }], form: 'density' });
    const overlay = panelView(fixture({ panels: [grouped] }), 'p1')?.specKey;
    const facets = panelView(
      fixture({
        panels: [
          panel({
            series: [{ kind: 'field' as const, field: asColumnId('manufacturer') }],
            form: 'density',
            options: { ...defaultPanelOptions(), splitPresentation: 'facets' },
          }),
        ],
      }),
      'p1',
    )?.specKey;
    expect(facets).not.toBe(overlay);
  });

  it('changes specKey when box ordering changes', () => {
    const boxes = panel({ series: [{ kind: 'field' as const, field: asColumnId('manufacturer') }], form: 'box' });
    const median = panelView(fixture({ panels: [boxes] }), 'p1')?.specKey;
    const count = panelView(
      fixture({
        panels: [
          panel({
            series: [{ kind: 'field' as const, field: asColumnId('manufacturer') }],
            form: 'box',
            options: { ...defaultPanelOptions(), boxSort: 'n' },
          }),
        ],
      }),
      'p1',
    )?.specKey;
    expect(count).not.toBe(median);
  });

  it('changes specKey when coverage axis options change', () => {
    const coverage = panel({
      y: 'count', aggregate: 'median',
      x: 'created_at',
      form: 'histogram',
      series: [{ kind: 'field' as const, field: asColumnId('manufacturer') }],
    });
    const counts = panelView(fixture({ panels: [coverage] }), 'p1')?.specKey;
    const share = panelView(
      fixture({
        panels: [
          panel({
            y: 'count', aggregate: 'median',
            x: 'created_at',
            form: 'histogram',
            series: [{ kind: 'field' as const, field: asColumnId('manufacturer') }],
            options: { ...defaultPanelOptions(), share: true },
          }),
        ],
      }),
      'p1',
    )?.specKey;
    expect(share).not.toBe(counts);
  });

  it('returns null for a panel that is gone', () => {
    expect(panelView(fixture({ panels: [] }), 'p1')).toBeNull();
  });
});

describe('significant', () => {
  it('rounds to three significant digits', () => {
    expect(significant(0.123456)).toBe('0.123');
    expect(significant(1234)).toBe('1230');
    expect(significant(-0.0098765)).toBe('-0.00988');
  });

  it('falls back to exponent form at the extremes and a dash for no value', () => {
    expect(significant(12345678)).toBe('1.23e+7');
    expect(significant(0.0000123)).toBe('1.23e-5');
    expect(significant(null)).toBe('--');
    expect(significant(Number.NaN)).toBe('--');
  });
});

describe('panel stats', () => {
  const key = () => panelKeys(fixture(), panel())[0];

  it('projects Count totals without inheriting the X metric unit', () => {
    // `spacing_x` is one of the few metrics the catalog gives a unit.
    const inMillimetres = panel({ x: asColumnId('spacing_x') });
    const spacingKey = panelKeys(fixture(), inMillimetres)[0];
    const state = fixture({
      panels: [inMillimetres],
      datasets: { [spacingKey]: ready('v1', distributionResult) },
    });
    const stats = panelView(state, 'p1')?.stats;
    // The fixture is on the raw view, so its rows are uploads.
    expect(stats?.map((s) => s.label)).toEqual([
      'UPLOADS',
    ]);
    // Every abbreviation carries its own sentence; the row itself stays a row.
    expect(stats?.every((stat) => stat.title.length > 0)).toBe(true);
    expect(stats?.[0].title).toBe('Total count in this dashboard.');
    // 300 records is a count, not a measurement, so it carries no unit.
    expect(stats?.[0].value).toBe('300');
    expect(stats).toHaveLength(1);
  });

  it('has no stats until the result arrives, and none for a grouped panel', () => {
    expect(panelView(fixture(), 'p1')?.stats).toBeNull();
    resetPanelViewMemo();
    const grouped = panel({ series: [{ kind: 'field' as const, field: asColumnId('manufacturer') }] });
    expect(panelView(fixture({ panels: [grouped] }), 'p1')?.stats).toBeNull();
  });

  it('names the first stat after the view, so a deduplicated dashboard says SCANS', () => {
    const canonical = { modality: 'bold' as const, view: 'k4plus' as const, filters: [] };
    const key = panelKeys(fixture({ global: canonical }), panel())[0];
    const state = fixture({
      global: canonical,
      datasets: { [key]: ready('v1', distributionResult) },
    });
    expect(panelView(state, 'p1')?.stats?.[0].label).toBe('SCANS');
  });

  it('names the whole corpus, in the view\'s own noun and never in "records"', () => {
    // The count line is the only place the card says what the corpus is, now
    // that the meaning line above it carries no count clause.
    expect(panelView(fixture(), 'p1')?.countLabel).toBe('BOLD uploads with a value');
    resetPanelViewMemo();
    const coverage = panel({
      y: 'count', aggregate: 'median',
      form: 'histogram',
      x: 'created_at',
      series: [{ kind: 'field' as const, field: asColumnId('manufacturer') }],
    });
    expect(panelView(fixture({ panels: [coverage] }), 'p1')?.countLabel).toBe('BOLD uploads');
    resetPanelViewMemo();
    expect(
      panelView(fixture({ global: { modality: 'bold', view: 'k4plus', filters: [] } }), 'p1')
        ?.countLabel,
    ).toBe('deduplicated BOLD scans with a value');
  });
});

describe('urlState', () => {
  it('round-trips through url.ts', () => {
    const state = reduce(fixture(), { t: 'hydrate', url: defaultDashboard() });
    const url = urlState(state);
    expect(encodeUrlState(url)).toBe('');
    const decoded = decodeUrlState(encodeUrlState(url)) ?? defaultDashboard();
    const restored = reduce(initialState, { t: 'hydrate', url: decoded });
    expect(urlState(restored)).toEqual(url);
    expect(restored.layout).toEqual(state.layout);
  });

  it('excludes cursors, so paging does not rewrite the URL', () => {
    const paged = reduce(
      fixture({ panels: [panel({ y: 'count', aggregate: 'median', form: 'table', x: asColumnId('fd_mean') })] }),
      { t: 'requestPage', id: 'p1', cursor: 'page-2' },
    );
    expect(encodeUrlState(urlState(paged))).toBe(
      encodeUrlState(
        urlState(fixture({ panels: [panel({ y: 'count', aggregate: 'median', form: 'table', x: asColumnId('fd_mean') })] })),
      ),
    );
  });
});

describe('chrome', () => {
  it('counts what is still in flight', () => {
    const state = fixture({ catalog: null });
    expect(chrome(state).catalogReady).toBe(false);
    expect(chrome(state).pendingCount).toBe(2);
  });

  it('lists only the views the modality has', () => {
    expect(chrome(fixture()).views.map((v) => v.id)).toEqual(['raw', 'k4plus', 'k4plus_all']);
    expect(
      chrome(fixture({ global: { modality: 'T1w', view: 'raw', filters: [] } })).views.map(
        (v) => v.id,
      ),
    ).toEqual(['raw', 'k3pp', 'k3pp_all']);
  });

  it('drops the task filter outside bold', () => {
    const t1w = chrome(fixture({ global: { modality: 'T1w', view: 'raw', filters: [] } }));
    expect(t1w.filterFields.map((f) => f.field.id)).not.toContain('task_id');
  });

  it('offers every categorical filterable field of the modality and view, split on `secondary`', () => {
    const categorical = fieldsFor('bold', 'raw', 'filter').filter((f) => f.kind === 'categorical');
    const primary = chrome(fixture()).filterFields.map((f) => f.field.id);
    const secondary = chrome(fixture()).secondaryFields.map((f) => f.field.id);
    // Together they are exactly the categorical filterable fields, in catalog
    // order: the split loses nothing and is no hand-written list of ids.
    expect([...primary, ...secondary].sort()).toEqual(categorical.map((f) => f.id).sort());
    expect(primary).toEqual(categorical.filter((f) => f.secondary !== true).map((f) => f.id));
    expect(secondary).toEqual(categorical.filter((f) => f.secondary === true).map((f) => f.id));
    // The long-tail and diagnostic fields are the ones out of the primary row.
    expect(secondary).toEqual(['manufacturer_raw', 'institution_name', 'protocol_name']);
    expect(primary).toContain('manufacturer');
    expect(primary).not.toContain('manufacturer_raw');
  });

  it('puts the everyday fields, and only those, in the primary row of each view', () => {
    expect(chrome(fixture()).filterFields.map((f) => f.field.label)).toEqual([
      'Manufacturer',
      'Scanner model',
      'Magnetic field strength',
      'MRIQC version',
      'Task',
    ]);
    // Motion correction joins them on the canonical view, which is the only
    // one that carries the column.
    expect(
      chrome(
        fixture({ global: { modality: 'bold', view: 'k4plus', filters: [] } }),
      ).filterFields.map((f) => f.field.label),
    ).toEqual([
      'Manufacturer',
      'Scanner model',
      'Magnetic field strength',
      'MRIQC version',
      'Task',
      'Motion correction',
    ]);
  });

  it('offers the canonical HMC mode on the K4+ view and nowhere else', () => {
    const raw = chrome(fixture()).filterFields.map((f) => f.field.id);
    const k4plus = chrome(
      fixture({ global: { modality: 'bold', view: 'k4plus', filters: [] } }),
    ).filterFields.map((f) => f.field.id);
    expect(raw).not.toContain('canonical_hmc_mode');
    expect(k4plus).toContain('canonical_hmc_mode');
  });

  it('never offers a date or numeric field as a multi-select', () => {
    const kinds = new Set(chrome(fixture()).filterFields.map((f) => f.field.kind));
    expect([...kinds]).toEqual(['categorical']);
  });

  it('marks a list past the threshold as searchable', () => {
    const many = Array.from({ length: FILTER_SEARCH_THRESHOLD + 1 }, (_, i) => ({
      value: `v${i}`,
      n: 1,
    }));
    const withValues = {
      ...catalog,
      fieldValues: { manufacturer: { bold: { raw: many } } },
    } as unknown as CompletedCatalog;
    const view = chrome(fixture({ catalog: withValues }));
    const manufacturer = view.filterFields.find((f) => f.field.id === 'manufacturer');
    expect(manufacturer?.searchable).toBe(true);
    // The same derivation runs over the secondary half, which is where the
    // long lists actually live.
    expect(view.secondaryFields.find((f) => f.field.id === 'protocol_name')?.searchable).toBe(
      false,
    );
  });

  it('carries the filters in force, so the bar can show what is selected', () => {
    const filters = [{ field: asColumnId('manufacturer'), op: 'in' as const, values: ['SIEMENS'] }];
    expect(chrome(fixture({ global: { modality: 'bold', view: 'raw', filters } })).filters).toBe(
      filters,
    );
  });

  it('counts failed panels', () => {
    const key = panelKeys(fixture(), panel())[0];
    const state = fixture({
      datasets: { [key]: { status: 'error', version: 'v1', error: 'boom' } },
    });
    expect(chrome(state).errorCount).toBe(1);
  });
});

describe('the default dashboard', () => {
  it('opens five panels: four distributions and one coverage', () => {
    const state = reduce(initialState, { t: 'hydrate', url: defaultDashboard() });
    expect(state.panels).toHaveLength(5);
    expect(state.panels.filter((p) => p.x !== 'created_at')).toHaveLength(4);
    expect(state.panels.at(-1)!.x).toBe('created_at');
    expect(state.panels.map((p) => p.x)).toEqual([
      'fd_mean',
      'tsnr',
      'dvars_std',
      'snr',
      'created_at',
    ]);
  });

  it('needs the catalog plus one query per panel', () => {
    const state = reduce(initialState, { t: 'hydrate', url: defaultDashboard() });
    const keys = needed(state);
    expect(keys.has(CATALOG_KEY)).toBe(true);
    expect(keys.size).toBe(6);
    expect([...keys]).toContain(
      queryKey({
        source: 'population',
        proc: 'distribution',
        modality: 'bold',
        view: 'k4plus',
        filters: [],
        selections: [],
        metric: asColumnId('fd_mean'),
        bins: defaultPanelOptions().bins,
        clip: defaultPanelOptions().clip,
      }),
    );
  });

  it('opens bold on its canonical view, not the raw log', () => {
    const state = reduce(initialState, { t: 'hydrate', url: defaultDashboard() });
    expect(state.global.view).toBe('k4plus');
  });
});

describe('chrome numeric fields', () => {
  it('offers every numeric filterable field of the modality and view', () => {
    const bold = chrome(fixture()).numericFields.map((f) => f.field.id);
    expect(bold).toEqual(
      fieldsFor('bold', 'raw', 'filter')
        .filter((f) => f.kind === 'numeric')
        .map((f) => f.id),
    );
    expect(bold).toEqual(
      expect.arrayContaining(['echo_time', 'repetition_time', 'spacing_x', 'size_x']),
    );
  });

  it('offers the canonical-only numeric fields on the canonical view alone', () => {
    const raw = chrome(fixture()).numericFields.map((f) => f.field.id);
    const k4plus = chrome(
      fixture({ global: { modality: 'bold', view: 'k4plus', filters: [] } }),
    ).numericFields.map((f) => f.field.id);
    expect(raw).not.toContain('canonical_diameter');
    expect(raw).not.toContain('canonical_group_rows');
    expect(k4plus).toContain('canonical_diameter');
    expect(k4plus).toContain('canonical_group_rows');
    const k3pp = chrome(
      fixture({ global: { modality: 'T1w', view: 'k3pp', filters: [] } }),
    ).numericFields.map((f) => f.field.id);
    expect(k3pp).toContain('canonical_diameter');
    expect(k3pp).toContain('canonical_group_rows');
  });

  it('carries the bounds the catalog computed, and null when it has none', () => {
    const withRange = {
      ...catalog,
      numericRange: { echo_time: { bold: { raw: { min: 0.01, max: 0.2 } } } },
    } as unknown as CompletedCatalog;
    const fields = chrome(fixture({ catalog: withRange })).numericFields;
    expect(fields.find((f) => f.field.id === 'echo_time')?.range).toEqual({ min: 0.01, max: 0.2 });
    expect(fields.find((f) => f.field.id === 'size_x')?.range).toBeNull();
  });

  it('carries the quarantine only where the figures leave it out', () => {
    const withQuarantine = {
      ...catalog,
      quarantine: { bold: { groups: 1898, rows: 5663 } },
    } as unknown as CompletedCatalog;
    const on = (view: State['global']['view']): State =>
      fixture({ catalog: withQuarantine, global: { modality: 'bold', view, filters: [] } });
    // The canonical view excludes the quarantined rows, so it says how many.
    expect(chrome(on('k4plus')).quarantine).toEqual({ groups: 1898, rows: 5663 });
    // The raw log is not a policy's output and the `_all` view already holds
    // them, so neither has anything to report.
    expect(chrome(on('raw')).quarantine).toBeNull();
    expect(chrome(on('k4plus_all')).quarantine).toBeNull();
    // A modality the build recorded nothing for.
    expect(
      chrome(
        fixture({
          catalog: withQuarantine,
          global: { modality: 'T1w', view: 'k3pp', filters: [] },
        }),
      ).quarantine,
    ).toBeNull();
  });
});

/* ------------------------------------------------- what the card says it is */

describe('clipChip', () => {
  const fdMean = metricsFor('bold').find((m) => m.id === 'fd_mean') ?? null;

  it('says nothing while the clip is the one the metric opens on', () => {
    // All five default cards are clipped to p01-p99, so printing it on each of
    // them reported only that nobody had changed anything.
    expect(clipChip('p01p99', fdMean, panel())).toBeNull();
  });

  it('names the range once someone has changed it', () => {
    expect(clipChip('p05p95', fdMean, panel())).toBe('p05–p95');
    expect(clipChip('none', fdMean, panel())).toBe('Full range');
  });

  it('says nothing on a panel whose rows the clip does not narrow', () => {
    const coverage = panel({ y: 'count', aggregate: 'median', x: 'created_at', series: [{ kind: 'field' as const, field: asColumnId('manufacturer') }] });
    expect(clipChip('none', null, coverage)).toBeNull();
  });
});

/* ------------------------------------------ the unit noun and the sentence */

describe('unit nouns', () => {
  const viewDef = (modality: Modality, id: View): ViewDef | undefined =>
    viewsFor(modality).find((v) => v.id === id);

  it('calls a raw row an upload and a canonical row a scan', () => {
    expect(unitNoun(viewDef('bold', 'raw'))).toBe('uploads');
    expect(unitNoun(viewDef('bold', 'k4plus'))).toBe('scans');
    expect(unitNoun(viewDef('T1w', 'k3pp'))).toBe('scans');
  });

  it('names both halves of a view that carries the quarantine back in', () => {
    expect(unitNoun(viewDef('bold', 'k4plus_all'))).toBe('scans and unstable uploads');
    expect(unitNoun(viewDef('T1w', 'k3pp_all'))).toBe('scans and unstable uploads');
  });

  it('falls back to uploads when there is no view yet', () => {
    expect(unitNoun(undefined)).toBe('uploads');
  });

  it('writes the whole corpus as a noun phrase, modality included', () => {
    expect(viewNoun('bold', viewDef('bold', 'k4plus'))).toBe('deduplicated BOLD scans');
    expect(viewNoun('bold', viewDef('bold', 'raw'))).toBe('BOLD uploads');
    expect(viewNoun('T1w', viewDef('T1w', 'k3pp'))).toBe('deduplicated T1w scans');
    expect(viewNoun('T2w', viewDef('T2w', 'k3pp_all'))).toBe(
      'deduplicated T2w scans and unstable uploads',
    );
  });

  it('keeps the short form for the places with no room: the axis and the stat row', () => {
    expect(countAxisTitle(viewDef('bold', 'k4plus'))).toBe('Scans');
    expect(countAxisTitle(viewDef('bold', 'k4plus_all'))).toBe('Scans');
    expect(countAxisTitle(viewDef('bold', 'raw'))).toBe('Uploads');
    expect(statUnitLabel(viewDef('bold', 'k4plus'))).toBe('SCANS');
    expect(statUnitLabel(viewDef('bold', 'raw'))).toBe('UPLOADS');
  });
});

describe('metricPhrase', () => {
  it('carries a short description and the unit', () => {
    expect(metricPhrase('Mean framewise displacement', 'Head motion between volumes.', 'mm')).toBe(
      'Mean framewise displacement (head motion between volumes, mm)',
    );
  });

  it('drops a description too long to ride in a sentence', () => {
    const long = 'DVARS-based temporal change metric across successive volumes.';
    expect(metricPhrase('DVARS Standard', long, null)).toBe('DVARS Standard');
  });

  it('omits the parenthesis entirely when there is nothing to put in it', () => {
    expect(metricPhrase('Temporal SNR', null, null)).toBe('Temporal SNR');
  });
});

describe('panelMeaning', () => {
  const base = {
    kind: 'distribution' as const,
    form: 'histogram' as const,
    modality: 'bold' as Modality,
    view: viewsFor('bold').find((v) => v.id === 'k4plus'),
    metricLabel: 'Mean framewise displacement',
    metricDescription: 'Head motion between volumes.',
    metricUnit: 'mm',
    groupLabel: null as string | null,
    granularity: 'month' as const,
  };
  const raw = viewsFor('bold').find((v) => v.id === 'raw');
  const all = viewsFor('bold').find((v) => v.id === 'k4plus_all');

  it('says what a histogram counts, and leaves the count to the count line', () => {
    expect(panelMeaning(base)).toBe(
      'How many scans fall in each range of Mean framewise displacement ' +
        '(head motion between volumes, mm).',
    );
    // The corpus and its size are the line underneath; saying them here too
    // printed 778,075 twice on every card.
    expect(panelMeaning(base)).not.toContain('across');
  });

  it('says what an ECDF reads off', () => {
    expect(panelMeaning({ ...base, form: 'ecdf' })).toContain(
      'Share of scans at or below each value of Mean framewise displacement',
    );
  });

  it('says what a grouped chart compares', () => {
    const grouped = {
      ...base,
      y: 'count', aggregate: 'median',
      form: 'box' as const,
      groupLabel: 'Manufacturer', cohortCount: 2,
    };
    expect(panelMeaning(grouped)).toBe(
      'Spread of Mean framewise displacement (head motion between volumes, mm), across 2 series.',
    );
  });

  it("says what a coverage chart plots, in the view's own noun", () => {
    const coverage = {
      ...base,
      x: 'created_at' as const,
      form: 'histogram' as const,
      metricLabel: null,
      metricDescription: null,
      metricUnit: null,
      groupLabel: 'Manufacturer',
    };
    expect(panelMeaning(coverage)).toBe('Scans uploaded per month.');
    expect(panelMeaning({ ...coverage, view: raw })).toBe(
      'Uploads uploaded per month.',
    );
  });

  it('says what the sample table holds', () => {
    const sample = { ...base, kind: 'sample' as const, form: 'table' as const };
    expect(panelMeaning(sample)).toBe(
      'The individual scans behind these charts, most recent first.',
    );
    expect(panelMeaning({ ...sample, view: raw })).toBe(
      'The individual uploads behind these charts, most recent first.',
    );
    expect(panelMeaning({ ...sample, view: all })).toBe(
      'The individual scans and unstable uploads behind these charts, most recent first.',
    );
  });

  it('names the metric and the cohort count on a comparison panel', () => {
    const comparison = {
      ...base,
      kind: 'comparison' as const,
      form: 'histogram' as const,
      cohortCount: 2,
    };
    expect(panelMeaning(comparison)).toBe(
      'How many scans fall in each range of Mean framewise displacement (head motion between volumes, mm), across 2 series.',
    );
    expect(panelMeaning({ ...comparison, cohortCount: 3 })).toContain('across 3 series');
    // The two states that are not a comparison yet say what is missing rather
    // than stating a comparison of one.
    expect(panelMeaning({ ...comparison, metricLabel: null })).toBe(
      'How many scans fall in each range of values, across 2 series.',
    );
    expect(panelMeaning({ ...comparison, cohortCount: 1 })).not.toContain('across');
  });

  it("names the unit in the view's own noun, and no number anywhere", () => {
    expect(panelMeaning({ ...base, view: raw })).toBe(
      'How many uploads fall in each range of Mean framewise displacement ' +
        '(head motion between volumes, mm).',
    );
    expect(panelMeaning({ ...base, view: all })).toContain(
      'How many scans and unstable uploads fall in each range of',
    );
    for (const view of [base.view, raw, all]) {
      expect(panelMeaning({ ...base, view })).not.toMatch(/\d/);
    }
  });
});

describe('panelNotes', () => {
  const brushed = (over: Partial<State> = {}) =>
    fixture({
      panels: [panel({ id: 'p1' }), panel({ id: 'p2' })],
      selections: [{ from: 'p1', metric: asColumnId('fd_mean'), range: [0.2, 0.6] }],
      ...over,
    });

  it('marks the panel the brush was drawn on', () => {
    const state = brushed();
    expect(panelNotes(state, state.panels[0])).toContain('brush source');
  });

  it('marks every panel the brush is narrowing', () => {
    const state = brushed();
    expect(panelNotes(state, state.panels[1])).toContain('filtered by brush');
  });

  it('says nothing about a brush a panel opted out of', () => {
    const opted = panel({ id: 'p2', options: { ...defaultPanelOptions(), useSelection: false } });
    const state = brushed({ panels: [panel({ id: 'p1' }), opted] });
    expect(panelNotes(state, opted)).not.toContain('filtered by brush');
  });

  it('leaves the clip to its own chip, so an untouched card carries no note', () => {
    const state = fixture();
    expect(panelNotes(state, state.panels[0])).toEqual([]);
    const coverage = panel({ y: 'count', aggregate: 'median', x: 'created_at', series: [{ kind: 'field' as const, field: asColumnId('manufacturer') }] });
    expect(panelNotes(fixture({ panels: [coverage] }), coverage)).toEqual([]);
  });

  it('says only what the brush is doing to this card', () => {
    const state = brushed();
    expect(panelNotes(state, state.panels[1])).toEqual(['filtered by brush']);
  });
});

describe('panelView help and totals', () => {
  it('carries the catalog prose for the metric, with its taxonomy path', () => {
    const help = panelView(fixture(), 'p1')?.metricHelp;
    expect(help?.label).toBe('Mean framewise displacement');
    // The path the card subtitle used to carry, now on demand.
    expect(help?.taxonomy).toBe('Motion / Framewise displacement');
    expect(help?.description).toBeTruthy();
    expect(help?.unit).toBe('mm');
  });

  it('has no help for a panel with no metric', () => {
    const coverage = panel({ y: 'count', aggregate: 'median', x: 'created_at', series: [{ kind: 'field' as const, field: asColumnId('manufacturer') }] });
    expect(panelView(fixture({ panels: [coverage] }), 'p1')?.metricHelp).toBeNull();
  });

  it('gives a sample panel a "showing N of M" subtitle off the coverage total', () => {
    const sample = panel({ id: 'p1', y: 'count', aggregate: 'median', x: asColumnId('fd_mean'), form: 'table' });
    const coverage = panel({
      id: 'p2',
      y: 'count', aggregate: 'median',
      x: 'created_at',
      form: 'histogram',
      series: [{ kind: 'field' as const, field: asColumnId('manufacturer') }],
    });
    const base = fixture({ panels: [sample, coverage] });
    const sampleKey = panelKeys(base, sample)[0];
    const coverageKey = panelKeys(base, coverage)[0];
    const state = fixture({
      panels: [sample, coverage],
      datasets: {
        [sampleKey]: ready('v1', { rows: [{ a: 1 }, { a: 2 }], nextCursor: 'c1' }),
        [coverageKey]: ready('v1', { buckets: [{ start: '2025-01-01', group: 'x', n: 778075 }] }),
      },
    });
    expect(panelView(state, 'p1')?.subtitle).toBe('Showing 2 of 778,075 uploads');
  });

  it('falls back to the rows it has when nothing on the board knows the total', () => {
    const sample = panel({ id: 'p1', y: 'count', aggregate: 'median', x: asColumnId('fd_mean'), form: 'table' });
    const base = fixture({ panels: [sample] });
    const key = panelKeys(base, sample)[0];
    const state = fixture({
      panels: [sample],
      datasets: { [key]: ready('v1', { rows: [{ a: 1 }], nextCursor: null }) },
    });
    expect(panelView(state, 'p1')?.subtitle).toBe('Showing 1 of 1 uploads');
  });
});

describe('chrome, the brushed range and a failed catalogue', () => {
  it('has no chip while nothing is selected', () => {
    expect(chrome(fixture()).brushes).toEqual([]);
  });

  it('prints the brush the way the stat row prints a figure', () => {
    const state = fixture({
      selections: [{ from: 'p1', metric: asColumnId('fd_mean'), range: [0.38123, 1.2801] }],
    });
    expect(chrome(state).brushes[0]).toEqual({
      from: 'p1',
      metric: 'fd_mean',
      // The chip is chip-sized, so it wears the metric's short name.
      label: 'FD mean',
      lo: '0.381',
      hi: '1.28',
    });
  });

  it('reports a failed catalogue instead of pretending it is still loading', () => {
    const failed = fixture({
      catalog: null,
      panels: [],
      datasets: { [CATALOG_KEY]: { status: 'error', version: 'v1', error: 'fetch failed' } },
    });
    const view = chrome(failed);
    expect(view.catalogReady).toBe(false);
    expect(view.catalogError).toBe('fetch failed');
    // And it is no longer counted as work in flight, which is what pinned the
    // status line on "Loading the metric catalogue".
    expect(view.pendingCount).toBe(0);
  });

  it('has no catalogue error once one arrived', () => {
    expect(chrome(fixture()).catalogError).toBeNull();
  });
});

/* ------------------------------------------------------------- comparison */

/** A distribution result over `[lo, hi]`, with the quantiles a clip reads. */
function dist(
  overrides: {
    n?: number;
    p01?: number;
    p99?: number;
    p50?: number;
    min?: number;
    max?: number;
    counts?: readonly number[];
    lo?: number;
    hi?: number;
  } = {},
) {
  const counts = overrides.counts ?? [1, 2, 1];
  const lo = overrides.lo ?? 0;
  const hi = overrides.hi ?? 10;
  return {
    n: overrides.n ?? counts.reduce((a, b) => a + b, 0),
    min: overrides.min ?? -5,
    max: overrides.max ?? 15,
    mean: 5,
    stddev: 1,
    quantiles: {
      p01: overrides.p01 ?? 0,
      p05: 1,
      p25: 2,
      p50: overrides.p50 ?? 5,
      p75: 6,
      p95: 9,
      p99: overrides.p99 ?? 10,
    },
    histogram: { lo, hi, width: (hi - lo) / counts.length, counts },
  };
}

function cohort(id: string, name: string, overrides: Partial<Cohort> = {}): Cohort {
  return {
    id,
    name,
    color: 2,
    source: 'population',
    view: 'raw',
    filters: [],
    selections: [],
    ...overrides,
  };
}

/** A two-cohort comparison panel over `fd_mean`. */
function comparisonPanel(cohorts: readonly string[] = ['current', 'all']): Panel {
  return panel({ y: 'count', aggregate: 'median', form: 'histogram', series: cohorts.filter(id => id !== 'current').map(id => id === 'all' ? { kind: 'population' as const } : id === 'study' ? { kind: 'study' as const } : { kind: 'cohort' as const, id }) });
}

/** A state whose datasets answer every key the panel asks for, with `make`. */
function answered(state: State, make: (key: string, i: number) => unknown): State {
  const datasets: Record<string, DatasetEntry> = { ...state.datasets };
  const keys = panelKeys(state, state.panels[0]);
  keys.forEach((key, i) => {
    datasets[key] = { status: 'ready', version: 'v1', result: make(key, i) };
  });
  return { ...state, datasets };
}

describe('derived cohorts', () => {
  it('builds `current` from the top bar, brush included', () => {
    const state = fixture({
      global: {
        modality: 'bold',
        view: 'k4plus',
        filters: [{ field: asColumnId('manufacturer'), op: 'in', values: ['SIEMENS'] }],
      },
      selections: [{ from: 'p9', metric: asColumnId('fd_mean'), range: [0.1, 0.9] }],
    });
    expect(currentCohort(state)).toEqual({
      id: 'current',
      name: CURRENT_COHORT_NAME,
      color: 0,
      source: 'population',
      view: 'k4plus',
      filters: state.global.filters,
      selections: [{ metric: 'fd_mean', range: [0.1, 0.9] }],
    });
  });

  it('builds `all` as this view with nothing applied', () => {
    const state = fixture({
      global: {
        modality: 'bold',
        view: 'k4plus',
        filters: [{ field: asColumnId('manufacturer'), op: 'in', values: ['SIEMENS'] }],
      },
      selections: [{ from: 'p9', metric: asColumnId('fd_mean'), range: [0.1, 0.9] }],
    });
    expect(allCohort(state)).toMatchObject({
      id: 'all',
      name: ALL_COHORT_NAME,
      color: 1,
      view: 'k4plus',
      filters: [],
      selections: [],
    });
  });

  it('lists the derived cohorts first, then the user\u2019s, and never stores them', () => {
    const state = fixture({ cohorts: [cohort('c1', 'Philips')] });
    expect(cohortsOf(state).map((c) => c.id)).toEqual(['current', 'all', 'c1']);
    // Derived, so they cannot drift from the top bar: they are not in state.
    expect(state.cohorts.map((c) => c.id)).toEqual(['c1']);
    expect(cohortById(state, 'current')?.name).toBe(CURRENT_COHORT_NAME);
    expect(cohortById(state, 'nope')).toBeNull();
  });

  it('marks only the user\u2019s cohorts editable in the chip list', () => {
    const list = cohortList(fixture({ cohorts: [cohort('c1', 'Philips')] }));
    expect(list.map((entry) => entry.editable)).toEqual([false, false, true]);
    // Colour is read off the palette index and is stable per cohort.
    expect(list[0].color).toBe('#0072b2');
    expect(list[1].color).toBe('#009e73');
  });

  it('does not let a comparison panel be filtered by the brush it drew', () => {
    const state = fixture({
      panels: [comparisonPanel()],
      selections: [{ from: 'p1', metric: asColumnId('fd_mean'), range: [0.1, 0.9] }],
    });
    const [current] = panelCohorts(state, state.panels[0]);
    // `current` carries the dashboard's brush -- but not on the card that drew
    // it, which would otherwise collapse to the interval it is displaying.
    expect(current.selections).toEqual([]);
  });

  it('applies the brush to `current` on a panel that did not draw it', () => {
    const state = fixture({
      panels: [comparisonPanel()],
      selections: [{ from: 'p9', metric: asColumnId('fd_mean'), range: [0.1, 0.9] }],
    });
    const [current, all] = panelCohorts(state, state.panels[0]);
    expect(current.selections).toEqual([{ metric: 'fd_mean', range: [0.1, 0.9] }]);
    // "Whole population" is the view with nothing applied, brush included, or
    // it would not be the thing the other cohort is being compared against.
    expect(all.selections).toEqual([]);
  });

  it('leaves a user cohort\u2019s own range alone, whatever the brush is doing', () => {
    const mine = cohort('c1', 'Philips', {
      selections: [{ metric: asColumnId('tsnr'), range: [10, 20] }],
    });
    const state = fixture({
      cohorts: [mine],
      panels: [comparisonPanel(['current', 'c1'])],
      selections: [{ from: 'p9', metric: asColumnId('fd_mean'), range: [0.1, 0.9] }],
    });
    // A cohort is a fixed reference by construction, which is what makes "this
    // brushed subset against that cohort" a comparison and not two moving halves.
    expect(panelCohorts(state, state.panels[0])[1].selections).toEqual([{
      metric: 'tsnr',
      range: [10, 20],
    }]);
  });
});

describe('the shared range', () => {
  it('takes the clip quantiles per cohort, and min/max when the clip is none', () => {
    expect(cohortRange(dist({ p01: 2, p99: 8 }), 'p01p99')).toEqual([2, 8]);
    expect(cohortRange(dist(), 'p05p95')).toEqual([1, 9]);
    expect(cohortRange(dist({ min: -3, max: 12 }), 'none')).toEqual([-3, 12]);
  });

  it('falls back to min and max when the clip range is a single point', () => {
    // A metric whose p01 and p99 coincide is a near-constant column. Refusing
    // a range would drop that cohort out of the union and the panel would bin
    // over the other cohort's range alone; the full extent is usable and is
    // what `clip: none` would have asked for anyway.
    expect(cohortRange(dist({ p01: 5, p99: 5, min: -5, max: 15 }), 'p01p99')).toEqual([-5, 15]);
  });

  it('reports a cohort that matched nothing as `empty`, not as unknown', () => {
    // The two have to be told apart: `null` is "the result has not arrived" and
    // postpones the range; `'empty'` is "the result is here and names no
    // interval" and is skipped, so the other cohorts can still be drawn.
    const empty = { ...dist(), quantiles: null, min: null, max: null };
    expect(cohortRange(empty, 'p01p99')).toBe('empty');
    // Nor one whose whole extent is a point: there is no grid to bin over.
    expect(cohortRange({ ...dist(), quantiles: null, min: 3, max: 3 }, 'none')).toBe('empty');
  });

  it('skips an empty cohort instead of collapsing the union', () => {
    // One cohort matching nothing used to blank every cohort's bars for good,
    // over a card that then claimed "No records match these filters."
    expect(sharedRange([[0, 6], 'empty'])).toEqual([0, 6]);
    expect(sharedRange(['empty', 'empty'])).toBeNull();
  });

  it('is the union, so no cohort\u2019s bulk is cut off the shared grid', () => {
    // The intersection would be [2, 6] and would hide exactly the difference an
    // overlay exists to show: which cohort reaches further.
    expect(
      sharedRange([
        [0, 6],
        [2, 11],
      ]),
    ).toEqual([0, 11]);
  });

  it('is null while any cohort is still missing', () => {
    // A range from half the cohorts would change the moment the other half
    // landed, which is a full refetch of every histogram.
    expect(sharedRange([[0, 6], null])).toBeNull();
    expect(sharedRange([])).toBeNull();
  });
});

describe('the two-step fetch', () => {
  const siemens = cohort('c1', 'Siemens', {
    filters: [{ field: asColumnId('manufacturer'), op: 'in', values: ['SIEMENS'] }],
  });

  function twoCohortState(): State {
    return fixture({ cohorts: [siemens], panels: [comparisonPanel(['current', 'c1'])] });
  }

  it('asks for the two cohorts\u2019 own distributions first and nothing else', () => {
    const state = twoCohortState();
    const queries = panelQueries(state, state.panels[0]);
    expect(queries).toHaveLength(2);
    expect(queries.map((q) => (q as { range?: unknown }).range)).toEqual([undefined, undefined]);
    expect(
      panelSharedRange(state, state.panels[0], panelCohorts(state, state.panels[0])),
    ).toBeNull();
  });

  it('adds one ranged key per cohort once step one is complete', () => {
    const state = answered(twoCohortState(), (_key, i) =>
      i === 0 ? dist({ p01: 0, p99: 6 }) : dist({ p01: 2, p99: 11 }),
    );
    const queries = panelQueries(state, state.panels[0]);
    expect(queries).toHaveLength(4);
    // The first two are unchanged, so their entries stay referenced and the
    // statistics do not blink while the bars refetch.
    expect(queries.slice(0, 2).map((q) => (q as { range?: unknown }).range)).toEqual([
      undefined,
      undefined,
    ]);
    // Both halves of step two ask for the *same* range, which is the whole
    // point: shared bin edges.
    expect(queries.slice(2).map((q) => (q as { range?: number[] }).range)).toEqual([
      [0, 11],
      [0, 11],
    ]);
  });

  it('puts the range in the key, so a moved quantile refetches the bars', () => {
    const first = answered(twoCohortState(), (_k, i) =>
      i === 0 ? dist({ p01: 0, p99: 6 }) : dist({ p01: 2, p99: 11 }),
    );
    const widened = answered(twoCohortState(), (_k, i) =>
      i === 0 ? dist({ p01: 0, p99: 6 }) : dist({ p01: 2, p99: 20 }),
    );
    const rangedKey = (state: State) => panelKeys(state, state.panels[0])[2];
    expect(rangedKey(first)).toContain('range=0..11');
    expect(rangedKey(widened)).toContain('range=0..20');
    expect(rangedKey(first)).not.toBe(rangedKey(widened));
  });

  it('renders the statistics from step one and the bars only after step two', () => {
    resetPanelViewMemo();
    const stepOne = answered(twoCohortState(), (_k, i) =>
      i === 0 ? dist({ n: 400, p01: 0, p99: 6 }) : dist({ n: 90, p01: 2, p99: 11 }),
    );
    const view = panelView(stepOne, 'p1');
    // Not "loading": a spinner over a complete statistics table and a real
    // ECDF would be a lie about what is on screen.
    expect(view?.status.kind).toBe('ready');
    expect(view?.partial).toBe(true);
    expect(view?.analysisRows).toHaveLength(2);
    expect(view?.cohorts?.map((c) => c.n)).toEqual([400, 90]);
    // No bars yet: the shared-range histograms have not landed.
    expect(view?.datasets['cohorts']).toEqual([]);
  });

  it('draws the bars, share-normalized over the shared grid, once they land', () => {
    resetPanelViewMemo();
    const stepOne = answered(twoCohortState(), (_k, i) =>
      i === 0 ? dist({ p01: 0, p99: 6 }) : dist({ p01: 2, p99: 11 }),
    );
    const both = answered(stepOne, (key, i) =>
      key.includes('range=')
        ? dist({ counts: [1, 3], lo: 0, hi: 11, n: 4 })
        : i === 0
          ? dist({ p01: 0, p99: 6 })
          : dist({ p01: 2, p99: 11 }),
    );
    // The step histogram, so the assertion is about bins rather than about a
    // smoothed curve; density is the kind's default chart.
    const view = panelView({ ...both, panels: [{ ...both.panels[0], form: 'histogram' }] }, 'p1');
    expect(view?.partial).toBe(false);
    const rows = view?.datasets['cohorts'] as readonly { share: number; cohort: string }[];
    // Two cohorts x (two bins + the closing point that draws the last bin full
    // width and shuts the area against the baseline).
    expect(rows).toHaveLength(6);
    expect(rows.map((row) => row.share)).toEqual([0.25, 0.75, 0.75, 0.25, 0.75, 0.75]);
    // Keyed by id, because two cohorts can share a name.
    expect(new Set(rows.map((row) => row.cohort))).toEqual(new Set(['current', 'c1']));
  });
});

describe('comparisonStats', () => {
  function results(
    cohorts: readonly Cohort[],
    base: readonly (ReturnType<typeof dist> | null)[],
    ranged: readonly (ReturnType<typeof dist> | null)[] = cohorts.map(() => null),
  ) {
    return cohorts.map((c, i) => ({
      id: c.id,
      name: c.name,
      base: base[i],
      ranged: ranged[i],
    }));
  }

  function table(
    cohorts: readonly Cohort[],
    base: readonly (ReturnType<typeof dist> | null)[],
    ranged?: readonly (ReturnType<typeof dist> | null)[],
    panelOverrides: Partial<Panel> = {},
  ) {
    const panel = { ...comparisonPanel(cohorts.map((c) => c.id)), ...panelOverrides };
    return comparisonStats(fixture(), panel, cohorts, results(cohorts, base, ranged));
  }

  const two = [cohort('c1', 'Siemens'), { ...cohort('c2', 'Philips'), color: 3 }];

  it('is one row per cohort, in its own colour, with the metric unit', () => {
    const stats = table(two, [dist({ n: 1234 }), dist({ n: 56 })]);
    expect(stats?.headers).toEqual([
      'Series',
      'n',
      'Median',
      'IQR',
      'p05–p95',
      'Δmedian/IQR',
      'KS',
    ]);
    expect(stats?.rows.map((row) => row.name)).toEqual(['Siemens', 'Philips']);
    expect(stats?.rows.map((row) => row.color)).toEqual(['#56b4e9', '#d55e00']);
    // `fd_mean` carries `unit: 'mm'`, so every amount in the row does.
    expect(stats?.rows[0].cells[0]).toBe('1,234');
    expect(stats?.rows[0].cells[1]).toBe('5 mm');
  });

  it('uses the compact n header for series counts', () => {
    expect(table(two, [dist(), dist()])?.headers[1]).toBe('n');
  });

  it('shows dashes for a cohort whose result has not arrived', () => {
    const stats = table(two, [dist(), null]);
    expect(stats?.rows[1].cells).toEqual(['--', '--', '--', '--', '--', '--']);
  });

  it('anchors the differences on the first cohort by default', () => {
    const stats = table(two, [dist({ p50: 5 }), dist({ p50: 7 })]);
    expect(stats?.differences).toBeNull();
    expect(stats?.rows.map((row) => row.id)).toEqual(['c1', 'c2']);
    expect(stats?.rows[0].cells.slice(4)).toEqual(['--', '--']);
    expect(stats?.rows[1].cells[4]).toBe('+50%');
  });

  it('keeps the first row as the compact table reference', () => {
    const stats = table(two, [dist({ p50: 5 }), dist({ p50: 7 })], undefined, {
      reference: 'c2',
    });
    expect(stats?.differences).toBeNull();
    expect(stats?.rows.map((row) => row.id)).toEqual(['c1', 'c2']);
    expect(stats?.rows.map(row => row.cells[4])).toEqual(['--', '+50%']);
  });

  it('keeps differences in each series row past two', () => {
    const three = [...two, { ...cohort('c3', 'GE'), color: 4 }];
    const stats = table(three, [dist({ p50: 5 }), dist({ p50: 7 }), dist({ p50: 9 })]);
    expect(stats?.rows).toHaveLength(3);
    expect(stats?.rows.map(row => row.cells[4])).toEqual(['--', '+50%', '+100%']);
  });

  it('signs the shifts and scales the median shift by the reference\u2019s IQR', () => {
    // Reference median 5, IQR 6 - 2 = 4.  Other median 7. Shift +2 mm, which is
    // +50% of the reference's IQR. Both means are 5, so the mean shift is 0.
    const stats = table(two, [dist({ p50: 5 }), dist({ p50: 7 })]);
    expect(stats?.rows.map(row => row.cells[1])).toEqual(['5 mm', '7 mm']);
    expect(stats?.rows[1].cells.slice(2, 5)).toEqual(['2 mm–6 mm', '1 mm–9 mm', '+50%']);
    expect(table(two, [dist({ p50: 7 }), dist({ p50: 5 })])?.rows[1].cells[4]).toBe('−50%');
    // The KS cell waits for the shared-range histograms.
    expect(stats?.rows[1].cells[5]).toBe('--');
  });

  it('marks the KS figure as approximate in the value, not only in a tooltip', () => {
    const stats = table(
      two,
      [dist(), dist()],
      [dist({ counts: [2, 2], n: 4 }), dist({ counts: [1, 3], n: 4 })],
    );
    const ks = stats?.rows[1].cells[5];
    // Curves 0, 0.5, 1 against 0, 0.25, 1: the largest gap is 0.25. A bare
    // "0.25" would read as exact, and the supremum can fall inside a bin.
    expect(ks).toBe('\u2248 0.25');
    expect(stats?.rows[0].cells[5]).toBe('--');
  });

  it('offers every pair, with the largest marked, for the all-pairs table', () => {
    const three = [...two, { ...cohort('c3', 'GE'), color: 4 }];
    const stats = table(
      three,
      [dist(), dist(), dist()],
      [
        dist({ counts: [4, 0], n: 4 }),
        dist({ counts: [2, 2], n: 4 }),
        dist({ counts: [0, 4], n: 4 }),
      ],
    );
    // Three cohorts, three unordered pairs.
    expect(stats?.pairs).toHaveLength(3);
    // Siemens (all low) against GE (all high) do not overlap at all, so theirs
    // is the largest distance and the one the table emphasises.
    const worst = stats?.pairs?.find((pair) => pair.worst);
    expect([worst?.aName, worst?.bName]).toEqual(['Siemens', 'GE']);
    expect(worst?.value).toBe('\u2248 1');
  });
});

describe('split groups as cohorts', () => {
  const split = (overrides = {}) =>
    fixture({
      global: { modality: 'bold', view: 'k4plus', filters: [] },
      panels: [panel({ series: [{ kind: 'field' as const, field: asColumnId('manufacturer') }], ...overrides })],
      catalog: {
        ...catalog,
        fieldValues: {
          manufacturer: {
            bold: {
              k4plus: [
                { value: 'Siemens', n: 9 },
                { value: 'GE', n: 4 },
              ],
            },
          },
        },
      } as unknown as CompletedCatalog,
    });

  it('offers one cohort per group of the split field, in the catalog colour order', () => {
    resetPanelViewMemo();
    const view = panelView(split(), 'p1');
    expect(view?.cohorts?.map(entry=>entry.name)).toEqual([
      'Siemens',
      'GE',
    ]);
    // The hue each group had on the chart it was selected from.
    expect(view?.cohorts?.map(entry=>entry.color)).toEqual(['#0072b2', '#009e73']);
    // Derived from the id, so there is nothing to edit and nothing to delete.
    expect(view?.cohorts?.every(entry=>!entry.editable)).toBe(true);
  });

  it('compiles a group cohort to this dashboard plus one value', () => {
    const state = split();
    const id = view0(state);
    const cohort = cohortById(state, id);
    expect(cohort?.filters).toEqual([{ field: 'manufacturer', op: 'in', values: ['Siemens'] }]);
    expect(cohort?.view).toBe('k4plus');
  });

  it('uses the dark chart colours for split chips and changes the spec key', () => {
    const state = split();
    const light = panelView(state, 'p1');
    const dark = panelView(state, 'p1', DARK_THEME);
    expect(dark?.cohorts?.map(entry=>entry.color)).toEqual([
      DARK_THEME.categories[0], DARK_THEME.categories[1],
    ]);
    expect(dark?.specKey).not.toBe(light?.specKey);
  });

  it('offers none on a panel no comparison could be made from', () => {
    resetPanelViewMemo();
    // A coverage panel is split by manufacturer as often as a grouped one and
    // has no metric, so 'Compare selected' there is a control that can do
    // nothing: the reducer refuses it, silently.
    const coverage = panelView(
      split({ y: 'count', aggregate: 'median', x: 'created_at', form: 'histogram' }),
      'p1',
    );
    expect(coverage?.splitCohorts).toEqual([]);
    resetPanelViewMemo();
    const unsplit = panelView(fixture(), 'p1');
    expect(unsplit?.splitCohorts).toEqual([]);
  });
});

/** The first split cohort id of a state, for the assertions above. */
function view0(state: State): string {
  resetPanelViewMemo();
  return panelView(state, 'p1')?.cohorts?.[0]?.id ?? '';
}
