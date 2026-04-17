"use client"

import type { ModalityId } from "@/types/ui"

import {
  ModalityIcon,
} from "@/components/modality-icon"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { ChevronsUpDownIcon, CheckIcon } from "lucide-react"
import { cn } from "@/lib/utils"

function getModalityIconContainerClass(modality: ModalityId) {
  switch (modality) {
    case "T1w":
      return "bg-emerald-100 text-emerald-800"
    case "T2w":
      return "bg-amber-100 text-amber-800"
    case "bold":
      return "bg-sky-100 text-sky-800"
  }
}

export function ModalitySwitcher({
  modalities,
  selectedModality,
  onSelectModality,
}: {
  modalities: readonly ModalityId[]
  selectedModality: ModalityId
  onSelectModality: (modality: ModalityId) => void
}) {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <div
                className={cn(
                  "flex aspect-square size-8 items-center justify-center rounded-lg ring-1 ring-black/5",
                  getModalityIconContainerClass(selectedModality)
                )}
              >
                <ModalityIcon modality={selectedModality} />
              </div>
              <div className="flex flex-col gap-0.5 leading-none">
                <span className="font-medium">Modality</span>
                <span>{selectedModality}</span>
              </div>
              <ChevronsUpDownIcon className="ml-auto" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width)"
            align="start"
          >
            {modalities.map((modality) => (
              <DropdownMenuItem
                key={modality}
                className="gap-2"
                onSelect={() => onSelectModality(modality)}
              >
                <div
                  className={cn(
                    "flex size-6 items-center justify-center rounded-md ring-1 ring-black/5",
                    getModalityIconContainerClass(modality)
                  )}
                >
                  <ModalityIcon modality={modality} className="size-3.5" />
                </div>
                <span>{modality}</span>
                {modality === selectedModality && (
                  <CheckIcon className="ml-auto" />
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
