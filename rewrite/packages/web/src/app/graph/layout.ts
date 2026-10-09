import type { Panel, State } from './state';

/** A panel rectangle in the fixed twelve-column dashboard grid. */
export interface GridPos {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export type DashboardLayout = Readonly<Record<string, GridPos>>;

/** The panel fields used to choose a default dashboard size. */
export type LayoutPanel = Pick<
  Panel,
  'id' | 'x' | 'y' | 'chart' | 'split' | 'cohorts' | 'options'
> & { readonly rows?: number };

const GRID_COLUMNS = 12;
const MIN_WIDTH = 3;
const MIN_HEIGHT = 5;
const DEFAULT_HEIGHT = 10;

type MutableGridPos = {
  x: number;
  y: number;
  w: number;
  h: number;
};

type LayoutEntry = {
  id: string;
  pos: MutableGridPos;
};

function integer(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.trunc(value)
    : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function normalizePos(pos: GridPos): MutableGridPos {
  const w = clamp(integer(pos.w, MIN_WIDTH), MIN_WIDTH, GRID_COLUMNS);
  const h = Math.max(MIN_HEIGHT, integer(pos.h, MIN_HEIGHT));

  return {
    x: clamp(integer(pos.x, 0), 0, GRID_COLUMNS - w),
    y: Math.max(0, integer(pos.y, 0)),
    w,
    h,
  };
}

function overlaps(left: GridPos, right: GridPos): boolean {
  return (
    left.x < right.x + right.w &&
    left.x + left.w > right.x &&
    left.y < right.y + right.h &&
    left.y + left.h > right.y
  );
}

function collides(pos: GridPos, entries: readonly LayoutEntry[]): boolean {
  return entries.some((entry) => overlaps(pos, entry.pos));
}

function firstFreeY(
  pos: MutableGridPos,
  entries: readonly LayoutEntry[],
  startingY: number,
): number {
  let y = Math.max(0, startingY);
  const candidate = { ...pos, y };

  while (true) {
    const collisions = entries.filter((entry) => overlaps(candidate, entry.pos));
    if (collisions.length === 0) {
      return y;
    }

    y = Math.max(...collisions.map((entry) => entry.pos.y + entry.pos.h));
    candidate.y = y;
  }
}

function ordered(entries: readonly LayoutEntry[]): LayoutEntry[] {
  return [...entries].sort(
    (left, right) =>
      left.pos.y - right.pos.y || left.pos.x - right.pos.x || left.id.localeCompare(right.id),
  );
}

function asEntries(layout: DashboardLayout): LayoutEntry[] {
  return Object.entries(layout).map(([id, pos]) => ({
    id,
    pos: normalizePos(pos),
  }));
}

function asLayout(entries: readonly LayoutEntry[]): DashboardLayout {
  return Object.fromEntries(
    entries.map(({ id, pos }) => [id, { ...pos }]),
  ) as DashboardLayout;
}

function placeWithoutCollisions(
  entries: readonly LayoutEntry[],
  changedId?: string,
): LayoutEntry[] {
  const changed = changedId === undefined ? undefined : entries.find(({ id }) => id === changedId);
  const remaining = entries.filter(({ id }) => id !== changedId);
  const sequence = changed === undefined ? ordered(remaining) : [changed, ...ordered(remaining)];
  const placed: LayoutEntry[] = [];

  for (const entry of sequence) {
    const pos = { ...entry.pos };
    if (entry.id !== changedId) {
      pos.y = firstFreeY(pos, placed, pos.y);
    }
    placed.push({ id: entry.id, pos });
  }

  return placed;
}

function compactEntries(
  entries: readonly LayoutEntry[],
  changedId?: string,
): LayoutEntry[] {
  const changed = entries.find(({ id }) => id === changedId);
  const sequence = ordered(entries.filter(({ id }) => id !== changedId));
  const compacted: LayoutEntry[] = changed ? [changed] : [];

  for (const entry of sequence) {
    const pos = firstFreePosition(entry.pos, compacted);
    compacted.push({ id: entry.id, pos });
  }

  return compacted;
}

function settle(entries: readonly LayoutEntry[], changedId?: string): DashboardLayout {
  const compacted = asLayout(compactEntries(placeWithoutCollisions(entries, changedId), changedId));
  // Placement priority must not reorder the panel list or its saved layout keys.
  return Object.fromEntries(entries.map(({ id }) => [id, compacted[id]]));
}

function baseWidth(columnsWide: number): number {
  const columns = clamp(integer(columnsWide, 3), 1, 3);
  return GRID_COLUMNS / columns;
}

function isTwoDimensionalChart(chart: string): boolean {
  return ['density2d', 'scatter', 'hexbin', 'clusters'].includes(chart.toLowerCase());
}

function isBoxOrSmallMultiples(chart: string): boolean {
  return [
    'box',
    'boxplot',
    'smallmultiples',
    'facetedhistogram',
    'facetedecdf',
  ].includes(chart.toLowerCase());
}

function declaredRows(panel: LayoutPanel): number {
  const rows = panel.rows;
  if (typeof rows === 'number' && Number.isFinite(rows)) {
    return Math.max(0, Math.trunc(rows));
  }

  return panel.cohorts.length;
}

/** Preferred row counts come from series metadata, never measured card content. */
export function panelsWithPreferredRows(state: Pick<State, 'panels' | 'catalog' | 'global'>): readonly LayoutPanel[] {
  return state.panels.map(panel => {
    if (!isBoxOrSmallMultiples(panel.chart) && !(panel.split && panel.options.splitPresentation === 'facets')) return panel;
    const count = panel.split
      ? state.catalog?.fieldValues[panel.split]?.[state.global.modality]?.[state.global.view]?.length ?? 7
      : panel.cohorts.length;
    // Categorical chart rendering keeps six named series and one Other row.
    return { ...panel, rows: Math.min(7, count) };
  });
}

/**
 * Return the default grid rectangle for a panel at the current responsive width.
 * The rectangle is only a preference; placement is handled by deriveLayout and
 * reconcileLayout.
 */
export function preferredSize(panel: LayoutPanel, columnsWide: number): GridPos {
  const chart = panel.chart.toLowerCase();

  if (chart === 'correlation') {
    return normalizePos({ x: 0, y: 0, w: 8, h: 14 });
  }

  if (isTwoDimensionalChart(chart)) {
    return normalizePos({ x: 0, y: 0, w: 6, h: 12 });
  }

  const minimumHeight = panel.split && panel.x !== 'created_at' ? 12 : DEFAULT_HEIGHT;
  const h = isBoxOrSmallMultiples(chart) || (panel.split && panel.options.splitPresentation === 'facets')
    ? Math.max(minimumHeight, 4 + declaredRows(panel))
    : minimumHeight;
  let w = baseWidth(columnsWide);
  if (panel.x === 'created_at' || panel.cohorts.length > 1) {
    w *= 2;
  }

  return normalizePos({ x: 0, y: 0, w, h });
}

function firstFreePosition(
  preferred: GridPos,
  entries: readonly LayoutEntry[],
): MutableGridPos {
  const pos = normalizePos(preferred);
  const maximumOccupiedY = entries.reduce(
    (maximum, entry) => Math.max(maximum, entry.pos.y + entry.pos.h),
    0,
  );

  const candidateRows = [...new Set([0, ...entries.map(entry => entry.pos.y + entry.pos.h)])].sort((a, b) => a - b);
  for (const y of candidateRows) {
    for (let x = 0; x <= GRID_COLUMNS - pos.w; x += 1) {
      const candidate = { ...pos, x, y };
      if (!collides(candidate, entries)) {
        return candidate;
      }
    }
  }

  // The final row at x=0 is always available, but keeps TypeScript's control
  // flow explicit if the loop above is changed in the future.
  return { ...pos, x: 0, y: maximumOccupiedY };
}

/** Lay out a dashboard with no saved manual geometry, in panel list order. */
export function deriveLayout(
  panels: readonly LayoutPanel[],
  columnsWide: number,
): DashboardLayout {
  const entries: LayoutEntry[] = [];

  for (const panel of panels) {
    const pos = firstFreePosition(preferredSize(panel, columnsWide), entries);
    entries.push({ id: panel.id, pos });
  }

  return asLayout(entries);
}

/** Pack up then left in spatial order, reserving the changed panel's position. */
export function compactLayout(layout: DashboardLayout, changedId?: string): DashboardLayout {
  return settle(asEntries(layout), changedId);
}

/** Resize one panel, clamp it to grid limits, and push conflicting panels down. */
export function resizeLayout(
  layout: DashboardLayout,
  id: string,
  w: number,
  h: number,
): DashboardLayout {
  const entries = asEntries(layout);
  const target = entries.find((entry) => entry.id === id);

  if (target === undefined) {
    return settle(entries);
  }

  target.pos = normalizePos({ ...target.pos, w, h });
  return settle(entries, id);
}

/** Pin a moved panel, push collisions down, then backfill the available space. */
export function moveLayout(
  layout: DashboardLayout,
  id: string,
  x: number,
  y: number,
): DashboardLayout {
  const entries = asEntries(layout);
  const target = entries.find((entry) => entry.id === id);

  if (target === undefined) {
    return settle(entries);
  }

  target.pos = normalizePos({ ...target.pos, x, y });
  return settle(entries, id);
}

/**
 * Reconcile saved manual geometry with the current panels. New panels are
 * placed at the first available row/column; missing panels are dropped.
 */
export function reconcileLayout(
  layout: DashboardLayout | null | undefined,
  panels: readonly LayoutPanel[],
  columnsWide: number,
): DashboardLayout {
  const saved = layout ?? {};
  const panelIds = new Set(panels.map((panel) => panel.id));
  const entries = asEntries(saved).filter(({ id }) => panelIds.has(id));
  const savedIds = new Set(entries.map(({ id }) => id));

  for (const panel of panels) {
    if (savedIds.has(panel.id)) {
      continue;
    }

    const pos = firstFreePosition(preferredSize(panel, columnsWide), entries);
    entries.push({ id: panel.id, pos });
  }

  return settle(entries);
}
