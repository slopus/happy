import { readFileSync } from "node:fs";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { resolveRequestSecretDestination } from "./bot-secrets.js";

/** page_secrets' isolated-world script, executed here rather than reimplemented. */
function installPageHelper(url: string, html: string) {
  const source = readFileSync(
    new URL("../../../infra/sandboxes/computer/page_secrets.py", import.meta.url),
    "utf8",
  );
  const match = source.match(/EVAL_HELPERS = r"""\n([\s\S]*?)\n"""/);
  if (!match?.[1]) throw new Error("page secrets script was not found");
  const dom = new JSDOM(
    `<!doctype html><html><head><title>Sign in</title></head><body>${html}</body></html>`,
    { url, pretendToBeVisual: true, runScripts: "outside-only" },
  );
  const domWindow = dom.window;
  // jsdom has no layout: every element is a 10 px square.
  (
    domWindow.Element.prototype as unknown as { getBoundingClientRect: unknown }
  ).getBoundingClientRect = () => ({
    width: 10,
    height: 10,
    top: 0,
    left: 0,
    right: 10,
    bottom: 10,
    x: 0,
    y: 0,
  });
  vm.runInContext(match[1], dom.getInternalVMContext());
  const secrets = (
    domWindow as unknown as {
      __rakazoPageBrowser: {
        findCard: (token: string) => number;
        focusCard: () => boolean;
        cardHolds: () => boolean;
        cardTyped: (length: number) => boolean;
        emptyCard: () => void;
        fill: (value: string, origin?: string, field?: string) => boolean;
      };
    }
  ).__rakazoPageBrowser;
  // The page browser focuses the field the bot pointed to; the fill then takes the focused field.
  const browser = {
    ...secrets,
    fill(label: string, value: string, origin?: string, field?: string) {
      (domWindow.document.querySelector(`[aria-label="${label}"]`) as HTMLElement).focus();
      return secrets.fill(value, origin as string, field as string);
    },
  };
  /** Focuses the first input whose name or label holds `label`, as the page browser would, then fills it. */
  function fillInput(label: string, value: string, origin: string, field: string) {
    const input = [...domWindow.document.querySelectorAll("input")].find((el) =>
      [el.getAttribute("aria-label"), ...[...(el.labels ?? [])].map((box) => box.textContent)].some(
        (name) => name?.includes(label),
      ),
    );
    if (!input) throw new Error(`no input named ${label}`);
    input.focus();
    return secrets.fill(value, origin, field);
  }
  return { domWindow, browser, fillInput };
}

function fieldValue(window: JSDOM["window"], label: string): string {
  const field = window.document.querySelector(`[aria-label="${label}"]`) as {
    value?: string;
  } | null;
  return field?.value ?? "";
}

function filled(window: JSDOM["window"], label: string) {
  return window.document
    .querySelector(`[aria-label="${label}"]`)!
    .hasAttribute("data-rakazo-filled");
}

