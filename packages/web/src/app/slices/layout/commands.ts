/**
 * The command union: one variant per thing that can happen to the dashboard.
 *
 * Verbatim from `docs/dashboard-graph.md`, "Inputs". Commands are plain
 * serializable data (the one exception is `studyChosen`, which carries a
 * `File`), so a session is a replayable log.
 */

import type {
PanelId,
UrlState
} from '../../graph/state';

import type { Command } from '../../loop/commands';
export type LayoutCommand =
  | { t: 'reconcilePanelLayout'; compact?: boolean; restore?: Extract<Command, { t: 'restorePanel' }> } | { t: 'unmaximizeRemoved'; id: PanelId } | { t: 'hydrateLayout'; url: UrlState }
  | { t: 'movePanel'; id: PanelId; x: number; y: number; columnsWide?: number }
  | { t: 'resizePanel'; id: PanelId; w: number; h: number; columnsWide?: number }
  | { t: 'resetLayout' }
  | { t: 'maximizePanel'; id: PanelId | null };

