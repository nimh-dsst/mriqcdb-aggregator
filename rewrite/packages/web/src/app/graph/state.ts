/**
 * The single state value the command loop folds over.
 *
 * Shapes follow `docs/dashboard-graph.md`, "State". Everything here is plain
 * data: no class, no observable, no method. The reducer is the only writer.
 */

import { canonicalViewFor } from '@mriqc/shared';
import type { DashboardLayout } from './layout';
import type {
  ClipMode,
  ColumnId,
  CompletedCatalog,
  Filter,
  Granularity,
  Modality,
  QueryKey,
  Selection,
  View,
} from '@mriqc/shared';

/** A panel's identity inside one dashboard. Minted by the reducer, carried in the URL. */
export type PanelId = string;

/** A cohort's identity inside one dashboard. Carried in the URL and by panels. */
export type CohortId = string;

/** The form vocabulary is derived from the one axis-to-form table. */
export type Form = (typeof import('./panel-shapes').FORM_ORDER)[number];
export type PanelChart = Form;
export type ColumnRef = ColumnId | 'created_at';
export type { Series } from './series';
import type { Series } from './series';

/** How a distribution split is presented; facets are an explicit reading mode. */
export type SplitPresentation = 'overlay' | 'facets';

/** The coverage period a card presents. `custom` follows the active date filter. */
export type CoverageWindow = '12m' | '5y' | 'all' | 'custom';

/** The ordering a box plot uses; median is the useful default for ranking. */
export type BoxSort = 'median' | 'n';

/** How many bins a density chart asks for, before smoothing. */
export const DENSITY_BINS = 200;

/** A metric column id. Same thing as a `ColumnId`, named for the role it plays. */
export type MetricId = ColumnId;

/** A groupable column id. */
export type GroupField = ColumnId;

/** An exportable column id. */
export type ColumnIdAlias = ColumnId;

/**
 * Per-panel display options.
 *
 * `granularity` is not in the document's `PanelOptions`, but the `coverage`
 * query needs one and `Panel` gives it no other home; it lives here so the
 * coverage bucket width is a panel setting rather than a constant.
 */
export interface PanelOptions {
  family?: string;
  metrics?: readonly MetricId[];
  sampleSize?: number;
  seed?: number;
  k?: number;
  showPoints?: boolean;
  clusterOrder?: boolean;
  clusterSplit?: boolean;
  /** Histogram bin count, 10..200. */
  bins: number;
  /** X-range clipping for distribution charts. */
  clip: ClipMode;
  xScale: 'linear' | 'log' | 'symlog';
  xRange: 'auto' | readonly [number, number];
  yScale: 'linear' | 'log' | 'symlog';
  yRange: 'auto' | readonly [number, number];
  yMode: 'count' | 'share' | 'logCount';
  layout: 'overlaid' | 'stacked' | 'stacked100';
  quantiles: 'quartiles' | 'tails';
  coefficient?: 'spearman' | 'pearson';
  /** Apply the linked brush from other panels. */
  useSelection: boolean;
  /** Coverage bucket width. */
  granularity: Granularity;
  /** A split starts as one readable overlay; small multiples are opt-in. */
  splitPresentation: SplitPresentation;
  /** Accumulate coverage values within each series. */
  cumulative: boolean;
  /** Normalize each coverage bucket to a 100% stack. */
  share: boolean;
  /** Coverage period; custom delegates its dates to the active filter set. */
  coverageWindow: CoverageWindow;
  /** Logarithmic coverage count axis. Ignored for 100% share. */
  coverageLogY: boolean;
  /** Inclusive, card-local ISO date bounds when `coverageWindow` is custom. */
  coverageCustom: readonly [string, string] | null;
  /** The ranking used for box rows. */
  boxSort: BoxSort;
}

/**
 * A named, coloured selection of scans: the unit every comparison is made of
 * (`docs/comparison-design.md`, "Cohort").
 *
 * `color` is an index into {@link CATEGORY_PALETTE}, assigned once when the
 * cohort is created and never re-ranked: a cohort keeps its hue when another is
 * added or deleted, so nothing already on screen is repainted.
 */
export interface Cohort {
  id: CohortId;
  /** "Siemens 3T, 2019" / "Whole population" / "My study". */
  name: string;
  /** Index into the categorical palette, fixed per cohort. */
  color: number;
  /** `study` cohorts answer from the DuckDB-WASM instance; none exist yet. */
  source: 'population' | 'study';
  /** Ignored for a study cohort, which has no server view. */
  view: View;
  /** The same `Filter` type the top bar produces, `created_at between` included. */
  filters: readonly Filter[];
  /** An optional metric range, e.g. carried over from a brush. */
  selections: readonly Selection[];
}

