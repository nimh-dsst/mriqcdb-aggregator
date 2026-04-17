import { ChevronRightIcon } from "lucide-react"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
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
}: {
  groups: readonly MeasureGroup[]
}) {
  return (
    <SidebarContent>
      {groups.map((group) => (
        <SidebarGroup key={group.title}>
          <SidebarGroupLabel>{group.title}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {group.items.map((item) => (
                <SidebarMenuItem key={item.title}>
                  {item.items?.length ? (
                    <Collapsible
                      defaultOpen={item.isActive}
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
