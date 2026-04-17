import * as React from "react"
import { MeasuresSidebar, type MeasureGroup } from "@/components/measures-sidebar"
import { SearchForm } from "@/components/search-form"
import { ModalitySwitcher } from "@/components/modality-switcher"
import {
  fuzzyFilterMetrics,
  getMetricSummaryMap,
  groupMetricsByCategory,
} from "@/lib/metric-catalog"
import type {
  MetricCatalog,
  MetricId,
  MetricSummary,
  ModalityId,
} from "@/types/ui"
import {
  Sidebar,
  SidebarHeader,
  SidebarRail,
} from "@/components/ui/sidebar"

export function AppSidebar({
  selectedModality,
  selectedMetric,
  catalog,
  summaries,
  query,
  onSelectModality,
  onSelectMetric,
  onQueryChange,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  selectedModality: ModalityId
  selectedMetric: MetricId | null
  catalog: MetricCatalog
  summaries: MetricSummary[]
  query: string
  onSelectModality: (modality: ModalityId) => void
  onSelectMetric: (metric: MetricId) => void
  onQueryChange: (query: string) => void
}) {
  const groups = React.useMemo<MeasureGroup[]>(() => {
    const modality = catalog.find((entry) => entry.name === selectedModality)
    if (!modality) {
      return []
    }

    const filteredMetrics = fuzzyFilterMetrics(modality.metrics, query)
    const summaryMap = getMetricSummaryMap(summaries)

    return groupMetricsByCategory(filteredMetrics).map((group) => ({
      title: group.family,
      items: group.subfamilies.map((subfamily) => ({
        title: subfamily.name,
        isActive: subfamily.metrics.some((metric) => metric.field === selectedMetric),
        badge: String(subfamily.metrics.length),
        items: subfamily.metrics.map((metric) => {
          const summary = summaryMap.get(metric.field)
          return {
            title: metric.label,
            subtitle: metric.field,
            isActive: selectedMetric === metric.field,
            badge: summary ? String(summary.value_count) : undefined,
            onSelect: () => onSelectMetric(metric.field),
          }
        }),
      })),
    }))
  }, [catalog, onSelectMetric, query, selectedMetric, selectedModality, summaries])

  return (
    <Sidebar {...props}>
      <SidebarHeader>
        <ModalitySwitcher
          modalities={catalog.map((entry) => entry.name)}
          selectedModality={selectedModality}
          onSelectModality={onSelectModality}
        />
        <SearchForm query={query} onQueryChange={onQueryChange} />
      </SidebarHeader>
      <MeasuresSidebar groups={groups} />
      <SidebarRail />
    </Sidebar>
  )
}
