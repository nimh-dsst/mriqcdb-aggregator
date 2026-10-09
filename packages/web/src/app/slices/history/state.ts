import type { CompletedCatalog, QueryKey } from '@mriqc/shared';
import type { DatasetEntry } from '../../graph/state';

export interface HistoryState {
  dataVersion: string | null;
  catalog: CompletedCatalog | null;
  notice: string | null;
  datasets: Readonly<Record<QueryKey, DatasetEntry>>;
}