/**
 * What a cohort looks like before the dashboard has one: everything but the two
 * fields the dashboard itself decides.
 *
 * The editor builds one of these; `mintCohortId` and `nextCohortColor` turn it
 * into a `Cohort`, so no component has to know how ids are minted or which
 * palette slots are free.
 */
export type CohortDraft = Omit<Cohort, 'id' | 'color'>;

/**
 * A derived cohort that is one group of a split: this dashboard's filters plus
 * `field in [value]`.
 *
 * Its id carries the field and the value, because that is the whole of its
 * definition -- there is nothing to store, and a link only has to say which
 * group of which column it meant. `\u0000` separates them: no catalog column
 * name and no categorical value contains it, so the split is unambiguous
 * wherever the id is read back.
 */
const GROUP_COHORT_PREFIX = 'g\u0000';

/** The cohort id for one group of a split field. */
export function groupCohortId(field: ColumnId | string, value: string): CohortId {
  return `${GROUP_COHORT_PREFIX}${String(field)}\u0000${value}`;
}

/** The field and value a group-cohort id names, or null for any other id. */
export function parseGroupCohortId(id: CohortId): { field: string; value: string } | null {
  if (!id.startsWith(GROUP_COHORT_PREFIX)) return null;
  const rest = id.slice(GROUP_COHORT_PREFIX.length);
  const split = rest.indexOf('\u0000');
  if (split <= 0) return null;
  return { field: rest.slice(0, split), value: rest.slice(split + 1) };
}

/** True for a cohort whose definition is a group of a split field. */
export function isGroupCohort(id: CohortId): boolean {
  return parseGroupCohortId(id) !== null;
}

/**
 * The two cohorts that always exist and are never stored.
 *
 * They are derived from `global` and `selection` at projection time
 * (`cohortsOf` in `cohorts.ts`), so they cannot drift from the top bar, and
 * their ids are reserved: `addCohort` re-mints anything that collides.
 */
export const CURRENT_COHORT: CohortId = 'current';
export const ALL_COHORT: CohortId = 'all';
/** The uploaded study is derived from `StudyState`; its rows never enter state or a URL. */
export const STUDY_COHORT: CohortId = 'study';

/** Every id a user cohort may not take. */
export const RESERVED_COHORT_IDS: readonly CohortId[] = [CURRENT_COHORT, ALL_COHORT, STUDY_COHORT];

/**
 * True for a cohort the dashboard derives rather than stores, and which
 * therefore cannot be edited or deleted: the two built-ins and every group of a
 * split field.
 *
 * They can all be removed from a *panel* -- that is a change to the panel, not
 * to the cohort list -- which is what the ✕ on a panel chip does.
 */
export function isDerivedCohort(id: CohortId): boolean {
  return id === CURRENT_COHORT || id === ALL_COHORT || id === STUDY_COHORT || isGroupCohort(id);
}

/**
 * The palette slots the two derived cohorts hold.
 *
 * Fixed, and skipped by `nextCohortColor`, so "This dashboard" is always the
 * blue a single-series histogram already draws and "Whole population" always
 * the second hue -- a panel converted to a comparison keeps the colour its bars
 * had.
 */
export const CURRENT_COHORT_COLOR = 0;
export const ALL_COHORT_COLOR = 1;
/** Reserved so a study keeps the same hue without repainting an existing cohort. */
export const STUDY_COHORT_COLOR = 7;

/** How many cohorts one dashboard may hold, so a hand-edited link cannot grow the list without bound. */
export const MAX_COHORTS = 12;

/** How many cohorts a comparison panel needs before it is a comparison at all. */
export const MIN_COMPARISON_COHORTS = 2;

/** One card on the dashboard. */
export interface Panel {
  id: PanelId;
  x: ColumnRef;
  y: MetricId | null;
  form: Form;
  series: readonly Series[];
  /** Rendering and analysis parameters, independent of the axes. */
  options: PanelOptions;
  /**
   * Which cohort the differences block subtracts from, when it is not the first.
   *
   * Panel state rather than ephemeral UI: it decides what every figure in the
   * block *means*, so it belongs in the URL beside the cohort list. Absent means
   * "the first cohort", so a panel that has never had its reference changed
   * carries nothing extra in its link.
   */
  reference?: CohortId;
  /**
   * The keyset cursors of the pages this panel has loaded, oldest first and
   * always starting with `null`. The document's `Panel` carries a single
   * `cursor`; a single cursor can only name the page on screen, and a table
   * that pages forward has to keep the pages behind it, so the field is the
   * chain rather than its last link. Table uses this chain; other forms keep
   * the initial page. With series, each entry holds their independent cursors.
   */
  cursors: readonly (string | null)[];
}

