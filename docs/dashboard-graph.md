# Dashboard Graph

Inputs, state, and outputs of the frontend command loop described in
`rewrite-architecture.md`. Drafted `2026-09-23`. This is the design of the
graph, not code; names are indicative.

The loop is:

```
sources ──map──▶ commands$ ──scan(reduce)──▶ state$ ──map──▶ projections
   ▲                                                            │
   └──────────── effects runner (fetch, WASM, export) ◀─────────┘
```

Everything left of `state$` is an input. Everything right of it is a
projection. The effects runner consumes two projections and produces commands,
which is the only way anything asynchronous re-enters the loop.

## Inputs

Each source is an observable that Angular or Vega already provides, mapped into
one command variant. Sources never touch state directly.

| Source                                                                            | Commands it produces                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global controls form (`FormGroup.valueChanges`, debounced on continuous controls) | `setModality`, `setView`, `setFilters`                                                                                                                                                                                                                                                        |
| Panel toolbar events                                                              | `addPanel`, `removePanel`, `movePanel`, `setPanelMetric`, `setPanelChart`, `setPanelGroup`, `setPanelOptions`, `requestPage`, `setPanelReference`, `removePanelCohort`, `revertPanelToSingle`, and `convertToComparison` from "Compare with…" or from "Compare selected (n)" on a split panel |
| "Save as cohort" in the filter actions                                            | `saveCurrentAsCohort`                                                                                                                                                                                                                                                                         |
| Cohort chips and the cohort editor dialog                                         | `addCohort`, `updateCohort`, `removeCohort`, and from "Compare across two date ranges" two `addCohort`s plus an `addPanel` carrying their ids                                                                                                                                                 |
| Vega selection signals (per panel directive)                                      | `brush` with a range, or `brush` with `null` to clear                                                                                                                                                                                                                                         |
| Router (`queryParamMap`, first emission and back/forward navigation)              | `hydrate`                                                                                                                                                                                                                                                                                     |
| Effects runner: query results                                                     | `dataArrived`, `dataFailed`                                                                                                                                                                                                                                                                   |
| Effects runner: data-version subscription (tRPC SSE)                              | `dataVersionChanged`                                                                                                                                                                                                                                                                          |
| Study file input                                                                  | `studyChosen` (a `File`), then from the runner `studyLoaded` or `studyFailed`, and `clearStudy` from the UI                                                                                                                                                                                   |
| Export button and runner                                                          | `requestExport`, `exportProgress`, `exportFinished`, `exportFailed`                                                                                                                                                                                                                           |

The command union, grouped:

```ts
type Command =
  // global controls
  | { t: "setModality"; modality: Modality }
  | { t: "setView"; view: View } // 'raw' | canonical policy id
  | { t: "setFilters"; filters: Filter[] } // catalog-validated
  // panels
  | { t: "addPanel"; kind: PanelKind; metric?: MetricId; cohorts?: CohortId[] }
  | { t: "removePanel"; id: PanelId }
  | { t: "movePanel"; id: PanelId; to: number }
  | { t: "setPanelMetric"; id: PanelId; metric: MetricId }
  | { t: "setPanelChart"; id: PanelId; chart: PanelChart } // ChartType plus the client-side 'density'
  | { t: "setPanelGroup"; id: PanelId; group: GroupField | null }
  | { t: "setPanelOptions"; id: PanelId; options: Partial<PanelOptions> }
  | { t: "requestPage"; id: PanelId; cursor: string | null }
  | { t: "setPanelReference"; id: PanelId; cohort: CohortId } // which cohort the differences subtract from
  | { t: "removePanelCohort"; panelId: PanelId; cohort: CohortId } // off this panel only
  | { t: "revertPanelToSingle"; id: PanelId } // "Back to single distribution"
  // cohorts
  | { t: "saveCurrentAsCohort" } // the one-click path; no payload, the reducer reads `global`
  | { t: "addCohort"; cohort: Cohort } // id and colour minted by the caller, re-minted on a clash
  | { t: "updateCohort"; id: CohortId; patch: Partial<Omit<Cohort, "id">> }
  | { t: "removeCohort"; id: CohortId } // drops it from every panel; see the revert rule
  | { t: "convertToComparison"; panelId: PanelId; with: CohortId | CohortId[] }
  // linked selection
  | {
      t: "brush";
      from: PanelId;
      metric: MetricId;
      range: [number, number] | null;
    }
  // url
  | { t: "hydrate"; url: UrlState }
  // data
  | { t: "dataArrived"; key: QueryKey; result: unknown; version: string }
  | { t: "dataFailed"; key: QueryKey; error: string }
  | { t: "dataVersionChanged"; version: string }
  // study
  | { t: "studyChosen"; file: File }
  | { t: "studyLoaded"; name: string; rows: number; metrics: MetricId[] }
  | { t: "studyFailed"; error: string }
  | { t: "clearStudy" }
  // export
  | { t: "requestExport"; columns: ColumnId[] }
  | { t: "exportProgress"; rows: number }
  | { t: "exportFinished" }
  | { t: "exportFailed"; error: string };
```

## State

One value. The reducer is the only writer.

```ts
interface State {
  dataVersion: string | null; // server's current ingest version
  catalog: Catalog | null; // metrics, filterable and groupable fields, per modality
  global: {
    modality: Modality;
    view: View;
    filters: Filter[];
  };
  selections: {
    from: PanelId;
    metric: MetricId;
    range: [number, number];
  }[]; // at most four distinct metrics
  panels: Panel[]; // ordered
  cohorts: Cohort[]; // the user's only; 'current', 'all' and the split groups are derived
  study: StudyState; // 'none' | { status: 'loading' } | { status: 'ready', name, rows, metrics } | { status: 'error', error }
  datasets: Record<QueryKey, DatasetEntry>;
  export: ExportState; // 'idle' | { status: 'running', rows } | { status: 'error', error }
}

interface Panel {
  id: PanelId;
  kind: PanelKind; // 'distribution' | 'grouped' | 'coverage' | 'sample' | 'comparison'
  metric: MetricId | null; // null for coverage and sample
  chart: PanelChart; // ChartType plus 'density'; constrained by kind, see below
  group: GroupField | null; // grouped, coverage, and optionally distribution facets
  options: PanelOptions; // bins, clip: 'p01p99' | 'p05p95' | 'none', logScale, useSelection
  cursor: string | null; // sample only
  cohorts?: CohortId[]; // comparison only, in draw order
  reference?: CohortId; // comparison only; absent means "the first"
}

type DatasetEntry =
  | { status: "loading"; version: string }
  | { status: "ready"; version: string; result: unknown }
  | { status: "error"; version: string; error: string };
```

Reducer behaviour worth stating:

- `setModality` resets `filters`, `selections`, and every panel's `metric` and
  `group` that the catalog says do not exist for the new modality. It does not
  touch `datasets`; entries simply stop being needed.
- `brush` sets/replaces one metric in `selections`; a null range removes it.
  `brush2d` sets/replaces both axes atomically. Up to four distinct metric ranges
  are accepted. Opted-in panels apply all entries except those whose `from`
  matches their own id; saved cohorts carry fixed selection lists. Clearing a
  chip removes only its metric, while Clear filters removes all entries.
- `dataVersionChanged` sets `dataVersion` and nothing else. Entries carry the
  version they were fetched at, so staleness is derived, not stored. Stale
  entries keep rendering until their replacement arrives.
