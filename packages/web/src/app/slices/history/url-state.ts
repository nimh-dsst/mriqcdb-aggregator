import type { Cohort, GlobalState, Panel, SelectionState } from '../../graph/state';
import type { DashboardLayout } from '../layout/geometry';
export interface UrlState {
  layout?: DashboardLayout | null;
  maximizedPanel?: string | null;
  global: GlobalState;
  /**
   * The user's cohorts. `current` and `all` are derived and never serialized;
   * a `study` cohort never leaves the browser either, because its rows do not
   * (`docs/comparison-design.md`, "Cohort").
   */
  cohorts: readonly Cohort[];
  panels: readonly Omit<Panel, 'cursors'>[];
  selections: readonly SelectionState[];
}

