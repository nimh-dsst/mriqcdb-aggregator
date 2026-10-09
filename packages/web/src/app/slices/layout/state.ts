import type { PanelId } from '../../graph/state';
import type { DashboardLayout } from '../layout/geometry';

export interface LayoutState {
  layout?: DashboardLayout | null;
  maximizedPanel?: PanelId | null;
}
