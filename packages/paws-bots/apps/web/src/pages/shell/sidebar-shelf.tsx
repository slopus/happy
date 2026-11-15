import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  SectionHeading,
} from "@rakazo/ui-web";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";

/** A folded list pinned to the bottom of the sidebar, such as Snoozed; it grows upwards when open. The sidebar caps all shelves together. */
export function SidebarShelf({
  title,
  count,
  children,
}: {
  title: ReactNode;
  count: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col">
      <SectionHeading variant="label">
        <CollapsibleTrigger className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 hover:bg-sidebar-accent">
          <span>{title}</span>
          <span className="flex items-center gap-1 tabular-nums">
            {count}
            <ChevronRight
              aria-hidden="true"
              className={`size-3.5 transition-transform ${open ? "rotate-90" : ""}`}
            />
          </span>
        </CollapsibleTrigger>
      </SectionHeading>
      <CollapsibleContent className="flex flex-col">{children}</CollapsibleContent>
    </Collapsible>
  );
}
