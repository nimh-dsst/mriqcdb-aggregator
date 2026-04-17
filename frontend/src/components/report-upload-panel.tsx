import { useRef, useState } from "react"
import { FileUpIcon, LoaderCircleIcon, Trash2Icon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { UploadedFileDraft, UploadedReportBundle } from "@/lib/uploaded-report"
import type { ModalityId } from "@/types/ui"

const MODALITIES: ModalityId[] = ["T1w", "T2w", "bold"]

function statusTone(hasUpload: boolean) {
  return hasUpload
    ? "border-emerald-200/80 bg-emerald-50/80 text-emerald-950"
    : "border-border/70 bg-background/55 text-muted-foreground"
}

export function ReportUploadPanel({
  disabled = false,
  uploadedReports,
  pendingFiles,
  onFilesSelected,
  onDraftModalityChange,
  onLoadDrafts,
  onDismissDraft,
  onClearUploadedModality,
  onClearAllUploaded,
}: {
  disabled?: boolean
  uploadedReports: UploadedReportBundle | null
  pendingFiles: UploadedFileDraft[]
  onFilesSelected: (files: File[]) => Promise<void> | void
  onDraftModalityChange: (draftId: string, modality: ModalityId | null) => void
  onLoadDrafts: () => Promise<void> | void
  onDismissDraft: (draftId: string) => void
  onClearUploadedModality: (modality: ModalityId) => void
  onClearAllUploaded: () => void
}) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [isLoading, setIsLoading] = useState(false)

  const handleFiles = async (fileList: FileList | null) => {
    const files = [...(fileList ?? [])].filter((file) =>
      file.name.toLowerCase().endsWith(".csv")
    )
    if (files.length === 0) {
      return
    }

    setIsLoading(true)
    try {
      await onFilesSelected(files)
      if (inputRef.current) {
        inputRef.current.value = ""
      }
    } finally {
      setIsLoading(false)
      setIsDragging(false)
    }
  }

  return (
    <section className="rounded-[1.25rem] border border-border/60 bg-card/65 p-3 shadow-sm">
      <div
        className={
          isDragging
            ? "rounded-[1rem] border border-dashed border-primary/60 bg-primary/5 p-3 transition"
            : "rounded-[1rem] border border-dashed border-border/60 bg-background/35 p-3 transition"
        }
        onDragOver={(event) => {
          event.preventDefault()
          if (!disabled && !isLoading) {
            setIsDragging(true)
          }
        }}
        onDragLeave={(event) => {
          event.preventDefault()
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
            return
          }
          setIsDragging(false)
        }}
        onDrop={(event) => {
          event.preventDefault()
          if (disabled || isLoading) {
            setIsDragging(false)
            return
          }
          void handleFiles(event.dataTransfer.files)
        }}
      >
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-primary/70">
              Your Dataset
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Keep per-modality uploads visible here. New files are reviewed before they
              replace a slot.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={inputRef}
              type="file"
              accept=".csv,text/csv"
              multiple
              className="sr-only"
              onChange={(event) => void handleFiles(event.target.files)}
            />
            <Button
              type="button"
              variant="outline"
              className="h-8 rounded-lg"
              disabled={disabled || isLoading}
              onClick={() => inputRef.current?.click()}
            >
              {isLoading ? (
                <LoaderCircleIcon className="size-4 animate-spin" />
              ) : (
                <FileUpIcon className="size-4" />
              )}
              Add CSV files
            </Button>
            {uploadedReports ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="h-8 rounded-lg"
                  onClick={onClearAllUploaded}
                  disabled={isLoading}
                >
                <XIcon className="size-4" />
                Clear dataset
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="mt-3 grid gap-2 lg:grid-cols-3">
        {MODALITIES.map((modality) => {
          const report = uploadedReports?.modalities[modality] ?? null
          return (
            <div
              key={modality}
              className={`rounded-[0.95rem] border px-3 py-2.5 ${statusTone(Boolean(report))}`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.16em]">
                    {modality}
                  </p>
                  <p className="mt-0.5 text-xs">
                    {report ? "Uploaded" : "Not uploaded"}
                  </p>
                </div>
                {report ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="size-6 rounded-lg"
                    onClick={() => onClearUploadedModality(modality)}
                  >
                    <Trash2Icon className="size-4" />
                  </Button>
                ) : null}
              </div>
              <p className="mt-2 truncate text-sm font-medium text-foreground">
                {report?.fileName ?? "No file loaded"}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {report ? `${report.rowCount} rows ready` : "Add CSV for this modality"}
              </p>
            </div>
          )
        })}
      </div>

      {pendingFiles.length > 0 ? (
        <div className="mt-3 rounded-[1rem] border border-amber-200/80 bg-amber-50/60 p-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-amber-900/80">
                Review Files
              </p>
              <p className="mt-1 text-xs text-amber-950">
                Confirm which modality each file should populate before loading it into
                the dataset.
              </p>
            </div>
            <Button type="button" className="h-8 rounded-lg" onClick={() => void onLoadDrafts()}>
              Load reviewed files
            </Button>
          </div>
          <div className="mt-3 space-y-2">
            {pendingFiles.map((draft) => (
              <div
                key={draft.id}
                className="rounded-[0.85rem] border border-amber-200/70 bg-white/70 p-3"
              >
                <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                  <div className="min-w-0 xl:flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {draft.fileName}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {draft.rowCount} rows · detected{" "}
                      {draft.detectedModality ?? "unknown"}
                    </p>
                  </div>
                  <div className="grid gap-3 xl:min-w-[320px] xl:grid-cols-[110px_minmax(0,190px)]">
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground">Replaces</p>
                      <p className="mt-1 text-sm font-medium text-foreground">
                        {draft.selectedModality ?? "Unassigned"}
                      </p>
                    </div>
                    <label className="grid gap-1 text-xs text-muted-foreground">
                      Assign modality
                      <select
                        value={draft.selectedModality ?? ""}
                        className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-ring"
                        onChange={(event) =>
                          onDraftModalityChange(
                            draft.id,
                            event.target.value ? (event.target.value as ModalityId) : null
                          )
                        }
                      >
                        <option value="">Select modality</option>
                        {MODALITIES.map((modality) => (
                          <option key={modality} value={modality}>
                            {modality}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </div>
                <div className="mt-3 flex justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-8 rounded-lg"
                    onClick={() => onDismissDraft(draft.id)}
                  >
                    <XIcon className="size-4" />
                    Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  )
}
