export const MODALITIES = ["bold", "T1w", "T2w"] as const

export type ModalityId = (typeof MODALITIES)[number]
