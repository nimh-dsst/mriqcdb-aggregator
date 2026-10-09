# Unified Panels and Analysis Modes

Design addendum to `dashboard-graph.md`, `comparison-design.md` and
`backend-graph.md`. Decided `2026-10-08` with the owner: collapse the five panel
kinds into one panel model, and add 2D density (scatter), correlation and
exploratory clustering.

## Invariants (stated by the owner; every brief is checked against this list)

1. **One chart list everywhere.** There is one fixed, ordered list of forms;
   every card's picker is a view of that same list, never a different list.
   A form that physically cannot draw the card's axes is hidden (occluded);
   a form that would work after one step (adding a second column) stays
   visible but disabled, with "add a second column" as the reason and link.
   Time is a column like any other: the Y slot lists Upload time first; the
   only convention is that when one of the two columns is time it goes on x
   by default (swap is one click). The order never changes.
2. **A form is a drawing, named by its geometry.** Never a description of the
   data. Forms apply to scale types (continuous, categorical, metric set), not
   to columns; time is a continuous scale with month bins.
3. **A card is Rows × Quantity × Series × Form, and Quantity is always x AND y.**
   y defaults to Count, a quantity like any other; alternatives are Share
   or any column with an aggregate (median by default; mean, sum, min,
   max, a percentile). There are no card types underneath: a histogram is
   x = metric, y = Count; "Uploads over time" is x = time, y = Count; "FD
   mean over time" is x = time, y = FD mean (median); a heatmap is x and y
   both columns with Count in 2D cells. Forms draw y over x and nothing
   else (owner, 2026-10-09: "we've been through this already about the x
   and y axes"; "it really feels like you are continuing to try and keep
   the same shape").
4. **Every way of getting more than one series is a comparison**, chosen in
   the one Compare control. Split-by is a comparison. Comparisons can be
   multiple.
5. **Nothing retiles unless the user drags it.** Explicit geometry per panel;
   compaction only moves panels up and left into free space, never reorders.
   A card's geometry is fixed when it is created (from the preferred size of
   the form chosen then) and changes only by the user; changing the form or
   adding series later never changes size or position (owner, 2026-10-09:
   "why does changing the graph type change the panel size?").
6. **State changes are never page navigations.** Scroll position survives
   every change; URL mirrors state with the push/replace rule.
7. **No per-case UI.** A complaint is answered by the general rule that makes
   it impossible, written here first, then built once.
8. **Greenfield.** No legacy decoders, aliases or compatibility shims until
   something has shipped.

9. **Quantity is set in one place, in one go.** The column drawer has an X
   slot and a Y slot; the first pick fills X, the second Y; Create makes the
   card. Opening the drawer from a title pre-fills both, with swap. Choosing
   a two-metric form on a one-metric card opens the drawer on the Y slot.
10. **Axes are direct manipulation.** Drag along an axis to set its range,
   double-click the axis to reset to auto, "Zoom to brush" on the brush
   chip. The options menu shows the same numbers for exact entry. A custom
   range re-bins on the server (shared-range path), never a client crop.

11. **Every history-worthy change is undoable from the keyboard.** Ctrl+Z
   undoes, Ctrl+Y or Ctrl+Shift+Z redoes; a transient note names the step
   ("Undid: form → Density"). The push/replace predicate that decides URL
   history entries decides what a step is, so Back and Ctrl+Z agree;
   continuous changes (brush drag, typing a range, axis drag) collapse into
   one step on release. Inside a text field the keys keep their native
   meaning. The stack lives in app state for the session, not in the URL.

## The one scheme (owner, 2026-10-09: "a solid continuous scheme to show data how I want to see it so that I can think of what I see")

Every card is one question with four parts. Nothing else exists on a card,
and every control, label, statistic, legend and default derives from these.
Any UI element that cannot be named as one of the four is a defect.

