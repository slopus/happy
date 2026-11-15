import { Tooltip, TooltipContent, TooltipTrigger } from "@rakazo/ui-web";
import type { ComponentProps, ReactElement } from "react";

/** Shows `label` beside an icon-only control on hover and focus; the control keeps its own accessible name. */
export function IconTooltip({
  label,
  side,
  children,
}: {
  label: string;
  side?: ComponentProps<typeof TooltipContent>["side"];
  children: ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}
