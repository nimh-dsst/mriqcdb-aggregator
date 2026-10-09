# Comparison: Cohorts and the Comparison Panel

Design addendum to `dashboard-graph.md` and `backend-graph.md`. Written
`2026-10-07` after the owner's finding that the dashboard was metric lookup,
not comparison. Requirement: compare an uploaded study against the population,
a cohort against another cohort, a subset against the whole population, and
the same cohort across time spans. One concept covers all four.

## Cohort

A cohort is a named, coloured selection of scans:

```ts
interface Cohort {
  id: CohortId;
  name: string; // "Siemens 3T, 2019" / "Whole population" / "My study"
  color: number; // index into the categorical palette, fixed per cohort
  source: "population" | "study";
  view: View; // raw / k4plus / k3pp / *_all; ignored for study
  filters: Filter[]; // same Filter type as the global bar, incl. created_at between
  selection: Selection | null; // an optional metric range, e.g. carried over from a brush
}
```

Two cohorts always exist and are not editable:

- **`current`**: "This dashboard" = the global view, filters and brush as they
  stand. It follows the top bar.
- **`all`**: "Whole population" = the global view with no filters and no brush.

Users add cohorts in two ways. "Save as cohort" snapshots the dashboard in one
click (see "Entry points"), which is the path almost every cohort takes. The
cohort editor is the other: "Start from" (This dashboard / Blank / Saved cohort)
first, because it overwrites everything under it; then the name, prefilled from
`cohortAutoName` and tracking the fields until the reader types in it; the view;
the same filter controls the top bar uses, two columns with the long-tail fields
behind "More filters" exactly as up there; the upload-date range; an optional
metric range; and the colour on a row of its own. Its footer shows a live count
of what the draft matches -- a debounced, cancelled, component-local request
that never enters state -- beside Cancel and Create.

A group of a split field is a cohort too, derived rather than stored: its id is
`g\0<field>\0<value>`, which is the whole of its definition, and it is named
"<field label>: <value>" and coloured by that group's slot in the field's value
list. Nothing about it can drift from the split it names, and a link only has to
carry the field and the value.

The uploaded study is a cohort with `source: 'study'`. It appears after a
successful upload and is removed with the study.

Cohorts live in state next to panels, are serialized into the URL (except the
study, whose rows never leave the browser), and are referenced by panels by id.
Deleting a cohort removes it from every comparison panel; a panel left with one
cohort still renders as a single-cohort distribution.

## Comparison panel

A panel kind that takes a metric and two or more cohort ids.

| Chart             | What it draws                                                                                                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Density (default) | Each cohort's share-normalized histogram over the shared grid, smoothed with a Gaussian kernel at Silverman's bandwidth, as a translucent area (fill 0.25) with a 2px outline in the cohort colour |
| Step histogram    | The same shares unsmoothed: a `step-after` area over the shared bin edges, same fill and outline                                                                                                   |
| Overlaid ECDF     | One step line per cohort on the same axes                                                                                                                                                          |
| Box per cohort    | One box row per cohort, labelled with the cohort name                                                                                                                                              |

Grouped bars were the first attempt and are gone. Thin bars side by side within
each bin read as zebra striping at any useful bin count -- the eye follows the
alternation rather than either distribution -- and the shape of a histogram is a
silhouette, which is what an outlined area draws. The fill is what lets two
silhouettes overlap and still be read; the outline is what keeps each one
followable through the overlap. There is no `overlay` option any more: the user
choice is between the smoothed shape and the bins, which is the choice that
changes what the chart is _about_.

The density is a pure function of a fine histogram the panel already asks for:
`bins = 200`, counts to shares, then a Gaussian convolution at
`0.9 · min(SD, IQR/1.34) · n^(-1/5)`, floored at 1.5 bin widths (below that the
kernel is narrower than the grid it is smoothing, so the "curve" is a picture of
the binning). Normalized analytically rather than by the kernel's mass over the
finite grid: grid normalization keeps a flat histogram flat but shrinks its
denominator towards the edges, so a spike in the second bin came out taller in
the first -- and a density whose peak is not where the mass is is not a density.
The underflow and overflow are **not** smoothed back into the edges, because
that would draw scans at values they do not have; the card states them
("Siemens: 3.3% above range").