| Part | What it is | Where it is set |
|---|---|---|
| **Rows** | which records: the dashboard's filters, the row policy ("Scans shown"), the linked brush | the top bar only; never per card |
| **Quantity** | an x column of any type (metric, time, categorical field) and an optional y metric | the card title (popover) and "Add panel", through the same column picker, grouped *Time* / metric families / *Fields* |
| **Series** | zero or more ways to put groups side by side: `field` (top groups), `values` (chosen values of a field), `population`, `cohort` (saved group), `study`, `span` (earlier time window) | the one **Compare** chip input on the card |
| **Form** | how it is drawn, derived from the axis types (table below); plus scale, range, bins, layout in the options menu | the icon dropdown on the card; menu for the rest |

## The grammar (2026-10-09)

Every card is `{ x, y, aggregate, series, form, options }`:

| Part | Values | Default |
|---|---|---|
| `x` | any column: numeric metric, time, categorical field | — (chosen in the drawer) |
| `y` | `count` · `share` · any numeric column (or time) | `count` |
| `aggregate` | for a column y: `median` · `mean` · `sum` · `min` · `max` · `p05` … `p95` | `median` |
| `series` | zero or more: field groups (each group its own chip), chosen values, population, saved group, study, earlier span; numeric split by cut points | none |
| `form` | a mark, see below | by x and y |

Forms are marks over (x, y). The list never changes; a mark that cannot draw the
card's x/y is hidden; one that needs one more choice is disabled with that choice
as the reason.

