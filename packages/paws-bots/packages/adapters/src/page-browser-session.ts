import type {
  BrowserActResult,
  BrowserActStep,
  BrowserNavigateResult,
  BrowserSnapshotNode,
  BrowserSnapshotResult,
} from "@rakazo/adapter-kit";
import type { PurchaseCardField } from "@rakazo/contracts";
import { JSDOM } from "jsdom";

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "[role='button']",
  "[role='link']",
  "[role='textbox']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='combobox']",
  "[role='menuitem']",
  "[contenteditable='true']",
].join(",");

const REOPEN_SAVED_SITE = "Open the saved site with browser_navigate, then fill again.";
const REOPEN_MERCHANT_SITE = "Open the merchant's checkout with browser_navigate, then fill again.";
const CARD_FIELD_MISSING =
  "No field for this card detail was found on the page. Pass its ref from browser_snapshot.";
const CARD_FIELD_AMBIGUOUS =
  "More than one field on the page takes this card detail. Pass its ref from browser_snapshot.";

const PAY_TOKEN_MISSING =
  "This checkout has no pay token field for this purchase's merchant. Take a fresh snapshot.";

/** Saved usernames are typed only into these input types. Textareas stay out: a username is an input. */
const USERNAME_INPUT_TYPES = new Set(["text", "email", "tel"]);

/** Card details are typed only into these; the CVC field is often a password input. */
const CARD_INPUT_TYPES = new Set(["text", "tel", "password"]);

const CARD_AUTOCOMPLETE: Record<PurchaseCardField, string> = {
  number: "cc-number",
  expiry: "cc-exp",
  cvc: "cc-csc",
  postal_code: "postal-code",
};

/** A saved-login or card fill declined before the page changed; reported as settled, not uncertain. */
class FillRefused extends Error {}

/** A step the page cannot take as asked, such as an option the dropdown does not have. */
class SettledStep extends Error {}

type DomWindow = JSDOM["window"];
type DomElement = InstanceType<DomWindow["Element"]>;

/** In-process page session used by fake/emulator browser adapters (offline). */
export class PageBrowserSession {
  private dom: JSDOM;
  private refs = new Map<string, DomElement>();
  /** Fields holding a saved login or card detail; snapshots never report their values. */
  private loginFilled = new WeakSet<DomElement>();
  private nextRef = 1;

  constructor(
    url = "about:blank",
    html = "<!doctype html><html><head><title></title></head><body></body></html>",
  ) {
    this.dom = new JSDOM(html, { url, contentType: "text/html", pretendToBeVisual: true });
  }

  close(): void {
    this.dom.window.close();
    this.refs.clear();
  }

  get url(): string {
    return this.dom.window.location.href;
  }

  get title(): string {
    return this.dom.window.document.title || "";
  }

  load(url: string, html: string): BrowserNavigateResult {
    this.dom.window.close();
    this.dom = new JSDOM(html, { url, contentType: "text/html", pretendToBeVisual: true });
    this.refs.clear();
    return { url: this.url, title: this.title };
  }

  snapshot(): BrowserSnapshotResult {
    const { elements, tree } = this.buildSnapshot();
    const account = payTokenAccount(this.dom.window);
    return {
      url: this.url,
      title: this.title,
      tree: account ? `${tree}\n${payTokenHint(account)}` : tree,
      elements,
    };
  }

  act(actions: BrowserActStep[]): BrowserActResult {
    let completed = 0;
    for (const action of actions) {
      const el = action.ref === undefined ? undefined : this.refs.get(action.ref);
      if (action.ref !== undefined && !el) {
        const snap = this.snapshot();
        return {
          ok: false,
          completed,
          url: snap.url,
          title: snap.title,
          tree: snap.tree,
          elements: snap.elements,
          error: `Stale element ref "${action.ref}": the page has changed since that snapshot. Use a ref from the page below.`,
          uncertain: false,
        };
      }
      try {
        if (action.kind === "pay_token") this.fillPayToken(action);
        else {
          if (action.kind === "fill" || action.kind === "type") this.checkFillOrigin(action);
          this.applyAction(el ?? this.cardField(action), action);
        }
      } catch (error) {
        const snap = this.snapshot();
        return {
          ok: false,
          completed,
          url: snap.url,
          title: snap.title,
          tree: snap.tree,
          elements: snap.elements,
          error: error instanceof Error ? error.message : String(error),
          ...(error instanceof FillRefused || error instanceof SettledStep
            ? { uncertain: false }
            : { fallback: "computer_act" as const }),
        };
      }
      completed += 1;
    }
    const snap = this.snapshot();
    return {
      ok: true,
      completed,
      url: snap.url,
      title: snap.title,
      tree: snap.tree,
      elements: snap.elements,
    };
  }

