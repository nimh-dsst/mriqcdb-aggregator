import {
  asColumnId,
  type FieldDef,
  type FieldValueCount,
  type Filter,
  type ViewDef,
} from '@mriqc/shared';
import {
  FILTER_SEARCH_THRESHOLD,
  type FilterFieldView,
  type NumericFieldView,
} from '../view/chrome-view';
import {
  activeFilterCount,
  busyLine,
  moreFilterCount,
  moreFiltersExpanded,
  studyMetricSummary,
  viewHelp,
} from './top-bar';
// The long-list narrowing moved with the control it belongs to: the categorical
// select is a component now, because the cohort editor needs the same one.
import { visibleFilterValues } from './filter-select';

function values(count: number, prefix = 'site'): FieldValueCount[] {
  return Array.from({ length: count }, (_, i) => ({ value: `${prefix}-${i}`, n: count - i }));
}

describe('visibleFilterValues', () => {
  it('leaves a short list alone, references and all', () => {
    const short = values(FILTER_SEARCH_THRESHOLD);
    expect(visibleFilterValues(short, [], '')).toBe(short);
  });

  it('caps a long list so a 200-value field is not 200 options', () => {
    expect(visibleFilterValues(values(200), [], '')).toHaveLength(FILTER_SEARCH_THRESHOLD);
  });

  it('narrows a long list to what the search matches', () => {
    const shown = visibleFilterValues(values(200), [], 'site-19');
    // site-19 and site-190..199.
    expect(shown.map((v) => v.value)).toContain('site-19');
    expect(shown).toHaveLength(11);
  });

  it('keeps a selected value visible even when the search hides it', () => {
    const shown = visibleFilterValues(values(200), ['site-199'], 'site-3');
    expect(shown.map((v) => v.value)).toContain('site-199');
  });

  it('does not show a selected value twice', () => {
    const shown = visibleFilterValues(values(200), ['site-0'], '');
    expect(shown.filter((v) => v.value === 'site-0')).toHaveLength(1);
  });

  it('matches on the label, so the "Not reported" bucket is findable', () => {
    const withNone: FieldValueCount[] = [{ value: null, n: 5 }, ...values(200)];
    expect(visibleFilterValues(withNone, [], 'not reported').map((v) => v.value)).toEqual([null]);
  });
});

/** A numeric field view, as the chrome projection hands them to the top bar. */
function numeric(id: string): NumericFieldView {
  const field = {
    id: asColumnId(id),
    label: id,
    kind: 'numeric',
    modalities: ['T1w'],
    filterable: true,
    groupable: true,
    exportable: true,
  } as FieldDef;
  return { field, range: { min: 0, max: 1 } };
}

const NUMERIC_FIELDS = [numeric('canonical_diameter'), numeric('echo_time')];

/** A long-tail categorical field view, as the chrome projection hands them over. */
function secondary(id: string): FilterFieldView {
  const field = {
    id: asColumnId(id),
    label: id,
    kind: 'categorical',
    modalities: ['bold'],
    filterable: true,
    groupable: true,
    exportable: true,
    secondary: true,
  } as FieldDef;
  return { field, values: [], searchable: false };
}

const SECONDARY_FIELDS = [secondary('institution_name'), secondary('protocol_name')];

const between = (field: string): Filter => ({
  field: asColumnId(field),
  op: 'between',
  lo: 0,
  hi: 1,
});

