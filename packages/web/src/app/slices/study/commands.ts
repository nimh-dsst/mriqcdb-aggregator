/** Feature commands composed into the root discriminated union. */

import type { ColumnId } from '@mriqc/shared';
import type { MetricId, PanelId } from '../../graph/state';

export type StudyCommand =
  | { t: 'studyChosen'; file: File; addToAll?: boolean }
  | {
      t: 'studyLoaded';
      name: string;
      rows: number;
      metrics: readonly MetricId[];
      totalMetrics: number;
      ignoredColumns: readonly string[];
      missingMetrics: readonly MetricId[];
      columns?: readonly string[];
      columnMapping?: readonly { source: string; target: string }[];
      addToAll?: boolean;
    }
  | { t: 'studyFailed'; error: string }
  | { t: 'clearStudy' }
  | { t: 'openExport'; panelId?: PanelId }
  | { t: 'requestExport'; columns: readonly ColumnId[]; format?: 'arrow' | 'csv' }
  | { t: 'cancelExport' }
  | { t: 'exportProgress'; rows: number }
  | { t: 'exportFinished'; blob?: Blob; filename?: string; rows?: number }
  | { t: 'exportFailed'; error: string };

