import type { CohortsCommand } from '../slices/cohorts/commands';
import type { FiltersCommand } from '../slices/filters/commands';
import type { HistoryCommand } from '../slices/history/commands';
import type { LayoutCommand } from '../slices/layout/commands';
import type { PanelsCommand } from '../slices/panels/commands';
import type { SeriesCommand } from '../slices/series/commands';
import type { StudyCommand } from '../slices/study/commands';

export type Command = FiltersCommand | LayoutCommand | CohortsCommand | SeriesCommand | StudyCommand | HistoryCommand | PanelsCommand;
export type CommandType = Command['t'];
export { cohortChange,type CohortChange,type CohortPatch } from '../slices/cohorts/commands';
export { panelPatch,type PanelPatch } from '../slices/panels/commands';
