import type {
  AdapterContext,
  AgentToolExecutionResult,
  BrowserActStep,
  BrowserDownload,
  BrowserProvider,
  ComputerRef,
} from "@rakazo/adapter-kit";
import { MAX_BROWSER_UPLOAD_FILES } from "@rakazo/adapter-kit";
import type { PurchaseCardField } from "@rakazo/contracts";
import { PURCHASE_CARD_FIELDS } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import { redactConnectorPayload } from "./connector-safety.js";
import { TOOL_RESULT_TEXT_LIMIT } from "./pi-runtime-limits.js";
import type { PurchaseApproval } from "./purchase-gate.js";
import { MAX_ACTIONS_PER_CALL } from "./tool-loop.js";
import { cardFillSite } from "./vault-card-use.js";

/** The action kinds `browser_act` takes, as its tool schema lists them. */
export const BROWSER_ACT_KINDS = [
  "click",
  "fill",
  "type",
  "upload",
  "fill_secret",
  "fill_card",
  "fill_pay_token",
  "fill_code",
] as const;
const MAX_QUERY = 200;
const NAVIGATE_URL_REQUIRED = "An HTTP(S) URL without embedded credentials is required";

/** Fills a saved website login's field by its label; the model never supplies or sees the value. */
export type SecretFillStep = {
  kind: "fill_secret";
  ref: string;
  secret: string;
  field: string;
};
/**
 * One field of an approved purchase's card, or of a saved card on the checkout `site` the person
 * approved. The model never supplies or sees the value.
 */
export type CardFillStep = {
  kind: "fill_card";
  ref?: string;
  field: PurchaseCardField;
} & ({ purchase: string } | { card: string; site: string });
/** The model never supplies or sees the token. */
export type PayTokenFillStep = { kind: "fill_pay_token"; purchase: string };
/** Types the code the user entered for the run's last code request; the model never sees it. */
/** With `secret`, the current code of that saved login's authenticator key. */
export type CodeFillStep = { kind: "fill_code"; ref: string; secret?: string };
export type BrowserActInput =
  | BrowserActStep
  | SecretFillStep
  | CardFillStep
  | PayTokenFillStep
  | CodeFillStep;
/**
 * desktopTools: the run also has computer_act, so a page-tool failure can fall back to it.
 * downloads: the folder in the computer's home that the page's file downloads are saved to, and the
 * path the bot's own tools use for a file there.
 */
export type PageToolOptions = {
  desktopTools?: boolean;
  downloads?: { folder: string; botPath: (path: string) => string };
};
/** `typed` is called once the page may have typed it, never for a fill refused before that. */
export type ResolveSecretFill = (
  step: SecretFillStep,
  /** The step's place in the batch. */
  index: number,
) => Promise<
  { text: string; origin: string; hidden: boolean; typed?: () => Promise<void> } | { error: string }
>;

export type ResolveCardFill = (
  step: CardFillStep,
) => Promise<{ text: string; origin: string; typed?: () => Promise<void> } | { error: string }>;

/**
 * `claim` takes the code for this one fill, or says why the bot gets no code: another fill took
 * it first, or the run may type no more of them. `restore` gives it back if the page refused.
 * `typed` is as a login fill's.
 */
export type ResolveCodeFill = (
  step: CodeFillStep,
  index: number,
) => Promise<
  | {
      text: string;
      origin: string;
      claim: () => Promise<string | undefined>;
      restore: () => Promise<void>;
      typed?: () => Promise<void>;
    }
  | { error: string }
>;

export type ResolvePayTokenFill = (
  step: PayTokenFillStep,
) => Promise<{ text: string; origin: string; merchantAccountId: string } | { error: string }>;

/**
 * A browser tool call turned down before anything ran, such as a missing argument. It is settled:
 * nothing on the page changed, so the bot fixes the call instead of turning to desktop tools.
 */
class BrowserToolInputError extends Error {}

function refusedInput(message: string) {
  return { ok: false, uncertain: false, error: message };
}

