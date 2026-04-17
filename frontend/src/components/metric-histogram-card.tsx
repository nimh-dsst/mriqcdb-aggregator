import { useEffect, useState } from "react"
import { XIcon } from "lucide-react"
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { fetchMetricDistribution } from "@/lib/api"
import { Button } from "@/components/ui/button"
import type { MetricDistribution, MetricId, ModalityId, ViewId } from "@/types/ui"

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; distribution: MetricDistribution }

function formatMetricValue(value: number | null, digits = 3) {
  if (value === null) {
    return "N/A"
  }

  return value.toFixed(digits)
}

function formatBucketLabel(start: number, end: number) {
  return `${start.toFixed(2)}-${end.toFixed(2)}`
}

function buildBucketEdges(min: number, max: number, bucketCount: number) {
  const safeCount = Math.max(1, bucketCount)
  if (min === max) {
    return Array.from({ length: safeCount + 1 }, (_, index) => min + index)
  }

  const width = (max - min) / safeCount
  return Array.from({ length: safeCount + 1 }, (_, index) =>
    index === safeCount ? max : min + width * index
  )
}

function rebinHistogram(distribution: MetricDistribution, edges: number[]) {
  const totalCount = distribution.value_count || 1
  const rebinned = new Array(Math.max(0, edges.length - 1)).fill(0)

  for (const bucket of distribution.histogram) {
    const bucketWidth = bucket.end - bucket.start
    if (bucket.count === 0) {
      continue
    }

    if (bucketWidth === 0) {
      const index = rebinned.findIndex(
        (_, edgeIndex) =>
          bucket.start >= edges[edgeIndex] && bucket.start <= edges[edgeIndex + 1]
      )
      if (index >= 0) {
        rebinned[index] += bucket.count
      }
      continue
    }

    for (let index = 0; index < rebinned.length; index += 1) {
      const overlapStart = Math.max(bucket.start, edges[index])
      const overlapEnd = Math.min(bucket.end, edges[index + 1])
      const overlapWidth = overlapEnd - overlapStart
      if (overlapWidth > 0) {
        rebinned[index] += bucket.count * (overlapWidth / bucketWidth)
      }
    }
  }

  return rebinned.map((count) => count / totalCount)
}