- `dataArrived` writes a `ready` entry only if no newer version is already
  present for that key. Out-of-order arrivals from a superseded version are
  dropped.
- `hydrate` replaces `global`, `panels`, and `selections` wholesale from the URL
  after catalog validation, leaving `datasets`, `study`, `export`, and
  `dataVersion` alone.
- `studyChosen` sets `study` to loading. Rows never enter state; they live in
  the DuckDB-WASM instance owned by the runner. State holds the name, row count,
  and which metrics the file contained.
- Eviction: after any command that changes `panels`, `global`, or `selection`,
  entries whose key is no longer referenced by any panel are dropped, except
  the most recent N to make undo-like toggling cheap.

## Outputs

Every projection is `state$.pipe(map(f), distinctUntilChanged(eq))` on its own
slice. No projection reads another.

| Projection       | Slice it depends on                                                                                     | Consumer                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `needed$`        | `panels`, `global`, `selection`, `catalog`, `study.status`, `dataVersion`, `datasets` keys and versions | effects runner: fetch                                        |
| `panelView$(id)` | that panel, `global`, `selection`, its dataset entries, `catalog`                                       | Vega directive for that panel, or the CDK table for `sample` |
| `url$`           | `global`, `panels` minus `cursor`, `selection`                                                          | router                                                       |
| `studyLoad$`     | `study` when status is loading, plus the chosen file                                                    | effects runner: WASM ingest                                  |
| `exportRun$`     | `export` when status is running, plus `global` and columns                                              | effects runner: Arrow stream                                 |
| `chrome$`        | `catalog`, `global.modality`, `study.status`, `export`, `dataVersion`                                   | toolbar, filter bar, status line                             |

`needed$` is the effects contract. It is the set of query keys for which no
entry exists at the current `dataVersion`, and it always contains the catalog
key while `catalog` is null. The runner diffs successive emissions: keys that
appear start a fetch, keys that disappear cancel one. That is the entire
cancellation story.

`panelView$` returns a tuple, `{ spec, datasets, status }`, so spec and data
come from the same state. The directive diffs: spec changed, re-embed; only
datasets changed, push named datasets into the existing view; status changed,
toggle the loading or error overlay.

## Query keys and procedures

A query key is the canonical serialization of a procedure name and its
parameters. Two panels with the same parameters share one entry.

```ts
type QueryKey = string; // e.g. 'population/distribution?m=bold&v=k4plus&metric=fd_mean&bins=64&f=...&sel=...'

type Query =
  | {
      source: "population" | "study";
      proc: "distribution";
      modality;
      view;
      filters;
      metric;
      bins;
    }
  | {
      source: "population" | "study";
      proc: "groupedSummary";
      modality;
      view;
      filters;
      metric;
      group;
    }
  | {
      source: "population";
      proc: "coverage";
      modality;
      view;
      filters;
      group;
      granularity;
    }
  | {
      source: "population";
      proc: "sample";
      modality;
      view;
      filters;
      columns;
      cursor;
    }
  | { source: "population"; proc: "catalog" };
```

Procedures, with what they return:

| Procedure        | Returns                                                                                                                                            | Serves panel kinds                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `catalog`        | metrics per modality with family, subfamily, description, range hints; filterable fields with their value lists; groupable fields; available views | all                                            |
| `distribution`   | `n`, quantiles p01 to p99, min, max, mean, stddev, equal-width histogram at `bins`                                                                 | distribution (histogram, ECDF), comparison     |
| `groupedSummary` | per group value: `n`, quantiles, mean, stddev, and a histogram at a fixed bin count for small multiples                                            | grouped (box, faceted histogram, faceted ECDF) |
| `coverage`       | counts per time bucket per group value                                                                                                             | coverage (stacked bars, area)                  |
| `sample`         | rows for the allowlisted columns plus `nextCursor`                                                                                                 | sample (table)                                 |
| `dataVersion`    | subscription, emits the ingest version on connect and on change                                                                                    | runner                                         |
| `exportRows`     | streamed Arrow record batches for the filter set and columns                                                                                       | export                                         |

`study` as a source runs `distribution` and `groupedSummary` against the
DuckDB-WASM instance using the same SQL templates. A `study` cohort is what will
ask for it (`comparison-design.md`, "Study upload"); no cohort has that source
yet, so nothing issues a `study` query.

`distribution` also takes an optional `range: [lo, hi]`, which bins over exactly
that interval instead of the clip's quantiles and reports `underflow` and
`overflow` beside the bins. It is part of the query key. A comparison panel is
the only caller: every cohort of one panel asks for the same range, which is what
makes overlaid histograms share bin edges.

## Panel kinds and charts

| Kind         | Charts                                                 | Query                                                                    | Notes                                                                                                               |
| ------------ | ------------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| distribution | density, histogram, ECDF                               | `distribution`                                                           | optional `group` turns it into faceted small multiples via `groupedSummary`, and its groups become tickable cohorts |
| grouped      | box, faceted histogram, faceted ECDF                   | `groupedSummary`                                                         | box uses quantiles, no raw values needed                                                                            |
| coverage     | stacked bar, area                                      | `coverage`                                                               | group defaults to manufacturer, granularity month                                                                   |
| sample       | table                                                  | `sample`                                                                 | not Vega; CDK table with virtual scroll, paged by `requestPage`                                                     |
| comparison   | density, step histogram, overlaid ECDF, box per cohort | one `distribution` per cohort, then one per cohort over the shared range | one metric across two or more cohorts; see the 2026-10-07 cohorts note                                              |

Density and violin charts are excluded because they need raw values or
server-side kernel density estimation. They can be added later as a
`distribution` procedure option without changing the graph.

## Brushing

A brush is an interval selection on a distribution or comparison panel's
metric axis. It becomes `selection` in state. Every other panel with
`useSelection` on adds `metric between lo and hi` to its filters, so its query
key changes and `needed$` refetches it. The brushing panel shows the interval
but is not filtered by it. Brushes are debounced at the Vega directive before
becoming commands so a drag issues one refetch, not fifty.

`useSelection` defaults to true. Turning it off on a panel makes it a fixed
reference that ignores brushes, which is how a user compares a brushed subset
against the whole.

## What the graph does not contain

Hover state, tooltip positions, open or closed side sheets, the file picker's
own state, and the WASM instance itself. None of these decide what a user sees
for a given command history, so none of them are state.

## URL encoding (2026-10-09)

The only URL codec is the schema-positional six-bit stream described below.
A default dashboard produces an empty parameter value. Catalog identifiers,
typed filter values, series descriptors and layout rectangles are written
directly in the URL alphabet; there is no compression or base64 stage.

## Implementation notes (2026-10-01)

Implemented in `rewrite/packages/web/src/app/graph/`. Where the code departs
from the text above, the code is current:

- `PanelOptions.granularity` exists; coverage needs it.
- `DatasetEntry` has no live `loading` variant. Loading is derived from
  membership in the needed set, because a stored loading entry would remove
  its own key from `needed` and cancel its fetch.
- `Panel.cursors` is a chain of page cursors, not a single `cursor`, so sample
  pages accumulate instead of replacing each other.
- The runner diffs `(key, version)` pairs: a data-version change cancels
  in-flight fetches and restarts them; it waits for the first `dataVersion`
  before fetching anything so every entry is tagged with the version it was
  really fetched at.
