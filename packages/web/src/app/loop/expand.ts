import { validateUrlState } from '../url/url';
import type { Command } from './commands';

/** Ordered reactions run within one fold; subscribers never see partial state.
 * Unchanged primary commands suppress their reactions in reduce(). Filters keep
 * brushes; only changing modality clears them, matching the original reducer.
 */
export function expand(command: Command): Command[] {
  const evict: Command = { t: 'evictDatasets' };
  switch (command.t) {
    case 'setModality': return [command, { t: 'retargetCohorts' }, { t: 'retargetPanels', prune: true }, { t: 'clearSelections' }, evict];
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
