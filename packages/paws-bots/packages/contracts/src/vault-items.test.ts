import { describe, expect, it } from "vitest";
import {
  BotSecretDestination,
  CardSecretValue,
  ContactSecretValue,
  cardBrand,
  cardExpiry,
  cardSummary,
  cardTitle,
  parseCardExpiry,
  VaultPutInput,
} from "./bot-secrets.js";
import {
  otherSiteOrigin,
  otherSitesText,
  typedOtherSites,
  vaultItemSubtitle,
} from "./vault-items.js";

describe("cards", () => {
  it("keeps a typed number as digits and refuses one that fails the Luhn check", () => {
    const card = CardSecretValue.parse({
      number: "4242 4242-4242 4242",
      expMonth: 8,
      expYear: 2030,
      cvc: "",
      name: "  ",
    });
    expect(card).toEqual({ number: "4242424242424242", expMonth: 8, expYear: 2030 });
    expect(
      CardSecretValue.safeParse({ number: "4242424242424241", expMonth: 8, expYear: 2030 }).success,
    ).toBe(false);
  });

  it("names the network, the last four digits and the expiry, never the number", () => {
    const card = CardSecretValue.parse({
      number: "5555555555554444",
      expMonth: 3,
      expYear: 2031,
      cvc: "123",
    });
    const summary = cardSummary(card);
    expect(summary).toEqual({ brand: "Mastercard", last4: "4444", expMonth: 3, expYear: 2031 });
    expect(cardTitle(summary)).toBe("Mastercard ·· 4444");
    expect(cardExpiry(summary)).toBe("03/31");
    expect(cardBrand("378282246310005")).toBe("Amex");
    expect(cardBrand("9999")).toBe("Card");
  });

  it("reads an expiry as people type it", () => {
    expect(parseCardExpiry("08/28")).toEqual({ expMonth: 8, expYear: 2028 });
    expect(parseCardExpiry("8 / 2029")).toEqual({ expMonth: 8, expYear: 2029 });
    expect(parseCardExpiry("0828")).toEqual({ expMonth: 8, expYear: 2028 });
    expect(parseCardExpiry("13/28")).toBeUndefined();
  });
});

describe("contacts", () => {
  it("drops empty fields and needs at least one", () => {
    expect(ContactSecretValue.parse({ name: "Alex Rivera", line2: "" })).toEqual({
      name: "Alex Rivera",
    });
    expect(ContactSecretValue.safeParse({ city: " " }).success).toBe(false);
    expect(ContactSecretValue.safeParse({ name: "A", password: "x" }).success).toBe(false);
  });
});

describe("vault destinations", () => {
  it("saves cards and contacts without a site", () => {
    for (const type of ["card", "contact"] as const) {
      expect(BotSecretDestination.safeParse({ name: "home", auth: { type } }).success).toBe(true);
      expect(
        BotSecretDestination.safeParse({
          name: "home",
          origin: "https://www.example.com",
          auth: { type },
        }).success,
      ).toBe(false);
    }
  });

  it("lets a new item leave out its name, and a saved one its value", () => {
    expect(
      VaultPutInput.safeParse({ destination: { auth: { type: "contact" } }, value: "{}" }).success,
    ).toBe(true);
    expect(
      VaultPutInput.safeParse({
        destination: { name: "home", auth: { type: "contact" } },
        title: "Home",
      }).success,
    ).toBe(true);
    expect(
      VaultPutInput.safeParse({ destination: { auth: { type: "login" } }, value: "{}" }).success,
    ).toBe(false);
  });
});

describe("the vault list's subtitle, shared by web and mobile", () => {
  const words = { apiKey: "API key", expires: (date: string) => `Expires ${date}` };
  const item = (fields: Partial<Parameters<typeof vaultItemSubtitle>[0]>) => ({
    name: "item",
    origin: "",
    auth: { type: "contact" as const },
    title: "Home",
    note: "",
    ...fields,
  });

  it("tells items of a kind apart without repeating the title", () => {
    expect(
      vaultItemSubtitle(
        item({
          preview: { contact: { name: "Alex Rivera", line1: "12 Elm St", city: "Springfield" } },
        }),
        words,
      ),
    ).toBe("Alex Rivera · 12 Elm St, Springfield");
    expect(
      vaultItemSubtitle(
        item({
          origin: "https://www.github.com",
          auth: { type: "login" },
          title: "github.com",
          preview: { username: "octo@example.com" },
        }),
        words,
      ),
    ).toBe("octo@example.com");
    expect(
      vaultItemSubtitle(
        item({
          auth: { type: "card" },
          note: "For travel",
          preview: { card: { brand: "Visa", last4: "4242", expMonth: 8, expYear: 2030 } },
        }),
        words,
      ),
    ).toBe("Expires 08/30 · For travel");
    expect(
      vaultItemSubtitle(
        item({ origin: "https://api.example.com", auth: { type: "bearer" }, title: "Status" }),
        words,
      ),
    ).toBe("API key · api.example.com");
    expect(
      vaultItemSubtitle(item({ name: "deploy-token", auth: { type: "command" } }), words),
    ).toBe("$DEPLOY_TOKEN");
    expect(vaultItemSubtitle(item({ auth: null }), words)).toBe("");
  });
});

describe("otherSiteOrigin", () => {
  // The one rule the editors and the server keep: a site a login could itself be saved for.
  it.each([
    ["https://www.example.com", "https://www.example.com"],
    ["https://www.example.com/sign-in?next=1", "https://www.example.com"],
    ["https://login.example.com:8443", "https://login.example.com:8443"],
    ["https://bücher.example", "https://xn--bcher-kva.example"],
    ["http://www.example.com", undefined],
    ["https://user:pass@www.example.com", undefined],
    ["https://*.example.com", undefined],
    ["https://169.254.169.254", undefined],
    ["https://metadata.google.internal", undefined],
    ["www.example.com", undefined],
    [`https://www.example.com/${"a".repeat(2048)}`, undefined],
  ])("reads %s as %s", (site, origin) => {
    expect(otherSiteOrigin(site)).toBe(origin);
  });

  it("refuses typed sites the server would refuse", () => {
    expect(typedOtherSites("https://a.example.com, https://169.254.169.254")).toBe("invalid");
    expect(typedOtherSites("http://a.example.com")).toBe("invalid");
    expect(typedOtherSites("https://a.example.com/x https://b.example.com")).toEqual([
      "https://a.example.com/x",
      "https://b.example.com",
    ]);
  });
});

describe("otherSitesText", () => {
  // Saved before a release that checks them, or edited by hand: shown as written, never a crash.
  it.each([
    [
      ["https://login.example.com", "https://www.example.com:8443"],
      "login.example.com, www.example.com:8443",
    ],
    [["not a site", "https://ok.example.com"], "not a site, ok.example.com"],
    [["", "https://"], ", https://"],
    [["https://[::1", "login.example.com"], "https://[::1, login.example.com"],
    [["mailto:someone@example.com"], "mailto:someone@example.com"],
    [[], ""],
  ])("shows %j as %j", (sites, text) => {
    expect(otherSitesText(sites)).toBe(text);
  });
});
