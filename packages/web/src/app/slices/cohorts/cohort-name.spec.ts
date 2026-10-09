/**
 * The auto-generated cohort name, against the filter combinations a reader
 * actually assembles. Every expectation is the whole string: a name is read as
 * a whole, and a test that only checked it "contains Siemens" would not notice
 * the parts arriving in the wrong order.
 */

import { asColumnId, type Filter, type Selection } from '@mriqc/shared';
import { UNFILTERED_SUMMARY, cohortAutoName, uniqueCohortName, yearsOf } from './name';

const siemens: Filter = {
  field: asColumnId('manufacturer'),
  op: 'in',
  values: ['Siemens'],
};

const dates = (lo: string, hi: string): Filter => ({
  field: asColumnId('created_at'),
  op: 'between',
  lo,
  hi,
});

describe('yearsOf', () => {
  it('is one year for a span inside it, and two for a span across', () => {
    expect(yearsOf('2019-01-01T00:00:00Z', '2019-12-31T00:00:00Z')).toBe('2019');
    expect(yearsOf('2019-01-01T00:00:00Z', '2021-06-30T00:00:00Z')).toBe('2019–2021');
  });

  it('is nothing at all for a bound that is not a date', () => {
    expect(yearsOf('not a date', '2019-01-01T00:00:00Z')).toBeNull();
  });
});

describe('cohortAutoName', () => {
  it('names the modality and the view, and says so when nothing is filtered', () => {
    // A name with no distinguishing part would be indistinguishable from the
    // next one, so the absence of filters is itself stated.
    expect(cohortAutoName('bold', 'k4plus', [], [])).toBe(`K4+ · ${UNFILTERED_SUMMARY}`);
    expect(cohortAutoName('T1w', 'raw', [], [])).toBe(`raw · all`);
    expect(cohortAutoName('T2w', 'k3pp_all', [], [])).toBe('K3++ +unstable · all');
  });

  it('writes a categorical filter as its value, with no column name', () => {
    // "Siemens" is obviously a manufacturer; naming the column would be noise.
    expect(cohortAutoName('bold', 'k4plus', [siemens], [])).toBe('K4+ · Siemens');
  });

  it('lists a few values and counts many', () => {
    const three: Filter = {
      field: asColumnId('manufacturer'),
      op: 'in',
      values: ['Siemens', 'GE', 'Philips'],
    };
    expect(cohortAutoName('bold', 'k4plus', [three], [])).toBe('K4+ · Siemens, GE, Philips');
    const many: Filter = {
      field: asColumnId('manufacturer'),
      op: 'in',
      values: ['Siemens', 'GE', 'Philips', 'Canon'],
    };
    // Past three, the count is the honest summary: a chip cannot hold nine
    // manufacturers, and a truncated list reads as the whole one.
    expect(cohortAutoName('bold', 'k4plus', [many], [])).toBe('K4+ · 4 Manufacturer');
  });

  it('names the column when the value alone says nothing', () => {
    // A bare number is not a fact about anything until its column is named.
    const uploads: Filter = {
      field: asColumnId('canonical_group_rows'),
      op: 'in',
      values: [1],
    };
    expect(cohortAutoName('bold', 'k4plus', [uploads], [])).toBe('K4+ · Times uploaded: 1');
  });

  it('writes the date range as years, not as two instants', () => {
    expect(
      cohortAutoName(
        'bold',
        'k4plus',
        [dates('2019-01-01T00:00:00Z', '2019-12-31T00:00:00Z')],
        [],
      ),
    ).toBe('K4+ · 2019');
    expect(
      cohortAutoName(
        'bold',
        'k4plus',
        [dates('2019-01-01T00:00:00Z', '2021-01-01T00:00:00Z')],
        [],
      ),
    ).toBe('K4+ · 2019–2021');
  });

  it('puts the brush last, in the metric’s short name and two significant figures', () => {
    const brush: Selection = { metric: asColumnId('fd_mean'), range: [0.1234, 0.4567] };
    expect(cohortAutoName('bold', 'k4plus', [], [brush])).toBe('K4+ · FD mean 0.12–0.46');
  });

  it('composes every part, in the order each one narrows the corpus', () => {
    const brush: Selection = { metric: asColumnId('fd_mean'), range: [0.1, 0.4] };
    expect(
      cohortAutoName(
        'bold',
        'k4plus',
        [siemens, dates('2019-01-01T00:00:00Z', '2021-01-01T00:00:00Z')],
        [brush],
      ),
    ).toBe('K4+ · Siemens · 2019–2021 · FD mean 0.1–0.4');
  });

  it('writes a numeric range and the two null predicates readably', () => {
    const range: Filter = {
      field: asColumnId('canonical_diameter'),
      op: 'between',
      lo: 0,
      hi: 0.0123,
    };
    expect(cohortAutoName('bold', 'k4plus', [range], [])).toContain('0–0.012');
    const absent: Filter = { field: asColumnId('task_id'), op: 'isNull' };
    expect(cohortAutoName('bold', 'k4plus', [absent], [])).toContain('no Task');
    const present: Filter = { field: asColumnId('task_id'), op: 'notNull' };
    expect(cohortAutoName('bold', 'k4plus', [present], [])).toContain('has Task');
  });

  it('drops a filter column this view does not have from the label, not the name', () => {
    // The name still states the filter; only its label falls back to the id,
    // because a name is a description and not a validation.
    const unknown: Filter = { field: asColumnId('nope'), op: 'in', values: ['x'] };
    expect(cohortAutoName('bold', 'k4plus', [unknown], [])).toBe('K4+ · x');
  });
});

describe('uniqueCohortName', () => {
  it('leaves a name that nothing has taken', () => {
    expect(uniqueCohortName('K4+ · all', [])).toBe('K4+ · all');
  });

  it('suffixes a repeat, and keeps counting', () => {
    // The one-click path produces the same name the moment a reader saves the
    // dashboard, changes nothing and saves it again -- and two cohorts with one
    // name are indistinguishable in a legend and in every table row.
    expect(uniqueCohortName('Siemens', ['Siemens'])).toBe('Siemens (2)');
    expect(uniqueCohortName('Siemens', ['Siemens', 'Siemens (2)'])).toBe('Siemens (3)');
    expect(uniqueCohortName('Siemens', ['Siemens', 'Siemens (2)', 'Siemens (3)'])).toBe(
      'Siemens (4)',
    );
  });

  it('is unaffected by names that merely start the same', () => {
    expect(uniqueCohortName('Siemens', ['Siemens 3T'])).toBe('Siemens');
  });
});
