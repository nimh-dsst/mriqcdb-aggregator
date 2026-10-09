/** Pure feature transitions; foreign commands preserve state identity. */

import { FIRST_PAGE, type State } from '../../graph/state';
import { panelPatch, type Command } from '../commands';
import { evict } from '../history/datasets';
import { mapPanel, newPanel, patchPanel, pruneCohortRefs, retargetPanels } from './model';

export function reducePanels(state: State, command: Command): State {
  switch (command.t) {
    case 'addPanel': {
      const made = newPanel(state, command.x);
      const configured = patchPanel({ ...state, panels: [...state.panels, made] }, made.id, {
        ...(command.y !== undefined ? { y: command.y } : {}),
        ...(command.form ? { form: command.form } : {}),
        ...(command.series ? { series: command.series } : {}),
      });
      return { ...state, panels: configured.panels };
    }

    case 'removePanel': {
      const panels = state.panels.filter(panel => panel.id !== command.id);
      return panels.length === state.panels.length ? state : { ...state, panels };
    }

    case 'restorePanel': {
      if (state.panels.some(panel => panel.id === command.panel.id)) return state;
      const at = Math.min(Math.max(0, Math.trunc(command.at)), state.panels.length);
      const panels = [...state.panels];
      panels.splice(at, 0, { ...command.panel, cursors: FIRST_PAGE });
      return { ...state, panels: pruneCohortRefs(panels, state) };
    }

    case 'patchPanel':

    case 'setPanelMetric':

    case 'setPanelAxis':

    case 'setPanelSplit':

    case 'setPanelChart':

    case 'setPanelForm':

    case 'setPanelRange':

    case 'resetPanelRanges':

    case 'setPanelGroup':

    case 'setPanelOptions':

    case 'setPanelCohort':

    case 'setPanelReference': {
      // The five one-field commands are aliases over `patchPanel`
      // (`commands.ts`, `panelPatch`), so every per-field rule is in one table.
      const change = panelPatch(command);
      return change === null ? state : patchPanel(state, change.id, change.patch);
    }


    case 'advancePanelPage':
    case 'requestPage':
      // Paging extends the chain; the table shows every page it has loaded, so
      // the earlier keys have to stay referenced.
      return mapPanel(state, command.id, (panel) =>
        panel.cursors.includes(command.cursor)
          ? panel
          : { ...panel, cursors: [...panel.cursors, command.cursor] },
      );

    /* --------------------------------------------------------------- cohorts */


    case 'retargetPanels': {
      const panels = retargetPanels(state.panels, state.global.modality, state.global.view);
      return { ...state, panels: command.prune ? pruneCohortRefs(panels, state) : panels };
    }
    case 'prunePanelCohorts': return { ...state, panels: pruneCohortRefs(state.panels, state) };
    case 'hydratePanels': return { ...state, panels: pruneCohortRefs(command.panels.map(panel => ({ ...panel, cursors: FIRST_PAGE })), state) };
    default: return state;
  }
}