- The first `hydrate` reads `window.location`, later ones are gated on the
  router having navigated, and no URL write happens before a real-URL hydrate.
  Initial navigation is blocking. This is what makes shared links survive a
  cold load.
- `decodeUrlState` never throws: every wire element is shape-checked and the
  whole decode is wrapped; a payload with nothing valid yields the default
  dashboard. Every source is wrapped in a `catchError` guard so no source can
  terminate the fold.
- Form sources are one stream per control with no stream-side memory; the
  reducer is idempotent instead (`setFilters` returns the same state reference
  when nothing changed).
- Eviction is LRU over unreferenced entries, keeping the last 16.
- Brush params are seeded from `selections` so a shared URL renders its
  intervals; entries are pruned when their panel or metric disappears.
- Coverage specs use UTC time units; the server's bucket starts are UTC.
- Historical note (superseded by the implementation sections below): study upload, comparison, and export had commands and reducer cases but no
  runner yet; comparison panels render disabled. A comparison panel with no
  ready study contributes no queries at all, not even the population half, so a
  shared link carrying one costs nothing, and the "+ panel" menu disables the
  comparison entry until a study is loaded.
- The dashboard opens on the canonical view: `k4plus` for bold, `k3pp` for T1w
  and T2w (`canonicalViewFor`, read off the authored views rather than
  hard-coded). `defaultDashboard`, `INITIAL_STATE`, the controls form's initial
  value and `decodeUrlState`'s fallback all use it, so a cold load, a crafted
  link and a link naming a view the modality lacks land on the same place.
  `setModality` keeps the view the user is on when the new modality has it --
  `raw` is common to all three, so an explicit choice of the raw log survives a
  switch -- and otherwise takes the new modality's canonical view, which is how
  bold/K4+ becomes T1w/K3++ instead of T1w/raw.
- The top bar's filter controls come from the catalog, not a list in the code:
  every categorical filterable field of the current modality _and_ view, in
  catalog order (`canonical_hmc_mode` therefore appears only on K4+). `created_at`
  belongs to the date-range picker. The numeric filterable fields get a
  two-ended min/max control each, from the same derivation, so
  `canonical_diameter` and `canonical_group_rows` appear on the canonical views
  only; the catalog's `numericRange` per field per modality and view supplies
  the placeholders. A control with both boxes empty contributes no filter;
  either box alone produces a `between` whose other end is the wide sentinel
  `±(2**52 - 0.5)` (`OPEN_LO`/`OPEN_HI`), which the URL round-trips, the form
  reads back as empty, and the DuckDB binding types as DOUBLE -- `MAX_VALUE`
  would bind as BIGINT and fail. A categorical field with more than 60 values
  renders a search box inside its panel and caps the options it draws; the
  values already selected are always drawn, because `mat-select` builds its
  trigger text from the options that exist. The form carries one control per
  categorical field and one range group per numeric field across every modality
  and view, so "Clear filters" clears all of them.