  private fillPayToken(action: Extract<BrowserActStep, { kind: "pay_token" }>): void {
    this.checkFillOrigin({ ...action, field: "card" });
    const win = this.dom.window;
    if (payTokenAccount(win) !== action.merchantAccountId) throw new FillRefused(PAY_TOKEN_MISSING);
    const input = win.document.querySelector(PAY_TOKEN_INPUT);
    if (!(input instanceof win.HTMLInputElement)) throw new FillRefused(PAY_TOKEN_MISSING);
    this.loginFilled.add(input);
    input.value = action.text;
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
  }

  private checkFillOrigin(action: { origin?: string; field?: string }): void {
    const card = action.field === "card";
    if (!action.origin && !card) return;
    const page = new URL(this.url);
    const notHttps = card
      ? `A card can only be filled on HTTPS. ${REOPEN_MERCHANT_SITE}`
      : `Website logins can only be filled on HTTPS. ${REOPEN_SAVED_SITE}`;
    let saved: URL;
    try {
      saved = new URL(action.origin ?? "");
    } catch {
      throw new FillRefused(notHttps);
    }
    // Private-LAN HTTP never qualifies, even when the page origin matches.
    if (saved.protocol !== "https:" || page.protocol !== "https:") {
      throw new FillRefused(notHttps);
    }
    if (page.origin !== saved.origin) {
      throw new FillRefused(
        card
          ? `The page is not on the merchant's site for this purchase. ${REOPEN_MERCHANT_SITE}`
          : `This login is saved for ${saved.origin}; the page is on ${page.origin}. ${REOPEN_SAVED_SITE}`,
      );
    }
  }

  private cardField(action: BrowserActStep): DomElement {
    if (!("cardField" in action)) throw new Error("Element ref is required");
    const win = this.dom.window;
    const token = CARD_AUTOCOMPLETE[action.cardField];
    const matches = [...win.document.querySelectorAll("input")].filter(
      (input) =>
        CARD_INPUT_TYPES.has(input.type) &&
        !input.disabled &&
        !input.readOnly &&
        !isIgnored(win, input) &&
        (input.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/).includes(token),
    );
    if (matches.length === 0) throw new FillRefused(CARD_FIELD_MISSING);
    if (matches.length > 1) throw new FillRefused(CARD_FIELD_AMBIGUOUS);
    return matches[0]!;
  }

