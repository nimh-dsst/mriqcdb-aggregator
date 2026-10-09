import {
  compactLayout,
  deriveLayout,
  moveLayout,
  panelsWithPreferredRows,
  reconcileLayout,
  resizeLayout,
} from './geometry';
/**
 * The reducer: `(state, command) => state`, pure, and the only writer of state.
 *
 * Every rule under "Reducer behaviour worth stating" in
 * `docs/dashboard-graph.md` is applied here -- which command changes what, in
 * what order, and what has to be evicted or pruned afterwards. The rules
 * themselves live beside the thing they are rules about: `panels.ts` for a
 * panel's shape, `cohorts.ts` for a cohort's, `filters.ts` for a filter list,
 * `datasets.ts` for the entries map, `url.ts` for anything that arrived from a
 * link. This file is the fold.
 */

import { type State } from '../../graph/state';
import { type Command } from '../commands';

export function reduceLayout(state: State, command: Command): State {
  switch (command.t) {
    case 'movePanel': {
      if (!state.panels.some(panel => panel.id === command.id)) return state;
      const layout = state.layout ?? deriveLayout(panelsWithPreferredRows(state), command.columnsWide ?? 3);
      return { ...state, layout: moveLayout(layout, command.id, command.x, command.y) };
    }

    case 'resizePanel': {
      if (!state.panels.some(panel => panel.id === command.id)) return state;
      const layout = state.layout ?? deriveLayout(panelsWithPreferredRows(state), command.columnsWide ?? 3);
      return { ...state, layout: resizeLayout(layout, command.id, command.w, command.h) };
    }

    case 'resetLayout':
      return { ...state, layout: deriveLayout(panelsWithPreferredRows(state), 3) };

    case 'maximizePanel':
      return command.id === null || state.panels.some(panel => panel.id === command.id)
        ? { ...state, maximizedPanel: command.id } : state;


    case 'reconcilePanelLayout': {
      const panels = command.restore ? state.panels.map(panel => panel.id === command.restore!.panel.id ? command.restore!.panel : panel) : state.panels;
      const layout = reconcileLayout(command.restore?.layout ?? state.layout, panelsWithPreferredRows({ ...state, panels }), 3);
      return { ...state, layout: command.compact ? compactLayout(layout) : layout };
    }
    case 'unmaximizeRemoved': return state.maximizedPanel === command.id ? { ...state, maximizedPanel: null } : state;
    case 'hydrateLayout': return { ...state, layout: reconcileLayout(command.url.layout, command.url.panels, 3), maximizedPanel: command.url.maximizedPanel ?? null };
    default: return state;
  }
}
