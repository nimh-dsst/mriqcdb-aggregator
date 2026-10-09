# Dashboard UI Style

Visual rules for the rewrite's frontend. Written `2026-10-06` after the first
review of the working dashboard: the functionality was right, the spacing,
padding and layout were inconsistent, and the chrome carried text no human
reader could use. These rules fix that. They are applied with Tailwind 4
utilities; Angular Material stays only for behaviour we don't want to rewrite
(select panels, date picker, menus, tooltips) and is restyled flat.

## Principles

- **Flat.** No shadows, no gradients, no filled form fields. Surfaces are
  separated by a 1px border or by background tone, never by elevation.
- **One spacing scale.** 4, 8, 12, 16, 24, 32 px. Every gap, padding and margin
  comes from this list. Siblings are laid out with flex or grid `gap`, never
  per-element margins.
- **One radius.** 6px on cards and controls, 999px on chips. Nothing else.
- **Text is for people.** Every string in the chrome must be understandable by
  a researcher who has never seen the code. Hashes, ids and internal names go
  in tooltips or nowhere.
- **Light, dark, or system.** One 32px icon button at the right end of the top
  bar cycles through the three modes so that the first click always changes
  what is on screen: System → the opposite of the current system theme → the
  same as the system theme (explicit) → System. With a dark OS that is
  System → Light → Dark → System; with a light OS, System → Dark → Light →
  System. The icon shows the current mode: Lucide `SunMoon` for System, `Sun`
  for Light, `Moon` for Dark. The tooltip names both the state and the action:
  "Theme: System (dark) · click for Light". No text label, no segmented
  control. The preference is per viewer
  (localStorage, try/catch), never in the shared dashboard state or URL.
- **One About link.** Explanatory links do not float under controls. "Scans
  shown" gets an info icon beside its caption, like the metric selects, whose
  popover holds the one-line view explanation and a "Read more" link to
  `/about#views`. The only standing About link is "About this data" at the
  right end of the top bar. The quarantine chip under the select stays, as a
  fact about this data.

## Tokens

Defined once in `styles.css` as CSS variables and exposed to Tailwind via
`@theme`.

| Token | Value | Use |
|---|---|---|
| `--bg` | `#f7f8fa` | page ground |
| `--surface` | `#ffffff` | cards, top bar |
| `--surface-2` | `#f1f3f6` | control backgrounds at rest, table header |
| `--border` | `#e2e5ea` | all 1px rules |
| `--ink` | `#1f2430` | primary text |
| `--ink-2` | `#5c6675` | secondary text, axis labels |
| `--ink-3` | `#6e7787` | captions, placeholders. 4.51:1 on `--surface`, which 11px and 12px text needs; only 4.06:1 on `--surface-2`, so text on that ground uses `--ink-2` |
| `--highlight` | `#ffca28` | Google Amber 400. Brush interval fill (at 35% alpha), active filter chips, the active view tab, focus rings, "new data" badge |
| `--highlight-ink` | `#5c4300` | text on amber |
| `--series-1` | `#0072b2` | default single-series mark (bars, lines); Okabe–Ito blue, 5.18:1 on white |

Amber is a highlight, not a series colour: it marks state (selected, active,
attention) and never encodes data. Bars stay blue so the amber reads
as "this is what you did".

Categorical charts use the six Okabe–Ito slots specified below. The six largest
groups receive distinct chromatic colours; the remaining groups fold into
`Other`, always last and always `#8c9196`. Comparison panels use the same cap.

### Dark tokens and theme selection (2026-10-08)

The bare `:root` defines light values. The system-dark media block uses
`:root:not([data-theme="light"])`; explicit dark uses `:root[data-theme="dark"]`.
Both dark blocks define the same tokens. `@theme inline` exposes them to
Tailwind, and Material uses matching light/dark themes and `color-scheme`.