/** The page chain a panel starts with: the first page and nothing after it. */
export const FIRST_PAGE: readonly (string | null)[] = [null];

/**
 * One entry of the datasets map.
 *
 * `loading` is part of the documented union but is never constructed: `needed`
 * is defined as "keys with no entry at the current dataVersion", so a key has
 * to stay absent from the map for the runner to keep its fetch alive. Loading
 * is therefore derived (key is needed), not stored.
 */
export type DatasetEntry =
  | { status: 'loading'; version: string }
  | { status: 'ready'; version: string; result: unknown }
  | { status: 'error'; version: string; error: string };

/** The uploaded comparison study. Rows live in DuckDB-WASM, never in state. */
export type StudyState =
  | 'none'
  | { status: 'loading' }
  | {
      status: 'ready';
      name: string;
      rows: number;
      metrics: readonly MetricId[];
      totalMetrics: number;
      ignoredColumns: readonly string[];
      missingMetrics: readonly MetricId[];
      columns?: readonly string[];
      columnMapping?: readonly { source: string; target: string }[];
    }
  | { status: 'error'; error: string };

/** The Arrow export. */
export interface ExportRequest {
  modality: Modality;
  view: View;
  filters: readonly Filter[];
  selections: readonly Selection[];
  columns: readonly ColumnId[];
  format: 'arrow' | 'csv';
}
export type ExportState =
  'idle' | { status: 'running'; rows: number; request?: ExportRequest } | { status: 'error'; error: string };

/** The linked brush: which panel set it, on which metric, over which interval. */
export interface SelectionState {
  from: PanelId;
  metric: MetricId;
  range: [number, number];
}

/** Global controls shared by every panel. */
export interface GlobalState {
  modality: Modality;
  view: View;
  filters: readonly Filter[];
}

/** The whole dashboard, as one value. */
export interface State {
  layout?: DashboardLayout | null;
  maximizedPanel?: PanelId | null;
  /** The server's current ingest version; null until the subscription first emits. */
  dataVersion: string | null;
  catalog: CompletedCatalog | null;
  global: GlobalState;
  selections: readonly SelectionState[];
  /** Ordered; the grid renders them in this order. */
  panels: readonly Panel[];
  /**
   * The cohorts the user defined. `current` and `all` are *not* here: they are
   * derived from `global` and `selection` so they can never drift from the top
   * bar (`docs/comparison-design.md`, "State changes").
   */
  cohorts: readonly Cohort[];
  study: StudyState;
  /** Ephemeral user-facing message; not part of the shareable URL. */
  notice: string | null;
  datasets: Readonly<Record<QueryKey, DatasetEntry>>;
  export: ExportState;
  exportDialogOpen?: boolean;
}

/** How many unreferenced dataset entries survive eviction. */
export const EVICTION_KEEP = 16;

/** Default options for a new panel. */
export function defaultPanelOptions(clip: ClipMode = 'p01p99'): PanelOptions {
  return {
    bins: 40,
    clip,
    xScale: 'linear', xRange: 'auto', yScale: 'linear', yRange: 'auto',
    yMode: 'count', layout: 'overlaid',
    quantiles: 'quartiles',
    useSelection: true,
    granularity: 'month',
    splitPresentation: 'overlay',
    cumulative: false,
    share: false,
    coverageWindow: 'all',
    coverageLogY: false,
    coverageCustom: null,
    boxSort: 'median',
  };
}

/** True for a chart whose x axis is the metric's and which therefore carries a brush. */
export function isValueChart(chart: PanelChart): boolean {
  return chart !== 'box' && chart !== 'table' && chart !== 'bars' && chart !== 'area';
}

/** Bin-count bounds the server also enforces. */
export const MIN_BINS = 10;
export const MAX_BINS = 200;

/**
 * The state a dashboard starts in, before the URL or the catalog say otherwise.
 *
 * The view is bold's canonical one, the same as `defaultDashboard`, so the view
 * select never shows `raw` for the instant between construction and the first
 * hydrate.
 */
export const INITIAL_STATE: State = {
  dataVersion: null,
  catalog: null,
  global: { modality: 'bold', view: canonicalViewFor('bold'), filters: [] },
  selections: [],
  panels: [],
  cohorts: [],
  study: 'none',
  notice: null,
  datasets: {},
  export: 'idle',
};
