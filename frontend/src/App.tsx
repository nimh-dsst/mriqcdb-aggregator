import { useEffect, useMemo, useState } from "react"
import { AppSidebar } from "@/components/qc-measures-sidebar"
import { MetricHistogramCard } from "@/components/metric-histogram-card"
import { ReportUploadPanel } from "@/components/report-upload-panel"
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
import {
  buildUploadDrafts,
  finalizeUploadedReports,
  type UploadedFileDraft,
  type UploadedReportBundle,
} from "@/lib/uploaded-report"
import { cn } from "@/lib/utils"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { Button } from "@/components/ui/button"
import type {
  MetricCatalog,
  MetricDistribution,
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
  const [remoteSummaries, setRemoteSummaries] = useState<MetricSummary[]>([])
  const [remoteSummariesError, setRemoteSummariesError] = useState<string | null>(null)
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null)
  const [uploadedReports, setUploadedReports] = useState<UploadedReportBundle | null>(null)
  const [pendingUploads, setPendingUploads] = useState<UploadedFileDraft[]>([])
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [showGlobalData, setShowGlobalData] = useState(true)
  const [showUploadedData, setShowUploadedData] = useState(true)

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

  const activeUploadedReport = uploadedReports?.modalities[activeModality] ?? null
  const canShowUploadedData = Boolean(activeUploadedReport)
  const effectiveShowUploadedData = showUploadedData && canShowUploadedData
  const effectiveView: ViewId = effectiveShowUploadedData ? "raw" : selectedView

  useEffect(() => {
    if (catalogState.status !== "ready" || !showGlobalData) {
      return
    }

    let cancelled = false

    void fetchMetricSummaries(activeModality, effectiveView).then(
      (nextSummaries) => {
        if (!cancelled) {
          setRemoteSummaries(nextSummaries)
          setRemoteSummariesError(null)
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setRemoteSummaries([])
          setRemoteSummariesError(
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
  }, [activeModality, catalogState, effectiveView, showGlobalData])

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
    params.set("view", effectiveView)
    if (query.trim()) {
      params.set("q", query.trim())
    }

    const nextUrl = `${window.location.pathname}?${params.toString()}`
    window.history.replaceState(null, "", nextUrl)
  }, [activeModality, effectiveView, query, selectedMetrics])

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

  const activeDistributions = useMemo<Record<string, MetricDistribution>>(
    () => activeUploadedReport?.distributions ?? {},
    [activeUploadedReport]
  )
  const uploadedModalityCount = useMemo(
    () => Object.keys(uploadedReports?.modalities ?? {}).length,
    [uploadedReports]
  )

  const summaries =
    showGlobalData || !canShowUploadedData
      ? remoteSummaries
      : activeUploadedReport?.summaries ?? []
  const summariesError = showGlobalData ? remoteSummariesError : null

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

  const handleFilesSelected = async (files: File[]) => {
    const nextDrafts = await buildUploadDrafts(files)
    setPendingUploads((current) => {
      const pendingByModality = new Map(
        current
          .filter((draft) => draft.selectedModality !== null)
          .map((draft) => [draft.selectedModality as ModalityId, draft])
      )

      for (const draft of nextDrafts) {
        if (draft.selectedModality) {
          pendingByModality.set(draft.selectedModality, draft)
        }
      }

      const unresolvedDrafts = [
        ...current.filter((draft) => draft.selectedModality === null),
        ...nextDrafts.filter((draft) => draft.selectedModality === null),
      ]

      return [...pendingByModality.values(), ...unresolvedDrafts]
    })
    setUploadError(null)
  }

  const handleLoadDrafts = async () => {
    if (catalogState.status !== "ready") {
      return
    }

    const nextReports = await finalizeUploadedReports(pendingUploads, catalogState.catalog)
    setUploadedReports((current) => ({
      modalities: {
        ...(current?.modalities ?? {}),
        ...nextReports.modalities,
      },
    }))
    setPendingUploads([])
    setUploadError(null)
    setSelectedModality((current) => {
      const modalities = Object.keys(nextReports.modalities) as ModalityId[]
      return modalities.includes(current) ? current : modalities[0]
    })
    setSelectedView("raw")
    setSelectionNotice("Loaded reviewed MRIQC CSV data in raw-row mode.")
    setShowUploadedData(true)
  }

  const handleFilesSelectedAttempt = async (files: File[]) => {
    try {
      await handleFilesSelected(files)
    } catch (error) {
      setUploadError(
        error instanceof Error ? error.message : "Unexpected error while reading CSV files."
      )
    }
  }

  const handleLoadDraftsAttempt = async () => {
    try {
      await handleLoadDrafts()
    } catch (error) {
      setUploadError(
        error instanceof Error ? error.message : "Unexpected error while loading reviewed files."
      )
    }
  }

  const handleDraftModalityChange = (draftId: string, modality: ModalityId | null) => {
    setPendingUploads((current) =>
      current.map((draft) =>
        draft.id === draftId ? { ...draft, selectedModality: modality } : draft
      )
    )
  }

  const handleDismissDraft = (draftId: string) => {
    setPendingUploads((current) => current.filter((draft) => draft.id !== draftId))
  }

  const handleClearUploadedModality = (modality: ModalityId) => {
    setUploadedReports((current) => {
      if (!current) {
        return current
      }

      const nextModalities = { ...current.modalities }
      delete nextModalities[modality]

      return Object.keys(nextModalities).length > 0 ? { modalities: nextModalities } : null
    })
    setSelectionNotice(`Removed uploaded ${modality} dataset.`)
  }

  const handleClearAllUploaded = () => {
    setUploadedReports(null)
    setPendingUploads([])
    setUploadError(null)
    setShowUploadedData(false)
    setSelectionNotice("Returned to API-backed dataset.")
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
            {uploadError ? (
              <p className="text-sm text-destructive">{uploadError}</p>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-[1.6rem] border border-border/70 bg-card/75 px-5 py-4 shadow-[0_18px_40px_-32px_rgba(36,66,52,0.35)]">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary/75">
                  QC Distributions
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Comparing {selectedMetrics.length} selected metrics for {activeModality}
                  {activeUploadedReport ? ` from ${activeUploadedReport.fileName}.` : "."}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Sheet>
                  <SheetTrigger asChild>
                    <Button type="button" variant="outline" className="rounded-xl">
                      Your data
                      {uploadedModalityCount > 0 ? `${uploadedModalityCount} loaded` : "none"}
                      {pendingUploads.length > 0 ? ` · ${pendingUploads.length} pending` : ""}
                    </Button>
                  </SheetTrigger>
                  <SheetContent side="right" className="w-full sm:max-w-xl">
                    <SheetHeader className="border-b border-border/70 pb-4">
                      <SheetTitle>Your Data</SheetTitle>
                      <SheetDescription>
                        Upload MRIQC CSV files by modality and prepare them for later
                        comparison against the global MRIQC reference.
                      </SheetDescription>
                    </SheetHeader>
                    <div className="flex-1 overflow-y-auto p-4">
                      <ReportUploadPanel
                        disabled={catalogState.status !== "ready"}
                        uploadedReports={uploadedReports}
                        pendingFiles={pendingUploads}
                        onFilesSelected={handleFilesSelectedAttempt}
                        onDraftModalityChange={handleDraftModalityChange}
                        onLoadDrafts={handleLoadDraftsAttempt}
                        onDismissDraft={handleDismissDraft}
                        onClearUploadedModality={handleClearUploadedModality}
                        onClearAllUploaded={handleClearAllUploaded}
                      />
                    </div>
                  </SheetContent>
                </Sheet>
                {uploadedModalityCount > 0 ? (
                  <span className="rounded-full border border-emerald-300/70 bg-emerald-100/80 px-3 py-1 text-xs font-medium text-emerald-900">
                    {uploadedModalityCount} uploaded modalit{uploadedModalityCount === 1 ? "y" : "ies"}
                  </span>
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex items-center gap-2 rounded-full border border-border/70 bg-background/75 p-1">
                    <button
                      type="button"
                      className={
                        showGlobalData
                          ? "rounded-full bg-sky-100 px-3 py-1 text-xs font-medium text-sky-900"
                          : "rounded-full px-3 py-1 text-xs font-medium text-muted-foreground"
                      }
                      onClick={() => setShowGlobalData((current) => !current)}
                    >
                      Global
                    </button>
                    <button
                      type="button"
                      className={
                        effectiveShowUploadedData
                          ? "rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-900"
                          : canShowUploadedData
                            ? "rounded-full px-3 py-1 text-xs font-medium text-muted-foreground"
                            : "rounded-full px-3 py-1 text-xs font-medium text-muted-foreground opacity-55"
                      }
                      onClick={() =>
                        canShowUploadedData
                          ? setShowUploadedData((current) => !current)
                          : undefined
                      }
                      disabled={!canShowUploadedData}
                      aria-label={
                        canShowUploadedData
                          ? "Toggle uploaded data"
                          : `Uploaded data unavailable for ${activeModality} until you upload a CSV`
                      }
                      title={
                        canShowUploadedData
                          ? undefined
                          : `Upload a ${activeModality} CSV to enable Yours`
                      }
                    >
                      Yours
                    </button>
                  </div>
                  {!canShowUploadedData ? (
                    <span className="text-xs text-muted-foreground">
                      Upload a {activeModality} CSV to enable <span className="font-medium text-foreground">Yours</span>.
                    </span>
                  ) : null}
                </div>
                {effectiveShowUploadedData && activeUploadedReport ? (
                  <span className="text-xs text-muted-foreground">
                    Uploaded data available for {activeModality}.
                  </span>
                ) : !canShowUploadedData ? (
                  <span className="text-xs text-muted-foreground">
                    No uploaded {activeModality} data yet. Add a CSV to use <span className="font-medium text-foreground">Yours</span>.
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {showGlobalData ? "Showing global MRIQC reference data." : "Global MRIQC reference hidden."}
                  </span>
                )}
                {pendingUploads.length > 0 ? (
                  <span className="rounded-full border border-amber-300/70 bg-amber-100/80 px-3 py-1 text-xs font-medium text-amber-900">
                    {pendingUploads.length} file{pendingUploads.length === 1 ? "" : "s"} pending review
                  </span>
                ) : null}
                {selectionNotice ? (
                  <span className="rounded-full border border-amber-300/70 bg-amber-100/80 px-3 py-1 text-xs font-medium text-amber-900">
                    {selectionNotice}
                  </span>
                ) : null}
                <ViewSwitcher
                  selectedView={effectiveView}
                  onSelectView={(view) =>
                    setSelectedView(effectiveShowUploadedData ? "raw" : view)
                  }
                />
              </div>
            </div>
            {activeUploadedReport ? (
              <div className="flex flex-wrap items-center gap-3 rounded-[1.4rem] border border-emerald-200/80 bg-emerald-50/70 px-4 py-3 text-sm text-emerald-950">
                <span className="font-medium">
                  Uploaded dataset active: {activeUploadedReport.rowCount} rows from{" "}
                  {activeUploadedReport.fileName}
                </span>
                <span className="text-emerald-800/80">
                  Deduplicated views are unavailable for uploads, so charts use raw rows.
                </span>
              </div>
            ) : null}
            {selectedMetricDescriptors.length ? (
              <div className={cn("grid gap-5", getGridClassName(selectedMetricDescriptors.length))}>
                {selectedMetricDescriptors.map((descriptor) => (
                  <MetricHistogramCard
                    key={`${activeModality}:${descriptor.field}:${effectiveView}`}
                    modality={activeModality}
                    metric={descriptor.field}
                    metricLabel={descriptor.label}
                    metricDescription={describeMetric(descriptor)}
                    selectedView={effectiveView}
                    uploadedDistribution={activeDistributions[descriptor.field] ?? null}
                    showGlobal={showGlobalData}
                    showUploaded={effectiveShowUploadedData}
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