export async function browserNavigateFromTool(
  browser: BrowserProvider,
  computer: ComputerRef,
  context: AdapterContext,
  args: Record<string, unknown>,
  options: PageToolOptions = {},
) {
  const url = String(args.url ?? "").trim();
  if (!URL.canParse(url)) return refusedInput(NAVIGATE_URL_REQUIRED);
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
    return refusedInput(NAVIGATE_URL_REQUIRED);
  }
  try {
    const result = await browser.navigate(
      computer,
      { url, downloads: options.downloads?.folder, signal: context.signal },
      context,
    );
    return formatBrowserResult(withBotPaths(result, options), options);
  } catch (error) {
    context.signal.throwIfAborted();
    return formatBrowserResult(
      { error: error instanceof Error ? error.message : String(error), fallback: "computer_act" },
      options,
    );
  }
}

export async function browserSnapshotFromTool(
  browser: BrowserProvider,
  computer: ComputerRef,
  context: AdapterContext,
  args: Record<string, unknown>,
  options: PageToolOptions = {},
) {
  const query = typeof args.query === "string" ? args.query.trim().slice(0, MAX_QUERY) : "";
  try {
    const result = await browser.snapshot(
      computer,
      { ...(query ? { query } : {}), downloads: options.downloads?.folder, signal: context.signal },
      context,
    );
    return formatBrowserResult(withBotPaths(result, options), options);
  } catch (error) {
    context.signal.throwIfAborted();
    return formatBrowserResult(
      { error: error instanceof Error ? error.message : String(error), fallback: "computer_act" },
      options,
    );
  }
}

