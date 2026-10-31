import * as React from "react"
import { cn } from "@/lib/utils"
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui"

import { toggleVariants } from "@/components/ui/toggle"

// variant="segmented": a switch of a few options that looks exactly like
// TabsList / TabsTrigger (tabs.jsx) — grey track, the chosen one a raised pill
// (white in the dark theme too, so the choice is seen at a glance).
// The chosen one is styled by aria-checked: a Tooltip around an item overrides
// its data-state. Height: size sm = 32px, default = 36px (like Tabs), or h-* on the group.
const SEGMENT_TRACK = "inline-flex w-fit items-center rounded-lg bg-secondary p-[3px] text-muted-foreground"
const SEGMENT_HEIGHT = { sm: "h-8", default: "h-9", lg: "h-10" }
const SEGMENT_ITEM = "inline-flex h-full min-w-0 flex-1 shrink-0 items-center justify-center gap-1.5 rounded-md border border-transparent px-2.5 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all outline-none hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-checked:bg-background aria-checked:text-foreground aria-checked:shadow-sm dark:text-muted-foreground dark:hover:text-foreground dark:aria-checked:border-transparent dark:aria-checked:bg-foreground dark:aria-checked:text-background [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"

const ToggleGroupContext = React.createContext({
  size: "default",
  variant: "default",
  spacing: 0,
})

function ToggleGroup({
  className,
  variant,
  size,
  spacing = 0,
  children,
  ...props
}) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      data-variant={variant}
      data-size={size}
      data-spacing={spacing}
      style={{
        "--gap": spacing
      }}
      className={cn(
        variant === "segmented"
          ? cn(SEGMENT_TRACK, SEGMENT_HEIGHT[size || "default"])
          : "group/toggle-group flex w-fit items-center gap-[--spacing(var(--gap))] rounded-md data-[spacing=default]:data-[variant=outline]:shadow-xs",
        className
      )}
      {...props}>
      <ToggleGroupContext.Provider value={{ variant, size, spacing }}>
        {children}
      </ToggleGroupContext.Provider>
    </ToggleGroupPrimitive.Root>
  );
}

function ToggleGroupItem({
  className,
  children,
  variant,
  size,
  ...props
}) {
  const context = React.useContext(ToggleGroupContext)
  if ((context.variant || variant) === "segmented") {
    return (
      <ToggleGroupPrimitive.Item data-slot="toggle-group-item" data-variant="segmented" className={cn(SEGMENT_ITEM, className)} {...props}>
        {children}
      </ToggleGroupPrimitive.Item>
    );
  }

  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      data-variant={context.variant || variant}
      data-size={context.size || size}
      data-spacing={context.spacing}
      className={cn(toggleVariants({
        variant: context.variant || variant,
        size: context.size || size,
      }), "w-auto min-w-0 shrink-0 px-3 focus:z-10 focus-visible:z-10", "data-[spacing=0]:rounded-none data-[spacing=0]:shadow-none data-[spacing=0]:first:rounded-l-md data-[spacing=0]:last:rounded-r-md data-[spacing=0]:data-[variant=outline]:border-l-0 data-[spacing=0]:data-[variant=outline]:first:border-l", className)}
      {...props}>
      {children}
    </ToggleGroupPrimitive.Item>
  );
}

export { ToggleGroup, ToggleGroupItem }
