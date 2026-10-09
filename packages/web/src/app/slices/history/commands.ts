/**
 * The command union: one variant per thing that can happen to the dashboard.
 *
 * Verbatim from `docs/dashboard-graph.md`, "Inputs". Commands are plain
 * serializable data (the one exception is `studyChosen`, which carries a
 * `File`), so a session is a replayable log.
 */

import type { QueryKey } from '@mriqc/shared';
import type { UrlState } from '../../graph/state';

export type HistoryCommand =
  | { t: 'evictDatasets' } | { t: 'dropStudyDatasets' }
  | { t: 'hydrate'; url: UrlState; notice?: string }
  | { t: 'dataArrived'; key: QueryKey; result: unknown; version: string }
  | { t: 'dataFailed'; key: QueryKey; error: string }
  | { t: 'retryKey'; key: QueryKey }
  | { t: 'dataVersionChanged'; version: string };

