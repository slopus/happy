import { getLogger } from "@rakazo/logging";
import type { FleetCardSummary } from "./approval-ask.js";
import { redactConnectorPayload } from "./connector-safety.js";
import { cardName } from "./fleet-tools.js";
import type { RunContext } from "./run-context.js";

/** The page tools a click that pays can go through. */
export const PURCHASE_CHECKED_TOOLS: ReadonlySet<string> = new Set(["browser_act", "computer_act"]);

/**
 * The purchase a person approves: carried in the persisted request, so a replay presses exactly
 * the clicks approved, on the site approved. `steps` are indexes into the call's actions, none
 * for a screen click or key. `label` and `amount` are the page's own text.
 */
export type PurchaseApproval = {
  steps: number[];
  site: string;
  label: string;
  amount: string;
  /** Whether the amount is the one the button names or the total the page shows. */
  amountSource: "button" | "page";
  /** The page's total beside a button that names its own amount, when the page shows one. */
  total?: string;
  /** The order lines the page lists above its total, as page text; none when it lists none. */
  items?: Array<{ name: string; amount: string }>;
};

// Empty when the check failed and the page is unknown.
const SITE = /^[\w.[\]:-]{0,253}$/;
// Zero-width, bidirectional and tag characters would let a page show one thing and be read as another.
const INVISIBLE = /[\u{E0000}-\u{E007F}​-‏⁠-⁤‪-‮⁦-⁩﻿]/gu;
const pageText = (text: string, max: number) =>
  Array.from(text.replace(INVISIBLE, "").replace(/\s+/g, " ").trim()).slice(0, max).join("");

// The card's own row labels, in its text and its receipt; the apps also drop their translations.
const CARD_LABEL = /^(?:button|(?:amount )?on the button|total)\b/i;
// The page reads at most this many order lines; a longer order may have more.
const MAX_ITEMS = 30;
// The card lists this many order lines; a longer order shows one fewer and how many more there are.
const CARD_ITEMS = 8;

/** Order lines as the card shows them: page text, cut short, at most MAX_ITEMS. Anything else is dropped. */
function withItems(
  value: unknown,
  shown: (text: string, max: number) => string = pageText,
): Pick<PurchaseApproval, "items"> {
  const items = (Array.isArray(value) ? value.slice(0, MAX_ITEMS) : []).flatMap((item) => {
    const { name, amount } = (item ?? {}) as Record<string, unknown>;
    // A line the page names like one of the card's own reads as the card's, not the page's: left out.
    if (
      typeof name !== "string" ||
      typeof amount !== "string" ||
      CARD_LABEL.test(pageText(name, 80))
    )
      return [];
    // Control characters are page noise, not words: they read as spaces.
    const plain = (text: string) => text.replace(/\p{Cc}/gu, " ");
    const line = { name: shown(plain(name), 80), amount: shown(plain(amount), 40) };
    return line.name && line.amount ? [line] : [];
  });
  return items.length ? { items } : {};
}

/** A purchase approval as the persisted request holds it, or nothing when it is not one. */
export function purchaseApprovalOf(value: unknown): PurchaseApproval | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { steps, site, label, amount, amountSource, total, items } = value as Record<
    string,
    unknown
  >;
  if (
    !Array.isArray(steps) ||
    !steps.every((step) => Number.isInteger(step) && step >= 0 && step < 24) ||
    typeof site !== "string" ||
    !SITE.test(site) ||
    typeof label !== "string" ||
    typeof amount !== "string"
  )
    return undefined;
  return {
    steps: steps as number[],
    site,
    label,
    amount,
    amountSource: amountSource === "button" ? "button" : "page",
    ...(typeof total === "string" && total ? { total } : {}),
    ...withItems(items),
  };
}

/** The card for a purchase. The button and total are read from the page, not chosen by the model. */
export function purchaseCardSummary(purchase: PurchaseApproval): FleetCardSummary {
  if (!purchase.site) {
    return {
      onceOnly: true,
      title: "Complete a payment on this page?",
      lines: ["The page could not be checked, so this may complete a payment."],
    };
  }
  const items = purchase.items ?? [];
  const listed = items.length > CARD_ITEMS ? items.slice(0, CARD_ITEMS - 1) : items;
  return {
    onceOnly: true,
    title: `Pay on ${cardName(purchase.site)}?`,
    receipt: {
      ...(purchase.label ? { button: purchase.label } : {}),
      items: listed,
      ...(items.length > listed.length
        ? { more: { count: items.length - listed.length, atLeast: items.length >= MAX_ITEMS } }
        : {}),
      ...(purchase.amount ? { amount: purchase.amount } : {}),
      amountSource: purchase.amountSource,
      ...(purchase.total && purchase.total !== purchase.amount ? { total: purchase.total } : {}),
    },
    // The same order as text, for anywhere that cannot draw the receipt.
    lines: [
      ...(purchase.label ? [`Button: "${purchase.label}"`] : []),
      ...listed.map((item) => `${item.name}: ${item.amount}`),
      ...(items.length > listed.length
        ? [`and ${items.length - listed.length}${items.length < MAX_ITEMS ? "" : "+"} more`]
        : []),
      ...(purchase.amount
        ? [
            `${purchase.amountSource === "button" ? "Amount on the button" : "Total on the page"}: ${purchase.amount}`,
          ]
        : []),
      ...(purchase.total && purchase.total !== purchase.amount
        ? [`Total on the page: ${purchase.total}`]
        : []),
      items.length
        ? "The button label, items and total are read from the page. The bot has not checked them."
        : "The button label and total are read from the page. The bot has not checked them.",
    ],
  };
}

