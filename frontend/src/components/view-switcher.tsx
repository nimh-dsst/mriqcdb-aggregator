import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { VIEW_OPTIONS, type ViewId } from "@/types/ui"

const LABELS: Record<ViewId, string> = {
  raw: "Raw",
  exact: "Exact",
  series: "Deduplicated",
}

export function ViewSwitcher({
  selectedView,
  onSelectView,
}: {
  selectedView: ViewId
  onSelectView: (view: ViewId) => void
}) {
  return (
    <div className="inline-flex rounded-2xl border border-border/70 bg-background/72 p-1 shadow-sm">
      {VIEW_OPTIONS.map((view) => (
        <Button
          key={view}
          variant="ghost"
          size="sm"
          className={cn(
            "rounded-xl px-3 text-muted-foreground",
            selectedView === view &&
              "bg-primary text-primary-foreground shadow-sm hover:bg-primary/92 hover:text-primary-foreground"
          )}
          onClick={() => onSelectView(view)}
        >
          {LABELS[view]}
        </Button>
      ))}
    </div>
  )
}
