/**
 * The command union: one variant per thing that can happen to the dashboard.
 *
 * Verbatim from `docs/dashboard-graph.md`, "Inputs". Commands are plain
 * serializable data (the one exception is `studyChosen`, which carries a
 * `File`), so a session is a replayable log.
 */

import type { Filter,Modality,View } from '@mriqc/shared';
import type {
MetricId,
PanelId,
UrlState
} from '../../graph/state';

export type FiltersCommand =
  | { t: 'dropPanelSelections'; id: PanelId } | { t: 'pruneSelections' } | { t: 'hydrateFilters'; url: UrlState }
  | { t: 'setModality'; modality: Modality }
  | { t: 'setView'; view: View }
  | { t: 'setFilters'; filters: readonly Filter[] }
  | { t: 'clearSelections' }
  | { t: 'brush'; from: PanelId; metric: MetricId; range: [number, number] | null }
  | { t: 'brush2d'; from: PanelId; x: MetricId; y: MetricId; ranges: { x: [number, number]; y: [number, number] } | null };