| form | draws | needs |
|---|---|---|
| Histogram | bars of y per x bin (y = count: a histogram; y = column: the aggregate per bin) | continuous x |
| Line, Area | the same per-bin value as a line / filled area (stacked when series, Area as 100% share when y = share) | continuous x |
| Density | smoothed y per x (y = count: kernel density) | continuous x |
| ECDF | cumulative y over x (y = count: the ECDF) | continuous x |
| Box | spread of y per series (y = count over x bins: the spread of bin counts; y = column: the column's spread) | any x |
| Band | quantiles of y per x bin: y = column → across the rows in the bin; y = count → across the series in the bin (one series: the line). Option `fill: band / lines` replaces the former "Lines" form; option `quantiles: quartiles / tails` | continuous x, ≥1 series for y = count |
| Bars, Share | y per category | categorical x |
| Heatmap, Hexbin, Scatter, Clusters | Count (or the aggregate) over 2D cells / sample points of (x, y) | continuous x and a column y |
| Table | the rows | any |
| Matrix | pairwise coefficient over a set of columns | a metric set |

Defaults: continuous x → Histogram; continuous x + column y → Heatmap (time x +
column y → Band); categorical x → Bars. Series chips are individually
removable: ✕ on a group drops that group (the field series becomes a chosen-
values series); the + menu adds any group back, picks a custom set, or sets
cut points for a numeric split.

Derived, never configured: the title ("Mean framewise displacement", "tSNR vs FD mean", "Uploads over time", "Scans per Manufacturer", "Metric correlations"), the count line, the stat row (quantiles of x for numeric; totals for time and categories), the meaning line, the legend (one, chips, ✕ removes a series, click isolates), the differences table when ≥2 series, the preferred grid size (numeric 4×10; time, categorical, two-metric 8×10; correlation 8×14; +2 rows with series).

Consequences for the current code: `PanelKind` and `coverage`/`sample`/`comparison` as kinds disappear (the sample table is Form = Table; coverage is x = time; comparison is Series ≠ ∅); the metric picker becomes a column picker including Upload time and the categorical fields; `split`/`cohorts` become `series`; the per-card scope select, the options-menu "Compare with", the Cohorts bar and "Compare selected" are removed; URL tokens migrate.

## One panel model

A panel is described by four axes, not a kind:

```ts
interface Panel {
  id: PanelId;
  x: MetricId | 'created_at';     // what runs along x: a metric, or upload time
  y: MetricId | null;             // a second metric makes the panel two-dimensional
  split: GroupField | null;       // one categorical or binned field
  cohorts: CohortId[];            // ['current'] by default; 2+ is a comparison
  chart: ChartId;                 // from the menu below; must be valid for the axes
  options: PanelOptions;          // bins, clip, log, follow-brush, granularity, cumulative, share, window, k…
  cursors: ...;                   // table only
}
```

The chart menu is a function of the axes:

| Axes set | Charts available | Default |
|---|---|---|
| x metric only | Histogram, Density, ECDF, Box, Table | Histogram |
| x metric + split | Density per group (overlaid), Box per group, Faceted histogram, Faceted ECDF | Density per group |
| x metric + 2+ cohorts | Density, Step histogram, ECDF, Box per cohort | Density |
| x metric + split + 2+ cohorts | not allowed: converting one drops the other, with a notice | |
| x metric + y metric | 2D density (heatmap), Scatter sample, Hexbin, with optional contour per cohort | 2D density |
| x = created_at | Stacked bars, Stacked area, Line (per split value) | Stacked bars |
| x = created_at + y metric | Median over time with p25–p75 band, per split or cohort | Median band |
| Table | always available as a chart; "Raw records" is `chart: 'table'` | |
| Correlation | a panel with `x: 'matrix'`-like sentinel? No: correlation is a chart over a metric *family*: `x: metric`, `chart: 'correlation'`, `options.family` selects the set; see below | |

The old kinds map onto this without loss: distribution = x metric;
grouped = x metric + split; comparison = x metric + cohorts; coverage =
x created_at; sample = table. URL decoding of old links maps kinds to axes.

Converting between shapes is now just setting an axis: "Compare with…" appends
a cohort, "Split by" sets `split`, choosing a second metric sets `y`. The
reducer validates `chart` against the axes and falls back to that shape's
default when it no longer applies.

## Axes and layout controls (owner, 2026-10-08)

Every panel's options gain an **Axes** section and, for multi-series panels, a
**Layout** section. Nothing here needs new server procedures; ranges reuse
`range` on `distribution`/`density2d`.

- **X axis**: scale `linear | log | symlog` (log only when every finite value
  in range is positive; symlog otherwise, with the constant chosen from the
  p05 magnitude); range `auto` (the clip preset, p01–p99 by default) or
  `custom [lo, hi]` typed in the metric's unit. A custom range becomes the
  shared range for the panel's cohorts/groups.
- **Y axis** (one-metric charts): `count | share | log count`; `share` is per
  series (each series sums to 100%), which is what overlays already draw. For
  two-metric panels the y axis gets the same scale/range controls as x.
- **Layout** (split or cohort series): `overlaid` (default; translucent areas
  with outlines) | `stacked` (counts stacked by series within each bin, step
  areas or bars) | `stacked 100%` (share of each bin by series, the
  composition view). Stacking is offered for **splits only**: split groups
  partition the data, cohorts may overlap ("This dashboard" is a subset of
  "Whole population"), so stacking cohorts would double count; the option is
  disabled for cohort panels with that reason in its tooltip. Density curves
  do not stack (smoothing per series then summing is not a density of the
  union); choosing stacked switches the chart to step histogram.
- All of these are panel options and live in the URL; defaults are omitted.

## New procedures

All server-side; the browser never receives raw rows except the capped point
sample.

- **`density2d`**: input modality, view, filters, selection, cohort scope,
  `x`, `y`, `bins` (default 120, max 200), optional `range` for both axes
  (shared grids across cohorts, like `distribution`), `clip`. Output: `lo`,
  `width` per axis, a `bins×bins` count grid (row-major, as a flat array),
  underflow/overflow per axis, `n`, Pearson `r`, Spearman `rho` for the finite
  pairs, and a **point sample** of at most `sampleSize` (default 2,000, max
  5,000) `(x, y)` pairs drawn with `USING SAMPLE` for the scatter overlay.
  Spearman via rank windows in SQL.
- **`correlation`**: input modality, view, filters, selection, cohort scope,
  `metrics: MetricId[]` (max 24; defaults to a family), `method:
  'pearson' | 'spearman' | 'both'`. Output: the metric list, an `m×m` matrix per
  method, pairwise `n` (finite pairs), computed in one statement with
  `corr()` over `isfinite` pairs; Spearman via rank windows.
- **`sample2d`** is not separate; the sample rides in `density2d`.
- **Clustering** has no procedure: the browser requests `density2d` with a
  larger sample (`sampleSize` up to 20,000 when `chart: 'clusters'`) and runs
  k-means in a Web Worker on the sample, `k` from options (2–8), 20 restarts,
  Lloyd's algorithm on standardized metrics. The result is drawn on the
  scatter and offered as a synthetic split ("Cluster 1…k") for the duration of
  the panel; it is marked "exploratory, on a 20k sample" in the meaning line.
  Cluster assignments never enter the URL (not reproducible server-side); the
  panel's `k` and seed do, so the picture is reproducible.

Templates live in shared like the others so the uploaded study can use
`density2d` and `correlation` against the WASM table; the study cohort then
appears on 2D panels and in correlation matrices.

## Rendering

- **2D density**: Vega-Lite `rect` heatmap over the grid, sequential batlow
  (truncated) for counts, log colour scale by default because the mass is
  concentrated; axis clipping identical to 1D (p01–p99 per axis). Point sample
  as 2px dots at 0.5 alpha in `--ink-2`, toggleable. Two or more cohorts: each
  cohort's grid becomes a contour set (3 levels at 25/50/75% of its mass) in
  the cohort colour over the first cohort's heatmap, or side-by-side small
  multiples when more than three cohorts. Brush: 2D interval on x and y
  becomes two selections (x range and y range) that filter the other panels
  the same way the 1D brush does today.
- **Correlation matrix**: `rect` grid, diverging palette (Crameri `vik`,
  sampled 11 steps, neutral at 0), cell text shows r to two decimals when the
  cell is at least 36px, tooltip carries both methods and n; click a cell to
  open or convert to the 2D panel for that pair. Rows and columns in catalog
  order with an option to order by hierarchical clustering of |r| (computed in
  the browser on the m×m matrix, cheap).
- **Clusters**: the scatter coloured by cluster with the six Okabe-Ito hues
  (k ≤ 6 chromatic, 7–8 use Other grey with a label), centroids as rings, a
  legend with each cluster's n and the two metrics' medians.
- **Median band over time**: line of the per-bucket median with a p25–p75
  area, per split value or cohort, sharing the coverage x axis.

## Statistics shown

- 2D panels: n, Pearson r, Spearman rho, both with 95% CIs via Fisher
  transform on the finite-pair n; per cohort when overlaid, with the
  difference in rho shown as the differences row does today.
- Correlation: the matrix itself; a note of the minimum pairwise n.
- Clusters: per cluster n, share, medians of x and y; the silhouette score
  on the sample as the single quality number, labelled as such.

## Build order

1. Shared: types for the new results, `density2d.sql`, `correlation.sql`
   templates, `ChartId` and the axes→charts table, URL mapping from kinds.
2. Server: the two procedures with range support, tests on the fixture with
   known r/rho, point sample bounds, Spearman correctness vs. a TS
   implementation.
3. Web: the panel model refactor onto axes (kinds removed; `panel-kinds.ts`
   becomes `panel-shapes.ts`), chart menu by axes, converters, URL
   compatibility; then the three renderers and the k-means worker; study
   support follows automatically through the shared templates.
4. Gallery and docs.


## Web implementation (2026-10-08)

The web state now carries `x`, optional `y`, `split`, and a nonempty `cohorts`
list. `panel-shapes.ts` derives the presentation and valid chart menu; `kind`
survives only as a legacy URL/preset vocabulary. Axis edits validate the chart
and choose the shape default. Table remains a chart. Old JSON and compact URLs
map onto these axes; compact links also carry the second metric, custom metric
sets, family/order options, and clustering k, seed and sample size. Assignments
never enter links. A single remaining cohort keeps its binding.

Implemented charts are clipped log-count 2D density using truncated batlow,
scatter and sample hexbins, 25/50/75% highest-density mass contours, and density
small multiples above three cohorts. Shared grids use a two-step union of the
cohorts' clipped ranges. Stats show paired n, Pearson r and Spearman rho with
Fisher 95% intervals, plus per-cohort rows and differences in rho.

Correlation uses a family (defaulting to x's family) or at most 24 custom
metrics, an eleven-sample vik palette, optional average-linkage ordering of
1-|r|, pairwise n and both coefficients in tooltips, and a cell click that
converts to the corresponding density panel. Cell labels require at least
36 pixels on both axes. The matrix shows the first bound cohort; choose a
single cohort in Show to inspect another cohort or the local study.

Clustering requests up to 20,000 pairs and runs standardized Lloyd k-means
with 20 seeded restarts in a Web Worker. The worker computes the exact mean
silhouette on that retained sample with O(n*k) storage. Six Okabe-Ito hues,
neutral Other for clusters 7–8, centroid rings, counts, shares and metric
medians accompany the exploratory label. Clustering uses the first bound
cohort. “Use clusters as split” is explicitly local colouring of that panel;
it neither identifies population rows nor creates a reusable server split.
The same density and correlation SQL templates execute in DuckDB-WASM for
uploaded studies, with exact-template regression assertions.

The follow-up now uses the existing multi-selection and `timeSummary` API:

- State and saved cohorts carry `selections` lists (up to four distinct metrics).
  A 1D brush replaces its metric's entry; a 2D interval updates both axes
  atomically. Each entry retains its source panel. That panel ignores its own
  ranges while other opted-in dashboard panels apply them together. Each chip
  clears one metric, and Clear filters clears all ranges. Saved cohorts keep
  their fixed selection lists and name every range. Compact URLs write lists
  and continue decoding old compact and JSON singleton links.
- `created_at` plus a y metric defaults to `medianBand`: bucket p50 lines and
  p25–p75 bands, sharing coverage's granularity and window options. Thin buckets
  (n < 20) fade the affected line/band segments and have a tooltip note. Stats
  show total n and each series' first/last occupied-bucket medians and change.
  Cohorts retain their colours; split series have six named colours plus Other.
- Categorical Other receives an exact additional `timeSummary` query over the
  tail values when those values are fully represented in the response. The API
  itself caps at 50 groups. Numeric-bin unions and already-capped categorical
  tails cannot be expressed by its conjunctive filters; their Other quantiles
  are explicitly approximate (count-weighted interpolated quantile CDFs), with
  exact counts. Individual named-series quantiles are always the API values.
- The study runner compiles the identical shared `time_summary` template and
  supports selections and time windows. Uploaded records need `created_at`
  (or its normalized `_created` source column) to contribute to a time band.

The renderer suppresses brush signals produced by programmatic data updates,
so a refresh cannot restore a cleared selection. No server source or shared
contract was changed.

The actual point-sample cap is 20,000 (not the earlier 5,000 design estimate);
ordinary scatter overlays request 2,000 points. No server source was changed.

## Correlation panel, redesigned (owner, 2026-10-09: "the correlation stuff i dont understand")

Looked at live: the Metric select still named a metric the matrix ignores, a
third control row said "Metric family", the diagonal was four saturated 1.00
cells so every real value looked pale, the cell number was an unlabelled
Pearson r while the tooltip showed a different Spearman value, axis labels
were abbreviations, and a four-metric family is a trivial matrix.

- Correlation is its own panel shape with its own control row: **Metrics**
  (a family select plus a chip list of the included metrics, removable, "add
  metric" from any family, max 24) and **Coefficient** (Spearman ρ default,
  Pearson r). No orphaned Metric or Split select.
- Lower triangle only, diagonal blank. Every cell carries its number. The
  legend title names the coefficient ("Spearman ρ"). The ±1 diverging palette
  (vik) stays at full range: "mostly weak" is a true finding.
- Full metric names on both axes, wrapped to two lines; abbreviations only in
  tooltips.
- Meaning line: "+1: the two metrics always rise together. −1: one falls as
  the other rises. 0: unrelated. Over N scans with both values; click a pair
  to see its scatter."
- Default metric set is cross-family, the eight most used IQMs for the
  modality (BOLD: FD mean, DVARS std, tSNR, SNR, EFC, FBER, GSR x, AOR; T1w/T2w:
  SNR total, CNR, EFC, FBER, CJV, WM2MAX, INU median, QI1), so the default
  matrix shows structure.
- "Order by clustering" becomes "Group similar metrics" with a tooltip
  ("reorders rows and columns so strongly related metrics sit together").
- Default size: 8 columns × 14 rows (see ui-style "Panel sizes").


## Implementation notes: web controls (2026-10-09)

The axes and stacking controls now use the shared-range query machinery and
catalog/legend series order. Stacking a density switches to a histogram with
a notice. Typed custom bounds retain their precision in the session; the URL
stream rounds shared ranges to three significant digits.

Correlation has its own shape and Metrics/Coefficient controls. Its default
set spans eight IQMs per modality; the selected coefficient (Spearman by
default) drives both values and the named legend. Only the lower triangle is
drawn, with a blank diagonal, full two-line metric labels, and a number in
every cell. The entire metric domain is explicit so missing diagonal and
upper-triangle cells do not collapse either axis. Selecting a pair still
opens its two-metric chart.

The explicit twelve-column dashboard model and per-chart preferred sizes
replace both earlier packing and span/height-preset experiments. The chart
fills its fixed card; group-row charts scroll within it. Maximize preserves
the saved geometry, and Escape restores it. The second-metric affordance is
outside the Metric/Chart/Split row.

Verification on the existing live servers: default 1600/1200/390 layouts,
pointer resize and restoration, fresh-context geometry and axes links,
stacked and stacked100 splits, disabled cohort stacking, correlation, and
maximize/Escape. A Bruker-filtered export downloaded 733 rows in both Arrow
(58,112 bytes) and CSV (89,607 bytes), with no browser console errors.

## Implementation notes: the one scheme (2026-10-09)

The web graph now stores `Panel { id, x, y, series, form, options }` (plus
ephemeral table cursors and an optional statistics reference). There is no live
panel kind or kinds table. `graph/panel-shapes.ts:formsFor` owns the axis-to-form
table; the reducer, dropdown and spec dispatcher all use it. Axis changes keep
a valid form and otherwise choose the first allowed form. Series edits preserve
the form; stacked density becomes a step histogram.

The shared column picker includes Upload time, metric families and categorical
fields. Categorical forms request groupedSummary counts and coverage totals;
the latter include rows with missing metric values. Time counts use coverage,
median bands use timeSummary, numeric series use distribution on a shared
range, paired quantities use density2d, matrices use correlation, and Table
uses sample. Table pagination keeps each comparison's cursor independently.
All calls use existing API procedures; the server is unchanged.

Titles, count labels, numeric quantiles or totals, meaning and comparisons are
view projections. Preferred sizes start at numeric 4×10; time, categories and
pairs 8×10; Matrix 8×14. Series count and control wrapping add height, while
explicit user sizing remains part of layout state.

The sole URL format is the version-1 six-bit stream. Default state emits no
`s` parameter; undecodable links restore the default dashboard with a notice.
Shared ranges round to three significant digits. Compression dictionaries,
legacy readers and form aliases are removed.

`formsFor` separates time counts (bars/line/area) from time summaries
(band/lines). Pairs use heatmap/scatter/hexbin/clusters, categories bars/share,
and metric sets matrix. It also supplies the TypeScript form vocabulary and
one-character URL tokens in row order. Numeric-only forms are unchanged.
Query planning and view dispatch use those names throughout: choosing a time
metric requests timeSummary, Band draws the median and p25–p75, and Lines
passes its mode to `medianBandChart` to draw p05/p50/p95. Area normalizes
multiple series to shares. Compare chips carry the plotted colours and counts,
and numeric comparisons use one compact series table.