- `panelView` carries the stat row under a distribution or comparison chart
  (`n`, mean, SD, p05, median, p95, min, max at three significant digits, with
  the metric's unit). It is a projection of the `DistributionResult` the chart
  is already drawing, never a request of its own, and a panel's `n` is labelled
  "records with a value" wherever it counts finite metric values rather than
  records.
- `?mock=1` selects the in-browser mock API for that load only and shows a
  badge.
- Top-bar filter controls are derived from the catalog: every categorical
  field filterable for the current modality and view, so HMC mode appears only
  on K4+. Fields with more than 60 values get a search box inside the select.
  The numeric filterable fields (`echo_time`, `repetition_time`, `size_*`,
  `spacing_*`, and `canonical_diameter` / `canonical_group_rows` on the
  canonical views) have a debounced min/max pair each; `created_at` is the
  date-range picker. "Clear filters" clears every field in state.
- Distribution panels show a stat row (n, mean, SD, p05, median, p95, min, max)
  projected from the dataset entry; the count is labelled "records with a
  value" because the server's `n` counts finite values of the panel's metric.
- Panels have move-left / move-right buttons dispatching `movePanel`. The
  comparison menu item is disabled until a study is ready, and a URL-borne
  comparison panel issues no population query while no study exists.

## Implementation notes: the third view, quarantine, More filters (2026-10-06)

- Each modality now offers three views, not two: `raw`, the canonical policy
  output, and that policy output with its quarantined raw rows added back
  (`k4plus_all`, `k3pp_all`, labelled "Canonical (K4+) + quarantined raw" and
  "Canonical (K3++) + quarantined raw"). They are authored `ViewDef`s carrying
  the same `policy` and the flag `includesQuarantined`, so everything that was
  already derived from the catalog -- the view select, URL validation,
  `setModality`'s view-keeping, the filter fields of a view -- picks them up
  with no new case. `canonicalViewFor` is now "the first policy view that does
  not include the quarantine", so the dashboard still opens on the
  canonical-only corpus. `canonical_diameter` and `canonical_group_rows` (and
  bold's `canonical_hmc_mode`) are offered on the `_all` views too, where they
  are NULL on every quarantined row.
- `chrome.quarantine` is the active policy's refused counts, and the status line
  renders "N groups / M rows quarantined" from it. Non-null only on a
  canonical-only view: that is where the counts are what the figures on screen
  leave out. On `raw` there is no policy, and on an `_all` view the rows are
  already in every figure. The numbers come from `meta.policies` through
  `CompletedCatalog.quarantine`; the dashboard never counts them itself.
- The eleven two-ended numeric range controls and the date-range picker moved
  into a collapsible "More filters" section below the primary row, which left
  the primary row one line: modality, view, and the categorical filters. The
  section is collapsed by default and auto-expands when one of its own filters
  is in force, so a shared link that carries a range opens showing the control
  that explains it; a badge counts those filters. The open/closed state is a
  local signal in `TopBar` -- ephemeral UI, never state, never the URL -- and an
  explicit click wins over the automatic rule until "Clear filters" resets it.
  `moreFilterCount` and `moreFiltersExpanded` are pure and unit-tested.

## Implementation notes: the usability pass (2026-10-07)

Applying the heuristic evaluation added two commands, one projection field set,
and nothing else to the shape of the loop. `state$` is still the only root and
no projection is recombined with another.

- **`retryKey`** forgets one dataset entry so `needed` asks for it again. It
  exists because an error entry _satisfies_ its key -- that is what stops the
  runner spinning on a failure -- so there was no other way back into the
  needed set. `neededQueries` no longer carries the catalog key "while the
  catalog is null": that clause retried nothing (the runner fetches a key that
  _enters_ the set, and this one never left) while keeping `pendingCount`
  above zero, which is what pinned the status line on "Loading the metric
  catalogue" for the rest of a session after a failed catalog fetch. The
  catalog key is now needed exactly when it has no entry at the current
  version, like every other key, and `chrome.catalogError` says so.
- **`restorePanel`** puts a removed panel back, whole, at the index it left.
  `addPanel` cannot: it mints a fresh id and fresh options. The removed panel
  itself is held in a local signal in `Dashboard` for the six seconds of its
  snackbar and nowhere else -- a toast is ephemeral UI -- but the undo goes
  through the reducer like every other change.
- `PanelStatus`'s error variant carries `retryKeys`, so the card's "Try again"
  knows which entries to forget, and `message` is the server's own words.
- `PanelView` gained `notes` (the qualifiers that follow the count: "brush
  source", "filtered by brush", "showing p01–p99") and `metricHelp` (the
  catalog's own description and family, for the card's info button). A sample
  panel's subtitle is "Showing N of M", where M is a sibling coverage panel's
  record total if the dashboard has one -- `corpusTotal` -- because the
  `sample` procedure answers with a page and no total. That is the one place a
  panel's view reads another panel's result, so it is in the memo's deps.
- `Chrome` gained `catalogError` and `brush`, the latter being the printed form
  of `selection` for the top bar's amber chip. "Clear filters" dispatches
  `brush null` as well: the brush is a filter in every way that matters.
- Categorical charts fold everything past the top eight groups by count into
  "Other" (`foldOther`, `foldBoxRows` in `panels/specs/rows.ts`), a pure
  transform on rows the panel already has, and the colour range is nine long so
  no hue is ever reused. `manufacturer` alone has 26 spellings in this corpus
  and drew a legend taller than its plot.
- Viewport breakpoints are signals off `matchMedia` (`chrome/media.ts`) and
  deliberately never reach the graph: a breakpoint is a property of the device,
  nobody can share it in a link, and folding resize events would re-derive the
  dashboard on every drag of a window edge.
- `environment.features.studyUpload` (false) keeps the "Study comparison" entry
  out of the "+ panel" menu. Everything behind it -- commands, reducer cases,
  overlaid specs, the disabled card -- is untouched; the flag is the only thing
  to flip when a study picker ships.
- The sample table dropped the CDK virtual viewport for a single scroll
  container in both axes, which is what lets its first column be sticky. Its
  column chooser is local component state over rows already on the client: the
  `sample` query already asks for every exportable field, and the card was
  simply clipping most of them off its right edge.

## Implementation notes: the copy and labelling pass (2026-10-07)

Copy only: no command, no reducer case and no query changed. Everything below
is a pure projection, a template, a spec title or a catalog string, and the
rule behind all of it is in `docs/ui-style.md`, "Copy".

- **`panelMeaning`** composes one sentence per card from kind, chart, metric,
  group, granularity and the active `ViewDef`. It is the card's only standing
  prose, and it states facts about this data ("across 778,075 deduplicated BOLD
  scans"), never definitions. The taxonomy path it replaced moved into
  `metricHelp.taxonomy`, which the info popover draws. Its inputs are an
  explicit `MeaningInput` rather than a `State`, so each kind x view noun is a
  table-driven unit test.
- **`unitNoun`** is the one answer to "what is a row of this view": `uploads`
  on `raw`, `scans` on a policy view, `scans and unstable uploads` on an `_all`
  view. It is read off the `ViewDef` -- `policy` and `includesQuarantined` --
  so a fourth view needs no fourth branch, and it now feeds the count line, the
  stat row's first label (`statUnitLabel`, the short form), the sample
  panel's "Showing N of M scans", and the Vega count axis
  (`countAxisTitle`, which is why `MetricAxis` gained `countTitle` and
  `coverageSpec` a fourth argument). "Records" is gone from the UI: it was true
  of every view and so said nothing about any of them.
- **`clipChip`** replaced `clipNote`. The clip was a standing note on all five
  cards reporting that nobody had changed it; it is now a chip, and only when
  the clip is not the metric's `clipDefault`. `panelNotes` is down to what the
  brush is doing.
- **`fieldValueLabel`** in `@mriqc/shared` is the single place a stored
  categorical value becomes a display string: `NONE_LABEL` ("Not reported")
  for the null bucket, and a per-field table for the values whose stored form
  is not readable (`canonical_hmc_mode`: `afni` -> "AFNI (3dvolreg)"). Display
  only -- filters, query keys and shared links still carry the stored value --
  and it is in shared because the axis, the legend and the filter list must all
  answer the same way. The row builders in `panels/specs/rows.ts` therefore take
  the grouping field's id.
- `MetricDef.shortLabel` exists for the chip-sized places, the brush chip above
  all; every reader falls back to `label`. `fd_mean` gained `unit: 'mm'`, which
  the catalog had simply never recorded.
- A `packages/shared` surface change does not reach a running `ng serve`; see
  `rewrite/CLAUDE.md`.

## Implementation notes: cohorts and the comparison panel (2026-10-07)

Build step 2 of `docs/comparison-design.md`. The comparison panel kind existed
before this pass but meant one thing only -- this population against an
uploaded study -- and was hidden behind `features.studyUpload`. It is now one
metric across **two or more cohorts**, which covers all four comparisons the
design asks for, and nothing about it waits on study upload. The flag stays
`false`; step 3 adds a `source: 'study'` cohort behind it and no more.

### What a cohort is

- **`Cohort` in state** (`graph/state.ts`): `{ id, name, color, source, view,
filters, selection }`. `State.cohorts` holds the **user's** cohorts only.
  Three kinds are derived instead of stored, so none of them can drift from what
  they name:
  - `current` ("This dashboard") and `all` ("Whole population"), from `global`
    and `selection` (`currentCohort`, `allCohort` in `graph/cohorts.ts`);
  - one per group of a split field, whose id **is** its definition --
    `g\0<field>\0<value>`, decoded by `parseGroupCohortId`, compiled to this
    dashboard's filters plus `field in [value]` by `groupCohort`. A group cohort
    is named "<field label>: <value>" and takes that group's slot in the field's
    value list, so a cohort made from a split group wears the hue the group had.
    `addCohort` refuses one: storing it would be a second, driftable definition.
- **Colour** is a palette index, assigned once by the lowest-free rule
  (`nextCohortColor`) and never re-ranked, so adding or deleting a cohort
  repaints nothing already on screen. `current` holds slot 0 and `all` slot 1,
  both skipped by the rule. An index from a link is read modularly
  (`cohortColor`), because a `Cohort.color` is hostile input like anything else.
- **Naming is not a question.** `graph/cohort-name.ts` composes
  "BOLD · K4+ · Siemens · 2019–2021 · FD mean 0.1–0.4" from the modality, the
  view, the filters, the date years and the brush, in that order -- the order of
  how much each one narrows the corpus -- dropping every part that says nothing
  and falling back to "all". `uniqueCohortName` adds " (2)". That is what makes
  `saveCurrentAsCohort` a single click with no dialog, which is how almost every
  cohort is made; the editor is for changing one.

### Commands

`saveCurrentAsCohort` (no payload: the reducer reads `global` and `selection`,
which is what makes it a snapshot), `addCohort` / `updateCohort` /
`removeCohort`, `convertToComparison` (whose `with` is one id _or a list_, so
"Compare selected (3)" off a split panel arrives as one command and the panel
never passes through a state comparing something nobody ticked),
`removePanelCohort`, `revertPanelToSingle`, `setPanelReference`. `addPanel`
gained an optional `cohorts`, which is how "Compare time spans" opens a panel
over the two cohorts it just created.

`addCohort` carries the whole cohort, id included, because the caller has to be
able to name the thing it just made -- "New cohort…" dispatches it and then
`convertToComparison` with the same id. `mintCohortId` and `nextCohortColor` are
the pure helpers a component calls; the reducer re-mints anything that collides.

### The revert rule, in three places

`pruneCohortRefs` drops ids no cohort answers to and turns a comparison panel
with fewer than two cohorts back into a **distribution** panel keeping its
metric and options -- a comparison of one cohort _is_ a distribution, and
turning it into an empty card would make deleting a cohort destroy a panel. It
runs from `hydrate`, `setModality`, `removeCohort` **and `restorePanel`**: a
cohort can be deleted inside the 6-second undo window, and a restored panel
naming a dead cohort would sit in the comparison empty state and write that id
into the shared link. `removePanelCohort` and `revertPanelToSingle` reach the
same transition deliberately, which is the visible way back the options menu's
"Back to single distribution" offers.

### The two-step fetch

`panelQueries` emits one `distribution` per cohort with no `range`; once all of
them are present, one per cohort carrying the **shared range** -- the union of
each cohort's p01/p99, or min/max when the clip is `none`. The union and not the
intersection, because a grid that cut off one cohort's bulk would lie about
which cohort is wider, which is the failure independently-binned overlays have.

- The ranged keys are **extra**, not replacements, so the statistics do not
  blink while the bars refetch; `range` is in the query key, so a moved quantile
  refetches the histograms by itself.
- `CohortExtent` distinguishes "no result yet" (`null`, which postpones the
  range) from "result present, no extent" (`'empty'`, which is _skipped_). One
  `null` for both meant a single cohort matching nothing blanked every cohort's
  bars for good, over a card that then claimed "No records match these filters."
- `statusOf` takes a `required` subset: a comparison panel is `ready` after step
  one, with `PanelView.partial` true and a quiet "Matching bin edges…" chip,
  because a spinner over a complete statistics table and a real ECDF would be a
  lie about what is on screen. A step-two-only _failure_ is demoted the same way
  (`status.failedExtra`, a "Bars unavailable" chip beside the chart) rather than
  replacing the card. The no-rows overlay is gated on `!partial` for the same
  reason.
- **`trpc-api.ts` has to forward `range`.** It did not, at first, and nothing
  failed loudly: the server clipped each cohort to its own quantiles, the two
  histograms came back on _different_ grids, and the only visible sign was a
  blank KS cell -- because `sameGrid` refuses to compare curves over different
  grids. That guard is the reason the bug was found at all. `MockApi` re-bins a
  seeded distribution over the requested range (`rebin`) rather than inventing a
  fresh one, so a component test sees a genuinely shared grid.

### The brush and `current`

`panelCohorts` substitutes `effectiveSelection` for `current`'s own range, so
the panel that drew a brush is not filtered by it and a panel with "Follow the
brushed range" off is not either. A _user_ cohort keeps its own metric range
untouched -- a cohort is a fixed reference by construction, which is what makes
"this brushed subset against that cohort" a comparison rather than two moving
halves. `brushable` is chart-aware on a comparison panel: the box has no
interval to drag, so switching to it clears the brush rather than leaving it
filtering the dashboard from a card that no longer shows it.

**Two cohorts can share one key.** With no global filters, `current` and `all`
_are_ the same slice, so `panelQueries` yields two queries and `needed` one
entry. That is the query key doing its job.

### Charts

`panels/specs/comparison.ts`: one dataset, `COHORTS_DATA`, whose rows carry a
`cohort` **id** and a `label`, and a colour scale whose domain, range and
`labelExpr` are declared from the cohort list -- so a cohort whose query has not
landed keeps its hue and its legend slot. Keyed on the id and not the name
because two cohorts can legitimately share a name (two unnamed ones are both
"Cohort", two duplicates are both "X copy"), and a name-keyed series merged them
into one: a single ECDF line zigzagging through both curves, two boxes on one
row, one legend entry. One unit spec rather than a layer per cohort, because the
cohort list is state and a layered spec would be re-embedded -- losing the brush
-- on every addition.

Four charts: `density` (the default), `overlaidHistogram` (a `step-after` area
over the shared bin edges, with a closing point at the final upper edge so the
last bin is drawn full width), `overlaidEcdf`, and `box`. All of them are
translucent areas or lines with 2px outlines, so the legend's swatch is a stroke
rather than a filled square. Grouped bars were the first attempt and read as
zebra striping; see the design doc.

`density` is **not** in `@mriqc/shared`'s `ChartType`. It is a kernel smoothing
of a histogram `distribution` already returns, so the server has no opinion
about it and never needs one -- `ChartType` is in shared only because the URL
carries a chart name. `graph/state.ts` widens it locally as `PanelChart`. The
maths is in `graph/comparison-stats.ts`: `silvermanBandwidth`, a floor of 1.5
bin widths, and a plain convolution normalized analytically rather than by the
kernel's mass over the finite grid (grid normalization keeps a flat histogram
flat but inflates the edges, so a spike in the second bin came out taller in the
first). The property that buys: a single spike smooths to a Gaussian of exactly
the chosen bandwidth, which is the test.

### The statistics table

`comparisonStats`: one row per cohort in the cohort's hue -- which is the legend
in text form -- with n, mean, SD, p05, median, p95, the count column named in
the view's own noun (`statUnitLabel`, not a hard-coded "SCANS"). Then a
differences block against a **selectable reference**, one row per other cohort,
and an "All pairs" KS table behind a toggle with the largest distance in full
ink. KS is `max_k |F_a − F_b|` over the two share-normalized cumulative
histograms on the shared grid, each curve **offset by its own underflow mass** --
over a shared range one cohort can have mass below `lo` that the other does not,
and starting both at zero would hide exactly the difference the statistic exists
to find. Every KS value is written `≈ 0.0279`, because the supremum can fall
inside a bin. The count line is a chip per cohort: a single total would be the
sum of cohorts that overlap, which counts nothing.

### Chrome

- The categorical filter select is a component (`chrome/filter-select.ts`, a
  `ControlValueAccessor`). It was an `ng-template` outlet twice inside the top
  bar; the cohort editor needs the same control over the same value lists, and
  an embedded view cannot be shared across components -- a template resolves
  `formControlName` against the group it is _declared_ in.
- The filter group ends in one action cluster (`filter-actions`) with
  `self-end`: a select is a 12px caption over a 36px control, so a bare button
  centred in that line sat 8px high. The `.btn-amber` "Save as cohort" is the
  only amber-outlined control on the page -- amber means "state you created",
  and a _filled_ amber button would outrank Modality and "Scans shown", which
  decide more.
- The rule between the primary group and the filters is a `border-left` on a
  grid column rather than an element, so it is exactly as tall as the group it
  separates; beside a one-line filter group at 1200px a full-height element was
  165px of line against nothing. It is dropped below 1300px and the groups stack.
- The cohort chip row exists only once a cohort does. "This dashboard" and
  "Whole population" have no chips: they always exist, and a chip apiece was two
  rows of furniture on every dashboard that had none of the user's.
- The editor is a `MatDialog`, dynamically imported from each of its openers --
  statically imported it pushed the initial bundle past its budget for a dialog
  most sessions never open. Its footer carries a live match count fetched by the
  dialog itself: a debounced, `switchMap`-cancelled, component-local request that
  never enters state. That is a deliberate exception to "only the runner
  fetches", and the alternative -- routing an unsaved draft through the command
  loop -- would put a draft nobody has saved into the thing that decides what the
  whole page shows.

### Fixes this pass made elsewhere

- `clipBounds` tests `!summary.quantiles` rather than `=== null`, and
  `differenceNumbers` likewise. A fuzz sequence found the first: the shared range
  is read from results _inside query-key construction_, which `referencedKeys`
  calls from the reducer's own `evict`, so a result whose shape is not a
  `DistributionResult` threw out of the fold and froze the dashboard.
  `graph/queries.ts` also guards the shape (`distributionResult`) before any key is
  built from it.
- `sameGrid`'s tolerance is relative with no floor; a floor of 1 made the test
  absolute for small magnitudes, where two genuinely different grids compared
  equal.
- `uniqueIds` seeds its taken-set with every id in the list, not only the ones
  walked past: re-minting against a partial set could hand a duplicate an id a
  later element still owned.
- The `+ panel` menu offers every kind. "Compare cohorts" used to be hidden
  behind `features.studyUpload`; two cohorts always exist, so it always produces
  a panel that draws something.
- The initial-bundle error budget went from 1 MB to 1.1 MB. The feature is worth
  about 8 kB over the old cap after the editor was already made lazy.

## Implementation notes: the module map and the compact URL (2026-10-07)

A refactor pass. No command, no projection and no query changed meaning: the
same 494 tests pass before and after, with eight added for the new URL format
(the size targets, the version character, a captured pre-token link, and the
round-trips that lock the grammar’s escaping). `state$` is still the only
root, projections are still never recombined, and nothing subscribes but the
edges.

### One table per panel kind

`graph/panel-kinds.ts` holds `PANEL_KINDS`, one row per kind, and everything
that used to be a `switch (panel.kind)` is a lookup in it: which procedures the
kind asks for and how its queries are planned, which charts it may draw and
which it opens on, the sentence its card says, the spec builder that draws it,
its menu label, its empty-state message, and the yes/no facts the rest of the
dashboard asks -- does it carry a metric, a split, a cohort list, a stat row, a
brush, a scrolling table, a row total. Five switches (23 arms) and some
thirty-odd per-kind `if`s went; a sixth panel kind is a row in that table plus
a spec builder, and the compiler names every place that has to answer for it.

Where a rule genuinely differs per _procedure_ rather than per kind -- which
parameters a query carries -- the switch stayed, in `graph/queries.ts`, over
`Query['proc']`.

### Module map

| module                    | what is in it                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `graph/state.ts`          | the state shape and its plain-data vocabulary                                                                    |
| `graph/commands.ts`       | the command union, `PanelPatch`, and the alias normalizers `panelPatch` / `cohortChange`                         |
| `graph/panel-kinds.ts`    | `PANEL_KINDS`, and `CHARTS_BY_KIND` as a projection of it                                                        |
| `graph/queries.ts`        | query planning: `panelQueries`, `panelKeys`, `needed`, the two-step shared range, cohort → query                 |
| `graph/cohorts.ts`        | cohorts: the derived ones, the chips, and minting / validating / patching a stored one                           |
| `graph/panels.ts`         | the rules about a panel's shape: `newPanel`, `patchPanel` and its validation table, retargeting, the revert rule |
| `graph/filters.ts`        | `validFilters`, `sameFilters`, and the two open-end sentinels                                                    |
| `graph/datasets.ts`       | `touch` and `evict` over the datasets map                                                                        |
| `graph/reducer.ts`        | the fold, and nothing else                                                                                       |
| `graph/url.ts`            | `UrlState`, `urlState`, `encodeUrlState` / `decodeUrlState`, `validateUrlState`                                  |
| `graph/url-tokens.ts`     | six-bit reader/writer, catalog tokens, scalar codecs and limits                                               |
| `graph/url-fields.ts`     | declarative record schemas walked in both directions                                                         |

| `graph/graph.ts`          | the loop: sources, `scan`, the projections, the three edges                                                      |
| `graph/effects.ts`        | the runner                                                                                                       |
| `view/text.ts`            | the card's words: unit nouns, the meaning line, notes, chips, `significant`                                      |
| `view/stats.ts`           | the stat row and the whole comparison table                                                                      |
| `view/panel-view.ts`      | `panelView`: status, datasets, the memo                                                                          |
| `view/chrome-view.ts`     | `chrome` and `chromeEquals`                                                                                      |
| `chrome/controls-form.ts` | the reactive form and the form ↔ `Filter[]` mapping                                                              |
| `panels/specs/select.ts`  | which spec builder and which row transform go together, per kind                                                 |

`graph/projections.ts` is gone; its contents are the `view/*` modules plus
`graph/queries.ts` and `graph/cohorts.ts`. `graph/projections.spec.ts` keeps its
name and covers the lot.

### One path per kind of change

- **`patchPanel(id, patch)`** replaced `setPanelMetric`, `setPanelChart`,
  `setPanelGroup`, `setPanelOptions` and `setPanelReference`. The five are kept
  in `commands.ts` as aliases that normalize into a patch, because the
  components and the tests that dispatch them outnumber by three times the ten
  call sites a rename would have been worth, and a one-field command is a
  readable thing to dispatch. `PANEL_FIELDS` in `graph/panels.ts` is the
  validation table: which kinds accept each field, how its value is checked,
  and whether writing it can change a query key (so the entry is evicted and
  the brush pruned) or not (`reference` changes no query).
- **`patchCohort`** is the one path `addCohort`, `updateCohort`,
  `patchCohort` and `saveCurrentAsCohort` take, so the cap, the reserved ids,
  the group-cohort refusal and the catalog validation are stated once. It
  returns the new list rather than a state, which is what keeps `graph/`
  acyclic.
- Restrictions the per-field commands did not have, and now do: a coverage or
  sample panel no longer accepts a metric, and a sample or comparison panel no
  longer accepts a split field. Nothing on screen could set either; a link
  could, and the value it set was written back into the link and read by
  nothing.

## URL format (2026-10-09)

A non-default `s` begins with schema version `1`, followed by characters from
`ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_`.
`BitWriter.write(bits, value)` and `BitReader.read(bits)` operate directly on
this alphabet. No JSON, field keys, delimiters, deflate, dictionary or base64
layer remains. Unknown versions, invalid alphabet, truncation, trailing data
and nonzero padding are rejected. The router falls back to the default dashboard.

`url-fields.ts` declares one table each for dashboard, panel, series, filter,
selection, layout entry and cohort. Common and additional panel options use
separate tables so common adjustments do not pay for every analysis option.
Each table names a field, its codec and its default. Both directions walk
that same table in order. A presence bitmap uses one character per six optional
fields; only non-default values follow. A saved cohort's source is implicitly
population, so that constant takes no presence bit or value.

- Omitted panels mean `defaultDashboard().panels`; an explicit empty list
  still means no panels. A completely default dashboard encodes as an empty
  string. Defaults for individual panel IDs and quantities are positional.
- Catalog IDs use prefix-free one- or two-character tokens. Enums use one
  character. Small integers/list lengths use one character; 63 is an escape
  followed by two characters for larger values. Input and list limits remain
  bounded, including the 4096-character parameter limit.
- Range and brush endpoints carry a sign, three significant digits and an
  exponent in three or four characters. Filter numbers retain their exact
  decimal spellings with length-prefixed, packed decimal digits. Open bounds
  retain their exact sentinels.
- Plain dates occupy three characters as signed days since 2000-01-01.
  Timestamp filter bounds keep their original text, including timezone and
  fractional seconds; they are never truncated to a day.
- Pinned categorical values use indices. Live catalog counts and ordering
  never determine the wire vocabulary. Free text has a byte-length prefix;
  alphanumerics and spaces cost one character, other UTF-8 bytes are escaped.
- Series are records, not escaped JSON. Saved-cohort references use cohort
  positions, including positional defaults when comparing saved cohorts.
  Custom identities remain supported. Study rows and stored study cohorts
  never enter a link.
- Layout entries follow panel order, so geometry repeats no panel IDs or list
  length. Coordinates equal to derived geometry are omitted. Geometry equal
  to the complete derived default is omitted altogether; partial layouts
  retain which entries were absent. Maximized panels use a positional reference.

The available `url-shortening.spec.ts` scenarios currently measure **0, 25,
45, 18 and 26** characters: default, three filters, cohort comparison,
split/custom range, and explicit layout. The requested 14/18 limits for the
last two remain failing assertions. The referenced scratchpad benchmark was
not present in this checkout. All lengths are already URL-safe characters.

`fflate` remains a web dependency solely for ZIP study uploads; URL code
does not import it. The former URL codecs and their migration fixtures are
removed. Changing schema order, defaults or token meanings requires a future
schema version.

## Implementation notes: local study upload (2026-10-07)

Build step 3 of `docs/comparison-design.md` uses the existing graph rather than
adding a second store or a parallel dashboard path.

- The browser owns a `StudyApi` beside the server `Api`. Query dispatch is
  source-aware: population queries go to tRPC, while `source: 'study'`
  distribution and grouped-summary queries go to the local runner. The runner
  lazy-loads DuckDB-WASM only when a study is first used. Angular serves the
  pinned package's matching `eh` WASM and classic worker as unchanged assets;
  the
  normalized rows remain in its single in-memory `study` table and never enter
  graph state or a network request.
- MRIQC group CSV and TSV files and zips of per-scan MRIQC JSON files converge
  on one normalization path. Source keys use the shared `normalizeColumnName`
  rule; the first source column wins a normalized-name collision, while later
  collisions and unknown columns are ignored but retained by source name in the
  upload summary. The resulting catalog metric ids drive availability.
- SQL is not duplicated in the browser. Distribution and grouped-summary use
  the templates in `@mriqc/shared`; their identifiers and values are compiled
  through the shared filter core. The population runner provides its validated
  view/table context, and the study runner validates against the columns it
  actually loaded.
- `StudyState` contains only lifecycle and summary data: loading, error, or the
  ready file name, row count, available and missing metrics, total metric count,
  and ignored columns. `studyCohort` derives the reserved `My study` cohort only
  from a ready state, giving every panel one stable id without putting a study
  cohort in `State.cohorts` or the URL.
- The gated upload UI accepts `.csv`, `.tsv`, and `.zip`, reports loading and
  parse/load failures, and on success shows scan count, metric coverage, and the
  ignored-column list. The top status line names the loaded study and provides
  the clear action. Comparisons that include `My study` disable metrics absent
  from the file, and a distribution card offers "Add my study" only when its
  metric is available.
- Choosing a replacement or clearing the study cancels the previous load and
  removes cached `study/` datasets. Clear also removes the derived cohort from
  every panel; `pruneCohortRefs` applies the existing fewer-than-two-cohorts
  rule, so an affected comparison becomes a distribution instead of a broken
  card. A link never carries study rows or the derived cohort. If hydration sees
  that its decoded payload had referenced a study, validation prunes the
  reference and `Chrome.notice` explains that the study was not included.
- File loading is an effects edge: `studyChosen` and `clearStudy` originate in
  the UI command source, `runStudyEffects` performs/cancels the asynchronous
  work, and `studyLoaded` or `studyFailed` re-enters through the feedback
  channel. Local queries use the existing `needed$` effects edge. `state$`
  remains the single root, every view remains a direct state projection, and no
  projection is recombined with another.

The browser end-to-end pass uploads the 300-row BOLD fixture, observes
`n = 300` and approximate KS `0.216`, switches to ECDF, sees the derived cohort,
then reloads the shared URL and observes the notice plus the normal revert. It
records zero console errors. File choice to `studyLoaded` is 1,355.6 ms in that
Chromium run. The EH WASM is 34,242,586 bytes raw and 7,639,912 bytes with
gzip -9; the development server used for the run sends the raw asset.

## Implementation notes: theme, About and packed panels (2026-10-08)

- `Theme` owns only per-viewer System / Light / Dark convenience state.
  Storage reads/writes use `try/catch`; System follows the media query and
  removes `data-theme`, while explicit choices stamp `<html>`. This does not
  enter the analytical command loop, saved state or the `s` query parameter.
  The root prepaint script restores an explicit preference before Angular.
- `PanelCard` passes the current immutable `ChartTheme` to `panelView$(id,
  theme)`. That observable still maps directly from `state$`; it does not
  recombine projections. Theme is part of the memo/spec key, so the existing
  chart edge finalizes and re-embeds Vega with the new axis, surface, selection
  and series colours. Spec builders remain pure, with light defaults for old
  callers. Material and CSS use matching light and dark tokens.
- The application shell is a router outlet with the dashboard at `/` and a
  lazy About page at `/about`. `about$` derives runtime catalog counts, latest
  upload date and ingest version directly from `state$`. The page subscribes
  only at its UI edge. The deduplication, stability and views anchors support
  direct links; navigation in either direction preserves `s`. No extra API
  request or parallel state root is introduced. Population counts sum the
  complete magnetic-field-strength partition, including its missing bucket;
  incomplete/capped catalog partitions are shown as unavailable.
- `PackedGrid` is a DOM-only layout directive. It observes each card's natural
  inner content, includes its borders, and computes
  `ceil((height + 16) / (8 + 16))` rows. Resize and content changes coalesce into
  one animation-frame write; observers disconnect on destruction. Analytical
  state never receives measurements. Placement is ordered, never dense;
  comparisons span two columns only on three-column layouts. The old last-card
  expansion is retired. Ordered wide cards can leave holes: the measured
  default desktop layout has 16px gutters and one 496px hole above a comparison.
- All categorical presentations cap at six named series plus neutral Other.
  Comparison queries still request each original cohort on the shared grid;
  the view pools the tail after results arrive. This is a union of memberships,
  not a deduplicated union of scans: overlapping cohorts contribute repeatedly.
  Other's quantiles are estimated from bins and marked approximate; a quantile
  beyond the shared grid is unavailable. The chart legend, chips and statistics
  share the same displayed series and theme colours. No server contract changed.


## Implementation notes: axes and analysis charts (2026-10-08)

- `Panel` has x/y/split/cohorts/chart; no stored kind, metric, group or singular
  cohort field. `graph/panel-shapes.ts` replaces `panel-kinds.ts`. Its shape
  lookup drives chart validation, while old kind names remain add-menu
  presets. `setPanelAxis` and `setPanelSplit` flow through the existing reducer
  path. Split plus multiple cohorts is refused with a notice; converting a
  split to a comparison drops the split with a notice. The current URL stream
  carries quantities, series, forms and analysis options directly.
- `api/api.ts`, the tRPC adapter and query planner explicitly cover both new
  procedures, removing the initial TS2366 failures. `view/analysis-view.ts`
  derives chart data, stats and status from one state snapshot. Density
  comparisons request individual clipped bounds before requesting shared
  grids. Correlation and clustering describe the first bound cohort.
- `panels/specs/analysis-charts.ts` builds density/contour, correlation and
  cluster specs. Pure marching-squares, Fisher intervals, hierarchical matrix
  ordering and standardized seeded k-means have bounded numerical tests;
  renderer tests also compile the matrix through Vega-Lite. The cell-click
  edge sends an atomic axis/chart edit through the same command stream.
- `study/cluster-effects.ts` subscribes only at an effect edge to `state$`,
  starts/cancels workers by query/k/seed/version, and feeds ordinary
  dataArrived/dataFailed commands back to the single loop. Worker assignments
  live in versioned datasets and are protected by referencedKeys; they are
  not URL state. No projection is recombined with another projection.
- `study/study-analysis.ts` compiles both new shared templates using the
  existing `study-sql.ts` binder; `StudyRunner` executes them in the browser
  and closes connections. Template identity and result-shaping tests cover
  both procedures; a real uploaded 300-row study was exercised in the browser.
- The 32px theme button cycles System, opposite OS theme, same OS theme,
  System with SunMoon/Sun/Moon and explanatory tooltips. This remains viewer
  state outside the analysis loop. The Scans shown caption has an info popover
  with its explanation and `/about#views`; the floating duplicate link is gone
  and the quarantine chip remains. Second-metric disclosure and other
  ephemeral controls remain local component state.
- Linked 2D brushing and median-over-time bands now use the existing API's
  `selections` and `timeSummary` contracts. No server source changed.

## Implementation notes: selection lists and median bands (2026-10-08)

- `State.selections` retains a source panel per metric; `Cohort.selections`
  snapshots only metric/range pairs. The reducer owns replacement, per-metric
  clear, the four-metric cap, atomic two-axis updates and pruning. Query planning
  includes the list in every data query and excludes the source's own entries.
- The stream codec carries global and saved-cohort selection lists.
  Both are validated for distinct, finite, ordered ranges.
- `medianBand` is the default time-plus-metric shape in `panel-shapes.ts`.
  `view/time-view.ts` derives status, named datasets and per-series first/last
  median statistics from one state snapshot. The web query union adds the
  separately exported `TimeSummaryQuery` locally, preserving shared compatibility.
- Split bands show six named series plus neutral Other. A second query obtains
  exact categorical-tail quantiles where its values are enumerable from the
  first response. Numeric bins and the backend's already-folded tail use a
  clearly labelled approximate Other; see `analysis-design.md` for the limit.
- `study-time-summary.ts` compiles the shared template with identifier checks,
  all selections, and filter/selection/window binding order. Its template
  identity test and a real timestamped study upload cover that execution path.
- `VegaViewDirective` has a distinct two-axis signal output, debounced and
  guarded during data pushes. A render/data update never becomes an analytical
  command. No projection is recombined: `state$` remains the sole root, and
  subscriptions remain at existing UI, URL and effect edges.


## Implementation notes: axes, explicit geometry, and exports (2026-10-09)

- Panel axis options are xScale/xRange, yScale/yRange, and yMode. Custom
  ranges feed the shared-bin query plan; distribution evidence gates positive
  log axes, with symlog available otherwise. Split layouts are overlaid,
  stacked, or stacked100; cohort stacking is disabled because scopes overlap.
- The earlier PackedGrid and span-based notes are superseded. graph/layout.ts
  derives preferred sizes and first-free placement on twelve columns, then
  performs vertical collision resolution and compaction. State.layout stays
  absent/null until movePanel or resizePanel snapshots the derived geometry.
  Add/remove reconcile explicit rectangles; resetLayout clears the snapshot.
  Pointer previews do not dispatch until release. Keyboard arrows move,
  Shift+arrows resize, and a live region announces the dimensions.
- State.maximizedPanel is URL state; maximizePanel and Escape preserve layout.
  Narrow viewports stack rectangles in (y,x) order and hide drag handles.
- The URL stream stores geometry positionally and omits derived defaults;
  see the URL format section for the current schema.
- Export effects snapshot scope, abort on cancellation, count Arrow record
  batches, and produce an Arrow or client-converted CSV Blob. Columns use the
  server route's comma-separated parameter; filters and selections are JSON.
  Arrow is imported only when export begins. exportFinished hands the Blob to
  the browser download edge and revokes its temporary Blob URL.

Chart-container ResizeObservers update Vega width/height on the next frame;
these measurements never set card geometry. The dashboard route and Arrow
export runtime load on demand to retain the existing production size limit.

## Implementation notes: Quantity · Series · Form (2026-10-09)

Panels are quantities and series rendered in a form, not kinds. New command
payloads are:

| Command | Payload and effect |
|---|---|
| `addPanel` | optional `x`, `y`, `form`, `series`; creates a valid quantity |
| `setPanelAxis` | `id`, `axis`, `value`; keeps the form when still valid |
| `setPanelForm` | `id`, `form`; validates through `formsFor` |
| `addPanelSeries` | `id`, `series`; validates descriptor, mixing and cap |
| `removePanelSeries` | `id`, `key`; removes the stable descriptor key |
| `addGroupToPanels` | `id`, optional `panelIds`; adds a saved group where capacity permits |
| `patchPanel` | `id`, `patch`; normalizes axes, forms, options and series |
| `addCohort` / `updateCohort` / `removeCohort` | saved-group storage; deletion also prunes references |
| `requestPage` | `id`, `cursor`; extends Table's ephemeral page chain |

Old command aliases remain read-compatible for callers; active controls use
the quantity/series/form commands. The URL stream carries only the current
panel model. `panelCohorts` resolves every form's series through the
same filters/brush machinery. Query keys deduplicate network work while
preserving distinct semantic series in projections, even when their rows
coincide. The default dashboard has four metric histograms and Uploads over
time, all with empty series lists.


The sole URL codec is the version-1 six-bit stream, with one-character form
tokens derived in `formsFor` order. The default dashboard emits no `s`
parameter. Undecodable streams restore it with a notice; shared numeric ranges
round to three significant digits. Legacy codecs and compression dictionaries
are removed. The fflate dependency is removed; ZIP study uploads use native
raw-DEFLATE and stored-entry parsing with integrity checks.

Scroll behavior is part of the same URL integration:

- The router disables scrollPositionRestoration so state mirrored into the
  s query parameter leaves the viewport alone. anchorScrolling stays enabled
  for About links. Query-only navigation uses the default RouteReuseStrategy
  and retains the same Dashboard component instance and host element.
- Scroll handling does not change history policy: Graph.syncUrl still uses
  router.navigate and the existing urlSyncMode/replaceUrl decision. Form and
  series changes push; hydration canonicalization replaces. Back hydrates
  the previous state without an extra history entry or a scroll reset.
- dashboard-navigation.spec.ts asserts component and host identity across
  changed s parameters and a return to the original URL. The standalone
  packages/web/e2e/scroll-position.spec.mjs uses the existing servers and real
  API: at a 1100 x 800 viewport, p3 changes Histogram to ECDF, adds Whole
  population, and traverses Back twice. It checks URL/history, restored
  controls, and component identity. Recorded scrollY values were 900 before,
  900 after Form, 900 after adding the series, and 900 after each Back.
