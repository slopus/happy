import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INVITED_TRIAL_WEEKS } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  accountDeletionEmail,
  CATALOGS,
  emailLocale,
  identityCodeEmail,
  passwordResetEmail,
  signInCodeEmail,
  verificationEmail,
} from "./email.js";
import { homeDeletionEmail } from "./home-deletion-email.js";
import {
  integrationClaimConfirmEmail,
  pluginSubmissionAdminEmail,
  pluginSubmissionReceivedEmail,
  pluginSubmissionReviewedEmail,
} from "./plugin-submission-email.js";
import { referralEmail } from "./referral-email.js";
import { welcomeEmail } from "./welcome-email.js";

describe("account email templates", () => {
  const url = "https://app.example.test/verify?token=fake-token&callbackURL=%2Fsign-in";

  it.each([
    ["verification", () => verificationEmail("user@example.test", url)],
    [
      "password reset",
      () => passwordResetEmail({ id: "user-1", email: "user@example.test", name: "Test" }, url),
    ],
  ] as const)("preserves the exact %s link in HTML and text", async (_name, create) => {
    const message = await create();
    expect(message.to).toBe("user@example.test");
    expect(message.text).toContain(url);
    expect(message.html).toContain(`href="${url.replaceAll("&", "&amp;")}"`);
  });

  it.each([signInCodeEmail, accountDeletionEmail])(
    "escapes code content and includes a plain-text fallback",
    async (create) => {
      const message = await create("user@example.test", "<script>fake-code</script>");
      expect(message.text).toContain("<script>fake-code</script>");
      expect(message.html).toContain("&lt;script&gt;fake-code&lt;/script&gt;");
      expect(message.html).not.toContain("<script>");
      expect(message.html).not.toContain("<a ");
    },
  );
});

// Every template must retain the same layout and a text alternative.
it("shares the layout across account, product and marketplace emails", async () => {
  const user = { id: "user-1", name: "Alex", email: "alex@example.com" };
  const url = "https://app.example.com";
  const messages = await Promise.all([
    verificationEmail(user.email, url),
    signInCodeEmail(user.email, "123456"),
    passwordResetEmail(user, url),
    accountDeletionEmail(user.email, "123456"),
    identityCodeEmail(user.email, "123456"),
    welcomeEmail(user, url),
    homeDeletionEmail(user, new Date(), "plan-ended", url),
    homeDeletionEmail(user, new Date(), "unused", url),
    referralEmail(user, url, url),
    pluginSubmissionReceivedEmail(user.email),
    integrationClaimConfirmEmail(user.email, url),
    pluginSubmissionAdminEmail(
      user.email,
      { name: "Example plugin", source: "https://example.com/plugin", email: user.email },
      url,
    ),
    pluginSubmissionReviewedEmail({
      email: user.email,
      name: "Example plugin",
      status: "approved",
      reason: null,
    }),
    pluginSubmissionReviewedEmail({
      email: user.email,
      name: "Example plugin",
      status: "rejected",
      reason: "Example reason",
    }),
  ]);
  for (const message of messages) {
    expect(message.html!.match(/class="email-card"/g)).toHaveLength(1);
    expect(message.html).toContain('role="presentation"');
    expect(message.text.length).toBeGreaterThan(0);
    expect(message.text).not.toContain("<table");
  }
});