export function MetricHistogramCard({
  modality,
  metric,
  metricLabel,
  metricDescription,
  selectedView,
  onRemove,
  compact = false,
  uploadedDistribution,
  showGlobal = true,
  showUploaded = false,
}: {
  modality: ModalityId
  metric: MetricId
  metricLabel: string
  metricDescription?: string
  selectedView: ViewId
  onRemove?: () => void
  compact?: boolean
  uploadedDistribution?: MetricDistribution | null
  showGlobal?: boolean
  showUploaded?: boolean
}) {
  const [state, setState] = useState<LoadState>({ status: "loading" })

  useEffect(() => {
    if (!showGlobal) {
      return
    }

    let cancelled = false

    void fetchMetricDistribution(modality, metric, selectedView).then(
      (distribution) => {
        if (!cancelled) {
          setState({ status: "ready", distribution })
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            message:
              error instanceof Error
                ? error.message
                : "Unexpected error while loading the metric distribution.",
          })
        }
      }
    )

    return () => {
      cancelled = true
    }
  }, [metric, modality, selectedView, showGlobal])

  if (showGlobal && state.status === "loading") {
    return (
      <section className="rounded-3xl border border-border/70 bg-card/90 p-6 shadow-sm">
        <p className="text-sm text-muted-foreground">Loading metric distribution…</p>
      </section>
    )
  }

  if (showGlobal && state.status === "error") {
    return (
      <section className="rounded-3xl border border-destructive/30 bg-destructive/5 p-6 shadow-sm">
        <p className="text-sm font-medium text-destructive">
          Failed to load histogram data.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">{state.message}</p>
      </section>
    )
  }

  const globalDistribution = showGlobal && state.status === "ready" ? state.distribution : null
  const visibleUploadedDistribution = showUploaded ? uploadedDistribution ?? null : null
  const visibleDistributions = [
    globalDistribution,
    visibleUploadedDistribution,
  ].filter((distribution): distribution is MetricDistribution => distribution !== null)

  if (visibleDistributions.length === 0) {
    return (
      <section className="rounded-3xl border border-dashed border-border/70 bg-card/90 p-6 shadow-sm">
        <p className="text-sm font-medium text-foreground">No data source is currently visible.</p>
        <p className="mt-2 text-sm text-muted-foreground">
          Turn on Global or Your data to render this metric.
        </p>
      </section>
    )
  }

  const distribution =
    visibleUploadedDistribution && !globalDistribution
      ? visibleUploadedDistribution
      : globalDistribution ?? visibleUploadedDistribution

  if (!distribution) {
    return null
  }

  if (visibleDistributions.every((entry) => entry.value_count === 0)) {
    return (
      <section className="rounded-3xl border border-dashed border-border/70 bg-card/90 p-6 shadow-sm">
        <p className="text-sm font-medium text-foreground">No values available for this metric.</p>
        <p className="mt-2 text-sm text-muted-foreground">
          Try a different modality or source selection, or confirm the chosen dataset has
          rows for `{metric}`.
        </p>
      </section>
    )
  }

  const minValue = Math.min(...visibleDistributions.map((entry) => entry.min ?? Infinity))
  const maxValue = Math.max(...visibleDistributions.map((entry) => entry.max ?? -Infinity))
  const bucketCount = Math.max(
    ...visibleDistributions.map((entry) => entry.histogram.length || 1)
  )
  const edges = buildBucketEdges(minValue, maxValue, bucketCount)
  const globalProbabilities = globalDistribution
    ? rebinHistogram(globalDistribution, edges)
    : new Array(bucketCount).fill(0)
  const uploadedProbabilities = visibleUploadedDistribution
    ? rebinHistogram(visibleUploadedDistribution, edges)
    : new Array(bucketCount).fill(0)
  const chartData = edges.slice(0, -1).map((start, index) => ({
    label: formatBucketLabel(start, edges[index + 1]),
    globalProbability: globalProbabilities[index] ?? 0,
    uploadedProbability: uploadedProbabilities[index] ?? 0,
    globalCount: globalDistribution?.histogram[index]?.count ?? 0,
    uploadedCount: visibleUploadedDistribution?.histogram[index]?.count ?? 0,
  }))
  const showCountLabels = chartData.length <= 12 && visibleDistributions.length === 1

  return (
    <section
      className={
        compact
          ? "relative grid gap-4 rounded-[1.6rem] border border-border/80 bg-[linear-gradient(180deg,color-mix(in_oklab,var(--color-card)_90%,white),color-mix(in_oklab,var(--color-card)_84%,var(--color-accent)_16%))] p-4 shadow-[0_18px_40px_-28px_rgba(36,66,52,0.45)]"
          : "relative grid gap-5 rounded-[1.8rem] border border-border/80 bg-[linear-gradient(180deg,color-mix(in_oklab,var(--color-card)_90%,white),color-mix(in_oklab,var(--color-card)_84%,var(--color-accent)_16%))] p-5 shadow-[0_18px_40px_-28px_rgba(36,66,52,0.45)] xl:grid-cols-[minmax(0,1.8fr)_220px]"
      }
    >
      {onRemove ? (
        <Button
          variant="ghost"
          size="icon-sm"
          className="absolute top-3 right-3 z-10 rounded-xl border border-border/70 bg-background/78"
          onClick={onRemove}
          aria-label={`Remove ${metricLabel}`}
        >
          <XIcon className="size-4" />
        </Button>
      ) : null}
      <div className="min-w-0">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="min-w-0">
              <h2 className={compact ? "font-heading text-[1.2rem] font-semibold leading-tight tracking-tight text-foreground pr-7" : "font-heading text-[1.7rem] font-semibold tracking-tight text-foreground"}>
                {metricLabel}
              </h2>
              <p className="mt-1 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                {metric}
              </p>
            </div>
            <p className={compact ? "mt-2 max-w-2xl text-xs leading-5 text-muted-foreground" : "mt-3 max-w-2xl text-sm leading-6 text-muted-foreground"}>
              {metricDescription ??
                `Normalized binned distribution for ${modality} observations in the ${selectedView} view.`}
            </p>
          </div>
          <div className={compact ? "flex items-start pr-8" : "flex flex-col items-end gap-3 pr-10"}>
            {visibleDistributions.length === 2 ? (
              <div className="flex flex-wrap justify-end gap-2 pr-1 text-[11px]">
                {globalDistribution ? (
                  <span className="rounded-full border border-sky-300/70 bg-sky-100/80 px-2.5 py-1 font-medium text-sky-900">
                    Global · {globalDistribution.value_count}
                  </span>
                ) : null}
                {visibleUploadedDistribution ? (
                  <span className="rounded-full border border-emerald-300/70 bg-emerald-100/80 px-2.5 py-1 font-medium text-emerald-900">
                    Yours · {visibleUploadedDistribution.value_count}
                  </span>
                ) : null}
              </div>
            ) : (
              <div className="pr-1 text-[11px]">
                <span className="rounded-full border border-border/70 bg-background/75 px-2.5 py-1 font-medium text-foreground">
                  Samples · {distribution.value_count}
                </span>
              </div>
            )}
          </div>
        </div>
        <div className={compact ? "mt-3 h-[220px] w-full rounded-[1.1rem] border border-border/60 bg-background/55 p-2.5" : "mt-6 h-[320px] w-full rounded-[1.4rem] border border-border/60 bg-background/55 p-3"}>
          <ResponsiveContainer
            width="100%"
            height="100%"
            minWidth={0}
            minHeight={compact ? 200 : 280}
          >
            <BarChart data={chartData} margin={{ top: 12, right: 12, left: -16, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="color-mix(in_oklab,var(--color-border)_85%,white)" strokeDasharray="3 3" />
              <XAxis
                dataKey="label"
                tick={{ fill: "var(--color-muted-foreground)", fontSize: 12 }}
                tickLine={false}
                axisLine={false}
                minTickGap={24}
              />
              <YAxis
                tickFormatter={(value) => `${Math.round(value * 100)}%`}
                tick={{ fill: "var(--color-muted-foreground)", fontSize: 12 }}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip
                cursor={{ fill: "rgba(63, 108, 84, 0.08)" }}
                contentStyle={{
                  borderRadius: 16,
                  border: "1px solid var(--color-border)",
                  background: "rgba(252,249,244,0.98)",
                  boxShadow: "0 16px 32px -24px rgba(39, 72, 58, 0.55)",
                }}
                formatter={(value, name) => {
                  const label = name === "uploadedProbability" ? "Yours" : "Global"
                  return [
                    `${(((value as number | undefined) ?? 0) * 100).toFixed(1)}%`,
                    label,
                  ]
                }}
              />
              {globalDistribution ? (
                <Bar dataKey="globalProbability" radius={[10, 10, 0, 0]} fill="var(--color-chart-2)">
                  {chartData.map((entry, index) => (
                    <Cell
                      key={`global-${entry.label}-${index}`}
                      fill="var(--color-chart-2)"
                      fillOpacity={visibleUploadedDistribution ? 0.62 : 1}
                    />
                  ))}
                  {showCountLabels ? (
                    <LabelList dataKey="globalCount" position="top" className="fill-muted-foreground text-[11px]" />
                  ) : null}
                </Bar>
              ) : null}
              {visibleUploadedDistribution ? (
                <Bar dataKey="uploadedProbability" radius={[10, 10, 0, 0]} fill="var(--color-chart-1)">
                  {chartData.map((entry, index) => (
                    <Cell
                      key={`uploaded-${entry.label}-${index}`}
                      fill="var(--color-chart-1)"
                      fillOpacity={globalDistribution ? 0.78 : 1}
                    />
                  ))}
                  {showCountLabels ? (
                    <LabelList dataKey="uploadedCount" position="top" className="fill-muted-foreground text-[11px]" />
                  ) : null}
                </Bar>
              ) : null}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className={compact ? "grid auto-rows-min grid-cols-3 gap-2 sm:grid-cols-6" : "grid auto-rows-min gap-2 sm:grid-cols-3 xl:grid-cols-1"}>
        <StatCard label="Mean" value={formatMetricValue(distribution.mean)} />
        <StatCard label="Std. dev." value={formatMetricValue(distribution.stddev)} />
        <StatCard label="Min" value={formatMetricValue(distribution.min)} />
        <StatCard label="Median" value={formatMetricValue(distribution.quantiles.p50)} />
        <StatCard label="P05" value={formatMetricValue(distribution.quantiles.p05)} />
        <StatCard label="P95" value={formatMetricValue(distribution.quantiles.p95)} />
      </div>
    </section>
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-border/70 bg-background/72 px-2.5 py-2 shadow-sm">
      <p className="truncate text-[9px] font-semibold uppercase tracking-[0.14em] text-primary/70">
        {label}
      </p>
      <p className="mt-1 truncate text-sm font-semibold text-foreground">{value}</p>
    </div>
  )
}