Same bin edges are essential, otherwise overlaid histograms lie. The panel
computes a shared range from the union of the cohorts' p01 and p99 (or min and
max when clip is none) and asks the server for every cohort's histogram over
exactly that range. That needs one addition to the `distribution` procedure: an
optional `range: [lo, hi]`. When present the histogram is binned over `[lo, hi]`
instead of the cohort's own clipped range, with underflow and overflow counts
reported separately so nothing is silently dropped.

Statistics below the chart: one row per cohort with n, mean, SD, p05, median,
p95, in the cohort colour, then a differences block "vs <reference>" with one
row per non-reference cohort: median shift (absolute and as a share of the
**reference's** IQR), mean shift, and the Kolmogorov–Smirnov distance computed
from the two share-normalized cumulative histograms over the shared grid, each
curve offset by its own underflow mass. The reference defaults to the first
cohort and is the reader's to change, because which cohort is the baseline is a
question about their study and not about the data. With two cohorts the block is
the single row this document first asked for; with more it is one row each,
which is the only reading of "the difference" that stays a number rather than a
matrix. An "All pairs" toggle shows every pairwise KS distance -- at most nine
cohorts, so at most 36 pairs -- with the largest in full `--ink`, because that
is the one question a single reference cannot answer. Every KS value is written
`≈ 0.0279`: the supremum can fall inside a bin, and a bare figure reads as
exact.

Entry points, so the user never has to assemble a comparison from scratch:

- **"Save as cohort"** in the top bar's filter actions, the one amber-outlined
  button on the page. The dashboard already _is_ a selection, so this is one
  click and the name composes itself from exactly what makes the slice
  different: `cohortAutoName` writes "BOLD · K4+ · Siemens · 2019–2021 ·
  FD mean 0.1–0.4", dropping every part that says nothing and falling back to
  "all", with " (2)" suffixes for uniqueness. This is the primary way a cohort
  comes into being; the editor is for changing one.
- On any distribution panel, "Compare with…" offers "Whole population", "This
  dashboard, saved as cohort", every saved cohort, the groups of the panel's
  split field, "My study" when uploaded, and "New cohort…". It converts the
  panel into a comparison of `current` plus the chosen cohort.
- On a **split** panel, each group is a chip to tick and "Compare selected (n)"
  converts the panel into a comparison of exactly those groups, in one command,
  keeping the metric. A split group _is_ a cohort -- this dashboard's filters
  plus `field in [value]` -- so any subset is reachable without a new concept.
- A comparison panel's header carries a chip per cohort with a ✕ that takes it
  off **that panel**; the ✕ in the cohort list deletes the cohort everywhere.
  The options menu has "Back to single distribution", so a reader who assembled
  a comparison has a visible way back rather than removing cohorts until it
  collapses.
- In the cohort editor, "Compare across two date ranges…" switches the dialog to
  two spans and opens a comparison panel over the two copies.
- After an upload, every distribution panel gets a one-click "Add my study".

Brushing on a comparison panel brushes on the shared x axis and filters the
other panels as today; the comparison panel itself is a brush source.

## Revisions after first live use (2026-10-07)

- **Overlay, not bars.** Side-by-side cohort bars within a bin produce pattern
  glare and are unreadable. Each cohort is a share-normalized step histogram
  drawn as a translucent area with a 2px outline in its colour, on shared bin
  edges. The `overlay` option is removed. Charts: step histogram (default),
  ECDF, box per cohort.
- **Back to single.** The panel shows its cohorts as chips with ✕. Removing
  chips down to one reverts the panel to a plain distribution panel on
  `current`; the options menu also offers "Back to single distribution".
- **Removing cohorts.** ✕ on a panel chip removes the cohort from that panel;
  ✕ in the top-bar cohort list removes it from every panel and from state.
  `current` and `all` can leave a panel but cannot be deleted.
- **Split groups are cohorts.** A derived cohort `{ base: 'current', splitField,
value }` means this dashboard's filters plus `field in [value]`, named
  "Manufacturer: Siemens", coloured by the group's palette index. On a split
  panel the user ticks any subset of groups and confirms "Compare selected";
  the panel becomes a comparison of exactly those groups. A comparison panel's
  "Add cohort…" lists the whole population, this dashboard, saved cohorts, the
  current split field's groups, and the study. Any mix is allowed.
- **Save as cohort, one click.** The primary way to create a cohort is a
  button that snapshots the current dashboard (view, filters, brush) with an
  auto-generated name: "BOLD · K4+ · Siemens · 3T · 2019 · FD mean 0.4–1.2",
  or "… · all" when unfiltered; made unique with a suffix; editable later,
  never required. Available in the top bar, in a comparison panel's "Add
  cohort…" menu, and as "Fill from this dashboard" inside the editor, which is
  the secondary path.
- **One chart list everywhere (owner, 2026-10-07).** Distribution and
  comparison panels offer the same four charts: Histogram, Density, ECDF, Box.
  Converting a panel to a comparison keeps its current chart (histogram
  becomes the step-area overlay of the same shape); a new comparison takes the
  source panel's chart, not a different default.
- **Auto names drop the modality.** A cohort lives inside one modality and
  nothing compares across modalities, so "BOLD · " is noise. The view stays
  (raw against deduplicated is a real comparison).
- **Per-card scope (owner, 2026-10-07: "the only uploads over time is all
  uploads over all time?").** Every panel has a `cohort` binding: `current`
  by default, or any saved cohort or `all`. A bound panel ignores the top bar
  and names its cohort in the count line. This is the single-cohort case of
  the comparison panel's machinery, so no new query path.
- **Coverage options.** Cumulative; 100% stacked share; time-window presets
  (last 12 months, last 5 years, all, custom); log y. Bucket size stays.
- **Density mode.** A "Density · smoothed share" chart for both single and
  comparison panels, computed on the client from a 200-bin histogram by
  Gaussian smoothing with Silverman's bandwidth (from SD, IQR and n in the
  result, clamped to 1.5 bins), drawn as a shaded area with a 2px outline.
  Approximate at histogram resolution and labelled so; underflow and overflow
  mass is reported, not smoothed in. Default chart for comparison panels.
- **Differences for n cohorts.** Rows per cohort, then a "vs reference" block
  with a selectable reference (default the first), giving median shift
  (absolute and in reference-IQR units), mean shift and approximate KS per
  cohort; an "All pairs" toggle shows the KS matrix for up to nine cohorts.

## Query model

A comparison panel needs one distribution query per cohort. The query key
already includes view, filters and selection, so each cohort is its own key,
and two panels comparing the same cohort on the same metric share the entry.
The `needed` projection gains the `range` field, which means that when the
shared range changes, because a cohort's p01 or p99 moved, the keys change and
the histograms are refetched. The first fetch of a new comparison therefore
happens in two steps: cohorts' own distributions, then the shared-range
histograms. The ECDF and statistics come from the first step, so the panel
renders statistics immediately and bars a moment later.

Study cohorts run the same SQL text against the DuckDB-WASM instance. To make
that literal, the SQL templates move into `@mriqc/shared` as text with the
same `{{table}}`, identifier and parameter holes, and both the server's
runner and the browser's WASM runner compile them. The server keeps its
validation and identifier quoting; the browser runner reuses the shared filter
compiler's output shape but binds against the study table. Keeping one source
of truth for the statistics SQL is the whole point of running DuckDB on both
sides.

## Study upload

- Input is an MRIQC group CSV or TSV (one row per scan) or a zip of per-scan
  MRIQC JSON files. Both paths normalize into the same rows: source keys pass
  through `normalizeColumnName`, known metric ids are retained, and columns the
  catalog does not know are ignored rather than becoming queryable fields.
- The browser runner lazy-loads DuckDB-WASM on first use; Angular copies the
  pinned package's matching `eh` WASM and classic worker unchanged and the
  browser fetches them only for an upload. The runner
  replaces its single `study` table when another file is chosen. The normalized
  rows live only in that WASM instance; no upload or row data reaches the
  server, graph state, or URL.
- `My study` is a stable derived cohort, not a stored cohort. It exists only
  while `StudyState` is ready, always has the reserved study id and
  `source: 'study'`, and disappears when the study is cleared. This keeps panel
  references stable without serializing an editable or driftable copy.
- The local runner compiles the same shared distribution and grouped-summary
  SQL templates as the server. Both runners use the shared filter core; the
  server supplies its view allowlist and table, while the study runner supplies
  the columns actually present and binds against the browser's `study` table.
- State keeps only upload status and summary metadata: file name, row count,
  available metrics, total catalog metrics, ignored columns, and missing
  metrics. The upload dialog shows loading, failure, and ready states, and the
  status line shows the loaded study with a clear action.
- A comparison that includes the study exposes only metrics that the file can
  answer: unavailable metrics are disabled, and "Add my study" is offered only
  when the current metric is present. Clearing or replacing a study drops local
  query results; clearing also removes the derived cohort from panels, using the
  normal one-cohort revert rule rather than leaving a broken comparison.
- Study rows are deliberately absent from shared links. When hydration detects
  that a link had referenced the omitted study cohort, it prunes that reference
  and shows a notice explaining that the study is not in the link.

Verification on the 300-row BOLD fixture: the local row reports `n = 300`, the
comparison reports an approximate KS distance of `0.216`, and file choice to
`studyLoaded` takes 1,355.6 ms in Chromium on the development server. The EH WASM
is 34,242,586 bytes raw and 7,639,912 bytes with gzip -9 (the development server
itself sends the raw asset).

## State changes

```ts
interface State { …; cohorts: Cohort[]; }        // the user's only; 'current', 'all' and the
                                                 // split groups are derived in projections
interface Panel  { …; cohorts?: CohortId[]; reference?: CohortId }   // comparison only
type Command = …
  | { t: 'saveCurrentAsCohort' }                                  // the one-click path
  | { t: 'addCohort'; cohort: Cohort } | { t: 'updateCohort'; id; patch } | { t: 'removeCohort'; id }
  | { t: 'convertToComparison'; panelId; with: CohortId | CohortId[] }
  | { t: 'removePanelCohort'; panelId; cohort } | { t: 'revertPanelToSingle'; id }
  | { t: 'setPanelReference'; id; cohort }
  | { t: 'studyChosen'; file } | { t: 'studyLoaded'; name; rows; metrics } | { t: 'studyFailed'; error } | { t: 'clearStudy' }
```

`overlay` is gone with the grouped bars. `reference` is absent when it is the
first cohort, so a panel nobody re-anchored carries nothing extra in its link.

`current` and `all` are derived from `global` at projection time, not stored,
so they can never drift from the top bar.

## Build order

1. Server: `range` on `distribution` with underflow and overflow; move SQL
   templates to shared; tests.
2. Web: cohorts in state and URL, cohort editor, comparison panel with the
   three charts and the statistics table, entry points, shared-range two-step
   fetch; tests and e2e against the real server.
3. Web: study upload runner on DuckDB-WASM using the shared templates, the
   study cohort, upload summary; tests with a fixture CSV and e2e.
4. Gallery and docs.

## One "Compare" control (owner, 2026-10-09: "comparisons might be multiple. really split by is a comparison with multiple cohorts in and of itself")

Live review found five entry points with five vocabularies: a per-card
"Compare" select that was really a scope ("This dashboard"), a "Compare with"
list in the options menu, "Save as cohort" in the top bar that only added a
chip ("K4+ · all") to a Cohorts bar, "Compare selected (0)" in split legends,
and the cohort editor. They collapse into one idea:

**A card draws a set of series. Every way of getting more than one series is a
comparison, and they are all chosen in one place.**

- `panel.series: Series[]` replaces `split` + `cohorts` in the panel model
  (URL migration: old `split` → `{kind:'field', field}`, old cohorts →
  `{kind:'cohort', id}`). A `Series` is one of
  `{kind:'field', field}` (expands to the top-5 groups + Other at query
  time, exactly as split does today), `{kind:'population'}` (whole
  population, no filters), `{kind:'cohort', id}` (a saved group),
  `{kind:'study'}` (the uploaded file), `{kind:'span', from, to}` (an earlier
  time window of the same filters). The card's own data ("This dashboard",
  current filters + brush) is always series 0 and is not listed.
