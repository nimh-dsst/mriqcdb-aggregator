import { asColumnId } from '@mriqc/shared';
import { commandLabel, historyShortcut, historyWorthy, reduceHistory } from './history';
import { defaultDashboard, initialState, reduce } from './reducer';
import { encodeUrlState, urlState } from './url';
import type { Command } from './commands';

const boot = () => reduceHistory(initialState, { t: 'hydrate', url: defaultDashboard() }, 0);
const range = (hi: number): Command => ({ t: 'setPanelRange', id: 'p1', axis: 'x', range: [0, hi] });

describe('session history fold', () => {
  it('records the previous dashboard, labels undo/redo, and does not serialize history', () => {
    const before = boot();
    const changed = reduceHistory(before, { t: 'setPanelForm', id: 'p1', form: 'density' }, 0);
    expect(changed.history?.undo).toHaveLength(1);
    expect(changed.history?.urlMode).toBe('push');
    const undone = reduceHistory(changed, { t: 'undo' }, 1);
    expect(urlState(undone)).toEqual(urlState(before));
    expect(undone.notice).toBe('Undid: form → Density');
    expect(undone.history?.urlMode).toBe('replace');
    const redone = reduceHistory(undone, { t: 'redo' }, 2);
    expect(urlState(redone)).toEqual(urlState(changed));
    expect(redone.notice).toBe('Redid: form → Density');
    expect(redone.history?.urlMode).toBe('replace');
    expect(encodeUrlState(urlState(redone))).toBe(encodeUrlState(urlState({ ...redone, history: undefined })));
  });

  it('coalesces ranges, closes on release or idle, and restores the start of a run', () => {
    const before = boot();
    let state = reduceHistory(before, range(1), 0);
    state = reduceHistory(state, range(2), 100);
    expect(state.history?.undo).toHaveLength(1);
    expect(state.history?.urlMode).toBe('replace');
    expect(urlState(reduceHistory(state, { t: 'undo' }, 101))).toEqual(urlState(before));
    state = reduceHistory(state, { t: 'endHistoryRun' }, 102);
    state = reduceHistory(state, range(3), 103);
    expect(state.history?.undo).toHaveLength(2);
    state = reduceHistory(state, range(4), 603);
    expect(state.history?.undo).toHaveLength(3);
  });

  it.each<Command[]>([
    [{ t: 'brush', from: 'p1', metric: asColumnId('fd_mean'), range: [0, 1] }, { t: 'brush', from: 'p1', metric: asColumnId('fd_mean'), range: [0, 2] }],
    [{ t: 'resizePanel', id: 'p1', w: 3, h: 4 }, { t: 'resizePanel', id: 'p1', w: 4, h: 5 }],
    [{ t: 'movePanel', id: 'p1', x: 0, y: 10 }, { t: 'movePanel', id: 'p1', x: 1, y: 11 }],
    [{ t: 'setPanelOptions', id: 'p1', options: { xRange: [0, 1] } }, { t: 'setPanelOptions', id: 'p1', options: { xRange: [0, 2] } }],
  ])('coalesces continuous commands: %j', (first, second) => {
    const state = reduceHistory(reduceHistory(boot(), first, 0), second, 100);
    expect(state.history?.undo).toHaveLength(1);
  });

  it('caps history at 100, clears redo on a new change but not a no-op', () => {
    let state = boot();
    for (let i = 0; i < 105; i++) state = reduceHistory(state, range(i + 1), i * 500);
    expect(state.history?.undo).toHaveLength(100);
    state = reduceHistory(state, { t: 'undo' }, 60000);
    expect(state.history?.redo).toHaveLength(1);
    state = reduceHistory(state, { t: 'removePanel', id: 'missing' }, 60001);
    expect(state.history?.redo).toHaveLength(1);
    state = reduceHistory(state, range(200), 60002);
    expect(state.history?.redo).toHaveLength(0);
  });

  it('does not rewind live feedback, upload or export state; explains upload exclusion', () => {
    let state = reduceHistory(boot(), range(1), 0);
    state = reduceHistory(state, { t: 'studyChosen', file: new File(['x'], 'study.tsv') }, 1);
    state = reduceHistory(state, { t: 'dataVersionChanged', version: 'new' }, 2);
    const study = state.study;
    state = reduceHistory(state, { t: 'undo' }, 3);
    expect(state.study).toBe(study);
    expect(state.dataVersion).toBe('new');
    expect(state.notice).toContain('Study upload is not undoable');
    expect(state.history?.undo).toHaveLength(0);
    const uploadOnly = reduceHistory(boot(), { t: 'studyChosen', file: new File([], 'study.tsv') }, 0);
    expect(reduceHistory(uploadOnly, { t: 'undo' }, 1).notice).toContain('Study upload is not undoable');
  });

  it('resets session history on external hydration and ignores feedback/no-op steps', () => {
    let state = reduceHistory(boot(), range(1), 0);
    state = reduceHistory(state, { t: 'hydrate', url: defaultDashboard() }, 1);
    expect(state.history?.undo).toHaveLength(0);
    expect(historyWorthy(state, reduce(state, { t: 'dataVersionChanged', version: 'v2' }), { t: 'dataVersionChanged', version: 'v2' })).toBe(false);
    expect(reduceHistory(state, { t: 'removePanel', id: 'missing' }, 2).history?.undo).toHaveLength(0);
  });

  it('labels forms, series, ranges and layout changes for humans', () => {
    const state = boot();
    expect(commandLabel({ t: 'setPanelForm', id: 'p1', form: 'ecdf' }, state, state)).toBe('form → ECDF');
    expect(commandLabel({ t: 'addPanelSeries', id: 'p1', series: { kind: 'population' } }, state, state)).toBe('added series Whole population');
    expect(commandLabel(range(2), state, state)).toBe('changed axis range');
    expect(commandLabel({ t: 'movePanel', id: 'p1', x: 1, y: 2 }, state, state)).toBe('moved chart');
  });
});

describe('history keyboard routing', () => {
  afterEach(() => document.body.replaceChildren());
  it.each([
    ['z', { ctrlKey: true }, 'undo'], ['z', { metaKey: true }, 'undo'],
    ['y', { ctrlKey: true }, 'redo'], ['z', { ctrlKey: true, shiftKey: true }, 'redo'],
    ['z', { metaKey: true, shiftKey: true }, 'redo'],
  ] as const)('routes %s with %j', (key, modifiers, expected) => {
    expect(historyShortcut(new KeyboardEvent('keydown', { key, ...modifiers }), document)).toBe(expected);
  });
  it.each(['input', 'textarea', 'div'])('preserves native editing in %s', tag => {
    const element = document.createElement(tag);
    if (tag === 'div') { element.contentEditable = 'true'; element.setAttribute('contenteditable', 'true'); element.tabIndex = 0; }
    document.body.append(element);
    element.focus();
    expect(historyShortcut(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }), document)).toBeNull();
  });
  it.each(['mat-mdc-select-panel', 'mat-mdc-menu-panel'])('ignores open %s', className => {
    const overlay = document.createElement('div');
    overlay.className = className;
    document.body.append(overlay);
    expect(historyShortcut(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }), document)).toBeNull();
  });
});
