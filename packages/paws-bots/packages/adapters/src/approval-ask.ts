import type { ToolBatch } from "@rakazo/adapter-kit";
import type { AskReceipt, MessageBlock } from "@rakazo/contracts";
import { BOT_INSTRUCTIONS_MAX_LENGTH } from "@rakazo/contracts";
import {
  batchActions,
  CARD_TITLE_ESCAPED_CHARACTERS,
  instructionUpdateDiff,
  messagingProviderName,
  redactSecrets,
  SITE_SENDING_TOOLS,
  sanitizeMessagingLabel,
  toolRequiresExplicitApproval,
} from "@rakazo/core";
import { urlSite } from "@rakazo/core/egress";
import { USER_COMPUTER_SCREEN_TOOLS, userComputerAppName } from "./user-computer-tools.js";

export const MAX_APPROVAL_SUMMARY_LENGTH = 500;
export const MAX_APPROVAL_DETAIL_LENGTH = 4_000;
/** Longer fetch URLs are refused, so an approval card always shows the whole URL it sends. */
export const MAX_FETCH_URL_LENGTH = 2_048;

/** A fleet card built from the resolved request: a title and the lines under it. */
/** `onceOnly`: the card never offers Always allow, as for a purchase. */
/** `receipt`: a payment's order, which apps draw in place of the lines. */
export type FleetCardSummary = {
  title: string;
  lines: string[];
  onceOnly?: boolean;
  receipt?: AskReceipt;
};

/**
 * The child instruction card shows the whole new text, so its detail holds the longest
 * instructions plus the two length lines above them.
 */
export function approvalDetailLength(toolName: string): number {
  return toolName === "set_child_instructions"
    ? BOT_INSTRUCTIONS_MAX_LENGTH + MAX_APPROVAL_SUMMARY_LENGTH
    : MAX_APPROVAL_DETAIL_LENGTH;
}

function redactReceipt(receipt: AskReceipt, secrets: string[]): AskReceipt {
  const clean = (text: string) => redactSecrets(text, secrets);
  return {
    ...receipt,
    ...(receipt.button ? { button: clean(receipt.button) } : {}),
    items: receipt.items.map((item) => ({ name: clean(item.name), amount: clean(item.amount) })),
    ...(receipt.amount ? { amount: clean(receipt.amount) } : {}),
    ...(receipt.total ? { total: clean(receipt.total) } : {}),
  };
}

