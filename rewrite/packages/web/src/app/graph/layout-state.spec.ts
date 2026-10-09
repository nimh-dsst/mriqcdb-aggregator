import { describe, expect, it } from 'vitest';

import { compactLayout, deriveLayout } from './layout';
import { defaultDashboard, initialState, reduce } from './reducer';
import { decodeUrlState, encodeUrlState, urlState } from './url';

function hydratedState() {
  return reduce(initialState, { t: 'hydrate', url: defaultDashboard() });
}

function layoutAfterFirstResize() {
  return reduce(hydratedState(), {
    t: 'resizePanel',
    id: 'p4',
    w: 5,
    h: 10,
    columnsWide: 3,
  });
}

describe('dashboard layout state', () => {
  it('snapshots every panel when the first manual resize is made', () => {
    const state = hydratedState();
    const resized = layoutAfterFirstResize();

    expect(state.layout).toEqual(deriveLayout(state.panels, 3));
    expect(resized.layout).toBeDefined();
    if (resized.layout === undefined || resized.layout === null) {
      throw new Error('Expected a manual layout snapshot');
    }

    expect(Object.keys(resized.layout)).toEqual(resized.panels.map((panel) => panel.id));
    expect(resized.layout['p4']).toMatchObject({ w: 5, h: 10 });
  });

  it('uses saved geometry for later interactions at a different viewport width', () => {
    const resized = layoutAfterFirstResize();
    if (resized.layout === undefined || resized.layout === null) {
      throw new Error('Expected a manual layout snapshot');
    }
    const unaffected = resized.layout['p1'];
    const moved = reduce(resized, {
      t: 'movePanel',
      id: 'p4',
      x: 1,
      y: 10,
      columnsWide: 2,
    });

    if (moved.layout === undefined || moved.layout === null) {
      throw new Error('Expected a saved layout after moving a panel');
    }
    expect(moved.layout['p1']).toEqual(unaffected);
  });

  it('rederives the saved layout when reset', () => {
    const state = reduce(layoutAfterFirstResize(), { t: 'resetLayout' });
    expect(state.layout).toEqual(deriveLayout(state.panels, 3));
  });

  it('compacts saved geometry when a panel is removed', () => {
    const state = layoutAfterFirstResize();
    if (state.layout === undefined || state.layout === null) {
      throw new Error('Expected a manual layout snapshot');
    }
    const expected = { ...state.layout };
    delete expected['p1'];
    const removed = reduce(state, { t: 'removePanel', id: 'p1' });

    expect(removed.layout).toEqual(compactLayout(expected));
  });

  it('places an added distribution panel into the saved layout', () => {
    const state = layoutAfterFirstResize();
    if (state.layout === undefined || state.layout === null) {
      throw new Error('Expected a manual layout snapshot');
    }
    const savedIds = new Set(state.panels.map((panel) => panel.id));
    const added = reduce(state, { t: 'addPanel',  });
    const newPanel = added.panels.find((panel) => !savedIds.has(panel.id));

    expect(newPanel).toBeDefined();
    expect(added.layout?.[newPanel?.id ?? '']).toBeDefined();
    expect(added.layout?.['p1']).toEqual(state.layout['p1']);
  });

  it('round-trips exact saved geometry through the URL state', () => {
    const state = layoutAfterFirstResize();
    const hydrated = reduce(initialState, {
      t: 'hydrate',
      url: decodeUrlState(encodeUrlState(urlState(state)))!,
    });

    expect(hydrated.layout).toEqual(state.layout);
    expect(hydrated.panels).toEqual(state.panels);
  });

  it('exits maximized mode without changing the saved layout', () => {
    const state = layoutAfterFirstResize();
    const maximized = reduce(state, { t: 'maximizePanel', id: 'p4' });
    const escaped = reduce(maximized, { t: 'maximizePanel', id: null });

    expect(maximized.maximizedPanel).toBe('p4');
    expect(escaped.maximizedPanel).toBeNull();
    expect(escaped.layout).toEqual(state.layout);
  });
});