| Token | Dark value | Use |
|---|---|---|
| `--bg` | `#141820` | page ground |
| `--surface` | `#1c222c` | cards, top bar, chart separators |
| `--surface-2` | `#252d3a` | controls and table headings |
| `--border` | `#2d3645` | rules |
| `--ink` | `#e8ecf2` | primary text |
| `--ink-2` | `#9aa5b8` | secondary text and chart labels |
| `--ink-3` | `#939fb2` | captions; exceeds 4.5:1 on the surface |
| `--highlight`, `--highlight-soft` | `#ffd54f` | Amber 300 selected state |
| `--highlight-ink` | `#2b2000` | text on amber |
| `--series-1` | `#009aed` | single-series marks; dark categorical blue, 5.21:1 on the surface |
| `--action-ink`, `--focus-edge` | `#ffd54f` | text actions and focus edges |
| `--danger` | `#ff998a` | errors |

System removes `data-theme`; Light and Dark stamp it on `<html>`. Storage reads
and writes are guarded with `try/catch`. A small prepaint script restores the
preference on cold load. Theme changes are spec-key inputs, so Vega re-embeds
with a pure theme object instead of retaining the previous canvas colours.

The fixed light chromatic set passes the validator's lightness, chroma and
CVD checks, with contrast warnings for sky blue and orange. The mandatory grey
`Other` fails its categorical chroma floor in both modes; this is an intentional
neutral exception, not a full validator pass. For dark mode, bounded fixed-hue
OKLCH search produced `#009aed #009e73 #1d729d #d55e00 #c976a4 #a26f00`.
All six pass the dark validator, including surface contrast. The bundled
validator reports failures but offers no replacement suggestions; these are
the nearest passing sampled steps subject to adjacent-colour separation.

## Type

- Family: system UI stack (`ui-sans-serif, system-ui, -apple-system, Segoe UI,
  Roboto, sans-serif`). The Geist font the old app bundled is dropped.
- Scale: 12 (captions, axis), 13 (controls, table), 14 (body), 16 (panel
  titles), 20 (page title). Weights 400 and 600 only.
- Numbers in tiles and tables: `tabular-nums`.
- Uppercase labels (stat tiles): 11px, letter-spacing 0.04em, `--ink-3`.

## Layout

- Page padding 24px desktop, 16px phone. Max width none; the grid fills.
- Top bar: one row of primary controls (modality, view, the four to six most
  used categorical filters), a second row only for "More filters" when
  expanded, and a status line at the right. Controls share one height, 36px.
  Which categorical filters are "most used" is the `secondary` flag on the
  shared `FieldDef`, split in the `chrome` projection: unflagged fields are the
  primary row, flagged ones ("Manufacturer (as uploaded)", Institution,
  Protocol name — long-tail or diagnostic) are a select apiece inside "More
  filters", ahead of the ranges, and count towards its badge. The rule lives
  with the field so adding one decides this in a single place.
- Panel grid: 12 explicit columns, 40px row unit, `gap-4`; every panel has
  its own `{x, y, w, h}` and a fixed height (see "Panel grid: explicit
  geometry"). Default widths 4 of 12 at >= 1500px and 6 below (at 1440, the
  commonest laptop width, three-up makes a 440px card and the metric name
  truncates in every one); one stacked column under 900px. Cards have 16px
  inner padding, a 1px border, no shadow.
  **Implementation note (2026-10-09):** manual changes compact up then left,
  with the changed panel pinned; a visible GripVertical button before Maximize
  exposes dragging and keyboard movement. The resize corner stays visible at
  low opacity.
- Under 700px the whole filter group -- the categorical selects, "More
  filters", "Clear filters" -- collapses behind one `Filters (N active)`
  button; modality and "Records shown" stay out, because they are the two that
  change what every figure means.
- Card header: title and subtitle on the left, controls in one row underneath.
  Icon buttons are 32px squares with a visible hover tone.
- Card controls: Metric, Chart and Split by share one row in fixed `2 1 0` /
  `1 1 0` / `1 1 0` proportions down to 480px of **card** width, below which
  Metric takes the first line alone and the other two share the second
  (`.card-controls`, a container query, because the card width at a given
  viewport depends on the column count). Zero-basis tracks and not
  `flex-[2_1_200px]`: with a basis, whether "Split by" wrapped depended on the
  card's exact width, so the first card of a grid row was taller than its
  neighbours. A value too long for its share ellipsizes and carries the whole
  string as a `title`.
