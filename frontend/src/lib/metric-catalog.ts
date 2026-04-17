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
