/** Feature commands composed into the root discriminated union. */

import type { PanelId, UrlState } from '../../graph/state';

import type { Command } from '../commands';
export type LayoutCommand =
  | { t: 'reconcilePanelLayout'; compact?: boolean; restore?: Extract<Command, { t: 'restorePanel' }> } | { t: 'unmaximizeRemoved'; id: PanelId } | { t: 'hydrateLayout'; url: UrlState }
  | { t: 'movePanel'; id: PanelId; x: number; y: number; columnsWide?: number }
  | { t: 'resizePanel'; id: PanelId; w: number; h: number; columnsWide?: number }
  | { t: 'resetLayout' }
  | { t: 'maximizePanel'; id: PanelId | null };