export async function browserActFromTool(
  browser: BrowserProvider,
  computer: ComputerRef,
  context: AdapterContext,
  args: Record<string, unknown>,
  options: PageToolOptions & {
    resolveSecretFill?: ResolveSecretFill;
    resolveCardFill?: ResolveCardFill;
    resolvePayTokenFill?: ResolvePayTokenFill;
    resolveCodeFill?: ResolveCodeFill;
    redactions?: () => string[];
    /** Maps a bot-facing workspace path to its path in the computer's home. */
    resolveUploadPath?: (path: string) => string;
    /** Trusted upload roots relative to the computer home, set by the executor. */
    uploadRoots?: string[];
    /** The purchase the user approved for this call; its clicks alone may complete it. */
    approvedPurchase?: PurchaseApproval;
    /**
     * Counts the approved purchase against the spending limit just before the page is asked; returns
     * why it may not go ahead.
     */
    countPurchase?: () => Promise<string | undefined>;
    /** Called when the counted purchase was clearly not pressed, so it no longer counts. */
    releasePurchase?: () => Promise<void>;
  } = {},
) {
  // Each saved login or card fill with its action, and whether the page was asked.
  const fills: Array<{ index: number; typed: () => Promise<void> }> = [];
  let asked = false;
  try {
    const actions: BrowserActStep[] = [];
    // The code this batch types, with the action that types it.
    let codeTyped:
      | {
          index: number;
          claim: () => Promise<string | undefined>;
          restore: () => Promise<void>;
        }
      | undefined;
    // Resolve every saved login and card before acting, so a missing one cannot leave a
    // half-filled form.
    for (const step of parseBrowserActions(args.actions)) {
      if (step.kind === "upload") {
        const resolve = options.resolveUploadPath ?? ((path: string) => path);
        let paths: string[];
        try {
          paths = step.paths.map(resolve);
        } catch (error) {
          // A path outside the bot's folder is the call's mistake, settled before anything runs.
          throw new BrowserToolInputError(error instanceof Error ? error.message : String(error));
        }
        actions.push({
          ...step,
          paths,
          ...(options.uploadRoots ? { roots: options.uploadRoots } : {}),
        });
        continue;
      }
      if (step.kind === "fill_pay_token") {
        let resolved: Awaited<ReturnType<ResolvePayTokenFill>>;
        try {
          resolved = options.resolvePayTokenFill
            ? await options.resolvePayTokenFill(step)
            : { error: "Pay tokens are unavailable here." };
        } catch (error) {
          context.signal.throwIfAborted();
          getLogger().warn("purchase pay token could not be loaded for a fill", {
            errorName: error instanceof Error ? error.name : typeof error,
          });
          return { ...refusedInput("This pay token could not be loaded."), completed: 0 };
        }
        if ("error" in resolved) return { ...refusedInput(resolved.error), completed: 0 };
        const { text, origin, merchantAccountId } = resolved;
        actions.push({ kind: "pay_token", text, origin, merchantAccountId });
        continue;
      }
      if (step.kind === "fill_code") {
        // One code is one fill: a second in the same batch would only be a replay.
        if (codeTyped) throw new BrowserToolInputError("browser_act takes one fill_code at a time");
        let resolved: Awaited<ReturnType<ResolveCodeFill>>;
        try {
          resolved = options.resolveCodeFill
            ? await options.resolveCodeFill(step, actions.length)
            : { error: "Codes are unavailable here." };
        } catch (error) {
          context.signal.throwIfAborted();
          getLogger().warn("one-time code could not be loaded for a fill", {
            errorName: error instanceof Error ? error.name : typeof error,
          });
          return { ...refusedInput("This code could not be loaded."), completed: 0 };
        }
        if ("error" in resolved) return { ...refusedInput(resolved.error), completed: 0 };
        const { claim, restore, typed } = resolved;
        codeTyped = { index: actions.length, claim, restore };
        if (typed) fills.push({ index: actions.length, typed });
        actions.push({
          kind: "fill",
          ref: step.ref,
          text: resolved.text,
          origin: resolved.origin,
          field: "code",
        });
        continue;
      }
      if (step.kind !== "fill_secret" && step.kind !== "fill_card") {
        actions.push(step);
        continue;
      }
      const card = step.kind === "fill_card";
      let resolved:
        | { text: string; origin: string; hidden?: boolean; typed?: () => Promise<void> }
        | { error: string };
      try {
        resolved = card
          ? options.resolveCardFill
            ? await options.resolveCardFill(step)
            : { error: "Card fills are unavailable here." }
          : options.resolveSecretFill
            ? await options.resolveSecretFill(step, actions.length)
            : { error: "Saved logins are unavailable here." };
      } catch (error) {
        context.signal.throwIfAborted();
        // A stored login or card that can't be read may quote its own text in the error, so
        // neither the bot nor the log gets the message: only that it failed, and how.
        getLogger().warn(
          card
            ? "purchase card could not be loaded for a fill"
            : "saved login could not be loaded for a fill",
          { errorName: error instanceof Error ? error.name : typeof error },
        );
        return {
          ...refusedInput(
            card ? "This card could not be loaded." : "This saved login could not be loaded.",
          ),
          completed: 0,
        };
      }
      if ("error" in resolved) return { ...refusedInput(resolved.error), completed: 0 };
      const { text, origin } = resolved;
      if (resolved.typed) fills.push({ index: actions.length, typed: resolved.typed });
      if (step.ref === undefined) {
        actions.push({ kind: "fill", text, origin, field: "card", cardField: step.field });
      } else {
        actions.push({
          kind: "fill",
          ref: step.ref,
          text,
          origin,
          // Every page browser, older computer images included, types "password" only into a
          // password field and "username" into a text, email or telephone field.
          field: card ? "card" : resolved.hidden === false ? "username" : "password",
        });
      }
    }
    const approved = options.approvedPurchase;
    // A card for a page that could not be checked names no click: it covers each one, and the page
    // browser still refuses any click it then finds buying on a known site.
    const approvedSteps =
      approved && !approved.site && !approved.steps.length
        ? actions.flatMap((step, index) => (step.kind === "click" ? [index] : []))
        : (approved?.steps ?? []);
    for (const index of approvedSteps) {
      const step = actions[index];
      if (step?.kind === "click" && approved) {
        const { site, label, amount } = approved;
        actions[index] = {
          ...step,
          approved: true,
          site,
          label,
          amount,
          total: approved.total ?? "",
        };
      }
    }
    if (approved) {
      const refused = await options.countPurchase?.();
      if (refused) return { ...refusedInput(refused), completed: 0 };
    }
    // Taken just before the page is asked, by one call only, so two fills never both type it.
    let refusedCode: string | undefined;
    try {
      refusedCode = await codeTyped?.claim();
    } catch (error) {
      // The page was never asked, so the purchase counted above did not go through.
      if (approved) await options.releasePurchase?.();
      throw error;
    }
    if (refusedCode) {
      if (approved) await options.releasePurchase?.();
      return { ...refusedInput(refusedCode), completed: 0 };
    }
    asked = true;
    const result = await browser.act(
      computer,
      { actions, downloads: options.downloads?.folder, signal: context.signal },
      context,
    );
    // Only fills the page may have typed: one it clearly never reached left nothing.
    for (const fill of fills)
      if (result.uncertain !== false || result.completed > fill.index) await fill.typed();
    // A purchase the page refused (it changed, or another step failed first) never went through.
    if (
      approvedSteps.length &&
      result.uncertain === false &&
      result.completed <= Math.min(...approvedSteps)
    ) {
      await options.releasePurchase?.();
    }
    // A code the page took is spent. One it clearly refused goes back, so a fill on the right page
    // can use it; any doubt about the outcome keeps it spent, never typed twice.
    if (codeTyped && result.uncertain === false && result.completed <= codeTyped.index) {
      await codeTyped.restore().catch((error: unknown) =>
        getLogger().warn("one-time code could not be restored", {
          errorName: error instanceof Error ? error.name : typeof error,
        }),
      );
    }
    return redactBrowserResult(
      formatBrowserResult(withBotPaths(result, options), options),
      options.redactions?.() ?? [],
    );
  } catch (error) {
    // Asked with no answer, the page may have typed any of them.
    if (asked) for (const fill of fills) await fill.typed().catch(() => undefined);
    context.signal.throwIfAborted();
    if (error instanceof BrowserToolInputError)
      return { ...refusedInput(error.message), completed: 0 };
    return formatBrowserResult(
      {
        ok: false,
        uncertain: true,
        error: error instanceof Error ? error.message : String(error),
        fallback: "computer_act",
      },
      options,
    );
  }
}

