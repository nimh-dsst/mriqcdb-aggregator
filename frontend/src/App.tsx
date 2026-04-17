import { useEffect, useMemo, useState } from "react"
import { AppSidebar } from "@/components/qc-measures-sidebar"
import { MetricHistogramCard } from "@/components/metric-histogram-card"
import { ViewSwitcher } from "@/components/view-switcher"
import {
  describeMetric,
  getMetricDescriptor,
  getModality,
} from "@/lib/metric-catalog"
import {
  fetchMetricSummaries,
  fetchModalities,
} from "@/lib/api"
import { cn } from "@/lib/utils"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import type {
  MetricCatalog,
  MetricId,
  MetricSummary,
  ModalityId,
  ViewId,
} from "@/types/ui"

type CatalogState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; catalog: MetricCatalog }

const DEFAULT_MODALITY: ModalityId = "bold"
const MAX_SELECTED_METRICS = 12

function readUrlState() {
  const params = new URLSearchParams(window.location.search)
  const metricsParam = params.get("metrics")
  const metric = params.get("metric")

  return {
    modality: params.get("modality") as ModalityId | null,
    metrics:
      metricsParam
        ?.split(",")
        .map((value) => value.trim())
        .filter(Boolean) ?? (metric ? [metric] : []),
    query: params.get("q") ?? "",
    view: (params.get("view") as ViewId | null) ?? "series",
  }
}

function getGridClassName(selectedCount: number) {
  if (selectedCount <= 1) {
    return "grid-cols-1"
  }

  if (selectedCount <= 4) {
    return "grid-cols-1 xl:grid-cols-2"
  }

  if (selectedCount <= 8) {
    return "grid-cols-1 xl:grid-cols-2"
  }

  return "grid-cols-1 2xl:grid-cols-2"
}