// Keys that submit a form or press the focused button; the key may carry its modifiers ("ctrl+Return").
const SUBMITTING_KEY = /^(return|kp_enter|enter|iso_enter|linefeed|space|kp_space)$/i;

/** What a page tool call asks the browser about: its clicks, or a click or key on the screen. */
function purchaseProbe(name: string, args: Record<string, unknown>) {
  const actions = Array.isArray(args.actions) ? (args.actions as unknown[]) : [];
  if (name === "browser_act") {
    const steps = actions.map((raw) => {
      const step = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      return {
        kind: String(step.kind ?? ""),
        // As browser_act reads it, so the check looks at the element the click will press.
        ref: step.ref === undefined ? undefined : String(step.ref).trim(),
      };
    });
    return steps.some((step) => step.kind === "click") ? { actions: steps } : undefined;
  }
  const points: Array<{ x: number; y: number }> = [];
  let enter = false;
  // A spot is judged on the page as it is now. Once a click, key, typing, wait or scroll has run in the
  // batch the page may have changed, so a later click cannot be placed; an `up` is checked where the pointer is and at its own spot.
  let disturbed = false;
  let unplaced = false;
  // A focus that opens a URL brings up a page this check cannot see beforehand: a click or key after it
  // asks whatever the page looks like now, even when no tab is showing yet.
  let opened = false;
  let unchecked = false;
  let pointer: { x: number; y: number } | undefined;
  for (const raw of actions) {
    const step = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const kind = String(step.kind);
    const own =
      typeof step.x === "number" && typeof step.y === "number"
        ? // Rounded as the desktop rounds it before pressing.
          { x: Math.round(step.x), y: Math.round(step.y) }
        : undefined;
    if (kind === "move") {
      pointer = own ?? pointer;
    } else if (["click", "down", "up"].includes(kind) && step.button === "right") {
      // A right-click opens a menu and presses nothing, but the page may change under later presses.
      disturbed = true;
    } else if (["click", "down", "up"].includes(kind)) {
      if (opened) unchecked = true;
      // The main screen releases where the pointer is; an extra display moves to the up's own spot first.
      const spots = kind === "up" ? [pointer, ...(own ? [own] : [])] : [own];
      if (kind !== "up") pointer = own ?? pointer;
      for (const at of spots) {
        if (!at || disturbed || points.length >= 24) unplaced = true;
        else points.push(at);
      }
      disturbed = true;
    } else {
      disturbed = true;
      if (kind === "scroll") pointer = own ?? pointer;
      if (kind === "key") {
        // Any part of the key, or any modifier, may be the one that submits: "a" with modifier "Return"
        // presses Enter too.
        const parts = [
          ...String(step.key ?? "").split("+"),
          ...(Array.isArray(step.modifiers) ? step.modifiers.map(String) : []),
        ];
        if (parts.some((part) => SUBMITTING_KEY.test(part.trim()))) {
          enter = true;
          if (opened) unchecked = true;
        }
      } else if (kind === "type" && /[\r\n]|^\s+$/.test(String(step.text ?? ""))) {
        // A line break submits; text that is only spaces presses a focused button.
        enter = true;
        if (opened) unchecked = true;
      } else if (kind === "focus" && step.uri !== undefined) opened = true;
    }
  }
  return points.length || enter || unplaced
    ? { desktop: true, enter, points, unplaced, unchecked }
    : undefined;
}

/**
 * Ask the page browser whether this call's clicks, or its click or key on the screen, would complete
 * a purchase. A browser that cannot tell (an older computer image, no page open) answers none, and
 * browser_act still refuses an unapproved purchase click itself when its browser knows how.
 */
export async function detectPurchase(
  ctx: RunContext,
  name: string,
  args: Record<string, unknown>,
): Promise<PurchaseApproval | undefined> {
  const probe = purchaseProbe(name, args);
  const { browser } = ctx.providers;
  if (!probe || !browser.purchaseCheck || !ctx.computer.pageBrowserAllowed) return undefined;
  if (ctx.computer.heldForTakeover) return undefined;
  const unchecked = { steps: [], site: "", label: "", amount: "", amountSource: "page" } as const;
  // A press after the batch opens a URL lands on a page nobody could look at yet.
  if ("unchecked" in probe && probe.unchecked) return { ...unchecked, steps: [] };
  let found: Awaited<ReturnType<NonNullable<typeof browser.purchaseCheck>>>["purchase"];
  let computer: Awaited<ReturnType<RunContext["computer"]["get"]>>;
  try {
    computer = await ctx.computer.get("tool", name);
  } catch {
    ctx.context.signal.throwIfAborted();
    // No computer, so the tool itself fails and nothing on a page is pressed.
    return undefined;
  }
  try {
    ({ purchase: found } = await browser.purchaseCheck(
      computer,
      { ...probe, signal: ctx.context.signal },
      ctx.context,
    ));
  } catch (error) {
    ctx.context.signal.throwIfAborted();
    getLogger().warn("purchase check failed, asking", {
      errorName: error instanceof Error ? error.name : typeof error,
    });
    found = { ...unchecked, steps: [] };
  }
  if (!found) return undefined;
  // Page text is stored with the approval: a value the run must keep secret never goes with it, not even
  // the start of one, so the whole text is redacted before it is cut.
  const shown = (text: string, max: number) =>
    pageText(String(redactConnectorPayload(pageText(text, 1_000), ctx.secrets)), max);
  return {
    steps: found.steps,
    site: found.site,
    label: shown(found.label, 80),
    amount: shown(found.amount, 40),
    amountSource: found.amountSource === "button" ? "button" : "page",
    ...(found.total ? { total: shown(found.total, 40) } : {}),
    ...withItems(found.items, shown),
  };
}