describe('moreFilterCount', () => {
  it('counts nothing when nothing is filtered', () => {
    expect(moreFilterCount([], NUMERIC_FIELDS)).toBe(0);
  });

  it('counts the numeric ranges of the current view and the date range', () => {
    const filters = [between('canonical_diameter'), between('created_at')];
    expect(moreFilterCount(filters, NUMERIC_FIELDS)).toBe(2);
  });

  it('ignores the filters the primary row owns', () => {
    const filters: Filter[] = [
      { field: asColumnId('manufacturer'), op: 'in', values: ['Siemens'] },
      between('echo_time'),
    ];
    expect(moreFilterCount(filters, NUMERIC_FIELDS)).toBe(1);
  });

  it('ignores a range on a field this view does not render', () => {
    // `spacing_tr` is bold-only; a link from a bold dashboard can carry it.
    expect(moreFilterCount([between('spacing_tr')], NUMERIC_FIELDS)).toBe(0);
  });

  it('counts the long-tail selects that moved into the section', () => {
    const filters: Filter[] = [
      { field: asColumnId('institution_name'), op: 'in', values: ['NIH'] },
      { field: asColumnId('manufacturer'), op: 'in', values: ['Siemens'] },
    ];
    // Institution is down here now and Manufacturer is not, so the badge is 1:
    // a dashboard filtered by a hidden control must say so.
    expect(moreFilterCount(filters, NUMERIC_FIELDS, SECONDARY_FIELDS)).toBe(1);
  });
});

describe('activeFilterCount', () => {
  it('counts nothing on an unfiltered dashboard', () => {
    expect(activeFilterCount([], false)).toBe(0);
  });

  it('counts the brush, which narrows the page like any other filter', () => {
    expect(activeFilterCount([], true)).toBe(1);
    expect(activeFilterCount([between('echo_time')], true)).toBe(2);
  });
});

describe('moreFiltersExpanded', () => {
  it('starts collapsed', () => {
    expect(moreFiltersExpanded(null, 0)).toBe(false);
  });

  it('auto-expands when one of its filters is in force', () => {
    expect(moreFiltersExpanded(null, 1)).toBe(true);
  });

  it('lets an explicit choice win either way', () => {
    expect(moreFiltersExpanded(false, 3)).toBe(false);
    expect(moreFiltersExpanded(true, 0)).toBe(true);
  });
});

describe('busyLine', () => {
  const line = (over: Partial<Parameters<typeof busyLine>[0] & object>) =>
    busyLine({
      catalogReady: true,
      catalogError: null,
      errorCount: 0,
      pendingCount: 0,
      ...over,
    });

  it('says nothing once everything has arrived, so the date can have the line', () => {
    expect(line({})).toBeNull();
  });

  it('reports a catalogue still on its way', () => {
    expect(line({ catalogReady: false })).toBe('Loading the metric catalogue');
  });

  it('stops claiming to load a catalogue that failed', () => {
    // The whole of finding #1: this line used to read "Loading the metric
    // catalogue" for the rest of the session with nothing loading.
    expect(line({ catalogReady: false, catalogError: 'fetch failed' })).toBe(
      "Couldn't load the metric catalogue",
    );
  });

  it('counts failures before pending work', () => {
    expect(line({ errorCount: 2, pendingCount: 3 })).toBe('2 panels could not load');
    expect(line({ pendingCount: 1 })).toBe('Loading 1 panel');
  });
});

describe('viewHelp', () => {
  const view = (over: Partial<ViewDef>): ViewDef =>
    ({ id: 'raw', label: 'x', modalities: ['bold'], ...over }) as ViewDef;

  it('says what the raw log is', () => {
    expect(viewHelp(view({ id: 'raw' }))).toBe('Every upload as received');
  });

  it('says what a policy view did, naming the policy', () => {
    expect(viewHelp(view({ id: 'k4plus', policy: 'K4+' }))).toBe(
      'One record per scan; repeated uploads of the same file merged (K4+)',
    );
    expect(viewHelp(view({ id: 'k3pp', policy: 'K3++' }))).toContain('(K3++)');
  });

  it('says what the "+ unstable" view adds back', () => {
    expect(viewHelp(view({ id: 'k4plus_all', policy: 'K4+', includesQuarantined: true }))).toBe(
      'One record per scan; repeated uploads of the same file merged (K4+), ' +
        'plus the raw uploads of groups the policy refused',
    );
  });

  it('says nothing for a view the catalog does not have', () => {
    expect(viewHelp(undefined)).toBe('');
  });
});

describe('studyMetricSummary', () => {
  it('reports matched metrics against the full dashboard catalogue', () => {
    expect(studyMetricSummary({ metrics: ['cjv', 'cnr', 'efc'], totalMetrics: 17 })).toBe(
      '3 of 17 metrics',
    );
  });
});
