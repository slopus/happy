import { readFileSync } from "node:fs";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { browserResultForModel } from "./browser-tools.js";
import { serializeToolResult } from "./pi-runtime-tools.js";

type Secrets = {
  fill: (value: string, origin: string, field: string) => unknown;
  focusedFrame: () => unknown;
  findCard: (token: string) => number;
  focusCard: () => boolean;
  cardTyped: (length: number) => boolean;
  payTokenAccount: () => string | null;
  setPayToken: (token: string) => boolean;
};

/** The saved-login, card and pay-token script page_secrets runs in a frame's isolated world. */
function installSecrets(html: string, url = "https://portal.example.test/") {
  const source = readFileSync(
    new URL("../../../infra/sandboxes/computer/page_secrets.py", import.meta.url),
    "utf8",
  );
  const match = source.match(/EVAL_HELPERS = r"""\n([\s\S]*?)\n"""/);
  if (!match?.[1]) throw new Error("page secrets script was not found");
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url,
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  const win = dom.window;
  // jsdom has no layout: every element is a 10 px square.
  (win.Element.prototype as unknown as { getBoundingClientRect: unknown }).getBoundingClientRect =
    () => ({ width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10, x: 0, y: 0 });
  vm.runInContext(match[1], dom.getInternalVMContext());
  const secrets = (win as unknown as { __rakazoPageBrowser: Secrets }).__rakazoPageBrowser;
  const field = (label: string) =>
    win.document.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
  return { win, secrets, field };
}

describe("saved logins and cards in the focused field", () => {
  const origin = "https://portal.example.test";
  const form = `<input aria-label="Email" type="email" /><input aria-label="Password" type="password" />
    <input aria-label="Notes" type="text" /><select aria-label="Plan"><option>Free</option></select>
    <textarea aria-label="Bio"></textarea>`;

  it("types a saved password only into a password field on its own HTTPS site", () => {
    const { secrets, field } = installSecrets(form);
    const fill = (label: string, value: string, site: string, kind: string) => {
      field(label).focus();
      return () => secrets.fill(value, site, kind);
    };
    expect(fill("Notes", "fake-password", origin, "password")).toThrow(
      /Refused: A saved password can only be typed into a password field/,
    );
    expect(fill("Plan", "fake-user", origin, "username")).toThrow(
      /Refused: A saved username can only be typed into a text, email, or telephone field/,
    );
    expect(fill("Bio", "fake-user", origin, "username")).toThrow(/Refused: A saved username/);
    expect(fill("Plan", "4242", origin, "card")).toThrow(
      /Refused: A card can only be typed into a card field/,
    );
    expect(fill("Password", "fake-password", "https://other.example.test", "password")).toThrow(
      /Refused: This login is saved for https:\/\/other\.example\.test; the page is on https:\/\/portal\.example\.test\./,
    );
    expect(fill("Password", "fake-password", "http://portal.example.test", "password")).toThrow(
      /Refused: Website logins can only be filled on HTTPS/,
    );
    expect(field("Password").value).toBe("");
    fill("Password", "fake-password", origin, "password")();
    expect(field("Password").value).toBe("fake-password");
    expect(field("Password").hasAttribute("data-rakazo-filled")).toBe(true);
  });

  it("refuses when nothing has focus, so a secret never lands elsewhere", () => {
    const { secrets, field } = installSecrets(form);
    expect(() => secrets.fill("fake-password", origin, "password")).toThrow(
      /Refused: The field did not keep focus/,
    );
    expect(field("Password").value).toBe("");
  });

  it("clears a login the field did not take whole", () => {
    const { secrets, field } = installSecrets(`<input aria-label="Code" maxlength="3" />`);
    Object.defineProperty(field("Code"), "value", {
      get: () => "fak",
      set: () => {},
      configurable: true,
    });
    field("Code").focus();
    expect(() => secrets.fill("fake-user", origin, "username")).toThrow(
      /Refused: This field didn't accept the saved login, so it was cleared/,
    );
  });

  it("focuses the one card field for a detail and marks it for snapshots", () => {
    const { secrets, field } = installSecrets(
      `<input aria-label="Card" autocomplete="cc-number" /><input aria-label="Other" autocomplete="name" />`,
      "https://shop.example.test/",
    );
    expect(secrets.findCard("cc-number")).toBe(1);
    expect(secrets.focusCard()).toBe(true);
    expect(field("Card").hasAttribute("data-rakazo-filled")).toBe(true);
    field("Card").value = "4242 4242";
    expect(secrets.cardTyped(8)).toBe(true);
    expect(secrets.findCard("cc-csc")).toBe(0);
  });

  it("names the merchant account of a pay token block and hands the token to it", () => {
    const { secrets, win } = installSecrets(
      `<div class="AiAgentPaymentSteering" data-stripe-merchant-account="acct_fake123">
        <input name="link_pay_token" /></div>`,
      "https://shop.example.test/",
    );
    expect(secrets.payTokenAccount()).toBe("acct_fake123");
    expect(secrets.setPayToken("lpt_fake")).toBe(true);
    expect((win.document.querySelector("input") as HTMLInputElement).value).toBe("lpt_fake");
  });

  it("points to the frame element holding focus, and to nothing when a field holds it", () => {
    const { secrets, win, field } = installSecrets(`${form}<iframe title="Login"></iframe>`);
    win.document.querySelector("iframe")!.focus();
    expect(secrets.focusedFrame()).toBe(win.document.querySelector("iframe"));
    field("Email").focus();
    expect(secrets.focusedFrame()).toBeNull();
  });
});

