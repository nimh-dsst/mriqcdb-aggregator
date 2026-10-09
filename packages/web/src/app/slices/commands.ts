import type { CohortsCommand } from './cohorts/commands';
import type { FiltersCommand } from './filters/commands';
import type { HistoryCommand } from './history/commands';
import type { LayoutCommand } from './layout/commands';
import type { PanelsCommand } from './panels/commands';
import type { SeriesCommand } from './series/commands';
import type { StudyCommand } from './study/commands';

export type Command = FiltersCommand | LayoutCommand | CohortsCommand | SeriesCommand | StudyCommand | HistoryCommand | PanelsCommand;
export type CommandType = Command['t'];
export { cohortChange,type CohortChange,type CohortPatch } from './cohorts/commands';
export { panelPatch,type PanelPatch } from './panels/commands';
