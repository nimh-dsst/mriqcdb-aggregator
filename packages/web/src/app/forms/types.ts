import type { CoverageResult } from '@mriqc/shared';
import type { Query } from '../api/api';
import type { ColumnRef, MetricId, Panel, State } from '../graph/state';
import type { Series } from '../graph/series';
import type { ChartInput, ChartOutput } from './shared/select';
import type { ChartTheme } from './shared/palette';
import type { PanelView } from '../view/panel-view';
import type { MeaningInput } from '../view/text';
import type { panelStats } from '../view/stats';
import type { categoryChart } from './bars/categories';
import type { AnyOptionSchema } from './options';

export type Availability = { state: 'enabled' | 'disabled' | 'hidden'; reason?: string };
export interface ProjectionInput {
  state: State;
  panel: Panel;
  theme: ChartTheme;
  projections: {
    analysis: typeof import('../view/analysis-view').analysisPanelView;
    time: typeof import('../view/time-view').timePanelView;
  };
}
export interface FormSpec {
  (input: ChartInput, coverage?: readonly (CoverageResult | null)[]): ChartOutput;
  (input: ProjectionInput): PanelView;
}
export interface FormDef {
  id: string;
  label: string;
  icon: string;
  glyph: string;
  hint: string;
  availability(x: ColumnRef | readonly MetricId[], y: MetricId | null, series: readonly Series[]): Availability;
  options: AnyOptionSchema;
  localKey?(state: State, panel: Panel, index: number, services: import('./shared/queries').QueryServices): string | null;
  queries(state: State, panel: Panel, services: import('./shared/queries').QueryServices): readonly Query[];
  spec: FormSpec;
  stats(state: State, panel: Panel, keys: Parameters<typeof panelStats>[2], derive: typeof panelStats): ReturnType<typeof panelStats>;
  brushable: boolean;
  meaning(input: MeaningInput, unit: string, metric: string, across: string): string;
  categorySpec: typeof categoryChart;
  table: boolean;
  metricSet: boolean;
  countBand: boolean;
  stacked: boolean;
  memoize: boolean;
  clip: boolean;
  countWithValue: boolean;
  distributionBins(panel: Panel): number;
  densitySampleSize(panel: Panel): number;
}
