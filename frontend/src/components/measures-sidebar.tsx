import * as React from "react"
import { ChevronRightIcon } from "lucide-react"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Button } from "@/components/ui/button"
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
}: {
  groups: readonly MeasureGroup[]
  collapseVersion?: number
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
    <SidebarContent>
      <div className="px-2 pb-2">
        <Button
          variant="ghost"
          size="xs"
          className="h-7 w-full justify-start rounded-xl border border-sidebar-border/60 bg-sidebar-accent/40 px-3 text-[11px] uppercase tracking-[0.18em] text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
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
                        <SidebarMenuButton isActive={item.isActive}>
                          <span>{item.title}</span>
                          <ChevronRightIcon className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
                        </SidebarMenuButton>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <SidebarMenuSub>
                          {item.items.map((subItem) => (
                            <SidebarMenuSubItem key={subItem.title}>
                              <SidebarMenuSubButton
                                isActive={subItem.isActive}
                                onClick={subItem.onSelect}
                                className="justify-between gap-3"
                              >
                                <span className="truncate">{subItem.title}</span>
                                {subItem.badge ? (
                                  <span className="text-[11px] tabular-nums text-sidebar-foreground/70">
                                    {subItem.badge}
                                  </span>
                                ) : null}
                              </SidebarMenuSubButton>
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
                  {item.badge ? <SidebarMenuBadge>{item.badge}</SidebarMenuBadge> : null}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </SidebarContent>
  )
}

export type { MeasureCategory, MeasureGroup, MeasureItem }
