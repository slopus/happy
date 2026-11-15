import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import * as Logging from "@rakazo/logging";
import { describe, expect, it, vi } from "vitest";
import type { CardFillStep } from "./browser-tools.js";
import {
  browserActFromTool,
  browserNavigateFromTool,
  browserSnapshotFromTool,
  parseBrowserActions,
} from "./browser-tools.js";
import { FakeBrowserProvider } from "./fake-browser.js";
import { PageBrowserSession } from "./page-browser-session.js";

const merchant = "https://shop.example.test";
const card = { number: "4242424242424242", expiry: "1234", cvc: "123", postal_code: "94110" };
const checkout = `<!doctype html><html><head><title>Checkout</title></head><body>
  <input aria-label="Card number" inputmode="numeric" />
  <input aria-label="Phone" type="tel" />
  <input aria-label="Security code" type="password" />
  <input aria-label="Email" type="email" />
  <input aria-label="Search" type="search" />
  <textarea aria-label="Notes"></textarea>
  <select aria-label="Country"><option>US</option></select>
  <div aria-label="Editor" contenteditable="true"></div>
</body></html>`;

function checkoutSession(url = `${merchant}/pay`) {
  const session = new PageBrowserSession(url, checkout);
  // Every snapshot hands out new refs, so a batch uses the refs of one.
  const refs = () => {
    const { elements } = session.snapshot();
    return (name: string) => elements.find((el) => el.name === name)!.ref;
  };
  return { session, ref: refs() };
}

const cardFill = (ref: string, text: string, origin = merchant) => ({
  kind: "fill" as const,
  ref,
  text,
  origin,
  field: "card" as const,
});

