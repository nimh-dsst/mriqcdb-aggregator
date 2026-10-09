/**
 * The chart vocabulary: one small fixed palette and the pieces every spec
 * repeats. Keeping it in one file is what makes eight chart types look like
 * one dashboard rather than eight.
 *
 * The hexes are literals rather than `var(--token)` on purpose: the panels
 * render to canvas, where a CSS variable has no meaning. They mirror the tokens
 * in `src/styles.css` (`docs/ui-style.md`, "Tokens"), which is the source --
 * change one and change the other.
 */

/** Vega-Lite 6 schema every spec declares. */
export const VL_SCHEMA = 'https://vega.github.io/schema/vega-lite/v6.json';

/* ------------------------------------------------------------------ tokens */

/** `--surface`: the ground every mark sits on, and the colour of the gaps. */
export const SURFACE = '#ffffff';
/** `--border`: gridlines and axis rules. One step off the surface, hairline. */
export const RULE = '#e2e5ea';
/** `--surface-2`: control grounds and the table header. */
export const SURFACE_2 = '#f1f3f6';
/** `--ink-2`: axis labels and titles. Text never wears a data colour. */
export const LABEL_INK = '#5c6675';
/** `--ink-3`: the whisker rule, which is chrome around the box, not a series. */
export const MUTED_INK = '#6e7787';
/** `--highlight`: Google Amber 400. State only -- it never encodes data. */
export const HIGHLIGHT = '#ffca28';
/** `--highlight-ink`: text on amber, and the dark edge of the focus indicator. */
export const HIGHLIGHT_INK = '#5c4300';

/**
 * `--series-1`: the default single-series mark.
 *
 * Only a single-series chart uses it. A comparison panel's cohorts are coloured
 * from {@link CATEGORY_PALETTE} by their own palette index -- including the
 * derived "This dashboard", which holds slot 0 so a panel converted to a
 * comparison keeps the colour its bars had.
 */
export const POPULATION_COLOR = '#0072b2';
/** `--ink`: the median tick, read as a reference line rather than a series. */
export const MEDIAN_COLOR = '#1f2430';

/* ------------------------------------------------- the categorical palette */

/** Okabe–Ito, fixed hue order; the neutral folded tail is separate. */
export const CATEGORY_PALETTE: readonly string[] = [
  '#0072b2', '#009e73', '#56b4e9', '#d55e00', '#cc79a7', '#e69f00',
];

/** How many named groups a categorical chart draws before folding the tail. */
export const MAX_CATEGORIES = CATEGORY_PALETTE.length;

/**
 * The hex a cohort's palette index names.
 *
 * Total, and modular: a `Cohort.color` arrives from state and from shared links,
 * so it has to answer for any integer rather than hand a spec `undefined`. The
 * index is assigned once at creation and never re-ranked, which is what keeps a
 * cohort's hue stable as others come and go.
 */
export function cohortColor(index: number): string {
  if (!Number.isFinite(index)) return CATEGORY_PALETTE[0];
  const slot = Math.trunc(index) % CATEGORY_PALETTE.length;
  return CATEGORY_PALETTE[slot < 0 ? slot + CATEGORY_PALETTE.length : slot];
}

/**
 * A group keeps this colour when its peers are filtered, folded or reordered.
 * Vega's inferred nominal domain is first-seen and therefore changes a hue as
 * rows arrive; a deterministic label slot is the small, safe fallback when the
 * catalog's full value list is not available to a spec builder.
 */
