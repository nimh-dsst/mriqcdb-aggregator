import type { State } from '../graph/state';
import type { Command } from '../slices/commands';
import { panelPatch } from '../slices/panels/commands';
import { zoomPatch } from '../slices/panels/queries';
import { studyFormReason } from '../slices/study/queries';
import { validateUrlState } from '../url/url';

/** Ordered reactions run within one fold; subscribers never see partial state.
 * Unchanged primary commands suppress their reactions in reduce(). Filters keep
 * brushes; only changing modality clears them, matching the original reducer.
 */
export function expand(command: Command, state?: State): Command[] {
  const evict: Command = { t: 'evictDatasets' };
  // Guard reactions by the pre-edit panel reference. A refused edit may only
  // produce a notice and must not prune selections or evict unrelated data.
  if (panelPatch(command) || ['addPanelSeries', 'removePanelSeries', 'removePanelCohort', 'revertPanelToSingle'].includes(command.t)) {
    return [command, { t: 'pruneSelections', panelsBefore: state?.panels }, { ...evict, panelsBefore: state?.panels }];
  }
  switch (command.t) {
    case 'requestPage': return [{ ...command, t: 'advancePanelPage' }, evict];
    case 'addCohort': case 'patchCohort': case 'updateCohort': case 'saveCurrentAsCohort':
    case 'setFilters': case 'clearSelections': return [command, evict];
    case 'brush': case 'brush2d': return [command, { ...evict, selectionsBefore: state?.selections }];
    case 'addGroupToPanels': return state ? state.panels.filter(panel => !command.panelIds || command.panelIds.includes(panel.id))
      .map(panel => ({ t: 'addPanelSeries', id: panel.id, series: { kind: 'cohort', id: command.id } })) : [command];
    case 'convertToComparison': return (Array.isArray(command.with) ? command.with : [command.with]).filter(id => id !== 'current')
      .map(id => ({ t: 'addPanelSeries', id: command.panelId, series: id === 'all' ? { kind: 'population' } : id === 'study' ? { kind: 'study' } : { kind: 'cohort', id } }));
    case 'addStudyToPanels': return state ? state.panels.filter(panel => !panel.series.some(series => series.kind === 'study') && !studyFormReason(panel, state))
      .map(panel => ({ t: 'addPanelSeries', id: panel.id, series: { kind: 'study' } })) : [command];
    case 'zoomToBrush': {
      const change = state && zoomPatch(state, command.from);
      return change ? [{ t: 'dropPanelSelections', id: command.from }, { t: 'patchPanel', ...change }] : [command];
    }
    case 'setModality': return [command, { t: 'retargetCohorts' }, { t: 'retargetPanels', prune: true }, { t: 'resetSelections' }, evict];
    case 'setView': return [command, { t: 'retargetPanels' }, evict];
    case 'addPanel': return [command, { t: 'reconcilePanelLayout' }, evict];
    case 'removePanel': return [command, { t: 'dropPanelSelections', id: command.id }, { t: 'reconcilePanelLayout', compact: true }, { t: 'unmaximizeRemoved', id: command.id }, evict];
    case 'restorePanel': return [command, { t: 'reconcilePanelLayout', restore: command }, evict];
    case 'removeCohort': return [command, { t: 'prunePanelCohorts' }, evict];
    case 'studyChosen': case 'studyFailed': return [command, { t: 'dropStudyDatasets' }];
    case 'studyLoaded': return [command, ...(command.addToAll ? [{ t: 'addStudyToPanels' } as const] : []), evict];
    case 'clearStudy': return [command, { t: 'dropStudyDatasets' }, { t: 'prunePanelCohorts' }, evict];
    case 'hydrate': {
      const url = validateUrlState(command.url);
      return [command, { t: 'hydrateFilters', url }, { t: 'hydrateCohorts', cohorts: url.cohorts }, { t: 'hydratePanels', panels: url.panels }, { t: 'hydrateLayout', url }, evict];
    }
    default: return [command];
  }
}