- **Control**: one chip input labelled **Compare**, full width of the control
  row's left part: chips for the chosen series ("by Manufacturer ✕",
  "Whole population ✕", "Siemens 3T ✕", "My study ✕", "2019 ✕"), and a
  "+" trigger opening a grouped menu: *By field* (the categorical fields),
  *Against* (Whole population, My study when uploaded, each saved group),
  *Earlier span…* (two presets: same months last year, previous year;
  plus custom), *New group…* (the cohort editor). Series cap: 6 chromatic +
  Other; a field series counts its groups; the menu disables what would
  exceed the cap and says why. Mixing one field series with up to two
  "against" series is allowed; two field series are not (that is a 2D
  split, not supported).
- **Legend**: one chip legend listing the series in colour; ✕ on a chip
  removes that series (same as the Compare chip). "Compare selected (N)" is
  gone: clicking a legend chip isolates (dims the others), double-click
  resets.
- **Stats**: the stat row shows series 0; with ≥2 series the differences
  table (median shift, KS) appears under the chart as today.
- **Top bar**: "Save as cohort" becomes **"Save as group…"** opening the
  editor pre-filled with the current filters + brush and an auto-name; saving
  adds the group to the *Against* menu of every card and, optionally
  (checkbox, default on), adds it as a series on all cards right away. The
  Cohorts bar is removed; saved groups are managed from the editor's list.