export function groupColorIndex(label: string): number {
  let hash = 2166136261;
  for (let i = 0; i < label.length; i += 1) {
    hash ^= label.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % CATEGORY_PALETTE.length;
}

export function groupColor(label: string): string {
  if (label === 'Other') return OTHER_COLOR;
  return CATEGORY_PALETTE[groupColorIndex(label)];
}

/** A scale range for labels already ordered by the field, not by result rank. */
export function groupRange(labels: readonly string[], ordered = false, theme: ChartTheme = LIGHT_THEME): readonly string[] {
  const named = [...new Set(labels.filter((label) => label !== 'Other'))].sort((a, b) =>
    a.localeCompare(b, 'en', { numeric: true }));
  const colors = ordered ? batlowRange(named.length) : theme.categories;
  return labels.map((label) => label === 'Other' ? OTHER_COLOR : colors[named.indexOf(label) % colors.length]);
}

/** Neutral Other always occupies the final scale slot. */
export const OTHER_COLOR = '#8c9196';

/** Six chromatic hues and the neutral tail slot. */
export const CATEGORY_RANGE: readonly string[] = [...CATEGORY_PALETTE, OTHER_COLOR];

/** Named groups plus "Other": the longest legend any chart here can produce. */
export const MAX_LEGEND_ENTRIES = MAX_CATEGORIES + 1;

/** Six named curves plus the folded tail in an overlaid split distribution. */
export const MAX_OVERLAY_GROUPS = MAX_CATEGORIES;
/** Small multiples use the full categorical palette plus the folded tail. */
export const MAX_FACET_GROUPS = MAX_CATEGORIES;

/* ------------------------------------------------------------ ordinal data */

/** Crameri batlow, original samples 0..199 (the pale tail is excluded).
 * Source: Scientific colour maps, batlow.txt; https://www.fabiocrameri.ch/colourmaps/.
 */
const BATLOW_SAMPLES: readonly string[] = [
  '#011959', '#021b59', '#031c5a', '#041e5a', '#051f5a', '#06215b', '#07225b', '#07245b',
  '#08255b', '#09275c', '#0a285c', '#0a2a5c', '#0b2b5c', '#0b2d5d', '#0c2e5d', '#0c2f5d',
  '#0d315d', '#0d325e', '#0d335e', '#0e355e', '#0e365e', '#0e375e', '#0f385f', '#0f395f',
  '#0f3b5f', '#0f3c5f', '#103d5f', '#103e5f', '#103f60', '#104060', '#114160', '#114260',
  '#114360', '#114460', '#124561', '#124661', '#124761', '#124861', '#134961', '#134a61',
  '#134b61', '#144c62', '#144d62', '#144e62', '#154f62', '#154f62', '#165062', '#165162',
  '#175262', '#175362', '#185462', '#185562', '#195662', '#195762', '#1a5762', '#1b5862',
  '#1b5962', '#1c5a62', '#1d5b62', '#1e5c62', '#1e5d62', '#1f5d61', '#205e61', '#215f61',
  '#226061', '#236060', '#246160', '#256260', '#26635f', '#27635f', '#28645f', '#2a655e',
  '#2b655e', '#2c665d', '#2d675d', '#2f675c', '#30685c', '#31695b', '#33695a', '#346a5a',
  '#356a59', '#376b58', '#386c58', '#3a6c57', '#3b6d56', '#3c6d56', '#3e6e55', '#3f6e54',
  '#416f53', '#426f52', '#447052', '#457051', '#477150', '#48714f', '#4a724e', '#4c724d',
  '#4d734d', '#4f734c', '#50744b', '#52744a', '#537549', '#557548', '#577647', '#587646',
  '#5a7745', '#5b7745', '#5d7844', '#5f7843', '#607942', '#627941', '#637a40', '#657a3f',
  '#677b3e', '#687b3e', '#6a7b3d', '#6c7c3c', '#6d7c3b', '#6f7d3a', '#717d39', '#737e38',
  '#747e38', '#767f37', '#787f36', '#798035', '#7b8034', '#7d8134', '#7f8133', '#818232',
  '#828231', '#848331', '#868330', '#88842f', '#8a842f', '#8c852e', '#8e852e', '#8f862d',
  '#91862d', '#93872c', '#95872c', '#97882c', '#99882c', '#9b892b', '#9d892b', '#9f892b',
  '#a18a2b', '#a38a2c', '#a58b2c', '#a78b2c', '#a98c2c', '#ab8c2d', '#ad8c2d', '#af8d2e',
  '#b18d2f', '#b38e2f', '#b58e30', '#b78e31', '#b98f32', '#bb8f33', '#bd8f34', '#be9035',
  '#c09036', '#c29037', '#c49138', '#c6913a', '#c8913b', '#ca923c', '#cb923e', '#cd923f',
  '#cf9340', '#d19342', '#d29343', '#d49445', '#d69446', '#d89448', '#d9954a', '#db954b',
  '#dd954d', '#de964f', '#e09651', '#e19752', '#e39754', '#e49756', '#e69858', '#e7985a',
  '#e9995c', '#ea995e', '#eb9a60', '#ed9a62', '#ee9b64', '#ef9b67', '#f09c69', '#f19d6b',
  '#f29d6d', '#f39e70', '#f49f72', '#f59f74', '#f6a077', '#f7a179', '#f8a17b', '#f8a27e',
];

export function batlowRange(count: number): readonly string[] {
  const n = Math.max(0, Math.trunc(Number.isFinite(count) ? count : 0));
  if (n === 0) return [];
  if (n === 1) return [BATLOW_SAMPLES[100]];
  return Array.from({ length: n }, (_, i) => BATLOW_SAMPLES[Math.round(i * 199 / (n - 1))]);
}

export interface ChartTheme {
  mode: 'light' | 'dark';
  surface: string; surface2: string; rule: string;
  labelInk: string; mutedInk: string; medianColor: string;
  highlight: string; highlightInk: string; populationColor: string;
  categories: readonly string[];
}
export const LIGHT_THEME: ChartTheme = {
  mode: 'light', surface: SURFACE, surface2: SURFACE_2, rule: RULE,
  labelInk: LABEL_INK, mutedInk: MUTED_INK, medianColor: MEDIAN_COLOR,
  highlight: HIGHLIGHT, highlightInk: HIGHLIGHT_INK, populationColor: POPULATION_COLOR,
  categories: CATEGORY_PALETTE,
};
/** Nearest passing fixed-hue grid search against the validator's dark band.
 * The validator itself supplies no replacement steps. Grey is deliberately exempt
 * from its chroma floor; full seven-slot validation reports that failure honestly.
 */
export const DARK_THEME: ChartTheme = {
  mode: 'dark', surface: '#1c222c', surface2: '#252d3a', rule: '#2d3645',
  labelInk: '#9aa5b8', mutedInk: '#939fb2', medianColor: '#e8ecf2',
  highlight: '#ffd54f', highlightInk: '#2b2000', populationColor: '#009aed',
  categories: ['#009aed', '#009e73', '#1d729d', '#d55e00', '#c976a4', '#a26f00'],
};

/** Translate a palette slot, leaving non-categorical (e.g. ordinal) colours intact. */
export function themedColor(color: string, theme: ChartTheme = LIGHT_THEME): string {
  const index = CATEGORY_PALETTE.indexOf(color.toLowerCase());
  return index < 0 ? color : theme.categories[index];
}

/* -------------------------------------------------------- the shared config */

/**
 * Shared look: no chart junk, recessive hairline grid, label text in `--ink-2`,
 * a tooltip on every mark, and a 2px surface gap between touching bars.
 *
 * `mark.tooltip` is set once here rather than per mark, so a chart type cannot
 * be added without one. `bar.binSpacing` is the gap for the pre-binned
 * histograms; `scale.bandPaddingInner` is the same gap for the band-scaled
 * coverage columns, which is the only lever a band scale offers.
 */
export function baseConfig(theme: ChartTheme = LIGHT_THEME) { return {
  background: 'transparent',
  padding: 4,
  config: {
    font: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
    mark: { tooltip: true },
    text: { color: theme.labelInk },
    bar: { binSpacing: 2 },
    scale: { bandPaddingInner: 0.12 },
    axis: {
      labelFontSize: 12,
      titleFontSize: 12,
      titleFontWeight: 400,
      labelColor: theme.labelInk,
      titleColor: theme.labelInk,
      tickColor: theme.rule,
      domainColor: theme.rule,
      gridColor: theme.rule,
      gridWidth: 1,
      gridDash: [] as number[],
      labelPadding: 4,
      titlePadding: 6,
      // Thin the tick labels rather than running them together: the coverage
      // axis has one tick per year and nine of them in 370px.
      labelOverlap: 'greedy',
      labelSeparation: 4,
    },
    // Value gridlines only. A vertical rule behind a column reads as a second
    // mark; the band itself already says where the column belongs.
    axisX: { grid: false },
    axisY: { grid: true },
    legend: {
      labelFontSize: 12,
      titleFontSize: 12,
      labelColor: theme.labelInk,
      titleColor: theme.labelInk,
      symbolType: 'square',
      symbolSize: 56,
    },
    header: { labelFontSize: 12, titleFontSize: 12, labelColor: theme.labelInk, titleColor: theme.labelInk },
    view: { stroke: null },
    // No `title` entry, and no spec sets one: the card header already names the
    // panel, and a title inside the plot repeats it in a smaller font.
    // (`title: null` is not the way to say that -- Vega-Lite destructures the
    // title config unconditionally and throws on a null.)
  },
} as const; }

export const BASE_CONFIG = baseConfig();

/** Axis title for a metric: its label, plus its unit when the catalog has one. */
export function axisTitle(label: string, unit?: string): string {
  return unit ? `${label} (${unit})` : label;
}

/**
 * The interval selection every brushable spec declares, named `brush`.
 *
 * Amber at 35% with a 1px amber edge: the brush is state the user created, so
 * it wears the highlight and never a series colour.
 */
export const BRUSH_PARAM = {
  name: 'brush',
  select: {
    type: 'interval',
    encodings: ['x'],
    mark: {
      fill: HIGHLIGHT,
      fillOpacity: 0.35,
      stroke: HIGHLIGHT,
      strokeWidth: 1,
      strokeOpacity: 1,
      strokeDash: [],
    },
  },
} as const;

/**
 * The same parameter, seeded with the interval the dashboard already holds.
 *
 * Vega reads a parameter's `value` once, at embed time, so this makes a brush
 * that arrived from a link or survived a chart change visible without feeding
 * it back: it is the panel's own selection, drawn where the user drew it.
 */
export function brushParam(value: readonly [number, number] | null, theme: ChartTheme = LIGHT_THEME): Record<string, unknown> {
  const param = { ...BRUSH_PARAM, select: { ...BRUSH_PARAM.select,
    mark: { ...BRUSH_PARAM.select.mark, fill: theme.highlight, stroke: theme.highlight } } };
  return value === null ? param : { ...param, value: { x: [value[0], value[1]] } };
}

/**
 * The size contract for a chart that fills its card's chart area: the width and
 * the height both come from the container, and `fit` makes Vega lay the axis
 * bands out *inside* that box rather than past it, so a 260px area never ends
 * up with a nested scrollbar hiding its own x axis.
 */
export const FILLS_CONTAINER = {
  width: 'container',
  height: 'container',
  autosize: { type: 'fit', contains: 'padding' },
} as const;

/** X scale for a metric axis: log when the catalog or the panel asks for it. */
export function valueScale(scale: boolean | 'linear' | 'log' | 'symlog' | 'time', range?: 'auto' | readonly [number, number], constant = 1): Record<string, unknown> {
  return { ...(scale === 'time' ? { type: 'utc', nice: false } : scale === true || scale === 'log' ? { type: 'log', clamp: true, nice: false }
    : scale === 'symlog' ? { type: 'symlog', constant, zero: false, nice: false } : { zero: false, nice: true }),
    ...(Array.isArray(range) ? { domain: [...range], nice: false } : {}) };
}

/**
 * The legend a chart with two or more series carries, and the only legend any
 * spec here declares: a one-series chart has none, because its one colour is
 * already named by the card header.
 */
export const SERIES_LEGEND = {
  orient: 'bottom',
  // A grid rather than one horizontal line: a coverage panel grouped by
  // manufacturer has a dozen entries, and a single row of them runs off the
  // right edge of the card instead of wrapping.
  columns: 3,
  labelLimit: 110,
  rowPadding: 2,
  offset: 4,
  title: null,
  // Seven is every colour the palette has plus "Other". The rows are folded to
  // that before they get here, so this is a backstop and not the mechanism:
  // without it a chart fed unfolded rows would quietly draw a legend taller
  // than its own plot.
  symbolLimit: MAX_LEGEND_ENTRIES,
} as const;