describe("what the model reads of a dense page", () => {
  /** The page tool result as the model's text carries it, and whether the shortener would touch it. */
  const asRead = (tree: string, elements: unknown[]) => {
    const result = {
      ok: true,
      url: "https://portal.example.test/",
      title: "Portal",
      completed: 1,
      tree,
      elements,
    };
    const view = browserResultForModel(result) as {
      content: Array<{ text: string }>;
      details: unknown;
    };
    return {
      text: view.content[0]!.text,
      details: view.details,
      result,
      full: serializeToolResult(result, undefined, "browser_snapshot", {}),
    };
  };
  // A tree at the page browser's budget: 10,000 characters as sent, with notices first.
  const elements = Array.from({ length: 80 }, (_, i) => ({
    ref: `e${i + 1}`,
    role: "button",
    name: `פעולה מספר ${i}`,
  }));
  const controls = elements.map((el) => `- button "${el.name}" [ref=${el.ref}]`).join("\n");
  const notices =
    "[controls: showing 80 of 150]\n[page text: showing first 4000 of 9000 characters]\n";
  const tree = `${notices}${"שורה של טבלת תשואות ".repeat(400).slice(0, 10_000 - notices.length - controls.length - 1)}\n${controls}`;

  it("keeps the notices, the controls and the page in one piece under the limit", () => {
    const { text, details, result, full } = asRead(tree, elements);
    expect(text.length).toBeLessThanOrEqual(12_000);
    // Sent whole, the same page is over the limit and the generic shortener cuts the middle of its tree.
    expect(JSON.stringify(result).length).toBeGreaterThan(12_000);
    expect(full).toContain("omitted evidence is unavailable");
    expect(text).not.toContain("omitted evidence");
    const read = (JSON.parse(text) as { tree: string }).tree;
    expect(read.startsWith(notices)).toBe(true);
    for (const element of elements) expect(read).toContain(`[ref=${element.ref}]`);
    // The elements are not sent twice; they stay in the details.
    expect(text).not.toContain('"elements"');
    expect(details).toBe(result);
  });

  it("sends a page as it is when it is larger than the limit anyway (an older computer image)", () => {
    const result = { ok: true, url: "u", title: "t", tree: "x".repeat(13_000), elements: [] };
    expect(browserResultForModel(result)).toBe(result);
    expect(browserResultForModel({ error: "boom" })).toEqual({ error: "boom" });
  });
});
