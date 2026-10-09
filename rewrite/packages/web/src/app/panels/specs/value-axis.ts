import { valueScale } from "./palette";

export type ValueScale = boolean | "linear" | "log" | "symlog" | "time";
export type ValueRange = "auto" | readonly [number, number];

/** The scale-related portion of a metric axis definition. */
export interface ValueAxisDescriptor {
  label?: string;
  unit?: string;
  logScale?: boolean;
  xScale?: ValueScale;
  yScale?: ValueScale;
  xRange?: ValueRange;
  yRange?: ValueRange;
  xPositive?: boolean;
  yPositive?: boolean;
  constant?: number;
  yMode?: "count" | "share" | "logCount";
  countTitle?: string;
}

type ValueDataset = readonly Record<string, unknown>[];
export type ValueDatasets =
  | readonly unknown[]
  | Readonly<Record<string, readonly unknown[]>>;

type Spec = Record<string, unknown>;
type Dimension = "x" | "y";

interface AxisEvidence {
  hasQuantitative: boolean;
  hasTemporal: boolean;
  hasNonPositiveValue: boolean;
  hasZeroBaseline: boolean;
}

interface ResolvedValueAxes {
  x: ValueScale;
  y: ValueScale;
}

const SCALE_SUFFIX = /\s+\((?:log|symlog)\)$/;
const CHILD_SPEC_KEYS = ["spec", "layer", "concat", "hconcat", "vconcat"] as const;

/**
 * Applies the metric's selected value scales to quantitative Vega-Lite x and y
 * encodings, including encodings nested in layered and faceted specifications.
 * The input spec is never mutated.
 */
export function withValueAxes<T extends object>(
  spec: T,
  axis: ValueAxisDescriptor,
  datasets?: ValueDatasets,
): T {
  const source = spec as unknown as Spec;
  const registry = datasetRegistry(source, datasets);
  const resolved = resolveValueAxes(source, axis, registry);
  return visitSpec(source, axis, resolved) as unknown as T;
}

function visitSpec(
  spec: Spec,
  axis: ValueAxisDescriptor,
  resolved: ResolvedValueAxes,
): Spec {
  const next: Spec = { ...spec };

  if (isRecord(spec["encoding"])) {
    next["encoding"] = withEncodingAxes(spec["encoding"], axis, resolved, spec["mark"]);
  }

  for (const key of CHILD_SPEC_KEYS) {
    const child = spec[key];
    if (isRecord(child)) {
      next[key] = visitSpec(child, axis, resolved);
    } else if (Array.isArray(child)) {
      next[key] = child.map((item) =>
        isRecord(item) ? visitSpec(item, axis, resolved) : item,
      );
    }
  }

  return next;
}

function withEncodingAxes(
  encoding: Spec,
  axis: ValueAxisDescriptor,
  resolved: ResolvedValueAxes,
  mark: unknown,
): Spec {
  const next: Spec = { ...encoding };

  for (const dimension of ["x", "y"] as const) {
    const definition = encoding[dimension];
    if (isRecord(definition)) {
      next[dimension] = withChannelAxis(
        definition,
        dimension,
        axis,
        resolved[dimension],
        dimension === "y" && requiresZeroBaseline(definition, encoding, mark),
      );
    }
  }

  return next;
}