describe("live page helper saved-login fill", () => {
  const html = `
    <input aria-label="Email" />
    <input aria-label="Password" type="password" />
    <input aria-label="Phone" type="tel" />
    <textarea aria-label="Username"></textarea>
    <input aria-label="Query" type="search" />
    <input aria-label="Website" type="url" />
    <input aria-label="Pin" type="number" />
  `;

  const origin = "https://login.example.test";

  it("types a username only into text, email, and tel inputs on the saved HTTPS origin", () => {
    const { domWindow, browser } = installPageHelper(`${origin}/signin`, html);
    browser.fill("Email", "fake-user", origin, "username");
    browser.fill("Phone", "555", origin, "username");
    expect(fieldValue(domWindow, "Email")).toBe("fake-user");
    expect(fieldValue(domWindow, "Phone")).toBe("555");
    for (const name of ["Password", "Username", "Query", "Website", "Pin"]) {
      expect(() => browser.fill(name, "fake-name", origin, "username")).toThrow(
        /text, email, or telephone/,
      );
    }
    expect(fieldValue(domWindow, "Password")).toBe("");
  });

  it("types a password only into a password field, also when the field is not named", () => {
    const { domWindow, browser } = installPageHelper(`${origin}/signin`, html);
    for (const name of ["Email", "Phone", "Username", "Query", "Website", "Pin"]) {
      for (const field of ["password", undefined]) {
        expect(() => browser.fill(name, "fake-password", origin, field)).toThrow(/password field/);
      }
    }
    expect(domWindow.document.body.innerHTML).not.toContain("fake-password");
    browser.fill("Password", "fake-password", origin, "password");
    expect(fieldValue(domWindow, "Password")).toBe("fake-password");
    // Marked, so the page browser's snapshots never show it.
    expect(filled(domWindow, "Password")).toBe(true);
  });

  function passwordField(domWindow: JSDOM["window"]) {
    return domWindow.document.querySelector('[aria-label="Password"]') as HTMLInputElement;
  }

  it("preserves a revealed password while keeping its value out of snapshots", async () => {
    const { domWindow, browser } = installPageHelper(`${origin}/signin`, html);
    const field = passwordField(domWindow);
    field.addEventListener("input", () => (field.type = "text"), { once: true });
    const ref = "Password";
    browser.fill(ref, "fake-password", origin, "password");
    await Promise.resolve();
    expect(field.type).toBe("text");
    expect(field.value).toBe("fake-password");
    // Snapshots still never report it.
    expect(filled(domWindow, "Password")).toBe(true);
  });

  it("refuses a password field that the page turns into text when it is focused", () => {
    const { domWindow, browser } = installPageHelper(`${origin}/signin`, html);
    const field = passwordField(domWindow);
    field.addEventListener("focus", () => (field.type = "text"));
    const ref = "Password";
    expect(() => browser.fill(ref, "fake-password", origin, "password")).toThrow(/password field/);
    expect(field.value).toBe("");
  });

  it("leaves nothing of a login that the field only partly accepts", () => {
    const { domWindow, browser } = installPageHelper(
      `${origin}/signin`,
      '<input aria-label="Email" type="email" />',
    );
    const ref = "Email";
    // Email fields trim surrounding spaces, so the value read back differs from the one set.
    // Settled like the other refusals: no desktop fallback, which can't type a saved login.
    expect(() => browser.fill(ref, " fake-user ", origin, "username")).toThrow(
      /^Refused: This field didn't accept the saved login, so it was cleared\.$/,
    );
    expect(fieldValue(domWindow, "Email")).toBe("");
  });

  it("fills a login saved from a page URL only on that page's exact site", () => {
    const origin = resolveRequestSecretDestination({
      label: "Sign in",
      purpose: "password",
      credential: {
        name: "site_login",
        origin: "https://www.example.test/some/login/page?x=1",
        auth: { type: "login" },
      },
    }).destination?.origin;
    expect(origin).toBe("https://www.example.test");
    const other = installPageHelper("https://www.example.test/other", html);
    other.browser.fill("Email", "fake-user", origin, "username");
    expect(fieldValue(other.domWindow, "Email")).toBe("fake-user");
    for (const url of ["https://example.test/login", "https://www.example.test.evil.test/login"]) {
      const { domWindow, browser } = installPageHelper(url, html);
      const email = "Email";
      expect(() => browser.fill(email, "fake-user", origin, "username")).toThrow(
        `This login is saved for https://www.example.test; the page is on ${new URL(url).origin}.`,
      );
      expect(fieldValue(domWindow, "Email")).toBe("");
    }
  });

  it("refuses a private-LAN HTTP origin in the same fill, even when the page matches", () => {
    const origin = "http://192.168.2.10:8080";
    const { domWindow, browser } = installPageHelper(`${origin}/signin`, html);
    const email = "Email";
    expect(() => browser.fill(email, "fake-user", origin)).toThrow(/HTTPS/);
    expect(fieldValue(domWindow, "Email")).toBe("");
  });
});

