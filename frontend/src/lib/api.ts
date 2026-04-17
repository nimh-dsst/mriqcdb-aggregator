import type {
  MetricCatalog,
  MetricSummary,
  ViewId,
} from "@/types/ui"

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "") ?? "/api/v1"

export type MetricHistogramBucket = {
  start: number
  end: number
  count: number
}

export type MetricDistribution = {
  field: string
  row_count: number
  value_count: number
  missing_count: number
  missing_fraction: number
  min: number | null
  max: number | null
  mean: number | null
  stddev: number | null
  quantiles: {
    p05: number | null
    p25: number | null
    p50: number | null
    p75: number | null
    p95: number | null
  }
  histogram: MetricHistogramBucket[]
}

type MetricDistributionResponse = {
  modality: string
  field: string
  view: ViewId
  filters: Record<string, unknown>
  distribution: MetricDistribution
}

type ModalitiesResponse = {
  modalities: MetricCatalog
}

type MetricSummariesResponse = {
  modality: string
  view: ViewId
  filters: Record<string, unknown>
  metrics: MetricSummary[]
}

export async function fetchModalities(): Promise<MetricCatalog> {
  const response = await fetch(`${API_BASE_URL}/modalities`)

  if (!response.ok) {
    throw new Error(`API request failed with status ${response.status}`)
  }

  const payload = (await response.json()) as ModalitiesResponse
  return payload.modalities
}

export async function fetchMetricSummaries(
  modality: string,
  view: ViewId
): Promise<MetricSummary[]> {
  const response = await fetch(
    `${API_BASE_URL}/modalities/${modality}/metrics?view=${view}`
  )

  if (!response.ok) {
    throw new Error(`API request failed with status ${response.status}`)
  }

  const payload = (await response.json()) as MetricSummariesResponse
  return payload.metrics
}

export async function fetchMetricDistribution(
  modality: string,
  fieldName: string,
  view: ViewId,
  bins = 24
): Promise<MetricDistribution> {
  const response = await fetch(
    `${API_BASE_URL}/modalities/${modality}/metrics/${fieldName}?view=${view}&bins=${bins}`
  )

  if (!response.ok) {
    throw new Error(`API request failed with status ${response.status}`)
  }

  const payload = (await response.json()) as MetricDistributionResponse
  return payload.distribution
}