function withChannelAxis(
  definition: Spec,
  dimension: Dimension,
  axis: ValueAxisDescriptor,
  resolved: ValueScale,
  zeroBaseline: boolean,
): Spec {
  const temporal = definition["type"] === "temporal";
  if (definition["type"] !== "quantitative" && !temporal) {
    return definition;
  }

  if (definition["scale"] === false) {
    return definition;
  }

  const range = dimension === "x" ? axis.xRange : axis.yRange;
  const existingScale = isRecord(definition["scale"]) ? definition["scale"] : undefined;
  const base = valueScale(resolved, range, resolved === "symlog" ? 1 : axis.constant);
  const scale: Spec = {
    ...(existingScale ?? {}),
    ...base,
  };
  if (zeroBaseline || (dimension === "y" && axis.yMode === "logCount")) {
    scale["zero"] = true;
  }

  if (resolved === "linear") {
    scale["type"] = "linear";
  }

  // The configured metric range describes the selected value domain and takes
  // precedence over defaults such as a normalized [0, 1] chart domain.
  if (numericDomain(range)) {
    scale["domain"] = range;
  } else if (existingScale?.["domain"] !== undefined) {
    scale["domain"] = existingScale["domain"];
  }
  if (existingScale?.["range"] !== undefined) {
    scale["range"] = existingScale["range"];
  }

  const next: Spec = { ...definition, scale };
  if (resolved === "log" || resolved === "symlog") {
    const titledAxis = withScaleTitle(
      definition["axis"],
      titleFallback(dimension, axis),
      dimension === "y" && axis.yMode === "logCount" ? "log" : resolved,
      typeof definition["title"] === "string" ? definition["title"] : undefined,
    );
    const isCountAxis =
      dimension === "y" &&
      (axis.yMode === "logCount" ||
        definition["field"] === "count" ||
        definition["field"] === "plotCount");
    next["axis"] =
      isCountAxis && titledAxis !== null && titledAxis !== false
        ? {
            ...(isRecord(titledAxis) ? titledAxis : {}),
            tickCount: { expr: "max(2, floor(height / 40))" },
            format: "~s",
          }
        : titledAxis;
  }
  return next;
}

function requestedScale(dimension: Dimension, axis: ValueAxisDescriptor): ValueScale {
  if (dimension === "y" && axis.yMode === "logCount") {
    return "symlog";
  }
  const selected = dimension === "x" ? axis.xScale : axis.yScale;
  if (selected !== undefined) {
    return selected === true ? "log" : selected === false ? "linear" : selected;
  }
  if (dimension === "x") {
    return axis.logScale ? "log" : "linear";
  }
  return "linear";
}

function resolveValueAxes(
  spec: Spec,
  axis: ValueAxisDescriptor,
  registry: Map<string, ValueDataset>,
): ResolvedValueAxes {
  const evidence: Record<Dimension, AxisEvidence> = {
    x: emptyEvidence(),
    y: emptyEvidence(),
  };
  collectAxisEvidence(spec, registry, undefined, undefined, evidence);
  return {
    x: resolveAxisScale("x", axis, evidence["x"]),
    y: resolveAxisScale("y", axis, evidence["y"]),
  };
}

function emptyEvidence(): AxisEvidence {
  return {
    hasQuantitative: false,
    hasTemporal: false,
    hasNonPositiveValue: false,
    hasZeroBaseline: false,
  };
}

function collectAxisEvidence(
  spec: Spec,
  registry: Map<string, ValueDataset>,
  inheritedData: unknown,
  inheritedMark: unknown,
  evidence: Record<Dimension, AxisEvidence>,
): void {
  addDatasets(registry, spec["datasets"]);
  const data = spec["data"] ?? inheritedData;
  const mark = spec["mark"] ?? inheritedMark;
  const encoding = spec["encoding"];

  if (isRecord(encoding)) {
    const rows = rowsFor(data, registry);
    for (const dimension of ["x", "y"] as const) {
      const definition = encoding[dimension];
      if (!isRecord(definition)) {
        continue;
      }
      if (definition["type"] === "temporal") {
        evidence[dimension].hasTemporal = true;
        continue;
      }
      if (definition["type"] !== "quantitative") {
        continue;
      }

      const dimensionEvidence = evidence[dimension];
      dimensionEvidence.hasQuantitative = true;
      collectDefinitionValues(definition, rows, dimensionEvidence);
      collectDefinitionValues(encoding[`${dimension}2`], rows, dimensionEvidence);
      if (dimension === "y" && requiresZeroBaseline(definition, encoding, mark)) {
        dimensionEvidence.hasZeroBaseline = true;
      }
    }
  }

  for (const key of CHILD_SPEC_KEYS) {
    const child = spec[key];
    if (isRecord(child)) {
      collectAxisEvidence(child, registry, data, mark, evidence);
    } else if (Array.isArray(child)) {
      for (const item of child) {
        if (isRecord(item)) {
          collectAxisEvidence(item, registry, data, mark, evidence);
        }
      }
    }
  }
}

