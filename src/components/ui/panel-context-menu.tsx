/**
 * PanelContextMenu — compact context menu for data panels (Stack / Memory / Storage).
 * All items use smaller text + tighter padding so the menu doesn't dominate the UI.
 *
 * Re-exports the same API as the base context-menu, just with panel-sized defaults.
 * Import everything from here instead of "@/components/ui/context-menu" in panels.
 */
import * as React from "react";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";

// Content: smaller min-width, compact padding
const PanelContextMenuContent = React.forwardRef<
  React.ElementRef<typeof ContextMenuContent>,
  React.ComponentPropsWithoutRef<typeof ContextMenuContent>
>(({ className, ...props }, ref) => (
  <ContextMenuContent
    ref={ref}
    className={cn("min-w-[9rem] p-0.5", className)}
    {...props}
  />
));
PanelContextMenuContent.displayName = "PanelContextMenuContent";

// Item: text-[11px], tight padding
const PanelContextMenuItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuItem>,
  React.ComponentPropsWithoutRef<typeof ContextMenuItem>
>(({ className, ...props }, ref) => (
  <ContextMenuItem
    ref={ref}
    className={cn("text-[11px] leading-tight px-2 py-px rounded-[3px]", className)}
    {...props}
  />
));
PanelContextMenuItem.displayName = "PanelContextMenuItem";

// Separator: thinner margin
const PanelContextMenuSeparator = React.forwardRef<
  React.ElementRef<typeof ContextMenuSeparator>,
  React.ComponentPropsWithoutRef<typeof ContextMenuSeparator>
>(({ className, ...props }, ref) => (
  <ContextMenuSeparator
    ref={ref}
    className={cn("my-0.5", className)}
    {...props}
  />
));
PanelContextMenuSeparator.displayName = "PanelContextMenuSeparator";

export {
  ContextMenu as PanelContextMenu,
  ContextMenuTrigger as PanelContextMenuTrigger,
  PanelContextMenuContent,
  PanelContextMenuItem,
  PanelContextMenuSeparator,
};
