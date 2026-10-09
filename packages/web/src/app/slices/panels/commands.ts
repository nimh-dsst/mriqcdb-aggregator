/** Feature commands composed into the root discriminated union. */

import type {
  CohortId,
  GroupField,
  MetricId,
  Panel,
  PanelChart,
  PanelId,
  PanelOptions,
  UrlState,
} from '../../graph/state';
import type { DashboardLayout } from '../layout/geometry';
import type { Series } from '../series/model';

import type { Command } from '../commands';
export type PanelsCommand =
  | { t: 'advancePanelPage'; id: PanelId; cursor: string | null }
  | { t: 'retargetPanels'; prune?: boolean } | { t: 'prunePanelCohorts' } | { t: 'hydratePanels'; panels: UrlState['panels'] }
  | { t: 'addPanel'; x?: MetricId | 'created_at'; y?: MetricId | null; form?: PanelChart; series?: readonly Series[] }
  | { t: 'setPanelForm'; id: PanelId; form: PanelChart }
  | { t: 'setPanelRange'; id: PanelId; axis: 'x' | 'y'; range: [number, number] | 'auto' }
  | { t: 'resetPanelRanges'; id: PanelId }
  | { t: 'zoomToBrush'; from: PanelId }
  | { t: 'removePanel'; id: PanelId }
  | { t: 'restorePanel'; panel: Panel; at: number; layout?: DashboardLayout }
  | { t: 'patchPanel'; id: PanelId; patch: PanelPatch }
  | { t: 'setPanelMetric'; id: PanelId; metric: MetricId }
  | { t: 'setPanelAxis'; id: PanelId; axis: 'x' | 'y'; value: MetricId | 'created_at' | null }
  | { t: 'setPanelSplit'; id: PanelId; split: GroupField | null }
  | { t: 'setPanelChart'; id: PanelId; form: PanelChart }
  | { t: 'setPanelGroup'; id: PanelId; group: GroupField | null }
  | { t: 'setPanelOptions'; id: PanelId; options: Partial<PanelOptions> }
  | { t: 'setPanelCohort'; id: PanelId; cohort: CohortId }
  | { t: 'setPanelReference'; id: PanelId; cohort: CohortId }
  | { t: 'requestPage'; id: PanelId; cursor: string | null };

/**
 * What `patchPanel` may change: a panel's settings, and nothing about its
 * identity, its place in the grid or its page chain.
 *
 * Which of these a panel kind actually accepts is a table in `reducer.ts`,
 * because the answer is a fact about the kind -- a coverage panel has no metric
 * to set and a sample panel has no cohorts to anchor a difference against.
 */
export interface PanelPatch {
  x?: MetricId | 'created_at';
  y?: MetricId | null;
  series?: readonly Series[];
  split?: GroupField | null;
  metric?: MetricId;
  form?: PanelChart;
  group?: GroupField | null;
  options?: Partial<PanelOptions>;
  /** The cohort whose scope this card follows. */
  cohort?: CohortId;
  /** Which cohort a comparison panel's differences block subtracts from. */
  reference?: CohortId;
}

/**
 * The patch a panel command carries, or null for a command that is not one.
 *
 * `setPanelMetric` and its four siblings are aliases: the components and the
 * tests that dispatch them outnumber the ten call sites a rename would have
 * been worth, and a one-field command is a readable thing to dispatch. They
 * normalize here, so the reducer has one path and one validation table.
 */
export function panelPatch(command: Command): { id: PanelId; patch: PanelPatch } | null {
  switch (command.t) {
    case 'patchPanel':
      return { id: command.id, patch: command.patch };
    case 'setPanelMetric':
      return { id: command.id, patch: { metric: command.metric } };
    case 'setPanelAxis':
      return { id: command.id, patch: command.axis === 'x' ? (command.value === null ? {} : { x: command.value }) :
        command.value === 'created_at' ? {} : { y: command.value } };
    case 'setPanelSplit':
      return { id: command.id, patch: { split: command.split } };
    case 'setPanelChart':
      return { id: command.id, patch: { form: command.form } };
    case 'setPanelForm':
      return { id: command.id, patch: { form: command.form } };
    case 'setPanelRange':
      return { id: command.id, patch: { options: { [command.axis === 'x' ? 'xRange' : 'yRange']: command.range } } };
    case 'resetPanelRanges':
      return { id: command.id, patch: { options: { xRange: 'auto', yRange: 'auto' } } };
    case 'setPanelGroup':
      return { id: command.id, patch: { group: command.group } };
    case 'setPanelOptions':
      return { id: command.id, patch: { options: command.options } };
    case 'setPanelCohort':
      return { id: command.id, patch: { cohort: command.cohort } };
    case 'setPanelReference':
      return { id: command.id, patch: { reference: command.cohort } };
    default:
      return null;
  }
}