export function parseBrowserActions(value: unknown): BrowserActInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BrowserToolInputError("browser_act requires at least one action");
  }
  if (value.length > MAX_ACTIONS_PER_CALL) {
    throw new BrowserToolInputError(
      `browser_act accepts at most ${MAX_ACTIONS_PER_CALL} actions but got ${value.length}; none ran. Send the first ${MAX_ACTIONS_PER_CALL} or fewer now, then the rest in a separate call.`,
    );
  }
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object") {
      throw new BrowserToolInputError(`browser_act action ${index} must be an object`);
    }
    const action = raw as Record<string, unknown>;
    const kind = String(action.kind ?? "") as (typeof BROWSER_ACT_KINDS)[number];
    if (!(BROWSER_ACT_KINDS as readonly string[]).includes(kind)) {
      throw new BrowserToolInputError(
        `browser_act action ${index} needs kind: ${BROWSER_ACT_KINDS.join(", ")}`,
      );
    }
    const ref = String(action.ref ?? "").trim();
    if (kind === "fill_pay_token") {
      const purchase = String(action.purchase ?? "").trim();
      if (!purchase)
        throw new BrowserToolInputError(
          "browser_act fill_pay_token needs purchase: the id of an approved purchase",
        );
      return { kind, purchase };
    }
    if (kind === "fill_card") {
      const purchase = String(action.purchase ?? "").trim();
      const card = typeof action.card === "string" ? action.card.trim() : "";
      const field = action.field;
      if (!purchase === !card)
        throw new BrowserToolInputError(
          "browser_act fill_card needs purchase: the id of an approved purchase, or card: the name of a saved card",
        );
      if (!(PURCHASE_CARD_FIELDS as readonly unknown[]).includes(field)) {
        throw new BrowserToolInputError(
          `browser_act fill_card needs field: ${PURCHASE_CARD_FIELDS.map((name) => `"${name}"`).join(", ")}`,
        );
      }
      const step = { kind, ...(ref ? { ref } : {}), field: field as PurchaseCardField };
      return purchase ? { ...step, purchase } : { ...step, card, site: cardFillSite(action.site) };
    }
    if (!ref) throw new BrowserToolInputError(`browser_act action ${index} requires ref`);
    if (kind === "fill_code") {
      const secret = typeof action.secret === "string" ? action.secret.trim() : "";
      return secret ? { kind, ref, secret } : { kind, ref };
    }
    if (kind === "upload") {
      const paths = Array.isArray(action.paths)
        ? action.paths.map((path) => (typeof path === "string" ? path.trim() : ""))
        : [];
      if (paths.length === 0 || paths.some((path) => !path)) {
        throw new BrowserToolInputError(
          "browser_act upload requires paths: one or more file paths",
        );
      }
      if (paths.length > MAX_BROWSER_UPLOAD_FILES) {
        throw new BrowserToolInputError(
          `browser_act upload accepts at most ${MAX_BROWSER_UPLOAD_FILES} files`,
        );
      }
      return { kind, ref, paths };
    }
    if (kind === "fill_secret") {
      const secret = String(action.secret ?? "").trim();
      const field = typeof action.field === "string" ? action.field.trim() : "";
      if (!secret)
        throw new BrowserToolInputError(
          "browser_act fill_secret needs secret: the name of a login saved with request_secret",
        );
      if (!field) {
        throw new BrowserToolInputError(
          "browser_act fill_secret needs field: the label of one of the login's fields",
        );
      }
      return { kind, ref, secret, field };
    }
    if (kind === "fill" || kind === "type") {
      if (typeof action.text !== "string") {
        throw new BrowserToolInputError(
          action.secret === undefined && action.field === undefined
            ? `browser_act ${kind} requires text`
            : `browser_act ${kind} requires text; for a saved login use kind "fill_secret"`,
        );
      }
      return { kind, ref, text: String(action.text) };
    }
    return { kind, ref };
  });
}

