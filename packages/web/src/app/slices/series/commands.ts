/** Feature commands composed into the root discriminated union. */

import type { CohortId, PanelId } from '../../graph/state';
import type { Series } from './model';

export type SeriesCommand =
  | { t: 'addStudyToPanels' }
  | { t: 'addPanelSeries'; id: PanelId; series: Series }
  | { t: 'removePanelSeries'; id: PanelId; key: string }
  | { t: 'addGroupToPanels'; id: CohortId; panelIds?: readonly PanelId[] }
  | { t: 'removePanelCohort'; panelId: PanelId; cohort: CohortId }
  | { t: 'revertPanelToSingle'; id: PanelId }
  | { t: 'convertToComparison'; panelId: PanelId; with: CohortId | readonly CohortId[] };