function App() {
  const [{ modality: initialModality, metrics: initialMetrics, query: initialQuery, view: initialView }] =
    useState(() => readUrlState())
  const [catalogState, setCatalogState] = useState<CatalogState>({ status: "loading" })
  const [selectedModality, setSelectedModality] = useState<ModalityId>(
    initialModality ?? DEFAULT_MODALITY
  )
  const [selectedMetricsByModality, setSelectedMetricsByModality] = useState<
    Partial<Record<ModalityId, MetricId[]>>
  >(
    initialMetrics.length
      ? { [(initialModality ?? DEFAULT_MODALITY) as ModalityId]: initialMetrics }
      : {}
  )
  const [selectedView, setSelectedView] = useState<ViewId>(initialView)
  const [query, setQuery] = useState(initialQuery)
  const [summaries, setSummaries] = useState<MetricSummary[]>([])
  const [summariesError, setSummariesError] = useState<string | null>(null)
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    void fetchModalities().then(
      (catalog) => {
        if (!cancelled) {
          setCatalogState({ status: "ready", catalog })
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setCatalogState({
            status: "error",
            message:
              error instanceof Error
                ? error.message
                : "Unexpected error while loading metric metadata.",
          })
        }
      }
    )

    return () => {
      cancelled = true
    }
  }, [])

  const activeModality = useMemo<ModalityId>(() => {
    if (catalogState.status !== "ready") {
      return selectedModality
    }

    return (
      getModality(catalogState.catalog, selectedModality)?.name ??
      catalogState.catalog[0]?.name ??
      selectedModality
    )
  }, [catalogState, selectedModality])

  useEffect(() => {
    if (catalogState.status !== "ready") {
      return
    }

    let cancelled = false

    void fetchMetricSummaries(activeModality, selectedView).then(
      (nextSummaries) => {
        if (!cancelled) {
          setSummaries(nextSummaries)
          setSummariesError(null)
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setSummaries([])
          setSummariesError(
            error instanceof Error
              ? error.message
              : "Unexpected error while loading metric summaries."
          )
        }
      }
    )

    return () => {
      cancelled = true
    }
  }, [activeModality, catalogState, selectedView])

  const selectedMetrics = useMemo(() => {
    if (catalogState.status !== "ready") {
      return []
    }

    const modality = getModality(catalogState.catalog, activeModality)
    const metricFields = new Set(modality?.metrics.map((metric) => metric.field) ?? [])
    const hasStoredSelection = Object.prototype.hasOwnProperty.call(
      selectedMetricsByModality,
      activeModality
    )
    const explicitSelection = (selectedMetricsByModality[activeModality] ?? []).filter(
      (metric) => metricFields.has(metric)
    )

    if (hasStoredSelection) {
      return explicitSelection
    }

    return modality?.metrics[0]?.field ? [modality.metrics[0].field] : []
  }, [activeModality, catalogState, selectedMetricsByModality])

  const selectedMetricDescriptors = useMemo(
    () =>
      selectedMetrics
        .map((metric) =>
          catalogState.status === "ready"
            ? getMetricDescriptor(catalogState.catalog, activeModality, metric)
            : null
        )
        .filter((descriptor) => descriptor !== null),
    [activeModality, catalogState, selectedMetrics]
  )

  useEffect(() => {
    const params = new URLSearchParams()
    params.set("modality", activeModality)
    if (selectedMetrics.length) {
      params.set("metrics", selectedMetrics.join(","))
    }
    params.set("view", selectedView)
    if (query.trim()) {
      params.set("q", query.trim())
    }

    const nextUrl = `${window.location.pathname}?${params.toString()}`
    window.history.replaceState(null, "", nextUrl)
  }, [activeModality, query, selectedMetrics, selectedView])

  useEffect(() => {
    const handlePopState = () => {
      const nextState = readUrlState()
      const nextModality = nextState.modality ?? DEFAULT_MODALITY
      setSelectedModality(nextModality)
      setSelectedMetricsByModality((current) => ({
        ...current,
        [nextModality]: nextState.metrics,
      }))
      setSelectedView(nextState.view)
      setQuery(nextState.query)
    }

    window.addEventListener("popstate", handlePopState)
    return () => window.removeEventListener("popstate", handlePopState)
  }, [])

  useEffect(() => {
    if (!selectionNotice) {
      return
    }

    const timeoutId = window.setTimeout(() => setSelectionNotice(null), 2500)
    return () => window.clearTimeout(timeoutId)
  }, [selectionNotice])

  const updateSelectedMetrics = (nextMetrics: MetricId[]) => {
    setSelectedMetricsByModality((current) => ({
      ...current,
      [activeModality]: nextMetrics.slice(0, MAX_SELECTED_METRICS),
    }))
  }

  const toggleSelectedMetric = (metric: MetricId) => {
    const isSelected = selectedMetrics.includes(metric)
    if (isSelected) {
      updateSelectedMetrics(selectedMetrics.filter((entry) => entry !== metric))
      return
    }

    if (selectedMetrics.length >= MAX_SELECTED_METRICS) {
      setSelectionNotice(`You can view up to ${MAX_SELECTED_METRICS} metrics at once.`)
      return
    }

    updateSelectedMetrics([...selectedMetrics, metric])
  }

  const handleSelectAllCurrentModality = () => {
    const modality = getModality(catalogState.status === "ready" ? catalogState.catalog : [], activeModality)
    const nextSelection = (modality?.metrics ?? [])
      .map((metric) => metric.field)
      .slice(0, MAX_SELECTED_METRICS)

    updateSelectedMetrics(nextSelection)

    if ((modality?.metrics.length ?? 0) > MAX_SELECTED_METRICS) {
      setSelectionNotice(
        `Selected the first ${MAX_SELECTED_METRICS} metrics for ${activeModality}.`
      )
    } else {
      setSelectionNotice(null)
    }
  }

  if (catalogState.status === "loading") {
    return (
      <SidebarProvider>
        <SidebarInset>
          <main className="flex min-h-screen items-center justify-center bg-background p-6 text-sm text-muted-foreground">
            Loading MRIQC metric catalog…
          </main>
        </SidebarInset>
      </SidebarProvider>
    )
  }

  if (catalogState.status === "error") {
    return (
      <SidebarProvider>
        <SidebarInset>
          <main className="flex min-h-screen items-center justify-center bg-background p-6">
            <div className="rounded-3xl border border-destructive/30 bg-destructive/5 p-6 text-sm text-muted-foreground">
              Failed to load the MRIQC metric catalog: {catalogState.message}
            </div>
          </main>
        </SidebarInset>
      </SidebarProvider>
    )
  }

  return (
    <SidebarProvider>
      <AppSidebar
        catalog={catalogState.catalog}
        selectedModality={activeModality}
        selectedMetrics={selectedMetrics}
        summaries={summaries}
        query={query}
        onSelectModality={setSelectedModality}
        onToggleMetric={toggleSelectedMetric}
        onSelectAllVisible={handleSelectAllCurrentModality}
        onClearSelection={() => updateSelectedMetrics([])}
        onQueryChange={setQuery}
      />
      <SidebarInset>
        <header className="flex h-14 items-center gap-3 border-b px-4">
          <SidebarTrigger />
          <div>
            <p className="text-sm font-semibold">MRIQC Aggregator</p>
            <p className="text-xs text-muted-foreground">
              {activeModality} · {selectedMetrics.length} selected metric
              {selectedMetrics.length === 1 ? "" : "s"}
            </p>
          </div>
        </header>
        <main className="min-h-[calc(100vh-3.5rem)] bg-[radial-gradient(circle_at_top,rgba(73,119,104,0.12),transparent_42%),linear-gradient(180deg,rgba(249,247,243,0.96),rgba(239,235,226,0.82))] px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto flex max-w-[1600px] flex-col gap-6">
            {summariesError ? (
              <p className="text-sm text-destructive">{summariesError}</p>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-[1.6rem] border border-border/70 bg-card/75 px-5 py-4 shadow-[0_18px_40px_-32px_rgba(36,66,52,0.35)]">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary/75">
                  QC Distributions
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Comparing {selectedMetrics.length} selected metrics for {activeModality}.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {selectionNotice ? (
                  <span className="rounded-full border border-amber-300/70 bg-amber-100/80 px-3 py-1 text-xs font-medium text-amber-900">
                    {selectionNotice}
                  </span>
                ) : null}
                <ViewSwitcher selectedView={selectedView} onSelectView={setSelectedView} />
              </div>
            </div>
            {selectedMetricDescriptors.length ? (
              <div className={cn("grid gap-5", getGridClassName(selectedMetricDescriptors.length))}>
                {selectedMetricDescriptors.map((descriptor) => (
                  <MetricHistogramCard
                    key={`${activeModality}:${descriptor.field}:${selectedView}`}
                    modality={activeModality}
                    metric={descriptor.field}
                    metricLabel={descriptor.label}
                    metricDescription={describeMetric(descriptor)}
                    selectedView={selectedView}
                    onRemove={() => toggleSelectedMetric(descriptor.field)}
                    compact={selectedMetricDescriptors.length > 1}
                  />
                ))}
              </div>
            ) : (
              <section className="rounded-3xl border border-dashed border-border/70 bg-card/80 p-8 text-sm text-muted-foreground">
                Select one or more QC metrics from the sidebar to build the comparison grid.
              </section>
            )}
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}

export default App
