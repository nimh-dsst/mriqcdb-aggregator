import type { ExportState,PanelId,StudyState } from '../../graph/state';

export interface StudySliceState {
  study: StudyState;
  export: ExportState;
  exportDialogOpen?: boolean;
  exportPanelId?: PanelId;
}