  private applyAction(el: DomElement, action: BrowserActStep): void {
    const win = this.dom.window;
    if (action.kind === "upload") {
      if (!(el instanceof win.HTMLInputElement) || el.type !== "file") {
        throw new Error("upload needs a file upload element from browser_snapshot");
      }
      if (action.paths.length > 1 && !el.multiple) {
        throw new Error("This file upload accepts one file");
      }
      // jsdom cannot build a FileList, so page handlers get named, empty files instead.
      const files = action.paths.map((path) => new win.File([], path.split("/").pop() ?? path));
      Object.defineProperty(el, "files", { configurable: true, value: files });
      el.dispatchEvent(new win.Event("input", { bubbles: true }));
      el.dispatchEvent(new win.Event("change", { bubbles: true }));
      return;
    }
    if (action.kind === "click") {
      if (el instanceof win.HTMLAnchorElement && el.href) {
        const next = new URL(el.href, this.url);
        if (next.href !== this.url) {
          // jsdom does not load a new document on location changes. Fall back so
          // callers use computer_act on the live browser instead of a false success.
          throw new Error(
            "In-process page browser cannot navigate links. Use computer_act on the desktop browser.",
          );
        }
      }
      el.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
      // Checkboxes toggle via jsdom activation behavior. Force radios on; do not
      // invert checkboxes after dispatchEvent (that would undo the activation).
      if (el instanceof win.HTMLInputElement && el.type === "radio") {
        el.checked = true;
      }
      return;
    }
    if (action.kind === "fill" || action.kind === "type") {
      const card = action.field === "card";
      if (action.origin || card) {
        const inputType = el instanceof win.HTMLInputElement ? el.type : "";
        if (card) {
          if (!CARD_INPUT_TYPES.has(inputType)) {
            throw new FillRefused("A card can only be typed into a card field.");
          }
        } else if (action.field === "code") {
          if (!USERNAME_INPUT_TYPES.has(inputType)) {
            throw new FillRefused(
              "A code can only be typed into a text, email, or telephone field.",
            );
          }
        } else if (action.field !== "username" && inputType !== "password") {
          // A password goes only into a password field, which never displays it.
          throw new FillRefused("A saved password can only be typed into a password field.");
        }
        if (action.field === "username" && !USERNAME_INPUT_TYPES.has(inputType)) {
          throw new FillRefused(
            "A saved username can only be typed into a text, email, or telephone field.",
          );
        }
      }
      const text = action.text;
      const formField = el instanceof win.HTMLInputElement || el instanceof win.HTMLTextAreaElement;
      if (formField) {
        // Fill and type both replace the field, and with it any saved login.
        if (action.origin) this.loginFilled.add(el);
        else this.loginFilled.delete(el);
        el.value = text;
        // A partly accepted login or card is not left on the page, as in the live helper.
        if (action.origin && el.value !== text) {
          el.value = "";
          throw new FillRefused(
            card
              ? "This field didn't accept the card, so it was cleared."
              : "This field didn't accept the saved login, so it was cleared.",
          );
        }
        el.dispatchEvent(new win.Event("input", { bubbles: true }));
        el.dispatchEvent(new win.Event("change", { bubbles: true }));
        return;
      }
      if (el instanceof win.HTMLSelectElement) {
        const norm = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
        const options = [...el.options];
        const match =
          options.find((o) => o.value === text) ??
          options.find((o) => optionLabel(o) === text) ??
          options.find((o) => norm(optionLabel(o)) === norm(text) || norm(o.value) === norm(text));
        if (!match) {
          throw new SettledStep(
            `This dropdown has no option "${text}". Its options: ${describeOptions(optionsOf(el, win))}.`,
          );
        }
        if (unavailable(win, match)) {
          throw new SettledStep(
            `The option "${optionLabel(match)}" is disabled. Its options: ${describeOptions(optionsOf(el, win))}.`,
          );
        }
        // The old choice goes: a multiple select would keep it otherwise.
        for (const option of options) option.selected = false;
        match.selected = true;
        el.dispatchEvent(new win.Event("input", { bubbles: true }));
        el.dispatchEvent(new win.Event("change", { bubbles: true }));
        return;
      }
      if (el.getAttribute("contenteditable") === "true") {
        el.textContent = text;
        el.dispatchEvent(new win.Event("input", { bubbles: true }));
        return;
      }
      throw new Error(`Ref ${action.ref} is not fillable`);
    }
    throw new Error(`Unsupported browser action ${action.kind}`);
  }

  private buildSnapshot(): { elements: BrowserSnapshotNode[]; tree: string } {
    this.refs.clear();
    const win = this.dom.window;
    const elements: BrowserSnapshotNode[] = [];
    const lines: string[] = [];
    const nodes = win.document.querySelectorAll(INTERACTIVE_SELECTOR);
    for (const node of nodes) {
      if (!(node instanceof win.Element)) continue;
      if (isIgnored(win, node)) continue;
      const ref = `e${this.nextRef++}`;
      this.refs.set(ref, node);
      const role = roleFor(win, node);
      const name = nameFor(win, node);
      const value = this.loginFilled.has(node) ? undefined : valueFor(win, node);
      const tag = node.tagName.toLowerCase();
      const entry: BrowserSnapshotNode = { ref, role, name, tag };
      if (value !== undefined) entry.value = value;
      if (node instanceof win.HTMLSelectElement) entry.options = optionsOf(node, win);
      elements.push(entry);
      const valuePart = value !== undefined ? ` value=${JSON.stringify(value)}` : "";
      const optionsPart = entry.options ? ` options: ${describeOptions(entry.options)}` : "";
      lines.push(`- ${role} ${JSON.stringify(name)} [${ref}]${valuePart}${optionsPart}`);
    }
    return { elements, tree: lines.join("\n") || "(no interactive elements)" };
  }
}

const PAY_TOKEN_INPUT = '.AiAgentPaymentSteering input[name="link_pay_token"]';

function payTokenAccount(win: DomWindow): string | null {
  const blocks = [...win.document.querySelectorAll(".AiAgentPaymentSteering")].filter((block) =>
    block.querySelector('input[name="link_pay_token"]'),
  );
  if (blocks.length !== 1) return null;
  const block = blocks[0]!;
  const holder = block.matches("[data-stripe-merchant-account]")
    ? block
    : block.querySelector("[data-stripe-merchant-account]");
  const account = holder?.getAttribute("data-stripe-merchant-account") ?? "";
  return /^acct_[A-Za-z0-9]{1,64}$/.test(account) ? account : null;
}

function payTokenHint(account: string): string {
  return `This checkout accepts a pay token: merchantAccountId "${account}".`;
}

