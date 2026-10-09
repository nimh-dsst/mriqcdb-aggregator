/**
 * The command union: one variant per thing that can happen to the dashboard.
 *
 * Verbatim from `docs/dashboard-graph.md`, "Inputs". Commands are plain
 * serializable data (the one exception is `studyChosen`, which carries a
 * `File`), so a session is a replayable log.
 */

import type {
CohortId,
PanelId
} from '../../graph/state';
import type { Series } from './model';

export type SeriesCommand =
  | { t: 'addStudyToPanels' }
  | { t: 'addPanelSeries'; id: PanelId; series: Series }
  | { t: 'removePanelSeries'; id: PanelId; key: string }
  | { t: 'addGroupToPanels'; id: CohortId; panelIds?: readonly PanelId[] }
  | { t: 'removePanelCohort'; panelId: PanelId; cohort: CohortId }
  | { t: 'revertPanelToSingle'; id: PanelId }
  | { t: 'convertToComparison'; panelId: PanelId; with: CohortId | readonly CohortId[] };

