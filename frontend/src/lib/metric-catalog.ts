import type {
  MetricCatalog,
  MetricDescriptor,
  MetricId,
  MetricSummary,
  ModalityDescriptor,
  ModalityId,
} from "@/types/ui"

export type MetricCategoryGroup = {
  family: string
  subfamilies: Array<{
    name: string
    metrics: MetricDescriptor[]
  }>
}

export function getModality(
  catalog: MetricCatalog,
  modality: ModalityId | null
): ModalityDescriptor | null {
  return catalog.find((entry) => entry.name === modality) ?? null
}

export function getMetricDescriptor(
  catalog: MetricCatalog,
  modality: ModalityId,
  metric: MetricId | null
): MetricDescriptor | null {
  if (!metric) {
    return null
  }

  return (
    getModality(catalog, modality)?.metrics.find((entry) => entry.field === metric) ??
    null
  )
}

export function firstMetricForModality(
  catalog: MetricCatalog,
  modality: ModalityId | null
): MetricId | null {
  return getModality(catalog, modality)?.metrics[0]?.field ?? null
}

export function groupMetricsByCategory(
  metrics: MetricDescriptor[]
): MetricCategoryGroup[] {
  const families = new Map<string, Map<string, MetricDescriptor[]>>()

  for (const metric of metrics) {
    const family = families.get(metric.family) ?? new Map<string, MetricDescriptor[]>()
    const subfamily = family.get(metric.subfamily) ?? []
    subfamily.push(metric)
    family.set(metric.subfamily, subfamily)
    families.set(metric.family, family)
  }

  return [...families.entries()]
    .map(([family, subfamilies]) => ({
      family,
      subfamilies: [...subfamilies.entries()]
        .map(([name, familyMetrics]) => ({
          name,
          metrics: [...familyMetrics].sort((left, right) =>
            left.label.localeCompare(right.label)
          ),
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    }))
    .sort((left, right) => left.family.localeCompare(right.family))
}

export function fuzzyFilterMetrics(
  metrics: MetricDescriptor[],
  query: string
): MetricDescriptor[] {
  const trimmed = query.trim()
  if (!trimmed) {
    return metrics
  }

  return metrics
    .map((metric) => ({
      metric,
      score: fuzzyScore(
        `${metric.label} ${metric.field} ${metric.family} ${metric.subfamily}`,
        trimmed
      ),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.metric)
}

export function getMetricSummaryMap(summaries: MetricSummary[]) {
  return new Map(summaries.map((summary) => [summary.field, summary]))
}

export function describeMetric(metric: MetricDescriptor) {
  const field = metric.field.toLowerCase()

  if (field.startsWith("fd_")) {
    return "Head-motion summary derived from framewise displacement."
  }
  if (field.startsWith("fwhm_") || field === "fwhm_avg") {
    return "Estimated image smoothness across the volume."
  }
  if (field.startsWith("snr")) {
    return "Signal-to-noise ratio; higher usually indicates cleaner signal."
  }
  if (field.startsWith("cnr")) {
    return "Contrast-to-noise ratio between tissues or structures."
  }
  if (field.startsWith("cjv")) {
    return "Joint tissue variability; lower can indicate cleaner tissue contrast."
  }
  if (field.startsWith("efc")) {
    return "Entropy focus criterion, a blur and ghosting sensitivity measure."
  }
  if (field.startsWith("fber")) {
    return "Foreground-to-background energy ratio for tissue separation."
  }
  if (field.startsWith("inu_")) {
    return "Intensity non-uniformity estimate related to bias field effects."
  }
  if (field.startsWith("qi_")) {
    return "Artifact-focused quality index from the MRIQC structural workflow."
  }
  if (field.startsWith("rpve_")) {
    return "Residual partial-volume estimate for tissue segmentation quality."
  }
  if (field.startsWith("icvs_")) {
    return "Intracranial volume fraction estimated per tissue compartment."
  }
  if (field.startsWith("summary_")) {
    return "Regional summary statistic computed from a tissue mask."
  }
  if (field.startsWith("tpm_overlap_")) {
    return "Overlap between segmentation output and tissue probability maps."
  }
  if (field.startsWith("wm2max")) {
    return "White-matter intensity relative to the global maximum signal."
  }
  if (field.startsWith("gsr_")) {
    return "Global signal ratio describing asymmetry across image halves."
  }
  if (field.startsWith("dvars_")) {
    return "DVARS-based temporal change metric across successive volumes."
  }
  if (field.startsWith("aor")) {
    return "AFNI outlier ratio summarizing extreme voxel behavior."
  }
  if (field.startsWith("aqi")) {
    return "AFNI quality index summarizing image degradation."
  }
  if (field.startsWith("gcor")) {
    return "Global correlation estimate across BOLD time series."
  }
  if (field.startsWith("tsnr")) {
    return "Temporal signal-to-noise ratio across time points."
  }
  if (field.startsWith("size_")) {
    return "Acquisition matrix or voxel-count dimension reported by MRIQC."
  }
  if (field.startsWith("spacing_")) {
    return "Voxel spacing along one acquisition axis."
  }

  return `${metric.family} · ${metric.subfamily}`.replace(/\s+/g, " ").trim()
}

function fuzzyScore(haystack: string, query: string) {
  const source = haystack.toLowerCase()
  const needle = query.toLowerCase()

  let score = 0
  let lastIndex = -1
  let consecutive = 0

  for (const char of needle) {
    const index = source.indexOf(char, lastIndex + 1)
    if (index === -1) {
      return 0
    }

    consecutive = index === lastIndex + 1 ? consecutive + 1 : 0
    score += 1 + consecutive * 2
    if (index === 0 || source[index - 1] === " " || source[index - 1] === "_") {
      score += 3
    }
    lastIndex = index
  }

  if (source.includes(needle)) {
    score += needle.length * 4
  }

  return score
}
