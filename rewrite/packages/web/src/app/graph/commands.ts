/**
 * The command union: one variant per thing that can happen to the dashboard.
 *
 * Verbatim from `docs/dashboard-graph.md`, "Inputs". Commands are plain
 * serializable data (the one exception is `studyChosen`, which carries a
 * `File`), so a session is a replayable log.
 */

import type { ColumnId, Filter, Modality, QueryKey, View } from '@mriqc/shared';
import type { Series } from './series';
import type { DashboardLayout } from './layout';
import type {
  Cohort,
  CohortId,
  GroupField,
  MetricId,
  Panel,
  PanelChart,
  PanelId,
  PanelOptions,
} from './state';
import type { UrlState } from './url';

/**
 * What `updateCohort` may change: everything but the id.
 *
 * `color` is in it. "Never re-ranked" is a rule about the *dashboard* -- adding
 * or deleting a cohort never repaints another -- not a rule against the user
 * picking a different swatch in the editor.
 */
export type CohortPatch = Partial<Omit<Cohort, 'id'>>;

export type Command =
  // global controls
  | { t: 'setModality'; modality: Modality }
  | { t: 'setView'; view: View }
  | { t: 'setFilters'; filters: readonly Filter[] }
  // panels
  /** Create a quantity, optionally with explicit series and a valid form. */
  | { t: 'addPanel'; x?: MetricId | 'created_at'; y?: MetricId | null; form?: PanelChart; series?: readonly Series[] }
  | { t: 'addPanelSeries'; id: PanelId; series: Series }
  | { t: 'removePanelSeries'; id: PanelId; key: string }
  | { t: 'setPanelForm'; id: PanelId; form: PanelChart }
  | { t: 'setPanelRange'; id: PanelId; axis: 'x' | 'y'; range: [number, number] | 'auto' }
  | { t: 'resetPanelRanges'; id: PanelId }
  | { t: 'zoomToBrush'; from: PanelId }
  | { t: 'addGroupToPanels'; id: CohortId; panelIds?: readonly PanelId[] }
  | { t: 'removePanel'; id: PanelId }
  /**
   * Put a removed panel back exactly as it was, at the place it was removed
   * from. `addPanel` cannot do this: it mints a fresh id and fresh options, so
   * an undo built on it would be a new panel that merely looks similar.
   */
  | { t: 'restorePanel'; panel: Panel; at: number; layout?: DashboardLayout }
  | { t: 'movePanel'; id: PanelId; x: number; y: number; columnsWide?: number }
  | { t: 'resizePanel'; id: PanelId; w: number; h: number; columnsWide?: number }
  | { t: 'resetLayout' }
  | { t: 'maximizePanel'; id: PanelId | null }
  /**
   * Change one or more of a panel's settings. One command and one reducer path
   * for every per-field change a card can make, because they all do the same
   * four things: validate the value, write it, drop the page chain, and refetch
   * what the new query key names.
   */
  | { t: 'patchPanel'; id: PanelId; patch: PanelPatch }
  // The five one-field commands this replaced, kept as aliases: see `panelPatch`.
  | { t: 'setPanelMetric'; id: PanelId; metric: MetricId }
  | { t: 'setPanelAxis'; id: PanelId; axis: 'x' | 'y'; value: MetricId | 'created_at' | null }
  | { t: 'setPanelSplit'; id: PanelId; split: GroupField | null }
  | { t: 'setPanelChart'; id: PanelId; form: PanelChart }
  | { t: 'setPanelGroup'; id: PanelId; group: GroupField | null }
  | { t: 'setPanelOptions'; id: PanelId; options: Partial<PanelOptions> }
  | { t: 'setPanelCohort'; id: PanelId; cohort: CohortId }
  | { t: 'setPanelReference'; id: PanelId; cohort: CohortId }
  | { t: 'requestPage'; id: PanelId; cursor: string | null }
  /**
   * Take one cohort off *this* panel, leaving the cohort list alone.
   *
   * The ✕ on a panel chip. `removeCohort` is the other half -- the ✕ in the top
   * bar's cohort list, which deletes the cohort everywhere. The built-ins and
   * the split groups can be taken off a panel but never deleted, because there
   * is nothing of them to delete.
   */
  | { t: 'removePanelCohort'; panelId: PanelId; cohort: CohortId }
  /**
   * "Back to single distribution": a comparison panel becomes a distribution
   * panel on this dashboard, keeping its metric and its options.
   *
   * The same transition the <2-cohort rule performs, as a deliberate action --
   * so a reader who assembled a comparison has a visible way back that is not
   * "remove cohorts until it collapses".
   */
  | { t: 'revertPanelToSingle'; id: PanelId }
  // cohorts
  /**
   * The whole cohort, id and colour included, because the caller needs to name
   * the thing it just made: "Compare with… / New cohort…" dispatches this and
   * then `convertToComparison` with the same id. `mintCohortId` and
   * `nextCohortColor` (both pure, both in `reducer.ts`) are what a component
   * calls to fill those two fields, and the reducer re-mints anything that
   * collides with an existing or reserved id, so a stale caller cannot corrupt
   * the list.
   */
  | { t: 'addCohort'; cohort: Cohort }
  /**
   * Change a cohort, or create the one this id names.
   *
   * `addCohort` and `updateCohort` are the same operation with `create` set or
   * not, and both are aliases over this one: see `cohortChange`.
   */
  | { t: 'patchCohort'; id: CohortId; patch: CohortPatch; create?: boolean }
  /**
   * Snapshot the dashboard as a cohort, in one click.
   *
   * The whole of the cohort is already on screen -- the view, the filters, the
   * brush -- so the only thing a dialog was adding was a name, and the name can
   * be composed from exactly those things (`cohortAutoName`). This is the
   * primary way a cohort comes into being; the editor is for changing one.
   *
   * No payload: the reducer reads `global` and `selection`, which is what makes
   * the snapshot a snapshot rather than a copy of whatever a component last saw.
   */
  | { t: 'saveCurrentAsCohort' }
  | { t: 'updateCohort'; id: CohortId; patch: CohortPatch }
  /**
   * Remove a cohort everywhere: from the list, and from every panel that drew
   * it. A comparison panel left with fewer than two cohorts reverts to a
   * distribution panel, because a comparison of one is a distribution.
   */
  | { t: 'removeCohort'; id: CohortId }
  /**
   * Turn a distribution panel into a comparison, or add a cohort to one that
   * already is.
   *
   * `with` is a list so the split path can hand over every group the reader
   * ticked in one command: "Compare selected (3)" on a panel split by
   * manufacturer becomes a comparison of exactly those three groups, with no
   * intermediate state in which the panel compared the wrong thing. A single id
   * is the one-click "Compare with…" case and still means "`current` plus this".
   */
  | { t: 'convertToComparison'; panelId: PanelId; with: CohortId | readonly CohortId[] }
  | { t: 'clearSelections' }
  // linked selection
  | { t: 'brush'; from: PanelId; metric: MetricId; range: [number, number] | null }
  | { t: 'brush2d'; from: PanelId; x: MetricId; y: MetricId; ranges: { x: [number, number]; y: [number, number] } | null }
  // url
  | { t: 'hydrate'; url: UrlState; notice?: string }
  // data
  | { t: 'dataArrived'; key: QueryKey; result: unknown; version: string }
  | { t: 'dataFailed'; key: QueryKey; error: string }
  /**
   * Forget one dataset entry so `needed` asks for it again. This is how "Try
   * again" works: an error entry satisfies its key (that is what stops the
   * runner spinning on a failure), so the only way back into the needed set is
   * to evict the entry through the reducer.
   */
  | { t: 'retryKey'; key: QueryKey }
  | { t: 'dataVersionChanged'; version: string }
  // study
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
  // export
  | { t: 'openExport'; panelId?: PanelId }
  | { t: 'requestExport'; columns: readonly ColumnId[]; format?: 'arrow' | 'csv' }
  | { t: 'cancelExport' }
  | { t: 'exportProgress'; rows: number }
  | { t: 'exportFinished'; blob?: Blob; filename?: string; rows?: number }
  | { t: 'exportFailed'; error: string };

/** Discriminator of every command, handy in tests and logging. */
export type CommandType = Command['t'];

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

/** A change to one cohort: the id, the patch, and whether it may create it. */
export interface CohortChange {
  id: CohortId;
  patch: CohortPatch;
  /** True for a new cohort, whose id is re-minted when that one is taken. */
  create: boolean;
}

/**
 * The cohort change a command carries, or null for a command that is not one.
 *
 * `addCohort` is `patchCohort` with `create`, and it carries the whole cohort
 * because the caller has to be able to name the thing it just made.
 */
export function cohortChange(command: Command): CohortChange | null {
  switch (command.t) {
    case 'patchCohort':
      return { id: command.id, patch: command.patch ?? {}, create: command.create === true };
    case 'addCohort': {
      const { id, ...rest } = command.cohort;
      return { id, patch: rest, create: true };
    }
    case 'updateCohort':
      return { id: command.id, patch: command.patch ?? {}, create: false };
    default:
      return null;
  }
}