function isIgnored(win: DomWindow, el: DomElement): boolean {
  if (el instanceof win.HTMLInputElement && el.type === "hidden") return true;
  // Sites often aria-hide the real file input behind a styled button; it is still the upload target.
  if (el.getAttribute("aria-hidden") === "true")
    return !(el instanceof win.HTMLInputElement && el.type === "file");
  return false;
}

function optionLabel(option: { label: string; text: string }): string {
  return (option.label || option.text).replace(/\s+/g, " ").trim();
}

/** An option is out of reach when it, or the group it is in, is disabled. */
function unavailable(win: DomWindow, option: HTMLOptionElement): boolean {
  const group = option.parentElement;
  return option.disabled || (group instanceof win.HTMLOptGroupElement && group.disabled);
}

function optionsOf(select: { options: Iterable<HTMLOptionElement> }, win: DomWindow) {
  return [...select.options].map((option) => ({
    label: optionLabel(option),
    value: option.value,
    ...(option.selected ? { selected: true } : {}),
    ...(unavailable(win, option) ? { disabled: true } : {}),
  }));
}

function describeOptions(options: NonNullable<BrowserSnapshotNode["options"]>): string {
  return options
    .map(
      (option) =>
        JSON.stringify(option.label) +
        (option.value !== option.label ? `=${JSON.stringify(option.value)}` : "") +
        (option.selected ? " (selected)" : "") +
        (option.disabled ? " (disabled)" : ""),
    )
    .join(", ");
}

function roleFor(win: DomWindow, el: DomElement): string {
  if (el instanceof win.HTMLInputElement && el.type === "file") return "file upload";
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button") return "button";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "summary") return "button";
  if (tag === "input" && el instanceof win.HTMLInputElement) {
    const type = (el.type || "text").toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "submit" || type === "button" || type === "reset") return "button";
    return "textbox";
  }
  return tag;
}

function nameFor(win: DomWindow, el: DomElement): string {
  const root = el.getRootNode();
  const labelledBy = (el.getAttribute("aria-labelledby") ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((id) =>
      root instanceof win.Document || root instanceof win.ShadowRoot
        ? (root.getElementById(id)?.textContent ?? "")
        : "",
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (labelledBy) return labelledBy;
  const aria = el.getAttribute("aria-label")?.trim();
  if (aria) return aria;
  if (el instanceof win.HTMLInputElement || el instanceof win.HTMLTextAreaElement) {
    const label = el.labels?.[0]?.textContent?.trim();
    if (label) return label;
    if (el.placeholder?.trim()) return el.placeholder.trim();
    if (el.name?.trim()) return el.name.trim();
  }
  const text = el.textContent?.replace(/\s+/g, " ").trim();
  if (text) return text.slice(0, 120);
  return el.tagName.toLowerCase();
}

function valueFor(win: DomWindow, el: DomElement): string | undefined {
  if (el instanceof win.HTMLInputElement) {
    if (el.type === "checkbox" || el.type === "radio") return el.checked ? "checked" : "unchecked";
    if (el.type === "file") return Array.from(el.files ?? [], (file) => file.name).join(", ");
    if (el.type === "password") return el.value ? "••••" : "";
    return el.value;
  }
  if (el instanceof win.HTMLTextAreaElement || el instanceof win.HTMLSelectElement) return el.value;
  return undefined;
}

/**
 * In-process page sessions for fake/emulator providers.
 * Callers must pass an isolation key that includes bot identity on Team
 * Computers (see `pageBrowserSessionKey`), never the bare computer id alone.
 */
export class PageBrowserSessionStore {
  private readonly sessions = new Map<string, PageBrowserSession>();

  get(sessionKey: string): PageBrowserSession {
    let session = this.sessions.get(sessionKey);
    if (!session) {
      session = new PageBrowserSession();
      this.sessions.set(sessionKey, session);
    }
    return session;
  }

  clear(sessionKey?: string): void {
    if (sessionKey) {
      this.sessions.get(sessionKey)?.close();
      this.sessions.delete(sessionKey);
    } else {
      for (const session of this.sessions.values()) session.close();
      this.sessions.clear();
    }
  }
}

/**
 * Isolate page state per computer and running bot on Team Computers.
 * Prefer `context.botId` (the running bot). `computer.botId` is the home key and
 * is shared by every bot on a Team Computer, so it alone cannot isolate sessions.
 * Do not include screen-lease fences: the same bot reacquiring the computer must
 * keep the in-process page and element refs across renewals and takeover resumes.
 */
export function pageBrowserSessionKey(
  computer: { id: string; botId: string },
  context?: { botId?: string },
): string {
  const bot = context?.botId?.trim() || computer.botId;
  return `${computer.id}::${bot}`;
}
