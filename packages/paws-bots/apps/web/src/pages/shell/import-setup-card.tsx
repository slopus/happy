import { Trans, useLingui } from "@lingui/react/macro";
import type { AgentImportSetupState, MessageBlock } from "@rakazo/contracts";
import {
  importSetupStateInput,
  isImportSetupComplete,
  isImportSetupDone,
  isImportSetupVerifiable,
  isRetiredImportSetup,
} from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import { BuiCard, SuccessPop } from "../../components/ai/primitives";
import { rpc } from "../../lib/rpc";
import { useImportStatusText } from "./import-status";

/** Where a setup item is finished: model connections, MCP servers, or the routine itself. */
export type ImportSetupTarget =
  | { kind: "models" }
  | { kind: "mcp"; serverId: string }
  | { kind: "routine"; routineId: string };

/** MCP servers on this checklist are still granted through their own approval cards. */
export function ImportSetupCard({
  botId,
  block,
  onOpen,
}: {
  botId?: string;
  block: Extract<MessageBlock, { kind: "import_setup" }>;
  onOpen?: (target: ImportSetupTarget) => void;
}) {
  const { t } = useLingui();
  const text = useImportStatusText();
  const [state, setState] = useState<AgentImportSetupState | null>(null);
  const retired = isRetiredImportSetup(block);

  // `block` is a new object each time the thread is fetched again, so this follows refreshes.
  useEffect(() => {
    if (!botId || retired) return;
    let current = true;
    rpc.bots
      .importSetupState(importSetupStateInput(botId, block))
      .then((next) => {
        if (current) setState(next);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [botId, block, retired]);

  if (retired) return null;
  // Rows that cannot be checked keep the full list.
  if (isImportSetupComplete(block, state)) {
    return (
      <BuiCard
        data-testid="import-setup-card"
        data-complete="true"
        className="w-[420px] max-w-full px-[18px] py-[14px] text-body text-foreground"
      >
        <SuccessPop label={t`Setup complete`} />
      </BuiCard>
    );
  }

  return (
    <BuiCard data-testid="import-setup-card" className="w-[420px] max-w-full px-[18px] py-[14px]">
      <p className="text-body-lg text-foreground/90">
        <Trans>Finish setting up</Trans>
      </p>
      <ul className="mt-2 divide-y divide-border">
        {block.items.map((item, index) => {
          const name = item.kind === "model" ? item.title : item.name;
          const done = isImportSetupDone(item, state);
          const detail =
            item.kind === "model"
              ? text.need({ kind: "api_key", provider: item.providerName ?? item.provider })
              : item.kind === "routine"
                ? text.need({ kind: "turn_on" })
                : item.needs.map(text.need).join(", ");
          const target: ImportSetupTarget | null =
            item.kind === "model"
              ? { kind: "models" }
              : item.kind === "mcp"
                ? { kind: "mcp", serverId: item.serverId }
                : item.kind === "routine"
                  ? { kind: "routine", routineId: item.routineId }
                  : null;
          return (
            <li
              key={`${index}:${name}`}
              data-done={done === true ? "true" : undefined}
              className="flex min-h-11 items-center gap-3 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-body text-foreground" dir="auto">
                  {name}
                </p>
                <p className="flex flex-wrap gap-x-2 text-body-sm text-muted-foreground" dir="auto">
                  <span>{detail}</span>
                  {isImportSetupVerifiable(item) ? null : <span>{t`Check this yourself`}</span>}
                </p>
              </div>
              {done ? (
                <Check
                  role="img"
                  aria-label={t`Done`}
                  size={16}
                  strokeWidth={2}
                  className="shrink-0 text-success"
                />
              ) : target && onOpen ? (
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={t`Open ${name}`}
                  onClick={() => onOpen(target)}
                >
                  <Trans>Open</Trans>
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </BuiCard>
  );
}
