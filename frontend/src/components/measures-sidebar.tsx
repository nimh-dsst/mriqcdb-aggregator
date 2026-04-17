import * as React from "react"
import { CheckIcon, ChevronRightIcon, InfoIcon } from "lucide-react"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenuBadge,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar"

type MeasureItem = {
  title: string
  subtitle?: string
  description?: string
  isActive?: boolean
  badge?: string
  onSelect?: () => void
}

type MeasureCategory = {
  title: string
  isActive?: boolean
  badge?: string
  items?: MeasureItem[]
  onSelect?: () => void
}

type MeasureGroup = {
  title: string
  items: MeasureCategory[]
}

export function MeasuresSidebar({
  groups,
  collapseVersion = 0,
  onSelectAll,
}: {
  groups: readonly MeasureGroup[]
  collapseVersion?: number
  onSelectAll?: () => void
}) {
  const [openItems, setOpenItems] = React.useState<Record<string, boolean>>({})

  React.useEffect(() => {
    setOpenItems((current) => {
      const next: Record<string, boolean> = {}
      for (const group of groups) {
        for (const item of group.items) {
          next[`${group.title}:${item.title}`] =
            current[`${group.title}:${item.title}`] ?? Boolean(item.isActive)
        }
      }
      return next
    })
  }, [groups])

  React.useEffect(() => {
    setOpenItems((current) => {
      const next = { ...current }
      for (const key of Object.keys(next)) {
        next[key] = false
      }
      return next
    })
  }, [collapseVersion])

  return (
    <TooltipProvider>
    <SidebarContent>
      <div className="px-2 pb-2">
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="ghost"
            size="xs"
            className="h-7 w-full justify-start rounded-xl border border-sidebar-border/70 bg-[linear-gradient(135deg,color-mix(in_oklab,var(--color-sidebar-accent)_68%,white),color-mix(in_oklab,var(--color-sidebar)_82%,white))] px-3 text-[11px] uppercase tracking-[0.18em] text-sidebar-foreground/75 shadow-sm hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            onClick={() => {
              setOpenItems((current) => {
                const next = { ...current }
                for (const key of Object.keys(next)) {
                  next[key] = false
                }
                return next
              })
            }}
          >
            Collapse all
          </Button>
          <Button
            variant="ghost"
            size="xs"
            className="h-7 w-full justify-start rounded-xl border border-sidebar-border/70 bg-[linear-gradient(135deg,color-mix(in_oklab,var(--color-sidebar)_78%,white),color-mix(in_oklab,var(--color-sidebar-accent)_48%,white))] px-3 text-[11px] uppercase tracking-[0.18em] text-sidebar-foreground/75 shadow-sm hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            onClick={onSelectAll}
          >
            Select all
          </Button>
        </div>
      </div>
      {groups.map((group) => (
        <SidebarGroup key={group.title}>
          <SidebarGroupLabel>{group.title}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {group.items.map((item) => (
                <SidebarMenuItem key={item.title}>
                  {item.items?.length ? (
                    (() => {
                      const itemKey = `${group.title}:${item.title}`
                      return (
                        <Collapsible
                          open={openItems[itemKey] ?? Boolean(item.isActive)}
                          onOpenChange={(open) =>
                            setOpenItems((current) => ({ ...current, [itemKey]: open }))
                          }
                          className="group/collapsible"
                        >
                          <CollapsibleTrigger asChild>
                            <SidebarMenuButton
                              isActive={item.isActive}
                              className="rounded-xl border border-transparent data-[active=true]:border-sidebar-border/60 data-[active=true]:bg-sidebar-accent/70"
                            >
                              <span>{item.title}</span>
                              <ChevronRightIcon className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
                            </SidebarMenuButton>
                          </CollapsibleTrigger>
                          <CollapsibleContent>
                            <SidebarMenuSub className="mt-1 border-l-sidebar-border/80">
                              {item.items.map((subItem) => (
                                <SidebarMenuSubItem key={subItem.title}>
                                  <div className="flex items-center gap-1">
                                    <SidebarMenuSubButton
                                      isActive={subItem.isActive}
                                      onClick={subItem.onSelect}
                                      className="flex-1 justify-between gap-3 rounded-lg border-l-2 border-l-transparent pr-2 data-[active=true]:border-l-sidebar-primary data-[active=true]:bg-sidebar-accent/55 data-[active=true]:font-medium"
                                    >
                                      <span className="flex min-w-0 items-center gap-2">
                                        {subItem.isActive ? (
                                          <CheckIcon className="size-3.5 shrink-0 text-sidebar-primary" />
                                        ) : null}
                                        <span className="truncate">{subItem.title}</span>
                                      </span>
                                      {subItem.badge ? (
                                        <span className="rounded-md bg-sidebar/80 px-1.5 py-0.5 text-[11px] tabular-nums text-sidebar-foreground/70">
                                          {subItem.badge}
                                        </span>
                                      ) : null}
                                    </SidebarMenuSubButton>
                                    {subItem.description ? (
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <button
                                            type="button"
                                            className="flex size-6 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/55 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                                            aria-label={`About ${subItem.title}`}
                                          >
                                            <InfoIcon className="size-3.5" />
                                          </button>
                                        </TooltipTrigger>
                                        <TooltipContent side="right" sideOffset={8}>
                                          {subItem.description}
                                        </TooltipContent>
                                      </Tooltip>
                                    ) : null}
                                  </div>
                                </SidebarMenuSubItem>
                              ))}
                            </SidebarMenuSub>
                          </CollapsibleContent>
                        </Collapsible>
                      )
                    })()
                  ) : (
                    <SidebarMenuButton
                      isActive={item.isActive}
                      onClick={item.onSelect}
                    >
                      {item.title}
                    </SidebarMenuButton>
                  )}
                  {item.badge ? (
                    <SidebarMenuBadge className="rounded-md bg-sidebar/85 px-1.5 text-[11px] text-sidebar-foreground/75">
                      {item.badge}
                    </SidebarMenuBadge>
                  ) : null}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </SidebarContent>
    </TooltipProvider>
  )
}

export type { MeasureCategory, MeasureGroup, MeasureItem }
