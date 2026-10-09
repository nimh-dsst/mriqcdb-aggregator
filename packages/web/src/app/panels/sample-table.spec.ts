import { DEFAULT_COLUMNS, shownColumns } from './sample-table';

const ALL = ['subject', 'session', 'run', 'manufacturer', 'model', 'site', 'created_at'];

describe('shownColumns', () => {
  it('starts with the first five of the view s exportable fields', () => {
    expect(shownColumns(ALL, null)).toEqual(ALL.slice(0, DEFAULT_COLUMNS));
  });

  it('draws the reader s choice in table order, not in the order they ticked it', () => {
    expect(shownColumns(ALL, ['created_at', 'subject'])).toEqual(['subject', 'created_at']);
  });

  it('ignores a column this view does not have', () => {
    // A view switch changes the exportable field set under a choice made on
    // the old one.
    expect(shownColumns(ALL, ['subject', 'canonical_diameter'])).toEqual(['subject']);
  });

  it('never empties the grid', () => {
    expect(shownColumns(ALL, [])).toEqual(['subject']);
  });
});