export function buildApprovalAskBlock(
  effectId: string,
  toolName: string,
  args: Record<string, unknown>,
  secrets: string[],
  options?: {
    reviewReason?: string;
    summary?: FleetCardSummary;
    batch?: ToolBatch;
    /** The approval asks every time, so the card never offers Always allow. */
    onceOnly?: boolean;
  },
): MessageBlock {
  const onceOnly = toolRequiresExplicitApproval(toolName) || Boolean(options?.onceOnly);
  if (options?.summary) {
    // Built from what was resolved before the effect was recorded, not from what the model typed.
    return {
      kind: "ask",
      approvalEffectId: effectId,
      text: truncate(redactSecrets(options.summary.title, secrets), MAX_APPROVAL_SUMMARY_LENGTH),
      detail: truncate(
        redactSecrets(options.summary.lines.join("\n"), secrets),
        approvalDetailLength(toolName),
      ),
      detailFormat: toolName === "set_child_instructions" ? "code" : "text",
      ...(options.summary.receipt
        ? { receipt: redactReceipt(options.summary.receipt, secrets) }
        : {}),
      status: "pending",
      actions:
        onceOnly || options.summary.onceOnly
          ? [
              { id: "allow", label: "Allow once" },
              { id: "deny", label: "Deny" },
            ]
          : [
              { id: "allow", label: "Allow once" },
              { id: "always", label: "Always allow this tool" },
              { id: "deny", label: "Deny" },
            ],
    };
  }
  if (toolName === "respond_agent_connection") {
    const name = sanitizeMessagingLabel(String(args.requester_name ?? "agent")).replace(
      new RegExp(CARD_TITLE_ESCAPED_CHARACTERS, "g"),
      "\\$&",
    );
    return {
      kind: "ask",
      approvalEffectId: effectId,
      text: redactSecrets(
        `${args.accept === true ? "Approve" : "Decline"} connection with “${name}”?`,
        secrets,
      ),
      detail: redactSecrets(
        `${messagingProviderName(String(args.requester_provider ?? ""))}: ${String(args.requester_address ?? "").replace(/[\r\n]/g, " ")}`,
        secrets,
      ),
      detailFormat: "text",
      status: "pending",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
    };
  }
  // Only an instruction change held for approval carries the text it replaces.
  if (toolName === "update_bot" && typeof args.previousInstructions === "string") {
    const before = redactSecrets(String(args.previousInstructions ?? ""), secrets);
    const after = redactSecrets(String(args.instructions ?? ""), secrets);
    const reason = redactSecrets(String(args.reason), secrets);
    return {
      kind: "ask",
      approvalEffectId: effectId,
      text: "Update instructions?",
      detail: instructionUpdateDiff(before, after),
      instructionUpdate: {
        botId: String(args.botId ?? ""),
        before,
        after,
        reason,
      },
      detailFormat: "code",
      status: "pending",
      actions: [
        { id: "allow", label: "Apply" },
        { id: "deny", label: "Dismiss" },
      ],
    };
  }
  if (USER_COMPUTER_SCREEN_TOOLS.has(toolName)) {
    const app = userComputerAppName(args.app).replace(
      new RegExp(CARD_TITLE_ESCAPED_CHARACTERS, "g"),
      "\\$&",
    );
    const steps = Array.isArray(args.actions) ? args.actions.map(screenActionLine) : [];
    return {
      kind: "ask",
      approvalEffectId: effectId,
      text: `Use ${app || "an app"} on your computer?`,
      ...(steps.length
        ? {
            detail: truncate(redactSecrets(steps.join("\n"), secrets), MAX_APPROVAL_DETAIL_LENGTH),
            detailFormat: "code" as const,
          }
        : {}),
      status: "pending",
      actions: [
        { id: "allow", label: "Allow in this space" },
        { id: "deny", label: "Deny" },
      ],
    };
  }
  if (toolName === "user_computer_shell") {
    const cwd = typeof args.cwd === "string" && args.cwd.trim() ? `cd ${args.cwd.trim()}\n` : "";
    return {
      kind: "ask",
      approvalEffectId: effectId,
      text: "Run on your computer?",
      detail: truncate(
        redactSecrets(`${cwd}${String(args.command ?? "")}`, secrets),
        MAX_APPROVAL_DETAIL_LENGTH,
      ),
      detailFormat: "code",
      status: "pending",
      actions: [
        { id: "allow", label: "Allow in this space" },
        { id: "deny", label: "Deny" },
      ],
    };
  }
  const fetchSite = webFetchSite(toolName, args);
  const summary = describeApprovalAction(toolName, args, options?.batch);
  const detail = formatApprovalDetail(
    toolName,
    args,
    options?.reviewReason,
    options?.batch,
    secrets,
  );
  const safeDetail = detail ? redactSecrets(detail, secrets) : undefined;
  return {
    kind: "ask",
    approvalEffectId: effectId,
    text: truncate(
      redactSecrets(
        toolName === "create_space" ? `${summary}?` : `Review before ${summary}`,
        secrets,
      ),
      MAX_APPROVAL_SUMMARY_LENGTH,
    ),
    detail: safeDetail ? truncate(safeDetail, MAX_APPROVAL_DETAIL_LENGTH) : undefined,
    ...(fetchSite ? { site: fetchSite } : {}),
    status: "pending",
    actions:
      toolName === "create_space"
        ? [
            { id: "allow", label: "Create space", outcome: "created" },
            { id: "deny", label: "Cancel", outcome: "cancelled" },
          ]
        : onceOnly
          ? [
              { id: "allow", label: "Allow once" },
              { id: "deny", label: "Deny" },
            ]
          : [
              { id: "allow", label: "Allow once" },
              {
                id: "always",
                label: fetchSite ? `Always allow ${fetchSite}` : "Always allow this tool",
              },
              { id: "deny", label: "Deny" },
            ],
  };
}

function webFetchSite(toolName: string, args: Record<string, unknown>): string | undefined {
  return SITE_SENDING_TOOLS.has(toolName) && typeof args.url === "string"
    ? urlSite(args.url)
    : undefined;
}

function describeApprovalAction(
  toolName: string,
  args: Record<string, unknown>,
  batchShape: ToolBatch | undefined,
): string {
  // A batch is named by the actions it runs; "…" stands for an entry that names none.
  const batch = batchShape && batchActions(batchShape, args);
  if (batch?.actions.length) {
    return [...batch.actions, ...(batch.complete ? [] : ["…"])].join(", ");
  }
  if (toolName === "archive_bot") {
    const name = args.confirm_name ?? args.confirmName;
    return name ? `${toolName.replace("_", " ")} (${String(name)})` : toolName.replace("_", " ");
  }
  if (toolName === "create_space") {
    const name = args.name ? String(args.name) : "Untitled";
    return `Create space “${name}”`;
  }
  const target = webFetchSite(toolName, args) ?? pickScopeLabel(args);
  return target ? `${toolName} → ${target}` : toolName;
}