/**
 * Page tool results with the run's secrets taken out. A snapshot writes control names and values as
 * quoted strings, so a secret with a quote, a backslash or a line break reads differently there:
 * hide it in that form too.
 */
export function redactBrowserResult<T>(result: T, secrets: string[]): unknown {
  const forms = secrets.flatMap((secret) => {
    const quoted = JSON.stringify(secret).slice(1, -1);
    return quoted === secret ? [secret] : [secret, quoted];
  });
  return redactConnectorPayload(result, forms);
}

/**
 * A page tool result as the model reads it. The snapshot tree already lists every control with its
 * ref and its notices (what was cut), so the `elements` array only repeats it: it stays in `details`
 * and out of the text, which keeps a page under the limit that would otherwise cut the tree's middle.
 * A page from an older computer image, whose tree is not sized for that, is sent as it is.
 */
export function browserResultForModel<T>(result: T): T | AgentToolExecutionResult {
  if (!result || typeof result !== "object") return result;
  const { elements, ...view } = result as { elements?: unknown; tree?: unknown };
  if (!Array.isArray(elements) || typeof view.tree !== "string") return result;
  const text = JSON.stringify(view);
  if (text.length > TOOL_RESULT_TEXT_LIMIT) return result;
  return { kind: "agent_tool_result", content: [{ type: "text", text }], details: result };
}

function withBotPaths<T extends { downloads?: BrowserDownload[] }>(
  result: T,
  { downloads }: PageToolOptions,
): T {
  if (!downloads || !Array.isArray(result.downloads)) return result;
  return {
    ...result,
    downloads: result.downloads.map((file) =>
      typeof file.path === "string" ? { ...file, path: downloads.botPath(file.path) } : file,
    ),
  };
}

function formatBrowserResult<
  T extends { fallback?: "computer_act"; error?: string; dialog?: string },
>(result: T, { desktopTools = true }: PageToolOptions) {
  if (result.fallback !== "computer_act") return result;
  // A confirm, prompt or "Leave site?" dialog asks something; page tools never answer it.
  if (result.dialog) {
    if (desktopTools) {
      return {
        ...result,
        note: "Answer it with computer_act, or request_takeover if the user should decide. Do not repeat the step that opened it.",
      };
    }
    const { fallback: _fallback, ...rest } = result;
    return {
      ...rest,
      note: "Use request_takeover so the user can answer it. Do not repeat the step that opened it.",
    };
  }
  if (desktopTools) {
    return {
      ...result,
      note: "Page browser could not complete this step. Inspect the current state before continuing with computer_act if available, otherwise request_takeover. Do not replay completed or uncertain actions.",
    };
  }
  // Without desktop tools, pointing at computer_act leaves only request_takeover. A browser
  // that is still starting after the computer woke up usually answers a moment later.
  const { fallback: _fallback, ...rest } = result;
  return {
    ...rest,
    note: "Page browser could not complete this step. The computer or its browser may still be starting, so call browser_snapshot again to check the page. Use request_takeover only if it keeps failing. Do not replay completed or uncertain actions.",
  };
}