- Chart area: fixed 260px height; Vega width is the container.
- Stat row: a grid of label-over-value pairs below the chart, separated by a 1px
  top border, `gap: 12px 16px`. The label is the quieter of the pair --
  10px/500 uppercase `--ink-2`, never wrapped -- over a 15px/600 tabular value,
  because the number is what the reader came for. A card wide enough for all
  eight pairs on one line (about 700px) gets
  `repeat(auto-fit, minmax(60px, 1fr))`; a narrower one, which the mandated
  three-column grid makes the normal case at ~507px, gets four columns, so the
  eight pairs are an exact 4x2 block and every card's row is the same height.
  Flex wrap is what this replaced: it stranded MIN and MAX on a ragged second
  line and left neighbouring cards at different heights. All four tracks are
  equal now that every label is an abbreviation; the wider first track was for
  "records with a value", which is "SCANS" with its sentence in a tooltip.
- Panel title 18px/600; under it the meaning line in `--ink-2`, which wraps
  rather than truncates; under that the count line, carrying the count and then
  the qualifiers that explain it ("filtered by brush") and the clip chip when
  the clip is not the default.

## Copy

One binding rule, applied in the pass of `2026-10-07`:

> **Always-visible text states facts about *this* data; every control is
> labelled; explanations live on demand in one place — a tooltip, the metric's
> info popover, or "About this data" — and never as standing prose.**

A corollary the whole dashboard now obeys: **the unit is named, once, in the
view's own noun.** A row of `raw` is an *upload*, a row of a policy view is a
*scan*, a row of an `_all` view is one of *scans and unstable uploads*
(`unitNoun` in `view/text.ts`, read off the `ViewDef`, so a fourth view
needs no fourth branch). "Records" is gone: it was true of every view and so
said nothing about any of them.