function formatApprovalDetail(
  toolName: string,
  args: Record<string, unknown>,
  reviewReason: string | undefined,
  batch: ToolBatch | undefined,
  secrets: string[],
): string | undefined {
  const lines: string[] = [];
  if (reviewReason?.trim()) {
    lines.push(reviewReason.trim().replace(/\u2014|\u2013/g, "-"));
  }
  if (toolName === "create_space") {
    lines.push(
      "Bots, groups, chats, files, memory, and integrations in this space stay separate from other spaces.",
    );
  }
  // A fetch carries data in its path and query, so the card shows the whole URL.
  const shown = (values: Record<string, unknown>) =>
    argumentLines(
      redactLeaves(values, secrets) as Record<string, unknown>,
      SITE_SENDING_TOOLS.has(toolName) ? ["url", "method", "body"] : undefined,
    );
  const items = batch ? args[batch.items] : undefined;
  if (batch && Array.isArray(items)) {
    // Every action and its destinations first, then each action's long text.
    const later: string[] = [];
    for (const item of items) {
      const entry = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const action = entry[batch.action];
      const name = (typeof action === "string" && action.trim()) || "…";
      const { first, last } = shown(objectArguments(entry[batch.arguments]));
      lines.push(name, ...first);
      later.push(...last.map((line) => `${name} ${line}`));
    }
    lines.push(...later);
  } else {
    const { first, last } = shown(args);
    lines.push(...first, ...last);
  }
  if (lines.length === 0) return undefined;
  return lines.join("\n");
}

/** Longer text goes below the short values, so recipients and places always come first. */
const SHORT_ARGUMENT_LENGTH = 200;

/**
 * Every argument as a `key: value` line, since any one may name who or where a call reaches.
 * `first` holds short values in their order, then long lists and objects; `last` holds long text
 * such as a message body, which the card's length limit cuts first.
 */
function argumentLines(
  values: Record<string, unknown>,
  keys = Object.keys(values),
): { first: string[]; last: string[] } {
  const short: string[] = [];
  const structured: string[] = [];
  const last: string[] = [];
  for (const key of keys) {
    const value = values[key];
    const text = argumentText(value);
    if (!text) continue;
    const line = `${key}: ${text}`;
    if (text.length <= SHORT_ARGUMENT_LENGTH) short.push(line);
    else (typeof value === "string" ? last : structured).push(line);
  }
  return { first: [...short, ...structured], last };
}

function argumentText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value) && value.every((item) => item === null || typeof item !== "object"))
    return value.map(String).join(", ");
  return JSON.stringify(value) ?? "";
}

/** Redacts every string inside a value, since JSON escaping could hide a secret from the card. */
function redactLeaves(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactLeaves(item, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactLeaves(item, secrets)]),
    );
  return value;
}

/** A batch entry's arguments, as an object or a JSON string. */
function objectArguments(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function pickScopeLabel(args: Record<string, unknown>): string | undefined {
  for (const key of ["to", "title", "collection", "subject", "amount"]) {
    const value = args[key];
    if (value != null && value !== "") return String(value);
  }
  return undefined;
}

export function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function screenActionLine(value: unknown): string {
  const action = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const at =
    action.element !== undefined
      ? ` [${String(action.element)}]`
      : action.x !== undefined
        ? ` ${String(action.x)},${String(action.y)}`
        : "";
  switch (action.kind) {
    case "type":
      return `type ${JSON.stringify(String(action.text ?? ""))}${at}`;
    case "set":
      return `set${at} to ${JSON.stringify(String(action.value ?? ""))}`;
    case "key":
      return `key ${[...(Array.isArray(action.modifiers) ? action.modifiers : []), action.key].join("+")}`;
    case "scroll":
      return `scroll ${String(action.direction ?? "")}${at}`;
    case "menu":
      return `menu ${(Array.isArray(action.path) ? action.path : []).join(" > ")}`;
    case "wait":
      return `wait ${String(action.ms ?? 0)}ms`;
    default:
      return `${String(action.kind ?? "action")}${at}`;
  }
}
