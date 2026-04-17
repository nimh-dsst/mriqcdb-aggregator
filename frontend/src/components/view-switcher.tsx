import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { ViewId } from "@/types/ui"

const LABELS: Record<ViewId, string> = {
  raw: "Raw",
  exact: "Exact",
  series: "Series",
}

export function ViewSwitcher({
  selectedView,
  onSelectView,
}: {
  selectedView: ViewId
  onSelectView: (view: ViewId) => void
}) {
  return (
    <div className="inline-flex rounded-2xl border border-border/70 bg-background/80 p-1">
      {(Object.keys(LABELS) as ViewId[]).map((view) => (
        <Button
          key={view}
          variant="ghost"
          size="sm"
          className={cn(
            "rounded-xl px-3",
            selectedView === view && "bg-foreground text-background hover:bg-foreground/90 hover:text-background"
          )}
          onClick={() => onSelectView(view)}
        >
          {LABELS[view]}
        </Button>
      ))}
    </div>
  )
}