- **Options menu** loses "Compare with" and gains nothing; the scope select
  ("Show": This dashboard / Whole population / a group) is dropped from the
  face and the menu — a card always shows the dashboard's filters as series
  0, and a group is compared *against* it instead.
- **Chart picker**: the segmented toggle is replaced by one compact select
  (≈130px): trigger shows the form's Lucide icon + name ("Histogram"),
  options show icon + name + one-line hint, forms per shape as before.
- Row layout: Compare chips `1fr` · chart picker `auto`.

## Implementation notes: Compare chips (2026-10-09)

`graph/series.ts` defines field, values, population, cohort, study and span
descriptors and the shared validation/reason functions. The Compare input
offers By field, Chosen values, Against, Earlier span and New group. The same
validator enforces one grouping, at most two against descriptors alongside a
grouping, duplicate rejection and six chromatic slots plus neutral Other.
Field grouping expands to five named groups and an exact pooled Other query.
Chosen values retain their exact wire values, including the missing token.

Grouping draws the selected parts of the dashboard; the unsplit dashboard is
still queried for its stat row. This makes Siemens + GE + Whole population
three plotted series, as required by the scheme acceptance example. Without
grouping, This dashboard is the first plotted series. This is the resolution
of the earlier always-plotted-series-0 wording for that acceptance example.

