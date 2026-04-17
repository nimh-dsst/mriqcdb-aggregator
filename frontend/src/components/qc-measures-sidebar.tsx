import * as React from "react"
import { MeasuresSidebar, type MeasureGroup } from "@/components/measures-sidebar"
import { SearchForm } from "@/components/search-form"
import { ModalitySwitcher } from "@/components/modality-switcher"
import { MODALITIES, type ModalityId } from "@/types/ui"
import {
  Sidebar,
  SidebarHeader,
  SidebarRail,
} from "@/components/ui/sidebar"

const MEASURE_GROUPS_BY_MODALITY: Record<ModalityId, MeasureGroup[]> = {
  bold: [
    {
      title: "QC Measures",
      items: [
        {
          title: "Motion",
          url: "#",
          isActive: true,
          items: [
            {
              title: "fd_mean",
              url: "#",
              isActive: true,
            },
          ],
        },
      ],
    },
  ],
  T1w: [],
  T2w: [],
}

export function AppSidebar({
  selectedModality,
  onSelectModality,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  selectedModality: ModalityId
  onSelectModality: (modality: ModalityId) => void
}) {
  return (
    <Sidebar {...props}>
      <SidebarHeader>
        <ModalitySwitcher
          modalities={MODALITIES}
          selectedModality={selectedModality}
          onSelectModality={onSelectModality}
        />
        <SearchForm />
      </SidebarHeader>
      <MeasuresSidebar groups={MEASURE_GROUPS_BY_MODALITY[selectedModality]} />
      <SidebarRail />
    </Sidebar>
  )
}
