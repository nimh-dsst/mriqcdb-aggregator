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

import {
type State
} from '../../graph/state';
import { type Command } from '../../loop/commands';
import {
addSeries,
patchPanel,
removeSeries
} from '../panels/model';
import { studyFormReason } from '../study/queries';
import { seriesKey,type Series } from './model';

export function reduceSeries(state: State, command: Command): State {
  switch (command.t) {
    case 'addPanelSeries': return addSeries(state, command.id, command.series);

    case 'removePanelSeries': return removeSeries(state, command.id, command.key);

    case 'addGroupToPanels': {
      let next = state;
      for (const panel of state.panels) {
        if (!command.panelIds || command.panelIds.includes(panel.id)) next = addSeries(next, panel.id, { kind: 'cohort', id: command.id });
      }
      return next;
    }

    case 'removePanelCohort': {
      const panel = state.panels.find(panel => panel.id === command.panelId);
      const item = panel?.series.find(series =>
        series.kind === 'cohort' ? series.id === command.cohort :
        series.kind === 'population' ? command.cohort === 'all' :
        series.kind === 'study' && command.cohort === 'study');
      return item ? removeSeries(state, command.panelId, seriesKey(item)) : state;
    }

    case 'revertPanelToSingle': return patchPanel(state, command.id, { series: [] });


    case 'convertToComparison': {
      let next = state;
      for (const id of Array.isArray(command.with) ? command.with : [command.with]) {
        if (id === 'current') continue;
        const series: Series = id === 'all' ? { kind: 'population' } : id === 'study' ? { kind: 'study' } : { kind: 'cohort', id };
        next = addSeries(next, command.panelId, series);
      }
      return next;
    }

    /* ------------------------------------------------------ linked selection */


    case 'addStudyToPanels': {
      let loaded = state;
      for (const panel of loaded.panels) {
        if (!panel.series.some(series => series.kind === 'study') && !studyFormReason(panel, loaded)) {
          loaded = addSeries(loaded, panel.id, { kind: 'study' });
        }
      }
      return loaded;
    }
    default: return state;
  }
}
