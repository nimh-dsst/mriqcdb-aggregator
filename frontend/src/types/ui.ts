export type ViewId = "raw" | "exact" | "series"

export type MetricDescriptor = {
  field: string
  label: string
  family: string
  subfamily: string
  unit_hint: string | null
}

export type ModalityDescriptor = {
  name: string
  distribution_fields: string[]
  metric_fields: string[]
  metrics: MetricDescriptor[]
  extra_fields: string[]
}

export type MetricSummary = {
  field: string
  value_count: number
  missing_count: number
  missing_fraction: number
  min: number | null
  max: number | null
  mean: number | null
}

export type MetricCatalog = ModalityDescriptor[]

export type ModalityId = ModalityDescriptor["name"]

export type MetricId = MetricDescriptor["field"]

export const VIEW_OPTIONS: ViewId[] = ["raw", "exact", "series"]
