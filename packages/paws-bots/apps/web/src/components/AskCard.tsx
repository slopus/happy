import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { AskReceipt, LoginFieldInput, ThreadMessage } from "@rakazo/contracts";
import { BOT_INSTRUCTIONS_MAX_LENGTH } from "@rakazo/contracts";
import {
  isApprovalAskBlock,
  isQuestionAskBlock,
  isSecretAskBlock,
  receiptItems,
  resolveAskChoice,
  selectedAskActionLabel,
} from "@rakazo/core";
import { Button, cn, Textarea } from "@rakazo/ui-web";
import { Check } from "lucide-react";
import { useState } from "react";
import type { RpcClient } from "../lib/rpc";
import { rpc as selectedSpaceRpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { BuiCard } from "./ai/primitives";
import { OptionRow, optionLetter } from "./OptionRow";
import { SecretAskCard } from "./SecretAskCard";

export type AskBlock = Extract<ThreadMessage["blocks"][number], { kind: "ask" }>;

function ReceiptRow({
  name,
  amount,
  className,
}: {
  name: string;
  amount: string;
  className?: string;
}) {
  return (
    <li className={`flex items-baseline justify-between gap-4 ${className ?? ""}`}>
      <span className="min-w-0 break-words">{name}</span>
      <span className="shrink-0 tabular-nums">{amount}</span>
    </li>
  );
}

/** A payment's order as the page shows it: its lines, then what is paid, then where it came from. */
function AskReceiptView({ receipt }: { receipt: AskReceipt }) {
  const { button, more, amount, total } = receipt;
  const items = receiptItems(receipt.items, [t`Total`, t`On the button`]);
  const count = more ? `${more.count}${more.atLeast ? "+" : ""}` : "";
  const lines = items.length > 0 || more || total;
  return (
    <div data-testid="ask-receipt" className="mt-3 text-body-lg leading-[1.5] text-foreground">
      {lines ? (
        <ul className="space-y-1 border-b border-border pb-2.5">
          {items.map((item, index) => (
            // Page lines can repeat, so their place is their key.
            <ReceiptRow key={index} name={item.name} amount={item.amount} />
          ))}
          {more ? <li className="text-muted-foreground">{t`${count} more`}</li> : null}
          {total ? <ReceiptRow name={t`Total`} amount={total} /> : null}
        </ul>
      ) : null}
      {amount ? (
        <ul className={lines ? "pt-2.5" : undefined}>
          <ReceiptRow
            className="font-medium"
            name={receipt.amountSource === "button" ? t`On the button` : t`Total`}
            amount={amount}
          />
        </ul>
      ) : null}
      <p className="mt-2.5 text-body-sm leading-[1.45] text-muted-foreground">
        {button
          ? t`Button “${button}” · read from the page, not checked`
          : t`Read from the page, not checked`}
      </p>
    </div>
  );
}

function formatAnsweredState(
  answer: string | undefined,
  approval: boolean,
  outcome?: "created" | "cancelled",
  actions?: AskBlock["actions"],
): string {
  if (!answer) return t`Answered`;
  if (!approval) return answer === "approved" ? t`Sent` : selectedAskActionLabel(answer, actions);
  if (outcome === "created") return t`Created`;
  if (outcome === "cancelled") return t`Cancelled`;
  if (answer === "allow") return allowsSpace(actions) ? t`Allowed in this space` : t`Allowed once`;
  if (answer === "always") return t`Always allowed`;
  if (answer === "deny") return t`Denied`;
  return t`Answered: ${answer}`;
}

/**
 * The server's labels on the user's-computer approval, whose "allow" covers the whole space. Cards
 * from before it covered the space carry the older label.
 */
const ALLOW_IN_SPACE = new Set(["Allow in this space", "Allow for this chat"]);

function allowsSpace(actions: AskBlock["actions"]): boolean {
  return actions?.some((action) => ALLOW_IN_SPACE.has(action.label)) ?? false;
}

function approvalActionLabel(
  id: string,
  fallback: string,
  outcome?: "created" | "cancelled",
  site?: string,
): string {
  if (outcome === "created") return t`Create space`;
  if (outcome === "cancelled") return t`Cancel`;
  if (id === "allow") return ALLOW_IN_SPACE.has(fallback) ? t`Allow in this space` : t`Allow once`;
  if (id === "always") return site ? t`Always allow ${site}` : t`Always allow this tool`;
  if (id === "deny") return t`Deny`;
  return fallback;
}

export type AskCardProps = {
  block: AskBlock;
  canAnswer: boolean;
  answerIsSeparate?: boolean;
  canDismiss: boolean;
  /** A login card answers with its fields and an empty `text`; `remember` false uses it once. */
  onAnswer: (text: string, fields?: LoginFieldInput[], remember?: false) => Promise<void>;
  /** Turns down a secret request without a value. */
  onDismiss: () => Promise<void>;
  /** The chat's space; Undo goes there even if another tab selects a different space. */
  rpc?: RpcClient;
};

/** A question, approval or protected-input request from the bot. */
export function AskCard(props: AskCardProps) {
  return isSecretAskBlock(props.block) ? (
    <SecretAskCard {...props} />
  ) : (
    <PromptAskCard {...props} />
  );
}

function PromptAskCard({
  block,
  canAnswer,
  answerIsSeparate,
  onAnswer,
  rpc = selectedSpaceRpc,
}: AskCardProps) {
  const { t } = useLingui();
  const [editing, setEditing] = useState(false);
  const [answer, setAnswer] = useState(block.instructionUpdate?.after ?? "");
  const [acceptedAnswer, setAcceptedAnswer] = useState<string>();
  const [undone, setUndone] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submitting = pendingAction !== null;
  const answered = block.status === "answered" || acceptedAnswer !== undefined;
  const answeredQuestion = answered && isQuestionAskBlock(block);
  const displayedAnswer = block.status === "answered" ? block.answer : acceptedAnswer;
  const approvalActions = isApprovalAskBlock(block) ? block.actions : undefined;
  const askActions = block.actions;
  const displayActions = block.instructionUpdate
    ? askActions?.flatMap((action) =>
        action.id === "allow" ? [action, { id: "edit", label: t`Edit` }] : [action],
      )
    : askActions;
  const optionQuestion =
    !approvalActions && !block.instructionUpdate && Boolean(askActions?.length);
  const chosenOption =
    answered && displayedAnswer ? resolveAskChoice(displayedAnswer, askActions) : undefined;
  // Typed replies already have their own message; the question must not repeat them.
  const typedAnswer =
    answered &&
    !optionQuestion &&
    !approvalActions &&
    !block.instructionUpdate &&
    displayedAnswer !== "approved"
      ? displayedAnswer
      : undefined;
  async function submitAnswer(value: string) {
    if (submitting || !value.trim()) return;
    const submitValue = value.trim();
    setPendingAction(submitValue);
    setError(null);
    try {
      await onAnswer(submitValue);
      setAcceptedAnswer(submitValue);
    } catch (err) {
      setError(errorText(err, t`Could not submit this answer`));
    } finally {
      setPendingAction(null);
    }
  }

  const { instructionUpdate, settingsUpdate } = block;
  const undo = instructionUpdate?.undoVersionId
    ? {
        label: t`Instructions updated`,
        run: () =>
          rpc.bots.restoreInstructions({
            botId: instructionUpdate.botId,
            versionId: instructionUpdate.undoVersionId!,
            expectedInstructions: instructionUpdate.after,
            undo: true,
          }),
      }
    : settingsUpdate
      ? {
          label: t`Settings updated`,
          run: () =>
            rpc.bots.update({
              botId: settingsUpdate.botId,
              ...settingsUpdate.before,
              expectedSettings: settingsUpdate.after,
            }),
        }
      : undefined;
  if (undo)
    return (
      <BuiCard className="px-5 py-4">
        <div className="flex items-center gap-2 text-body">
          {undo.label}
          <Button
            variant="link"
            disabled={undone || submitting}
            onClick={async () => {
              setPendingAction("undo");
              setError(null);
              try {
                await undo.run();
                setUndone(true);
              } catch (err) {
                setError(errorText(err));
              } finally {
                setPendingAction(null);
              }
            }}
          >
            {undone ? <Trans>Restored</Trans> : <Trans>Undo</Trans>}
          </Button>
          {error ? <span className="text-destructive">{error}</span> : null}
        </div>
      </BuiCard>
    );

  return (
    <BuiCard
      data-testid={
        block.instructionUpdate
          ? "instruction-approval-card"
          : isQuestionAskBlock(block)
            ? "question-card"
            : undefined
      }
      className={cn(
        "w-full min-w-0 max-w-xl px-5 py-4",
        answeredQuestion && "opacity-50 [&_button:disabled]:opacity-100",
      )}
    >
      <div className="text-body-lg leading-[1.5] text-foreground">
        {block.instructionUpdate ? (
          <Trans>Update instructions?</Trans>
        ) : (
          <ChatMarkdown>{block.text}</ChatMarkdown>
        )}
      </div>
      {block.receipt ? (
        <AskReceiptView receipt={block.receipt} />
      ) : block.detail ? (
        <pre
          data-testid="ask-detail"
          className={
            block.detailFormat === "text"
              ? "mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words font-sans text-body-lg leading-[1.5] text-foreground"
              : "mt-2.5 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background px-3 py-2 font-mono text-body-sm leading-[1.6] text-foreground"
          }
        >
          {block.detail}
        </pre>
      ) : null}
      {block.instructionUpdate && editing && canAnswer && !answered ? (
        <form
          className="mt-3 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submitAnswer(JSON.stringify({ instructions: answer }));
          }}
        >
          <Textarea
            aria-label={t`Instructions`}
            maxLength={BOT_INSTRUCTIONS_MAX_LENGTH}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
          />
          <Button type="submit" disabled={submitting}>
            <Trans>Apply</Trans>
          </Button>
          <Button type="button" variant="outline" onClick={() => setEditing(false)}>
            <Trans>Cancel</Trans>
          </Button>
        </form>
      ) : optionQuestion ? (
        // Options stay in place once answered: the chosen one is marked, the rest dim.
        <div className="mt-2.5 space-y-0.5">
          {askActions?.map((action, index) => (
            <OptionRow
              key={action.id}
              letter={optionLetter(index)}
              selected={chosenOption?.id === action.id}
              disabled={answered || !canAnswer || submitting}
              onClick={() => void submitAnswer(action.id)}
            >
              {pendingAction === action.id ? <Trans>Sending…</Trans> : action.label}
            </OptionRow>
          ))}
        </div>
      ) : typedAnswer ? (
        answerIsSeparate ? null : (
          <blockquote
            data-testid="ask-answer"
            className="mt-3 whitespace-pre-wrap break-words border-s-2 border-border ps-3 text-body-lg leading-[1.5] text-muted-foreground"
          >
            {typedAnswer}
          </blockquote>
        )
      ) : answered ? (
        <div className="mt-3.5 flex items-center gap-1.5 text-body font-medium text-muted-foreground">
          {displayedAnswer === "deny" ||
          approvalActions?.find((action) => action.id === displayedAnswer)?.outcome ===
            "cancelled" ? null : (
            <Check aria-hidden className="size-4" />
          )}
          {block.instructionUpdate
            ? displayedAnswer === "deny"
              ? t`Dismissed`
              : t`Allowed once`
            : formatAnsweredState(
                displayedAnswer,
                Boolean(approvalActions),
                approvalActions?.find((action) => action.id === displayedAnswer)?.outcome,
                askActions,
              )}
        </div>
      ) : !canAnswer ? (
        <div className="mt-3.5 text-body font-medium text-muted-foreground">
          <Trans>No longer active</Trans>
        </div>
      ) : displayActions?.length ? (
        <div className="mt-3.5 flex flex-wrap gap-2">
          {displayActions.map((action) => (
            <Button
              key={action.id}
              variant={action.id === "allow" ? "default" : "outline"}
              // Wraps long site names like the other cards' buttons.
              className="h-auto min-h-8 min-w-0 whitespace-normal py-1 text-start"
              disabled={submitting}
              onClick={() =>
                action.id === "edit" && block.instructionUpdate
                  ? setEditing(true)
                  : void submitAnswer(action.id)
              }
            >
              {pendingAction === action.id ? (
                <Trans>Sending…</Trans>
              ) : action.id === "edit" ? (
                action.label
              ) : block.instructionUpdate ? (
                action.id === "allow" ? (
                  t`Apply`
                ) : (
                  t`Dismiss`
                )
              ) : (
                approvalActionLabel(action.id, action.label, action.outcome, block.site)
              )}
            </Button>
          ))}
        </div>
      ) : null}

      {error ? <p className="mt-3 text-body-sm text-destructive">{error}</p> : null}
    </BuiCard>
  );
}
