/** Pure feature transitions; foreign commands preserve state identity. */

import { type State } from '../../graph/state';
import { type Command } from '../commands';
import { addSeries, patchPanel, removeSeries } from '../panels/model';
import { seriesKey } from './model';

export function reduceSeries(state: State, command: Command): State {
  switch (command.t) {
    case 'addPanelSeries': return addSeries(state, command.id, command.series);

    case 'removePanelSeries': return removeSeries(state, command.id, command.key);

    case 'removePanelCohort': {
      const panel = state.panels.find(panel => panel.id === command.panelId);
      const item = panel?.series.find(series =>
        series.kind === 'cohort' ? series.id === command.cohort :
        series.kind === 'population' ? command.cohort === 'all' :
        series.kind === 'study' && command.cohort === 'study');
      return item ? removeSeries(state, command.panelId, seriesKey(item)) : state;
    }

    case 'revertPanelToSingle': return patchPanel(state, command.id, { series: [] });


    default: return state;
  }
}