function resolveAxisScale(
  dimension: Dimension,
  axis: ValueAxisDescriptor,
  evidence: AxisEvidence,
): ValueScale {
  if (evidence.hasTemporal) {
    return "time";
  }

  const selected = requestedScale(dimension, axis);
  if (selected !== "log") {
    return selected;
  }

  const range = dimension === "x" ? axis.xRange : axis.yRange;
  const configuredDomain = numericDomain(range);
  if (configuredDomain) {
    return configuredDomain[0] > 0 && configuredDomain[1] > 0 ? "log" : "symlog";
  }

  const positiveHint = dimension === "x" ? axis.xPositive : axis.yPositive;
  if (
    evidence.hasZeroBaseline ||
    evidence.hasNonPositiveValue ||
    positiveHint === false
  ) {
    return "symlog";
  }
  return "log";
}

function collectDefinitionValues(
  definition: unknown,
  rows: ValueDataset | undefined,
  evidence: AxisEvidence,
): void {
  if (!isRecord(definition)) {
    return;
  }
  addNumericValue(definition["datum"], evidence);
  const scale = definition["scale"];
  if (isRecord(scale)) {
    const domain = numericDomain(scale["domain"]);
    if (domain) {
      addNumericValue(domain[0], evidence);
      addNumericValue(domain[1], evidence);
    }
  }
  if (typeof definition["field"] !== "string" || !rows) {
    return;
  }
  for (const row of rows) {
    addNumericValue(row[definition["field"]], evidence);
  }
}

function addNumericValue(value: unknown, evidence: AxisEvidence): void {
  if (typeof value === "number" && Number.isFinite(value) && value <= 0) {
    evidence.hasNonPositiveValue = true;
  }
}

function requiresZeroBaseline(definition: Spec, encoding: Spec, mark: unknown): boolean {
  if (encoding["y2"] !== undefined) {
    return false;
  }
  const markType =
    typeof mark === "string" ? mark : isRecord(mark) ? mark["type"] : undefined;
  return (
    markType === "bar" ||
    markType === "area" ||
    definition["aggregate"] === "count"
  );
}

function withScaleTitle(
  axis: unknown,
  fallback: string | undefined,
  scale: "log" | "symlog",
  preferredTitle?: string,
): unknown {
  if (axis === false) {
    return axis;
  }
  const current = isRecord(axis) ? axis : {};
  const title =
    preferredTitle ??
    (typeof current["title"] === "string" ? current["title"] : fallback);
  if (!title) {
    return axis;
  }
  return { ...current, title: `${title.replace(SCALE_SUFFIX, "")} (${scale})` };
}

function titleFallback(dimension: Dimension, axis: ValueAxisDescriptor): string | undefined {
  if (dimension === "y") {
    return axis.countTitle;
  }
  if (!axis.label) {
    return undefined;
  }
  return axis.unit ? `${axis.label} (${axis.unit})` : axis.label;
}

function numericDomain(value: unknown): readonly [number, number] | undefined {
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number" &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  ) {
    return [value[0], value[1]];
  }
  return undefined;
}

function datasetRegistry(spec: Spec, datasets: ValueDatasets | undefined): Map<string, ValueDataset> {
  const registry = new Map<string, ValueDataset>();
  addDatasets(registry, spec["datasets"]);
  addDatasets(registry, datasets);
  return registry;
}

function addDatasets(registry: Map<string, ValueDataset>, datasets: unknown): void {
  if (Array.isArray(datasets) && datasets.every(isRecord)) {
    registry.set("__default__", datasets);
    return;
  }
  if (!isRecord(datasets)) {
    return;
  }
  for (const [name, value] of Object.entries(datasets)) {
    if (Array.isArray(value) && value.every(isRecord)) {
      registry.set(name, value);
    }
  }
}

function rowsFor(data: unknown, registry: ReadonlyMap<string, ValueDataset>): ValueDataset | undefined {
  if (Array.isArray(data) && data.every(isRecord)) {
    return data;
  }
  if (!isRecord(data)) {
    return undefined;
  }
  if (Array.isArray(data["values"]) && data["values"].every(isRecord)) {
    return data["values"];
  }
  if (typeof data["name"] === "string") {
    return registry.get(data["name"]);
  }
  return registry.get("__default__");
}

function isRecord(value: unknown): value is Spec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