describe("live page helper one-time code fill", () => {
  const origin = "https://login.example.test";
  const html = `
    <input aria-label="Code" inputmode="numeric" autocomplete="one-time-code" />
    <input aria-label="Password" type="password" />
    <input aria-label="Notes" type="text" />
  `;
  const MASK = "-webkit-text-security";

  function fillCode(
    boxes: string,
    label: string,
    code = "123456",
    url = `${origin}/verify`,
    at = origin,
  ) {
    const { domWindow, fillInput } = installPageHelper(url, boxes);
    return { domWindow, fill: () => fillInput(label, code, at, "code") };
  }

  it("types a code on its HTTPS site only, and refuses another site or plain HTTP", () => {
    const { domWindow, fillInput } = installPageHelper(`${origin}/verify`, html);
    expect(() => fillInput("Code", "123456", "https://evil.example.test", "code")).toThrow(
      /Refused: The page is not on the site this code was asked for/,
    );
    expect(() => fillInput("Code", "123456", "http://login.example.test", "code")).toThrow(
      /Refused: A code can only be filled on HTTPS/,
    );
    expect(fieldValue(domWindow, "Code")).toBe("");
    fillInput("Code", "123456", origin, "code");
    expect(fieldValue(domWindow, "Code")).toBe("123456");
  });

  it("refuses a code on a page that moved to plain HTTP or another site", () => {
    for (const url of ["http://login.example.test/verify", "https://other.example.test/verify"]) {
      const { domWindow, fill } = fillCode(html, "Code", "123456", url);
      expect(fill).toThrow();
      expect(fieldValue(domWindow, "Code")).toBe("");
    }
  });

  it("draws the filled box as dots and keeps its value out of snapshots", () => {
    const { domWindow, fill } = fillCode(html, "Code");
    const box = domWindow.document.querySelector<HTMLInputElement>('[aria-label="Code"]')!;
    // jsdom drops vendor properties, so watch the CSSOM calls Chrome applies.
    const set = vi.spyOn(box.style, "setProperty");
    fill();
    expect(set).toHaveBeenCalledWith(MASK, "disc", "important");
    expect(filled(domWindow, "Code")).toBe(true);
  });

  it("types a code only into a text, email or telephone box, never a password box", () => {
    const { domWindow, fillInput } = installPageHelper(`${origin}/verify`, html);
    expect(() => fillInput("Password", "123456", origin, "code")).toThrow(
      /Refused: A code can only be typed into a text, email, or telephone field/,
    );
    expect(fieldValue(domWindow, "Password")).toBe("");
  });

  it("drops a code's dashes for a numeric box and keeps them for a text one", () => {
    const numeric = `<input aria-label="Verification code" inputmode="numeric" />
      <input aria-label="Phone code" type="tel" />
      <input aria-label="Digits code" pattern="[0-9]*" />
      <input aria-label="Digits two code" pattern="\\d{6}" />`;
    for (const label of ["Verification code", "Phone code", "Digits code", "Digits two code"]) {
      const { domWindow, fill } = fillCode(numeric, label, "123-456");
      fill();
      expect(fieldValue(domWindow, label)).toBe("123456");
    }
    const text = fillCode(`<input aria-label="Sign-in code" />`, "Sign-in code", "AB-1234");
    text.fill();
    expect(fieldValue(text.domWindow, "Sign-in code")).toBe("AB-1234");
  });

  it.each([
    ['<input aria-label="Code" />', "Code"],
    ['<input aria-label="Enter OTP" />', "OTP"],
    ['<input name="verification" aria-label="Field" />', "Field"],
    ['<input placeholder="Passcode" aria-label="Field" />', "Field"],
    ['<input id="mfa_token" aria-label="Field" />', "Field"],
    ['<input aria-label="Field" inputmode="numeric" />', "Field"],
    ['<input aria-label="Field" autocomplete="one-time-code" />', "Field"],
    ['<input aria-label="Field" maxlength="6" />', "Field"],
    ['<label for="x">Security PIN</label><input id="x" />', "Security PIN"],
    ['<input aria-label="קוד אימות" />', "קוד"],
  ])("takes %s for a code box", (boxes, label) => {
    const { domWindow, fill } = fillCode(boxes, label);
    fill();
    expect(domWindow.document.querySelector("input")!.value).toBe("123456");
  });

  it.each([
    ['<input aria-label="Email" />', "Email"],
    ['<input aria-label="Search" />', "Search"],
    ['<input aria-label="Shipping address" />', "Shipping"],
    ['<input aria-label="Field" maxlength="1" />', "Field"],
    ['<input aria-label="Digit 1 of code" maxlength="1" />', "Digit"],
    ['<input aria-label="Field" maxlength="40" />', "Field"],
  ])("refuses %s, which does not look like a code box", (boxes, label) => {
    const { domWindow, fill } = fillCode(boxes, label);
    expect(fill).toThrow(
      "Refused: This field doesn't look like a code box; ask the user to take over.",
    );
    expect(domWindow.document.querySelector("input")!.value).toBe("");
  });

  describe("a code box over slot elements that draw each digit", () => {
    const slots = `<div id="outer"><div id="widget">
      <input aria-label="Code" autocomplete="one-time-code" maxlength="6" />
      <div>·</div><div>·</div><div>·</div><div>·</div><div>·</div><div>·</div>
    </div><p>Resend</p></div>`;

    function widget(delayMs?: number) {
      const { domWindow, fillInput } = installPageHelper(`${origin}/verify`, slots);
      const document = domWindow.document;
      const input = document.querySelector<HTMLInputElement>("input")!;
      const draw = () =>
        [...document.querySelectorAll("#widget > div")].forEach((slot, at) => {
          slot.textContent = input.value.replaceAll("-", "")[at] ?? "·";
        });
      input.addEventListener("input", () =>
        delayMs === undefined ? draw() : void setTimeout(draw, delayMs),
      );
      const widgetBox = document.getElementById("widget")!;
      const outer = document.getElementById("outer")!;
      const set = vi.spyOn(widgetBox.style, "setProperty");
      const remove = vi.spyOn(widgetBox.style, "removeProperty");
      const outerSet = vi.spyOn(outer.style, "setProperty");
      const fill = (code: string, field = "code") => fillInput("Code", code, origin, field);
      return { domWindow, fill, set, remove, outerSet, document };
    }

    it("draws the slots as dots too, right away", () => {
      const { fill, set, outerSet } = widget();
      fill("123456");
      expect(set).toHaveBeenCalledWith("-webkit-text-security", "disc", "important");
      // Only the nearest ancestor that shows the code.
      expect(outerSet).not.toHaveBeenCalled();
    });

    it("draws them as dots when the widget draws its slots a moment later", () => {
      // Fake timers make the order explicit: the widget draws at 10 ms, then the helper masks
      // again at 50 ms. The test no longer depends on how a loaded runner schedules them.
      vi.useFakeTimers();
      try {
        const { fill, set } = widget(10);
        fill("123456");
        expect(set).not.toHaveBeenCalled();
        vi.advanceTimersByTime(50);
        expect(set).toHaveBeenCalledWith("-webkit-text-security", "disc", "important");
      } finally {
        vi.useRealTimers();
      }
    });

    it("finds a code written with dashes shown without them, and gives the slots back when the box is refilled", () => {
      const { fill, set, remove } = widget();
      fill("12-34-56");
      expect(set).toHaveBeenCalledWith("-webkit-text-security", "disc", "important");
      expect(remove).not.toHaveBeenCalled();
      fill("fake-user", "username");
      expect(remove).toHaveBeenCalledWith("-webkit-text-security");
    });

    it("matches slots drawn in another case", () => {
      const { fill, set, document } = widget();
      const input = document.querySelector<HTMLInputElement>("input")!;
      const slots = [...document.querySelectorAll("#widget > div")];
      input.addEventListener("input", () =>
        slots.forEach((slot, at) => {
          slot.textContent = (input.value[at] ?? "·").toUpperCase();
        }),
      );
      fill("ab12cd");
      expect(set).toHaveBeenCalledWith("-webkit-text-security", "disc", "important");
    });

    it("keeps the code out of the snapshot's listing of the box", () => {
      const { domWindow, fill } = widget();
      fill("123456");
      expect(filled(domWindow, "Code")).toBe(true);
    });
  });

  it("clears a box that only partly accepts the code, saying code", () => {
    const { domWindow, fill } = fillCode(
      '<input aria-label="Code" type="email" />',
      "Code",
      // An email box trims surrounding spaces, so what it holds differs from what was set.
      " 123456 ",
    );
    expect(fill).toThrow(/^Refused: This field didn't accept the code, so it was cleared\.$/);
    expect(fieldValue(domWindow, "Code")).toBe("");
  });
});

describe("live page helper card fill", () => {
  const html = `
    <input aria-label="Card number" />
    <input aria-label="Phone" type="tel" />
    <input aria-label="Security code" type="password" />
    <input aria-label="Email" type="email" />
    <input aria-label="Query" type="search" />
    <input aria-label="Pin" type="number" />
    <textarea aria-label="Notes"></textarea>
    <select aria-label="Country"><option>US</option></select>
    <div aria-label="Editor" contenteditable="true" role="textbox"></div>
  `;
  const origin = "https://shop.example.test";
  const number = "4242424242424242";

  it("types a card into text, tel, and password inputs on the merchant's HTTPS origin, hidden", () => {
    const { domWindow, browser } = installPageHelper(`${origin}/pay`, html);
    browser.fill("Card number", number, origin, "card");
    browser.fill("Phone", number, origin, "card");
    browser.fill("Security code", "123", origin, "card");
    expect(fieldValue(domWindow, "Card number")).toBe(number);
    expect(fieldValue(domWindow, "Security code")).toBe("123");
    expect(filled(domWindow, "Card number")).toBe(true);
    expect(filled(domWindow, "Security code")).toBe(true);
  });

  it("draws a filled card as dots on screen until a saved login replaces it", () => {
    const { domWindow, browser } = installPageHelper(`${origin}/pay`, html);
    const ref = "Card number";
    const input = domWindow.document.querySelector<HTMLInputElement>('[aria-label="Card number"]')!;
    // jsdom drops vendor properties, so watch the CSSOM calls Chrome applies.
    const set = vi.spyOn(input.style, "setProperty");
    const remove = vi.spyOn(input.style, "removeProperty");
    browser.fill(ref, number, origin, "card");
    expect(set).toHaveBeenCalledWith("-webkit-text-security", "disc", "important");
    expect(remove).not.toHaveBeenCalled();
    browser.fill(ref, "fake-user", origin, "username");
    expect(remove).toHaveBeenCalledWith("-webkit-text-security");
  });

  it("refuses any other field, with card wording", () => {
    const { domWindow, browser } = installPageHelper(`${origin}/pay`, html);
    for (const name of ["Email", "Query", "Pin", "Notes", "Country", "Editor"]) {
      expect(() => browser.fill(name, number, origin, "card"), name).toThrow(
        /^Refused: A card can only be typed into a card field\.$/,
      );
    }
    expect(domWindow.document.body.innerHTML).not.toContain(number);
  });

  it("refuses another site, plain HTTP, and a card without its origin", () => {
    for (const [url, saved, error] of [
      ["https://shop.example.test.evil.test/pay", origin, /not on the merchant's site/],
      ["http://shop.example.test/pay", "http://shop.example.test", /only be filled on HTTPS/],
      [`${origin}/pay`, undefined, /only be filled on HTTPS/],
    ] as const) {
      const { domWindow, browser } = installPageHelper(url, html);
      const ref = "Card number";
      expect(() => browser.fill(ref, number, saved, "card"), url).toThrow(error);
      expect(fieldValue(domWindow, "Card number"), url).toBe("");
    }
  });

  it("clears a card the field only partly accepts", () => {
    const { domWindow, browser } = installPageHelper(`${origin}/pay`, html);
    const field = domWindow.document.querySelector<HTMLInputElement>('[aria-label="Card number"]')!;
    // A page script that formats the number as it is set changes what reads back.
    const setter = Object.getOwnPropertyDescriptor(domWindow.HTMLInputElement.prototype, "value")!;
    Object.defineProperty(field, "value", {
      get: () => setter.get!.call(field).slice(0, 12),
      set: (value: string) => setter.set!.call(field, value),
    });
    const ref = "Card number";
    expect(() => browser.fill(ref, number, origin, "card")).toThrow(
      /^Refused: This field didn't accept the card, so it was cleared\.$/,
    );
    expect(setter.get!.call(field)).toBe("");
  });

  it("finds the one visible card field by its autocomplete token for a fill without a ref", () => {
    const { domWindow, browser } = installPageHelper(
      `${origin}/pay`,
      `<input aria-label="Autofill" autocomplete="cc-number" aria-hidden="true" />
        <input aria-label="Faded" autocomplete="cc-exp" style="opacity: 0" />
        <input aria-label="Email" autocomplete="cc-csc" type="email" />
        <input aria-label="Card number" autocomplete="section-pay billing CC-Number" />
        <input aria-label="Postal" autocomplete="postal-code" /><input autocomplete="postal-code" />
        <iframe></iframe>`,
    );
    expect(browser.findCard("cc-exp")).toBe(0);
    expect(browser.findCard("cc-csc")).toBe(0);
    expect(browser.findCard("postal-code")).toBe(2);
    expect(browser.focusCard()).toBe(false);
    expect(browser.findCard("cc-number")).toBe(1);
    const field = domWindow.document.querySelector<HTMLInputElement>('[aria-label="Card number"]')!;
    const mask = vi.spyOn(field.style, "setProperty");
    expect(browser.focusCard()).toBe(true);
    expect(mask).toHaveBeenCalledWith("-webkit-text-security", "disc", "important");
    expect(browser.cardHolds()).toBe(true);
    field.value = "4242 4242 4242 4242";
    expect(browser.cardTyped(16)).toBe(true);
    expect(browser.cardTyped(15)).toBe(false);
    expect(filled(domWindow, "Card number")).toBe(true);
    domWindow.document.querySelector<HTMLInputElement>('[aria-label="Email"]')!.focus();
    expect(browser.cardHolds()).toBe(false);
    browser.emptyCard();
    expect(field.value).toBe("");
  });

  it("is refused by a helper that reads an unknown field as a password, outside password inputs", () => {
    // An older helper treats "card" like a password; a card number field is never one.
    const { browser } = installPageHelper(`${origin}/pay`, html);
    const ref = "Card number";
    expect(() => browser.fill(ref, number, origin, "unknown-field")).toThrow(/password field/);
  });
});
