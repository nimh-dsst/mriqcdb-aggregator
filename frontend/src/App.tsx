import { useState } from "react"
import { AppSidebar } from "@/components/qc-measures-sidebar"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { MODALITIES, type ModalityId } from "@/types/ui"

function App() {
  const [selectedModality, setSelectedModality] = useState<ModalityId>(
    MODALITIES[0]
  )

  return (
    <SidebarProvider>
      <AppSidebar
        selectedModality={selectedModality}
        onSelectModality={setSelectedModality}
      />
      <SidebarInset>
        <header className="flex h-14 items-center gap-3 border-b px-4">
          <SidebarTrigger />
          <div>
            <p className="text-sm font-semibold">MRIQC Aggregator</p>
            <p className="text-xs text-muted-foreground">
              Selected modality: {selectedModality}
            </p>
          </div>
        </header>
      </SidebarInset>
    </SidebarProvider>
  )
}

export default App
