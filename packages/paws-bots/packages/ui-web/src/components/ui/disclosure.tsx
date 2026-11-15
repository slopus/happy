import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@rakazo/ui-web/components/ui/collapsible";
import { cn } from "@rakazo/ui-web/lib/utils";
import { ChevronDown } from "lucide-react";
import type * as React from "react";

/** A shared animated fold-out that preserves its children's state while closed. */
function Disclosure({
  summary,
  summaryClassName,
  contentClassName,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof Collapsible>, "children" | "className"> & {
  summary: React.ReactNode;
  summaryClassName?: string;
  contentClassName?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Collapsible data-slot="disclosure" className={cn("group/disclosure", className)} {...props}>
      <CollapsibleTrigger
        className={cn(
          "flex w-fit cursor-pointer items-center gap-1.5 rounded-md text-start outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50",
          summaryClassName,
        )}
      >
        {summary}
        <ChevronDown
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground transition-transform group-data-panel-open/disclosure:rotate-180 motion-reduce:transition-none"
        />
      </CollapsibleTrigger>
      <CollapsibleContent hiddenUntilFound className={contentClassName}>
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

export { Disclosure };
