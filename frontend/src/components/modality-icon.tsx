import type { ComponentType } from "react"
import type { LucideProps } from "lucide-react"
import { ActivityIcon, BrainIcon, Layers3Icon } from "lucide-react"

import type { ModalityId } from "@/types/ui"
import { cn } from "@/lib/utils"

const ICON_BY_MODALITY: Record<ModalityId, ComponentType<LucideProps>> = {
  T1w: BrainIcon,
  T2w: Layers3Icon,
  bold: ActivityIcon,
}

export function ModalityIcon({
  modality,
  className,
}: {
  modality: ModalityId
  className?: string
}) {
  const Icon = ICON_BY_MODALITY[modality]

  return <Icon className={cn("size-4", className)} />
}