describe("in-process page browser card fill", () => {
  it("types card details on the merchant's HTTPS origin and keeps them out of snapshots", () => {
    const { session, ref } = checkoutSession();
    const result = session.act([
      cardFill(ref("Card number"), card.number),
      cardFill(ref("Phone"), card.number),
      cardFill(ref("Security code"), card.cvc),
    ]);
    expect(result).toMatchObject({ ok: true, completed: 3 });
    expect(JSON.stringify(result)).not.toContain(card.number);
    expect(JSON.stringify(session.snapshot())).not.toContain(card.number);
    expect(JSON.stringify(session.snapshot())).not.toContain(card.cvc);
  });

  it("refuses another site, plain HTTP, and fills without the merchant's origin", () => {
    for (const [url, origin, error] of [
      ["https://evil.example.test/pay", merchant, /not on the merchant's site/],
      ["https://shop.example.test.evil.test/pay", merchant, /not on the merchant's site/],
      ["http://shop.example.test/pay", "http://shop.example.test", /only be filled on HTTPS/],
      [`${merchant}/pay`, "", /only be filled on HTTPS/],
    ] as const) {
      const { session, ref } = checkoutSession(url);
      const result = session.act([
        { ...cardFill(ref("Card number"), card.number), origin: origin || undefined },
      ]);
      expect(result, url).toMatchObject({ ok: false, completed: 0, uncertain: false });
      expect(result, url).not.toHaveProperty("fallback");
      expect(result.error, url).toMatch(error);
      expect(result.error, url).not.toMatch(/login/);
      expect(JSON.stringify(result), url).not.toContain(card.number);
    }
  });

  it("types a card only into a text, telephone, or password input", () => {
    for (const name of ["Email", "Search", "Notes", "Country", "Editor"]) {
      const { session, ref } = checkoutSession();
      const result = session.act([cardFill(ref(name), card.number)]);
      expect(result, name).toMatchObject({
        ok: false,
        completed: 0,
        uncertain: false,
        error: "A card can only be typed into a card field.",
      });
      expect(JSON.stringify(result), name).not.toContain(card.number);
    }
  });

  it("finds a card field without a ref by its autocomplete token", () => {
    const session = new PageBrowserSession(
      `${merchant}/pay`,
      `<!doctype html><body>
        <input aria-label="Hidden number" autocomplete="cc-number" type="hidden" />
        <input aria-label="Autofill number" autocomplete="cc-number" aria-hidden="true" />
        <input aria-label="Card number" autocomplete="section-pay cc-number" />
        <input aria-label="Expiry" autocomplete="CC-EXP" type="tel" />
        <input aria-label="Postal code" autocomplete="billing postal-code" />
        <input aria-label="Email" autocomplete="cc-csc" type="email" />
      </body>`,
    );
    const fill = (cardField: "number" | "expiry" | "cvc" | "postal_code", text: string) =>
      session.act([{ kind: "fill", text, origin: merchant, field: "card", cardField }]);
    expect(fill("number", card.number)).toMatchObject({ ok: true, completed: 1 });
    expect(fill("expiry", card.expiry)).toMatchObject({ ok: true });
    expect(fill("postal_code", card.postal_code)).toMatchObject({ ok: true });
    const values = session.snapshot().elements.map((el) => [el.name, el.value]);
    expect(values).toContainEqual(["Card number", undefined]);
    expect(JSON.stringify(values)).not.toContain(card.number);
    expect(fill("cvc", card.cvc)).toMatchObject({
      ok: false,
      completed: 0,
      uncertain: false,
      error: expect.stringContaining("No field for this card detail"),
    });
  });

  it("refuses a card fill without a ref on another site or with two matching fields", () => {
    const twoNumbers = `<!doctype html><body>
      <input autocomplete="cc-number" /><input autocomplete="cc-number" /></body>`;
    for (const [url, error] of [
      ["https://evil.example.test/pay", /not on the merchant's site/],
      [`${merchant}/pay`, /More than one field/],
    ] as const) {
      const session = new PageBrowserSession(url, twoNumbers);
      const result = session.act([
        { kind: "fill", text: card.number, origin: merchant, field: "card", cardField: "number" },
      ]);
      expect(result, url).toMatchObject({ ok: false, completed: 0, uncertain: false });
      expect(result.error, url).toMatch(error);
      expect(JSON.stringify(session.snapshot())).not.toContain(card.number);
    }
  });

  it("forgets a field's card once the bot types over it", () => {
    const { session, ref } = checkoutSession();
    const filled = session.act([cardFill(ref("Card number"), card.number)]);
    const field = filled.elements!.find((el) => el.name === "Card number")!.ref;
    session.act([{ kind: "fill", ref: field, text: "visible" }]);
    expect(JSON.stringify(session.snapshot())).toContain("visible");
  });
});

describe("browser_act fill_card", () => {
  const context: AdapterContext = {
    operationId: "1",
    traceId: "1",
    spaceId: "w",
    userId: "u",
    signal: new AbortController().signal,
  };
  const computer: ComputerRef = { id: "c1", botId: "b1", kind: "fake", providerRef: "c1" };
  const url = `${merchant}/pay`;

  async function checkoutBrowser() {
    const browser = new FakeBrowserProvider({ pages: { [url]: { html: checkout } } });
    await browserNavigateFromTool(browser, computer, context, { url });
    const snap = (await browserSnapshotFromTool(browser, computer, context, {})) as {
      elements: Array<{ ref: string; name: string }>;
    };
    const ref = (name: string) => snap.elements.find((el) => el.name === name)!.ref;
    return { browser, ref };
  }
  const resolveCardFill = async (step: CardFillStep) => ({
    text: card[step.field],
    origin: merchant,
  });

  it("parses fill_card without a value, and without a ref", () => {
    expect(
      parseBrowserActions([
        { kind: "fill_card", ref: "e1", purchase: "p1", field: "cvc" },
        { kind: "fill_card", purchase: "p1", field: "expiry" },
        { kind: "fill_card", ref: " ", purchase: "p1", field: "postal_code" },
      ]),
    ).toEqual([
      { kind: "fill_card", ref: "e1", purchase: "p1", field: "cvc" },
      { kind: "fill_card", purchase: "p1", field: "expiry" },
      { kind: "fill_card", purchase: "p1", field: "postal_code" },
    ]);
  });

  it("asks the page browser to find a card field when no ref is given", async () => {
    const { browser } = await checkoutBrowser();
    const act = vi.spyOn(browser, "act");
    await browserActFromTool(
      browser,
      computer,
      context,
      { actions: [{ kind: "fill_card", purchase: "p1", field: "expiry" }] },
      { resolveCardFill },
    );
    expect(act.mock.calls[0]?.[1].actions).toEqual([
      { kind: "fill", text: card.expiry, origin: merchant, field: "card", cardField: "expiry" },
    ]);
  });

  it.each([
    [
      "a fill_card without its purchase",
      { kind: "fill_card", ref: "e1", field: "number" },
      "browser_act fill_card needs purchase: the id of an approved purchase, or card: the name of a saved card",
    ],
    [
      "a fill_card without its field",
      { kind: "fill_card", ref: "e1", purchase: "p1" },
      'browser_act fill_card needs field: "number", "expiry", "cvc", "postal_code"',
    ],
    [
      "a fill_card for another card detail",
      { kind: "fill_card", ref: "e1", purchase: "p1", field: "track2" },
      'browser_act fill_card needs field: "number", "expiry", "cvc", "postal_code"',
    ],
  ])("settles %s before anything runs", async (_, action, error) => {
    const browser = new FakeBrowserProvider();
    const act = vi.spyOn(browser, "act");
    const resolve = vi.fn();
    const result = await browserActFromTool(
      browser,
      computer,
      context,
      { actions: [{ kind: "click", ref: "e0" }, action] },
      { resolveCardFill: resolve },
    );
    expect(result).toEqual({ ok: false, completed: 0, uncertain: false, error });
    expect(act).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("types the card and never shows its number to the model", async () => {
    const { browser, ref } = await checkoutBrowser();
    const act = vi.spyOn(browser, "act");
    const result = await browserActFromTool(
      browser,
      computer,
      context,
      {
        actions: [
          { kind: "fill_card", ref: ref("Card number"), purchase: "p1", field: "number" },
          { kind: "fill_card", ref: ref("Security code"), purchase: "p1", field: "cvc" },
        ],
      },
      // Only the number is long enough to redact; the CVC is kept out by the fill itself.
      { resolveCardFill, redactions: () => [card.number] },
    );
    expect(result).toMatchObject({ ok: true, completed: 2 });
    expect(act.mock.calls[0]?.[1].actions).toEqual([
      cardFill(ref("Card number"), card.number),
      cardFill(ref("Security code"), card.cvc),
    ]);
    expect(JSON.stringify(result)).not.toContain(card.number);
    expect(JSON.stringify(result)).not.toContain(card.cvc);
  });

  it("refuses the whole batch when a purchase cannot be filled, before anything runs", async () => {
    const { browser, ref } = await checkoutBrowser();
    const act = vi.spyOn(browser, "act");
    const result = await browserActFromTool(
      browser,
      computer,
      context,
      {
        actions: [
          { kind: "fill", ref: ref("Phone"), text: "555" },
          { kind: "fill_card", ref: ref("Card number"), purchase: "p1", field: "number" },
        ],
      },
      { resolveCardFill: async () => ({ error: "This purchase is not approved." }) },
    );
    expect(result).toEqual({
      ok: false,
      completed: 0,
      uncertain: false,
      error: "This purchase is not approved.",
    });
    expect(act).not.toHaveBeenCalled();
  });

  it("says card fills are unavailable where no resolver is wired", async () => {
    const result = await browserActFromTool(new FakeBrowserProvider(), computer, context, {
      actions: [{ kind: "fill_card", ref: "e1", purchase: "p1", field: "number" }],
    });
    expect(result).toMatchObject({ ok: false, error: "Card fills are unavailable here." });
  });

  it("says only that a card failed to load, never what the error quoted", async () => {
    const warn = vi.fn();
    const logger = vi.spyOn(Logging, "getLogger").mockReturnValue({ warn } as never);
    try {
      const result = await browserActFromTool(
        new FakeBrowserProvider(),
        computer,
        context,
        { actions: [{ kind: "fill_card", ref: "e1", purchase: "p1", field: "number" }] },
        { resolveCardFill: async () => JSON.parse(`card ${card.number}`) },
      );
      expect(result).toEqual({
        ok: false,
        completed: 0,
        uncertain: false,
        error: "This card could not be loaded.",
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(card.number);
      expect(warn).toHaveBeenCalledWith(expect.any(String), { errorName: "SyntaxError" });
    } finally {
      logger.mockRestore();
    }
  });
});

describe("pay token fill", () => {
  const token = "lpt_fake_secret_token";
  const steering = (account = "acct_fake123") => `<!doctype html><body>
    <input aria-label="Card number" autocomplete="cc-number" />
    <div class="AiAgentPaymentSteering" style="position:absolute;left:-9999px">
      <span data-stripe-merchant-account="${account}"></span>
      <input name="link_pay_token" />
    </div></body>`;
  const fill = (merchantAccountId = "acct_fake123", origin = merchant) => ({
    kind: "pay_token" as const,
    text: token,
    origin,
    merchantAccountId,
  });

  it("shows the checkout's merchant account and hands it the token, never showing it", () => {
    const session = new PageBrowserSession(`${merchant}/pay`, steering());
    expect(session.snapshot().tree).toContain(
      'This checkout accepts a pay token: merchantAccountId "acct_fake123".',
    );
    const result = session.act([fill()]);
    expect(result).toMatchObject({ ok: true, completed: 1 });
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("refuses another site, another merchant account, and a page without the block", () => {
    for (const [url, html, step, error] of [
      ["https://evil.example.test/pay", steering(), fill(), /not on the merchant's site/],
      [`${merchant}/pay`, steering("acct_other"), fill(), /no pay token field/],
      [`${merchant}/pay`, steering("not-an-account"), fill(), /no pay token field/],
      [`${merchant}/pay`, "<!doctype html><body></body>", fill(), /no pay token field/],
      [`${merchant}/pay`, steering(), fill("acct_fake123", "http://shop.example.test"), /HTTPS/],
    ] as const) {
      const session = new PageBrowserSession(url, html);
      const result = session.act([step]);
      expect(result, url).toMatchObject({ ok: false, completed: 0, uncertain: false });
      expect(result.error, url).toMatch(error);
      expect(JSON.stringify(result)).not.toContain(token);
    }
  });

  it("resolves fill_pay_token server-side and refuses it where no resolver is wired", async () => {
    expect(parseBrowserActions([{ kind: "fill_pay_token", purchase: " p1 " }])).toEqual([
      { kind: "fill_pay_token", purchase: "p1" },
    ]);
    const context: AdapterContext = {
      operationId: "1",
      traceId: "1",
      spaceId: "w",
      userId: "u",
      signal: new AbortController().signal,
    };
    const computer: ComputerRef = { id: "c1", botId: "b1", kind: "fake", providerRef: "c1" };
    const browser = new FakeBrowserProvider();
    const act = vi.spyOn(browser, "act");
    const resolvePayTokenFill = vi.fn(async () => ({
      text: token,
      origin: merchant,
      merchantAccountId: "acct_fake123",
    }));
    await browserActFromTool(
      browser,
      computer,
      context,
      { actions: [{ kind: "fill_pay_token", purchase: "p1" }] },
      { resolvePayTokenFill, redactions: () => [token] },
    );
    expect(resolvePayTokenFill).toHaveBeenCalledWith({ kind: "fill_pay_token", purchase: "p1" });
    expect(act.mock.calls[0]?.[1].actions).toEqual([fill()]);
    expect(
      await browserActFromTool(browser, computer, context, {
        actions: [{ kind: "fill_pay_token", purchase: "p1" }],
      }),
    ).toMatchObject({ ok: false, error: "Pay tokens are unavailable here." });
    expect(
      await browserActFromTool(browser, computer, context, {
        actions: [{ kind: "fill_pay_token" }],
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("needs purchase") });
  });
});
