import { type ReactNode, useEffect, useState } from "react"
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { fetchMetricDistribution, type MetricDistribution } from "@/lib/api"
import { ViewSwitcher } from "@/components/view-switcher"
import type { MetricId, ModalityId, ViewId } from "@/types/ui"

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

export function MetricHistogramCard({
  modality,
  metric,
  metricLabel,
  selectedView,
  onSelectView,
}: {
  modality: ModalityId
  metric: MetricId
  metricLabel: string
  selectedView: ViewId
  onSelectView: (view: ViewId) => void
}) {
  const [state, setState] = useState<LoadState>({ status: "loading" })

  useEffect(() => {
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
  }, [metric, modality, selectedView])

  if (state.status === "loading") {
    return (
      <section className="rounded-3xl border border-border/70 bg-card/90 p-6 shadow-sm">
        <p className="text-sm text-muted-foreground">Loading metric distribution…</p>
      </section>
    )
  }

  if (state.status === "error") {
    return (
      <section className="rounded-3xl border border-destructive/30 bg-destructive/5 p-6 shadow-sm">
        <p className="text-sm font-medium text-destructive">
          Failed to load histogram data.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">{state.message}</p>
      </section>
    )
  }

  const { distribution } = state
  const histogramTotal = distribution.value_count || 1
  const chartData = distribution.histogram.map((bucket, index) => ({
    ...bucket,
    label: formatBucketLabel(bucket.start, bucket.end),
    probability: bucket.count / histogramTotal,
    fill:
      index % 2 === 0 ? "var(--color-chart-1)" : "var(--color-chart-2)",
  }))
  const showCountLabels = chartData.length <= 12

  if (distribution.value_count === 0) {
    return (
      <section className="rounded-3xl border border-dashed border-border/70 bg-card/90 p-6 shadow-sm">
        <p className="text-sm font-medium text-foreground">No values available for this metric.</p>
        <p className="mt-2 text-sm text-muted-foreground">
          Try a different modality or view, or confirm the database has loaded rows for
          `{metric}`.
        </p>
      </section>
    )
  }

  return (
    <section className="grid gap-6 rounded-[1.8rem] border border-border/80 bg-[linear-gradient(180deg,color-mix(in_oklab,var(--color-card)_90%,white),color-mix(in_oklab,var(--color-card)_84%,var(--color-accent)_16%))] p-6 shadow-[0_18px_40px_-28px_rgba(36,66,52,0.45)] xl:grid-cols-[minmax(0,1.8fr)_minmax(280px,0.9fr)]">
      <div className="min-w-0">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-primary/75">
              Probability Distribution
            </p>
            <h2 className="mt-2 font-heading text-[2rem] font-semibold tracking-tight text-foreground">
              {metricLabel}
            </h2>
            <div className="mt-3 flex flex-wrap gap-2">
              <InfoPill>{modality}</InfoPill>
              <InfoPill>{selectedView}</InfoPill>
              <InfoPill>{distribution.value_count} values</InfoPill>
            </div>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
              Normalized binned distribution for {modality} observations in the
              `{selectedView}` view.
            </p>
          </div>
          <div className="flex flex-col items-end gap-3">
            <ViewSwitcher
              selectedView={selectedView}
              onSelectView={onSelectView}
            />
            <div className="rounded-2xl border border-border/70 bg-background/75 px-4 py-3 text-right shadow-sm">
              <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">
                Samples
              </p>
              <p className="mt-1 text-2xl font-semibold">{distribution.value_count}</p>
            </div>
          </div>
        </div>
        <div className="mt-6 h-[320px] w-full rounded-[1.4rem] border border-border/60 bg-background/55 p-3">
          <ResponsiveContainer width="100%" height="100%">
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
                formatter={(value) => [
                  `${(((value as number | undefined) ?? 0) * 100).toFixed(1)}%`,
                  "Probability",
                ]}
              />
              <Bar dataKey="probability" radius={[10, 10, 0, 0]}>
                {chartData.map((entry) => (
                  <Cell key={entry.label} fill={entry.fill} />
                ))}
                {showCountLabels ? (
                  <LabelList dataKey="count" position="top" className="fill-muted-foreground text-[11px]" />
                ) : null}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
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
    <div className="rounded-2xl border border-border/70 bg-background/72 p-4 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-primary/70">
        {label}
      </p>
      <p className="mt-2 text-xl font-semibold text-foreground">{value}</p>
    </div>
  )
}

function InfoPill({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-border/70 bg-background/75 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground shadow-sm">
      {children}
    </span>
  )
}
