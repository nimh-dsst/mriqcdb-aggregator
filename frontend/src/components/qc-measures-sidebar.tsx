import * as React from "react"
import { MeasuresSidebar, type MeasureGroup } from "@/components/measures-sidebar"
import { SearchForm } from "@/components/search-form"
import { ModalitySwitcher } from "@/components/modality-switcher"
import {
  describeMetric,
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
  selectedMetrics,
  catalog,
  summaries,
  query,
  onSelectModality,
  onToggleMetric,
  onSelectAllVisible,
  onClearSelection,
  onQueryChange,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  selectedModality: ModalityId
  selectedMetrics: MetricId[]
  catalog: MetricCatalog
  summaries: MetricSummary[]
  query: string
  onSelectModality: (modality: ModalityId) => void
  onToggleMetric: (metric: MetricId) => void
  onSelectAllVisible: () => void
  onClearSelection: () => void
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
        isActive: subfamily.metrics.some((metric) =>
          selectedMetrics.includes(metric.field)
        ),
        badge: String(subfamily.metrics.length),
        items: subfamily.metrics.map((metric) => {
          const summary = summaryMap.get(metric.field)
          return {
            title: metric.label,
            subtitle: metric.field,
            description: describeMetric(metric),
            isActive: selectedMetrics.includes(metric.field),
            badge: summary ? String(summary.value_count) : undefined,
            onSelect: () => onToggleMetric(metric.field),
          }
        }),
      })),
    }))
  }, [catalog, onToggleMetric, query, selectedMetrics, selectedModality, summaries])

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
      <div className="px-3 pb-2 text-[11px] uppercase tracking-[0.18em] text-sidebar-foreground/55">
        {selectedMetrics.length} selected
        {selectedMetrics.length > 0 ? (
          <button
            type="button"
            className="ml-2 text-sidebar-primary hover:underline"
            onClick={onClearSelection}
          >
            Clear
          </button>
        ) : null}
      </div>
      <MeasuresSidebar
        groups={groups}
        onSelectAll={onSelectAllVisible}
      />
      <SidebarRail />
    </Sidebar>
  )
}
