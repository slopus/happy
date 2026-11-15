import { useLingui } from "@lingui/react/macro";
import { Tooltip, TooltipContent, TooltipTrigger } from "@rakazo/ui-web/components/ui/tooltip";
import { CircleHelp } from "lucide-react";
import { useId, useRef, useState } from "react";

/** Help for a settings label, available to pointer, keyboard and touch users. */
export function InfoTooltip({ label, children }: { label: string; children: string }) {
  const { t } = useLingui();
  const id = useId();
  const descriptionId = useId();
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const dismissed = useRef(false);
  return (
    <Tooltip
      open={open}
      triggerId={id}
      onOpenChange={(next, details) => {
        if (next && dismissed.current) return;
        if (!next && pinned.current && details.reason === "trigger-hover") return;
        if (!next) {
          pinned.current = false;
          dismissed.current = details.reason === "escape-key" || details.reason === "outside-press";
        }
        setOpen(next);
      }}
    >
      <span id={descriptionId} className="sr-only">
        {children}
      </span>
      <TooltipTrigger
        id={id}
        type="button"
        aria-label={t`About ${label}`}
        aria-describedby={descriptionId}
        delay={0}
        closeOnClick={false}
        className="-ms-1 -my-1 inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onPointerLeave={() => {
          dismissed.current = false;
        }}
        onFocus={() => {
          dismissed.current = false;
        }}
        onClick={(event) => {
          event.preventDefault();
          pinned.current = !pinned.current;
          dismissed.current = !pinned.current;
          setOpen(pinned.current);
        }}
      >
        <CircleHelp aria-hidden="true" size={14} />
      </TooltipTrigger>
      <TooltipContent aria-hidden="true" role="presentation" className="max-w-[320px]">
        {children}
      </TooltipContent>
    </Tooltip>
  );
}