| Before | After |
|---|---|
| `up to date · data f52ac564…` | `Uploads through 6 Aug 2026` — the newest `created_at` in the corpus; "from" read as the start of a range. Tooltip: `Newest upload in the database. Ingest version <hash>.` |
| `up to date` when a newer version exists | an amber chip `New data available · Refresh` that re-fetches on click |
| page tagline `Visual statistics over every image-quality metric MRIQC has uploaded.` | removed; the H1 stays and every card now says what it itself shows |
| card subtitle `Motion / Framewise displacement` | the **meaning line**: one sentence per card, composed in `panelMeaning`, and carrying no count — the line under it is the count. Histogram: `How many scans fall in each range of {metric}{ (gloss, unit)}.` ECDF: `Share of scans at or below each value of …`. Grouped/faceted: `Spread of {metric} for each {group}.` Coverage: `Scans uploaded per month, by Manufacturer.` Sample: `The individual scans behind these charts, most recent first.` The taxonomy path moved into the info popover |
| metric parenthetical | the catalog `description` when it is ≤ 40 characters (`GLOSS_LIMIT`), then the unit; neither present, no parenthesis. A longer description stays whole in the info popover |
| `records with a value` | the **count line**, which is the one place the card names the corpus: `778,075 deduplicated BOLD scans with a value` / `778,075 BOLD uploads with a value` (`viewNoun` + `countLabel`), and on coverage `778,075 deduplicated BOLD scans`, then the qualifiers (`· filtered by brush`). It used to say only `scans with a value` while the meaning line above it ended `… across 778,075 deduplicated BOLD scans`, printing the figure twice |
| Vega count axis `Records` | `Scans` / `Uploads` (`countAxisTitle`) |
| stat labels `records with a value`, `mean`, `SD`, `p05`, `median`, `p95`, `min`, `max` | `SCANS` (or `UPLOADS`), `MEAN`, `SD`, `5TH PCT`, `MEDIAN`, `95TH PCT`, `MIN`, `MAX`, each with a one-line `title` ("Half of these scans are below this value.") |
| unlabelled card dropdowns | captions `Metric`, `Chart`, `Split by` in the 12px `.field-label` style, the three on one row in 2:1:1 proportions (`.card-controls`; see Layout), each ellipsizing with the full value as a `title` |
| chart options `Histogram`, `ECDF`, `Box plot`, `Small multiples` | `Histogram · scans per value range`, `ECDF · share at or below a value`, `Box · spread per group`, `Faceted histogram`, `Stacked bars`, `Stacked area`. The closed control shows the name alone; the clause is for the open list |
| icon buttons with no tooltip, and `Panel settings` | `Move left`, `Move right`, `Panel options`, `Remove panel` |
| subtitle `· showing p01–p99` on every card | gone from the note line. The options menu reads `Range: p01–p99`, and the card shows a muted `p05–p95` / `Full range` chip **only when the clip is not the metric's default** |
| brush chip `Brushed: Framewise displacement Mean 0.537–1.24` | `Brushed: FD mean 0.537–1.24 ✕` — `MetricDef.shortLabel`, falling back to `label` |
| `Records shown` | `Scans shown`, with `Every upload (raw)` / `Deduplicated (K4+)` / `Deduplicated + unstable uploads (K4+)` |
| two lines of prose + `About deduplication` under the view select | one fact: the chip `1,898 unstable groups left out`, whose tooltip carries the uploads count and the definition. The sentence that explained deduplication is the select's own tooltip and a paragraph of "About this data" |
| `(none)` | `Not reported` — everywhere a category value is shown (filter lists, axes, legends, groups). `NONE_LABEL` in `@mriqc/shared`, so the server's coverage label and the client's axis label are the same string. The filter value stays the `''` sentinel |
| `afni`, `fsl`, `unknown` under Motion correction | `AFNI (3dvolreg)`, `FSL (MCFLIRT)`, `Unknown` (`fieldValueLabel`). Display only: the filter, the query key and the URL still carry the stored value |
| `Canonical (K4+)` | `Deduplicated (K4+)` |
| `All uploads` | `Every upload (raw)` |
| `Processing stability (diameter)` | `Run-to-run stability` with a tooltip explaining the diameter |
| `Upload count` | `Times uploaded` |
| `Head-motion correc…` (truncated) | `Motion correction` |
| `5 panels. The whole dashboard is in the URL.` | `5 panels · Share this view` where "Share this view" copies the URL |
| `Framewise displacement Mean`, no unit | `Mean framewise displacement`, `unit: 'mm'`, description `Head motion between volumes.` Every metric label over 24 characters also carries a `shortLabel` (`FD mean`, `tSNR`, `DVARS std`, `SNR`, `rPVE WM`, …) for the chip-sized places |

## Material restyle

A focused control wears the same indicator everywhere: a 2px amber outline
*plus* a `--highlight-ink` edge on the control itself. Amber on white is
1.53:1, under the 3:1 a non-text indicator owes; `--highlight-ink` is 9.30:1
and is what makes the ring visible. The amber says "this is where you are" in
the same language as every other piece of user state.

Material components are used for: `mat-select`, `mat-datepicker`, `mat-menu`,
`mat-tooltip`, `mat-slide-toggle`. Everything else is a plain element with
Tailwind classes. Material gets the `outline` appearance with zero fill, the
border token as its outline colour, amber as its focus colour, and the
`density: -2` setting so controls match the 36px height. Buttons are Tailwind,
not `mat-button`.

## Panel grid: explicit geometry, fixed heights (decided 2026-10-09)

What went wrong before, in the owner's words: the masonry "decided that it
rather have the shortest possible than fill things in a way a human would
understand", the meaning line forced a two-line minimum, and none of the
row-based or masonry variants could survive a user resizing a panel without
retiling everything. Looked at how dashboards actually do this (Grafana,
Kibana, Metabase, Datadog, Superset, Home Assistant, react-grid-layout,
gridstack): every one of them uses the same model, and so do we now.

**The model.** Each panel owns an explicit integer rectangle `{x, y, w, h}` on
a 12-column grid with a fixed row unit. Height is never derived from content;
the chart fills whatever is left of its box. A changed panel stays pinned,
pushes collisions down, and the remaining panels compact up then left into
the first space that fits. Nothing reorders unless the user drags it; smaller
panels can backfill earlier gaps without changing the panel list. The layout
is stored verbatim.