Expanded Compare chips are the sole series legend and show each plotted colour
and n. Click dims other series; double-click resets; the remove button removes
the corresponding descriptor. There is no separate legend row or Vega series
legend. Numeric comparisons have one compact table: Series, n, Median, IQR,
p05–p95, Δmedian/IQR and approximate KS, relative to the first row. Time and
category comparisons display their applicable totals or summaries. Tables
scroll within the card while the chart retains at least 160px.

Save as group opens the editor with current filters, linked brush and an
automatic name. Add to all cards defaults on and respects each card's cap.
Saved groups are listed in the editor for rename/delete and in every Against
menu. The Cohorts bar, per-card scope, Compare selected and options-menu
Compare with controls have been removed.

Matrix and Clusters render small multiples for multiple series. Local-study
Table and row-count forms are disabled with an explanation: the existing
StudyApi supports distribution, groupedSummary, timeSummary, density2d and
correlation, but no sample or coverage procedure. Changing an existing study
comparison to one of those forms retains the descriptor and shows a note.


## Implementation notes: individually editable groups (2026-10-09)

The Compare input renders field groups as individual chips, including Other.
Removing a rendered group converts its field descriptor to a values descriptor
containing the remaining groups; removing Other removes only the pooled tail.
The + menu lists the selected field's values for adding groups back, and
Chosen values edits that field's selection. Other retains its exact pooled
values when a neighboring group is removed.

Numeric fields offer Split at. Cut points produce a values descriptor with
encoded intervals. Query expansion turns those intervals into ordinary numeric
range filters; upper edges use the preceding representable number so adjacent
bins do not count the cut-point value twice. This uses existing server filters
and does not require a numeric-split procedure. Chips and selected values,
including numeric intervals, survive URL round trips.
