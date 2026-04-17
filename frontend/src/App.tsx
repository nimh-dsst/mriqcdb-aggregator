import { useEffect, useMemo, useState } from "react"
import { AppSidebar } from "@/components/qc-measures-sidebar"
import { MetricHistogramCard } from "@/components/metric-histogram-card"
import { ViewSwitcher } from "@/components/view-switcher"
import {
  fuzzyFilterMetrics,
  getMetricDescriptor,
  getModality,
} from "@/lib/metric-catalog"
import {
  fetchMetricSummaries,
  fetchModalities,
} from "@/lib/api"
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

function readUrlState() {
  const params = new URLSearchParams(window.location.search)
  return {
    modality: params.get("modality"),
    metric: params.get("metric"),
    query: params.get("q") ?? "",
    view: (params.get("view") as ViewId | null) ?? "raw",
  }
}

function App() {
  const [{ modality: initialModality, metric: initialMetric, query: initialQuery, view: initialView }] =
    useState(() => readUrlState())
  const [catalogState, setCatalogState] = useState<CatalogState>({ status: "loading" })
  const [selectedModality, setSelectedModality] = useState<ModalityId>(
    (initialModality as ModalityId | null) ?? "bold"
  )
  const [selectedMetric, setSelectedMetric] = useState<MetricId | null>(
    initialMetric
  )
  const [selectedView, setSelectedView] = useState<ViewId>(initialView)
  const [query, setQuery] = useState(initialQuery)
  const [summaries, setSummaries] = useState<MetricSummary[]>([])
  const [summariesError, setSummariesError] = useState<string | null>(null)

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

  const selectedMetricDescriptor = useMemo(() => {
    if (catalogState.status !== "ready") {
      return null
    }

    const modality = getModality(catalogState.catalog, activeModality)
    const visibleMetrics = modality ? fuzzyFilterMetrics(modality.metrics, query) : []
    const activeMetric =
      visibleMetrics.some((metric) => metric.field === selectedMetric)
        ? selectedMetric
        : visibleMetrics[0]?.field ?? null

    return getMetricDescriptor(
      catalogState.catalog,
      activeModality,
      activeMetric
    )
  }, [activeModality, catalogState, query, selectedMetric])

  const activeMetric = selectedMetricDescriptor?.field ?? null

  useEffect(() => {
    const params = new URLSearchParams()
    params.set("modality", activeModality)
    if (activeMetric) {
      params.set("metric", activeMetric)
    }
    params.set("view", selectedView)
    if (query.trim()) {
      params.set("q", query.trim())
    }

    const nextUrl = `${window.location.pathname}?${params.toString()}`
    window.history.replaceState(null, "", nextUrl)
  }, [activeMetric, activeModality, query, selectedView])

  useEffect(() => {
    const handlePopState = () => {
      const nextState = readUrlState()
      setSelectedModality((nextState.modality as ModalityId | null) ?? "bold")
      setSelectedMetric(nextState.metric)
      setSelectedView(nextState.view)
      setQuery(nextState.query)
    }

    window.addEventListener("popstate", handlePopState)
    return () => window.removeEventListener("popstate", handlePopState)
  }, [])

  const selectedMetricSummary = useMemo(
    () => summaries.find((summary) => summary.field === activeMetric) ?? null,
    [activeMetric, summaries]
  )

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
        selectedMetric={activeMetric}
        summaries={summaries}
        query={query}
        onSelectModality={setSelectedModality}
        onSelectMetric={setSelectedMetric}
        onQueryChange={setQuery}
      />
      <SidebarInset>
        <header className="flex h-14 items-center gap-3 border-b px-4">
          <SidebarTrigger />
          <div>
            <p className="text-sm font-semibold">MRIQC Aggregator</p>
            <p className="text-xs text-muted-foreground">
              {activeModality} · {selectedMetricDescriptor?.family ?? "Metric browser"}
            </p>
          </div>
        </header>
        <main className="min-h-[calc(100vh-3.5rem)] bg-[radial-gradient(circle_at_top,rgba(73,119,104,0.12),transparent_42%),linear-gradient(180deg,rgba(249,247,243,0.96),rgba(239,235,226,0.82))] px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto flex max-w-6xl flex-col gap-6">
            <section className="rounded-3xl border border-border/60 bg-card/90 p-6 shadow-sm backdrop-blur">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                    Dashboard
                  </p>
                  <h1 className="mt-2 font-heading text-3xl font-semibold tracking-tight text-foreground">
                    MRIQC probability distributions
                  </h1>
                  <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
                    Metrics are grouped by modality, family, and subfamily in the
                    sidebar. Search is fuzzy and the current state is encoded in
                    the URL for shareable views.
                  </p>
                </div>
                <ViewSwitcher
                  selectedView={selectedView}
                  onSelectView={setSelectedView}
                />
              </div>
              <div className="mt-5 flex flex-wrap gap-3">
                <SummaryChip
                  label="Metric"
                  value={selectedMetricDescriptor?.label ?? "Select a metric"}
                />
                <SummaryChip
                  label="Category"
                  value={
                    selectedMetricDescriptor
                      ? `${selectedMetricDescriptor.family} · ${selectedMetricDescriptor.subfamily}`
                      : "N/A"
                  }
                />
                <SummaryChip
                  label="Values"
                  value={String(selectedMetricSummary?.value_count ?? 0)}
                />
                <SummaryChip
                  label="Missing"
                  value={String(selectedMetricSummary?.missing_count ?? 0)}
                />
              </div>
              {summariesError ? (
                <p className="mt-4 text-sm text-destructive">{summariesError}</p>
              ) : null}
            </section>
            {activeMetric ? (
              <MetricHistogramCard
                key={`${activeModality}:${activeMetric}:${selectedView}`}
                modality={activeModality}
                metric={activeMetric}
                metricLabel={selectedMetricDescriptor?.label ?? activeMetric}
                selectedView={selectedView}
              />
            ) : (
              <section className="rounded-3xl border border-dashed border-border/70 bg-card/80 p-8 text-sm text-muted-foreground">
                No metric matches the current modality and search filters.
              </section>
            )}
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}

function SummaryChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-sm font-medium text-foreground">{value}</p>
    </div>
  )
}

export default App