- Grid: `grid-template-columns: repeat(12, minmax(0, 1fr))`,
  `grid-auto-rows: 40px`, `gap: 16px`. A panel with `h` units is
  `40·h + 16·(h−1)` px tall. Each card is placed with
  `grid-column: x+1 / span w; grid-row: y+1 / span h`. No packer, no
  ResizeObserver on cards, no `dense`.
- Limits: `3 ≤ w ≤ 12`, `x + w ≤ 12`, `h ≥ 5`. Defaults: `h = 10` (≈ 544px,
  about today's card); `w = 4` when the grid is at least 1500px wide,
  otherwise `6`; time-axis panels (`x: 'created_at'`) and comparison
  panels get double width (`8`, or `12` below 1500px).
- Default layout is **derived**, not stored: panels in list order, each at
  the first free position scanning rows top to bottom, left to right, where
  its default size fits. It is re-derived on viewport changes only while the
  user has never touched the layout. The first manual change snapshots the
  derived layout into state (`dashboard.layout`, in the URL as one compact
  token per panel); from then on it is explicit and never re-derived.
  "Reset layout" in the dashboard toolbar clears it.
- Resize: a handle in the bottom-right corner of every card (Lucide
  `GripDiagonal`-style corner, 16px hit area, opacity 0.35 and full on hover/focus). Pointer
  drag snaps to units with a live outline of the new rectangle; on release the
  state receives `resizePanel {id, w, h}`. Move: the title area and a 32px
  Lucide `GripVertical` button before Maximize are drag handles (cursor `grab`,
  `grabbing` during drag); `movePanel {id, x, y}`. The grip is hidden on touch
  and below 900px. Its label is "Move panel (drag, or arrow keys)" and tooltip
  is "Drag to move · arrow keys move · Shift+arrows resize". Keyboard: with
  the card or grip focused, arrow keys move by one unit, Shift+arrows resize by one unit, both
  announced through a polite live region ("Width 6 of 12, height 10").
- Collision rule (gridstack compact semantics): after a move/resize, panels
  overlapping the changed one are pushed down until free. Place the changed
  panel first, pinned where the user put it; then visit the rest in `(y, x)`
  order, scanning rows top-to-bottom and columns left-to-right for the first
  non-overlapping position that fits. Add/remove uses the same compaction
  without a pinned panel. This pure, idempotent function in `graph/layout.ts`
  preserves processing order while backfilling toward the top-left; the reducer
  calls it.
- Add panel: lowest free position where the default size fits, ties to the
  left. Remove panel: the rest compact up then left. Reorder arrows are gone; drag
  replaces them.
- Narrow (< 900px): one column, cards in `(y, x)` order, full width, heights
  kept in units. No drag handles.
- Inside the card: a flex column — header, controls, legend, stat row, then
  the chart as `flex: 1; min-height: 0` with Vega sized to the container, and
  the meaning line last as **one** line, truncated, full text in its tooltip
  (no `min-h-8`). Charts with one row per group (box plot, small multiples)
  scroll vertically inside the chart area instead of growing the card.
- Any change re-renders the chart at the new size on the next frame; no
  layout thrash (one state update per pointer-up, outline only during drag).

### Panel sizes and the maximized view (owner, 2026-10-09: "some things might just need to be big big")

Some charts are only legible large: a correlation matrix across eight
metrics, a comparison with four cohorts and a legend, a box plot with twenty
groups. Two mechanisms, both standard in Grafana and Kibana:

- **Per-chart default size.** The derived default layout asks the chart for
  its preferred `{w, h}` instead of using one size for all: distribution
  charts 4 × 10 (6 × 10 below 1500px); time axis and comparison 8 × 10;
  correlation 8 × 14; 2D density, scatter and clusters 6 × 12; box plot and
  small multiples `h = max(10, 4 + rows)`. Users resize from there; `h` has
  no upper bound, `w` is at most 12.
- **Maximize.** Every card has a "Maximize" icon button (Lucide `Maximize2`,
  `Minimize2` to restore, Escape restores) that shows that one panel filling
  the viewport below the top bar, chart re-rendered at full size, the rest of
  the grid hidden, the layout untouched. The maximized panel id is in the URL
  (`view panel` the way Grafana's `viewPanel` works) so a link can open
  straight onto one big chart.

### Card face, revised (owner, 2026-10-09: "what kind of control do people actively need to change?")

The metric is the card's identity, not a control people flip while reading:
nobody toggles one card between FD mean and tSNR, they want both on screen.
What changes while reading is the slice (Split by), the comparison (which
cohort or subset), the brushed range on the chart, and occasionally the chart
form. Axes, scale, layout and bins are set once. The face follows that.

- **Header.** Title = the metric's full name (16px/600); subtitle = the count
  line. The title is a button (`aria-label="Change metric"`, hover shows a
  16px Lucide `Pencil` after the text) that opens the Metric popover: a
  searchable metric list grouped by family, a "Second metric (y)" select, and
  the metric's description, unit and MRIQC docs link. The caption info icon is
  gone; this popover is where that text lives. Two-metric panels title as
  "X vs Y". Action group at the right, 32px icon buttons: Move (grip),
  Maximize, Options, Remove.
- **One control row**, 36px, 8px gaps: **Split by** (select, `1fr`) ·
  **Compare** (select, `1fr`: "This dashboard" default, each saved cohort,
  "My study" when uploaded, "Whole population", and "Compare with…" which
  opens the cohort editor) · **chart-form toggle** (segmented icon buttons,
  28px each, amber outline on the active one, tooltip + `aria-label` with the
  chart name: Histogram, Density, ECDF, Box, Table for one metric; Density,
  Scatter, Hexbin, Clusters for two; Bars, Line, Median band for time
  panels). Under 480px of card width the toggle wraps to its own line, right
  aligned. No Metric select, no Chart select, no "+ second metric" link.
- **Correlation** keeps its own row (Metrics chips · Coefficient · Group
  similar metrics) and gets the same header rule (title "Metric correlations",
  pencil opens the metric set).
- **Body**: stat row, chart (`flex: 1; min-height: 160px`), ONE legend (the
  chip legend with "Compare selected"; the Vega legend is off whenever the
  chip legend is shown), notes, meaning line. Split panels derive a preferred
  height of 12 rows so the chart is not squeezed to a strip.
- **Add panel** opens the same metric picker first; the card is created with
  the metric's default chart, no split, "This dashboard".
- **Type in controls**: 13px (the type scale's control size); captions 12px;
  select triggers never exceed their column, long values truncate with the
  full text in `title`.

### Column drawer (owner, 2026-10-09: "make the add panel thing a bottom drawer across the screen to fit more stuff")

Choosing what a card shows is the one place the whole catalog must be visible
at once, so it is not a popover. It is a **bottom drawer** across the full
viewport width, 40vh tall (min 320px), surface background, 1px top border,
opened by "Add panel" and by a card title (then pre-selected). Layout:

- Left to right, as columns with their own scroll: **Time** (Upload time),
  one column per metric family (family name as heading, sub-family as a
  caption, each metric as a row: full name, short label in `--ink-3`, unit),
  **Fields** (the categorical fields). Columns are `minmax(200px, 1fr)`; on
  narrow screens they wrap into a two-column grid and the drawer grows to
  70vh.
- Right pane, 320px: the hovered or selected column's description, unit,
  direction ("higher is better" when known) and docs link; below it the
  **Second metric (y)** select (numeric x only) and, for time x, the metric
  select that turns Bars into Band/Lines.
- Search box at the top left filters every column live; Escape closes;
  focus returns to the opener.
- Selecting a column creates the card (Add panel) or re-targets it (title) at
  once; the drawer closes unless Shift is held, which keeps it open to add
  several cards in a row.

## Fixed-height captions and real icons (owner, 2026-10-07)

- Every control caption is exactly 16px tall (`line-height: 16px`, no wrap).
  Badges inside a caption (the filter's active-count "1", the More-filters
  count) are 16px inline-flex elements with `vertical-align: middle`, so a
  badge can never change the caption's height and push the control, or the
  action row beside it, down.
- Icon buttons use 16px SVG outline icons (Material Symbols outline paths
  inlined), never text glyphs like "ⓘ", and are `align-self: center` in their
  row. Text glyphs render off-baseline and blur at low zoom.

## Palettes (decided 2026-10-08: Okabe-Ito 6, equal visual weight)

Measured against every published perceptually-designed categorical set
(Crameri batlowS/KS/WS, hawaiiS, lipariS, naviaS, glasgowS; Okabe-Ito; Tol
muted and bright) with the dataviz validator on `#ffffff`: the Crameri
categorical sets use lightness as their discriminator (members from L 0.12 to
0.97), so no reordering gives equal weight; Tol muted spans L 0.35–0.84 and
two members sit under 1.8:1 on white. **Okabe-Ito, reordered for colour-vision
separation and capped at six chromatic slots plus grey, is the only published
set chosen for similar visual weight (L 0.53–0.75).** The six chromatic entries
pass the lightness, chroma and separation checks, with two contrast warnings;
the required grey is an explicit chroma exception (see the dark-theme notes).

- **Categorical** (cohorts, split groups, legends), fixed order:
  `#0072B2` blue, `#009E73` green, `#56B4E9` sky, `#D55E00` vermilion,
  `#CC79A7` pink, `#E69F00` orange; `Other` grey `#8c9196` always last (next to
  the orange, never next to the pink where protan ΔE collapses to 2–4).
  Dark equivalents keep that order: `#009aed`, `#009e73`, `#1d729d`,
  `#d55e00`, `#c976a4`, `#a26f00`; `Other` remains `#8c9196`.
  Series are capped at six; the seventh group and beyond fold into Other.
  Sky and orange are under 3:1 on white, so the relief rule binds: direct
  labels, legend, and the table view. Hues follow the entity, never its rank.
- **Ordinal / binned**: Crameri batlow sampled evenly but truncated at index
  199 so the light end keeps 2:1 on white: `#011959 #134b61 #356a59 #737e38
  #be9035 #f8a27e` for six steps (resample proportionally for other counts),
  dark to light in data order. Never the categorical set for ordered data.
- **Single series** uses the first categorical blue slot through `--series-1`
  (`#0072B2` light, `#009aed` dark), so conversion to a comparison preserves
  the first cohort's colour. Amber remains the only state colour.
- Swatch comparison of every candidate: session scratchpad
  `palette/swatches.png`; scripts beside it reproduce the validator exactly.

## Palettes (superseded 2026-10-07 note: "a PUC instead of brightest colors")

- **Categorical** (cohorts, split groups, legends): Paul Tol's *muted*
  qualitative scheme in fixed order: indigo `#332288`, teal `#44AA99`, wine
  `#882255`, olive `#999933`, purple `#AA4499`, cyan `#88CCEE`, green `#117733`,
  sand `#DDCC77`, rose `#CC6677`; `Other` is grey `#777777`. Hues follow the
  entity, never its rank. Validate with the dataviz validator against
  `--surface`; members under 3:1 (teal, cyan, sand) rely on direct labels and
  the legend, never on colour alone. The owner deliberately accepts this muted
  set's validator failures for lightness (indigo, cyan, sand) and chroma (teal,
  cyan). Normal-vision adjacency is not waived: this order passes it (worst
  adjacent ΔE 26.4), and also passes CVD adjacency (worst ΔE 20.9, deutan).
- **Ordinal / binned** (field strength, times uploaded, numeric split bins,
  any sequential encoding): a discrete sampling of Crameri's *batlow*
  (perceptually uniform, CVD-safe), k evenly spaced steps for k groups, light
  to dark in data order. Never the categorical set for ordered data.
- **Single series** stays `--series-1` `#3b6fb6`; amber remains the only state
  colour and never encodes data.
- The previous saturated eight (`#2a78d6 #eb6834 #1baf7a #c98500 …`) are
  retired.

## Split-by charts (added 2026-10-07 after review: "nigh on impossible to read")

The failure seen: a box plot of Quality index 1 by manufacturer where every
box collapsed to a hairline because the IQRs are tiny against a range set by
outliers, whiskers ran to min and max, and a coverage chart whose canvas was
CSS-scaled so its text rendered at about 7px. Rules:

- **Box per group**: whiskers to p05 and p95, not min and max. The x domain is
  the union of the groups' p05 to p95 (or the panel's clip range when wider),
  so boxes fill the axis. A box is never thinner than 3px; the median is a 2px
  tick in `--ink`; the group's n is printed at the row's right edge in
  `--ink-2`. Rows sorted by median by default, with n as an alternative. When
  the metric is flagged `logScale`, or when the p95/p05 ratio exceeds 50, the x
  axis is symlog.
- **Split-by default is overlaid density, not facets** (owner, 2026-10-07:
  "the faceted charts hurt to read"). A split on a distribution panel draws
  the top six groups by n plus Other as translucent density curves on one
  axis, legend beside the plot, one set of axis labels; this is the comparison
  panel's drawing applied to group-cohorts. "Box per group" remains for
  ranking. Facets are opt-in.
- **Faceted small multiples** (opt-in): inner facets show no axis labels or
  titles, only the outer row and column do; wrap facets into a grid with shared x; each facet
  at least 160px wide and 90px tall; the card grows to fit and spans two grid
  columns while a split is active on a two-or-three-column layout. Never more
  than seven facets (top six by n plus Other). Each facet header carries the
  group name and n.
- **Degenerate distributions**: when more than 50% of finite values share one
  exact value (Quality index 1 is mostly 0), the count line says so, "71% of
  scans are exactly 0", and the histogram is drawn over the remaining values,
  with the spike shown as a separate labelled bar at the left edge.
- **Pattern glare**: high-contrast marks repeating at a regular spatial
  frequency cause visual stress (pattern glare, Wilkins). So: never alternate
  cohort colours within a bin, and when a histogram has more than about 100
  bins set the bar gap to 0 so the bars read as one filled shape rather than a
  stripe field.
- **Overlaid distributions (comparison panel)**: never side-by-side bars per
  bin, which read as zebra striping. Each cohort is a share-normalized step
  histogram drawn as a translucent area (fill opacity 0.25) with a 2px step
  outline in the cohort colour, all on the same bin edges. ECDF overlays are
  2px step lines. Legend swatches are lines, not squares.
- **Canvas scaling**: Vega renders at the container's CSS pixel width and
  device pixel ratio; the canvas element is never CSS-scaled after render. Axis
  and legend text is 12px on every chart regardless of card width.

## Charts

Follow the dataviz skill: thin bars with a 2px surface gap, recessive grid in
`--border`, axis text in `--ink-2`, tooltip on every mark, legend present for
two or more series and absent for one, direct labels only where they add
information. The brush interval is amber at 35% alpha with a 1px amber edge.

## Implementation notes: scheme card face (2026-10-09)

The card title opens the shared bottom drawer, pre-selected to the card column:
searchable Time (Upload time), metric families and Fields. Add panel uses the
same drawer. Each family scrolls independently. The right pane describes the
hovered or selected column and exposes Second metric (y), or Metric over time
for time quantities. Selection dispatches immediately; Shift keeps the drawer
open. Escape closes and returns focus to the opener. Matrix quantities choose
their metric set.

The control row is Compare chips `1fr` and a minimum-130px, 36px-high form
select that grows for the longest name in its axis row, wrapping below 480px
card width. The trigger shows a 20x14 inline SVG mark and an untruncated name;
each option shows that mark, its name and a separate use-when line. Only `formsFor(x, y)` is listed.
The old segmented chart toggle, metric-only picker, split select and per-card
scope controls are gone. The title's accessible name includes its visible
quantity, and both picker and dropdown support keyboard interaction.

The face order is title, Compare/form, one compact series statistics table when
comparing, chart, then the meaning line. Single-series cards retain their
count and numeric stat row; comparison cards omit that redundant block.
Expanded Compare chips carry the plotted colours and n, support click isolation
and double-click reset, and replace the separate legend row. Saved groups are
managed from Save as group… and the editor, not a separate dashboard bar.
Preferred sizing accounts for quantity, series count and chip wrapping. The
chart keeps a 160px minimum and statistics scroll inside the remaining height;
explicit user layout and mobile single-column packing continue to apply.
