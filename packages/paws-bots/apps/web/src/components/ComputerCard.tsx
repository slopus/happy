import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { ComputerReleaseReason, MessageBlock } from "@rakazo/contracts";
import {
  TAKEOVER_COMPUTER_DONE_STATE,
  TAKEOVER_COMPUTER_PENDING_STATE,
  TAKEOVER_COMPUTER_SKIPPED_STATE,
} from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { Laptop, Monitor } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { useSpaceQueries } from "../lib/query";
import { errorText } from "../lib/user-error";

type ComputerBlock = Extract<MessageBlock, { kind: "computer" }>;

function stateLabel(state: string) {
  if (state === TAKEOVER_COMPUTER_PENDING_STATE) return t`Needs you`;
  if (state === TAKEOVER_COMPUTER_SKIPPED_STATE) return t`Skipped`;
  if (state === TAKEOVER_COMPUTER_DONE_STATE) return t`Done`;
  return state;
}

function Header({ children }: { children?: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-foreground/5">
        <Laptop aria-hidden className="size-4 text-muted-foreground" />
      </span>
      <span className="shrink-0 text-body-lg font-medium text-foreground">
        <Trans>Computer</Trans>
      </span>
      {children}
    </span>
  );
}

/**
 * A bot's request to use its computer. While it waits it shows the screen and the answers;
 * once settled it folds to one line that opens to show what was asked.
 */
export function ComputerCard({
  block,
  botId,
  runId,
  onOpen,
  onRelease,
}: {
  block: ComputerBlock;
  botId: string | undefined;
  runId?: string;
  onOpen: (botId: string | undefined, takeControl?: boolean) => void;
  onRelease: (
    botId: string,
    runId: string | undefined,
    reason: ComputerReleaseReason,
  ) => Promise<void>;
}) {
  if (block.state === TAKEOVER_COMPUTER_PENDING_STATE) {
    return (
      <PendingComputerCard
        block={block}
        botId={botId}
        runId={runId}
        onOpen={onOpen}
        onRelease={onRelease}
      />
    );
  }
  return <SettledComputerCard block={block} botId={botId} onOpen={onOpen} />;
}

function PendingComputerCard({
  block,
  botId,
  runId,
  onOpen,
  onRelease,
}: {
  block: ComputerBlock;
  botId: string | undefined;
  runId?: string;
  onOpen: (botId: string | undefined, takeControl?: boolean) => void;
  onRelease: (
    botId: string,
    runId: string | undefined,
    reason: ComputerReleaseReason,
  ) => Promise<void>;
}) {
  const [releasing, setReleasing] = useState<ComputerReleaseReason | null>(null);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const queries = useSpaceQueries();
  const preview = useQuery({
    ...queries.computer.preview.queryOptions({ input: { botId: botId ?? "", runId } }),
    // A card with no run (an imported one) never answers or shows a later request.
    enabled: Boolean(botId && runId),
    retry: false,
    // A later request must never paint an earlier screen, and a return to the tab redraws it.
    gcTime: 0,
    refetchOnWindowFocus: "always",
  });
  const image = preview.data?.image ?? null;
  const release = async (reason: ComputerReleaseReason) => {
    if (!botId) return;
    setReleasing(reason);
    setReleaseError(null);
    // An answer that went through stays busy until the card settles, so it cannot be sent twice.
    try {
      await onRelease(botId, runId, reason);
    } catch (error) {
      setReleasing(null);
      setReleaseError(errorText(error, t`Could not continue`));
    }
  };
  return (
    <div
      data-testid="computer-card"
      className="w-full rounded-[18px] border border-border bg-muted px-[18px] py-4"
    >
      <Header />
      <div className="mt-3 text-body-lg font-semibold text-foreground">
        <Trans>Needs you</Trans>
      </div>
      <div className="mt-0.5 text-body-lg leading-[1.5] text-muted-foreground">
        <ChatMarkdown>{block.text}</ChatMarkdown>
      </div>
      {image ? (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          data-testid="computer-card-preview"
          className="mt-3 block w-full cursor-pointer overflow-hidden rounded-lg border border-border bg-background"
          onClick={() => onOpen(botId)}
        >
          <img src={image} alt="" className="block h-auto w-full" draggable={false} />
        </button>
      ) : preview.isPending && botId && runId ? (
        <div className="mt-3 aspect-[16/10] w-full animate-pulse rounded-lg bg-foreground/5" />
      ) : null}
      {releaseError ? (
        <p role="alert" className="mt-3 text-body-sm text-destructive">
          {releaseError}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {runId ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={releasing !== null}
              onClick={() => void release("skipped")}
            >
              <Trans>Skip</Trans>
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={releasing !== null}
              onClick={() => void release("done")}
            >
              <Trans>I’m done</Trans>
            </Button>
          </>
        ) : null}
        <Button
          type="button"
          size="sm"
          data-testid="computer-card-open"
          disabled={releasing !== null}
          onClick={() => onOpen(botId, true)}
        >
          <Trans>Take control</Trans>
        </Button>
      </div>
    </div>
  );
}

function SettledComputerCard({
  block,
  botId,
  onOpen,
}: {
  block: ComputerBlock;
  botId: string | undefined;
  onOpen: (botId: string | undefined, takeControl?: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const label = stateLabel(block.state);
  return (
    <div
      data-testid="computer-card"
      className="w-full rounded-[18px] border border-border bg-muted"
    >
      <button
        type="button"
        aria-expanded={expanded}
        data-testid="computer-card-toggle"
        className="flex w-full min-w-0 cursor-pointer items-center px-[18px] py-3 text-left"
        onClick={() => setExpanded((open) => !open)}
      >
        <Header>
          {expanded ? null : (
            <span className="min-w-0 truncate text-body-lg text-muted-foreground" dir="auto">
              {label} · {block.text}
            </span>
          )}
        </Header>
      </button>
      {expanded ? (
        <div className="px-[18px] pb-4">
          <div className="text-body-lg font-semibold text-foreground">{label}</div>
          <div className="mt-0.5 text-body-lg leading-[1.5] text-muted-foreground">
            <ChatMarkdown>{block.text}</ChatMarkdown>
          </div>
          <div className="mt-3 flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="computer-card-open"
              onClick={() => onOpen(botId)}
            >
              <Monitor aria-hidden />
              <Trans>Open</Trans>
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