describe("email languages", () => {
  const headers = (value: string) => new Headers({ "accept-language": value });

  it("writes in the saved app language, else the asking browser's, else English", () => {
    expect(emailLocale("es", headers("de-DE,de;q=0.9"))).toBe("es");
    expect(emailLocale(null, headers("es-CL,es;q=0.9,en;q=0.8"))).toBe("es");
    expect(emailLocale(undefined, headers("it-IT"))).toBe("en");
    expect(emailLocale("it", headers("es-ES"))).toBe("en");
    expect(emailLocale(null, headers("it-IT,es;q=0.9"))).toBe("es");
    expect(emailLocale(null, headers("en-US,es;q=0.9"))).toBe("en");
    expect(emailLocale(null, headers("*"))).toBe("en");
    expect(emailLocale(null, null)).toBe("en");
    expect(emailLocale("pl-PL", headers("es-ES,es;q=0.9"))).toBe("pl");
    expect(emailLocale(null, headers("pl-PL,pl;q=0.9,en;q=0.8"))).toBe("pl");
    expect(emailLocale(null, headers("it-IT,pl;q=0.9,en;q=0.8"))).toBe("pl");
    expect(emailLocale(null, headers("en-US,pl;q=0.9"))).toBe("en");
  });

  it("prefers the highest acceptable supported language in the request", () => {
    expect(emailLocale(null, headers("en;q=0,fr;q=1"))).toBe("fr");
    expect(emailLocale(null, headers("de;q=0.1,es;q=0.9"))).toBe("es");
    expect(emailLocale(null, headers("de;q=0.5,fr"))).toBe("fr");
    expect(emailLocale(null, headers("fr;q=0.8,de;q=0.8"))).toBe("fr");
    expect(emailLocale(null, headers("it;q=1,ES-cl;Q=0.9,en;q=0.8"))).toBe("es");
    expect(emailLocale(null, headers("zh-Hant-TW;q=0.9,pt-PT;q=0.8"))).toBe("zh-TW");
    expect(emailLocale(null, headers("en-US;q=0.8,fr;q=0.7"))).toBe("en");
    expect(emailLocale(null, headers("fr;q=0.,de;q=1."))).toBe("de");
  });

  it.each([
    ["zh_Hans_CN", "zh-CN"],
    ["zh_Hans_CN;q=0.9,en;q=0.8", "zh-CN"],
    ["zh_Hant_TW;q=0.9,fr;q=0.8", "zh-TW"],
    ["pt_BR;q=0.9,fr;q=0.8", "pt-BR"],
    ["en_US;q=1,fr;q=0.5", "en"],
    ["zh_Hans_CN;q=0,fr;q=0.5", "fr"],
    ["zh_Hans_CN;q=bogus,fr;q=0.5", "fr"],
    ["zh__Hans_CN;q=1,fr;q=0.5", "fr"],
  ])("matches underscored request tags in %s to %s", (request, locale) => {
    expect(emailLocale(null, headers(request))).toBe(locale);
  });

  it("ignores malformed weights and falls back when no supported language is acceptable", () => {
    for (const invalid of ["-0.1", "1.1", "0.1234", "bogus", "0.5junk", ""]) {
      expect(emailLocale(null, headers(`de;q=${invalid},fr;q=0.1`))).toBe("fr");
    }
    expect(emailLocale(null, headers("de;q=0,fr;q=0"))).toBe("en");
    expect(emailLocale(null, headers("en;q=0"))).toBe("en");
    expect(emailLocale(null, headers("*;q=1,fr;q=0.5"))).toBe("fr");
    expect(emailLocale("es", headers("en;q=1,es;q=0"))).toBe("es");
    expect(emailLocale("it", headers("fr;q=1"))).toBe("en");
  });

  it("renders Polish account emails with exact links, escaped codes and names", async () => {
    const url = "https://app.example.test/reset?token=fake&callbackURL=%2Fsign-in";
    const name = "Żaneta <Account>";
    const code = "<123456>";
    const user = { id: "user-1", email: "user@example.test", name };
    const locale = emailLocale("pl-PL");
    const messages = await Promise.all([
      verificationEmail(user.email, url, locale),
      signInCodeEmail(user.email, code, locale),
      passwordResetEmail(user, url, locale),
      accountDeletionEmail(user.email, code, locale),
      identityCodeEmail(user.email, code, locale),
    ]);
    for (const message of messages) {
      expect(message.html).toContain('lang="pl"');
      expect(message.html).toContain('dir="ltr"');
      expect(Object.values(CATALOGS.pl!)).toContain(message.subject);
      expect(message.text).not.toMatch(/\{\w+\}/);
    }
    for (const index of [0, 2]) {
      expect(messages[index]?.text).toContain(url);
      expect(messages[index]?.html).toContain(`href="${url.replaceAll("&", "&amp;")}"`);
    }
    for (const index of [1, 3, 4]) {
      expect(messages[index]?.text).toContain(code);
      expect(messages[index]?.html).toContain("&lt;123456&gt;");
      expect(messages[index]?.html).not.toContain(code);
    }
    expect(messages[2]?.text).toContain(name);
    expect(messages[2]?.html).toContain("Żaneta &lt;Account&gt;");
  });

  it("interpolates Polish product emails without changing dates, names or unsubscribe links", async () => {
    const user = { id: "user-1", email: "user@example.test", name: "Żaneta" };
    const url = "https://app.example.test";
    const unsubscribeUrl = `${url}/unsubscribe?token=fake-token`;
    const deletionDate = new Date("2030-01-15T00:00:00Z");
    const deletion = await homeDeletionEmail(user, deletionDate, "plan-ended", url, "pl");
    const welcome = await welcomeEmail(user, unsubscribeUrl, "pl");
    const referral = await referralEmail(user, url, unsubscribeUrl, "pl");
    const name = "Example <Plugin>";
    const plugin = await pluginSubmissionReviewedEmail(
      { email: user.email, name, status: "approved", reason: null },
      "pl",
    );
    for (const message of [deletion, welcome, referral, plugin]) {
      expect(message.html).toContain('lang="pl"');
      expect(message.html).toContain('dir="ltr"');
      expect(message.text).not.toMatch(/\{\w+\}/);
    }
    const formattedDate = new Intl.DateTimeFormat("pl", {
      dateStyle: "long",
      timeZone: "UTC",
    }).format(deletionDate);
    expect(deletion.text).toContain(formattedDate);
    expect(referral.text).toContain(String(INVITED_TRIAL_WEEKS));
    expect(plugin.subject).toContain(name);
    expect(plugin.text).toContain(name);
    expect(plugin.html).toContain("Example &lt;Plugin&gt;");
    for (const message of [welcome, referral]) {
      expect(message.text).toContain(user.name);
      expect(message.text).toContain(unsubscribeUrl);
      expect(message.headers?.["List-Unsubscribe"]).toBe(`<${unsubscribeUrl}>`);
    }
  });

  it("writes a code email in Spanish", async () => {
    const message = await signInCodeEmail("user@example.test", "123456", "es");
    expect(message.subject).toBe("Tu código para iniciar sesión en Rakazo");
    expect(message.html).toContain('lang="es"');
    expect(message.text).toContain("Introduce este código para iniciar sesión en Rakazo:");
    expect(message.html).toContain('dir="ltr"');
  });

  it("lays a right-to-left language out right to left", async () => {
    const message = await signInCodeEmail("user@example.test", "123456", "he");
    expect(message.html).toContain('lang="he"');
    expect(message.html).toContain('dir="rtl"');
  });

  it("greets by name in Spanish and keeps English as written", async () => {
    const user = { id: "user-1", email: "user@example.test", name: "Ana" };
    expect((await passwordResetEmail(user, "https://example.test/r", "es")).text).toContain(
      "Hola, Ana:",
    );
    const english = await welcomeEmail(user, "https://example.test/u");
    expect(english.subject).toBe("Welcome to Rakazo");
    expect(english.text).toContain("Hi Ana,");
    expect(english.text).toContain("Rakazo runs on iPhone");
  });

  it.each(Object.entries(CATALOGS))(
    "translates every email string into %s with its placeholders",
    (_locale, catalog) => {
      const dir = dirname(fileURLToPath(import.meta.url));
      const ids = readdirSync(dir)
        .filter((file) => file.endsWith(".tsx"))
        .flatMap((file) =>
          [...readFileSync(join(dir, file), "utf8").matchAll(/say\(\s*("(?:[^"\\]|\\.)*")/g)].map(
            (match) => JSON.parse(match[1] ?? '""') as string,
          ),
        );
      expect(ids.length).toBeGreaterThan(30);
      const placeholders = (text: string) => [...text.matchAll(/\{\w+\}/g)].map(String).sort();
      for (const id of ids) {
        expect(catalog[id], id).toBeTruthy();
        expect(placeholders(catalog[id] ?? ""), id).toEqual(placeholders(id));
      }
    },
  );
});
