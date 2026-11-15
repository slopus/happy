import { Trans } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { ThreadMessage } from "@rakazo/contracts";
import { helperCardState } from "@rakazo/core";
import { Button } from "@rakazo/ui-web/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@rakazo/ui-web/components/ui/collapsible";
import { ChevronDown } from "lucide-react";
import { useState } from "react";

type SubagentBlock = Extract<ThreadMessage["blocks"][number], { kind: "subagent" }>;

// A running helper's live card and the saved message that replaces it have different ids, so
// its row mounts again when the helper finishes. Remember open cards by agent id across that.
const openHelpers = new Set<string>();

/**
 * A helper's card. It starts folded to its name, status and one line of the task, so a long
 * brief or report does not fill the chat. The header opens it to the full task and the result
 * or progress.
 */
export function SubagentCard({
  block,
  onStop,
}: {
  block: SubagentBlock;
  /** Stops this background helper; absent for a helper inside a turn. */
  onStop?: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(() => openHelpers.has(block.agentId));
  const [stopping, setStopping] = useState(false);
  const running = block.status === "running";
  const { stopped, failed, body } = helperCardState(block);
  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        if (next) openHelpers.add(block.agentId);
        else openHelpers.delete(block.agentId);
        setOpen(next);
      }}
      data-testid="subagent-card"
      className="w-[420px] max-w-full rounded-[18px] border border-border bg-muted px-[18px] py-4"
    >
      <CollapsibleTrigger className="block w-full min-w-0 cursor-pointer rounded-md text-start outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-muted">
        <span className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 flex-1 items-center text-body-lg font-medium text-foreground">
            <span className="truncate" dir="auto">
              {block.name}
            </span>
          </span>
          <span
            className={`${running ? "motion-safe:animate-[rkPulse_1.2s_ease-in-out_infinite]" : ""} shrink-0 rounded-full px-[11px] py-1 text-body-sm ${
              failed
                ? "bg-destructive/15 text-destructive"
                : running
                  ? "bg-warning/15 text-warning"
                  : stopped
                    ? "bg-muted-foreground/15 text-muted-foreground"
                    : "bg-success/15 text-success"
            }`}
          >
            {running ? (
              <Trans>Running</Trans>
            ) : stopped ? (
              <Trans>Stopped</Trans>
            ) : failed ? (
              <Trans>Failed</Trans>
            ) : (
              <Trans>Completed</Trans>
            )}
          </span>
          <ChevronDown
            data-testid="subagent-chevron"
            aria-hidden
            size={14}
            strokeWidth={1.8}
            className={`shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none ${
              open ? "rotate-180" : ""
            }`}
          />
        </span>
        <span
          data-testid="subagent-task"
          className={`mt-2 block text-body text-muted-foreground ${open ? "" : "truncate"}`}
          dir="auto"
        >
          {block.task}
        </span>
      </CollapsibleTrigger>
      {running && onStop ? (
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          disabled={stopping}
          onClick={() => {
            setStopping(true);
            // The card settles from the chat's events once the helper stops.
            onStop().catch(() => setStopping(false));
          }}
        >
          <Trans>Stop</Trans>
        </Button>
      ) : null}
      {body ? (
        <CollapsibleContent>
          <div
            data-testid="subagent-body"
            className="mt-2.5 text-body-lg leading-[1.5] text-foreground/75"
          >
            <ChatMarkdown streaming={running}>{body}</ChatMarkdown>
          </div>
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  );
}
