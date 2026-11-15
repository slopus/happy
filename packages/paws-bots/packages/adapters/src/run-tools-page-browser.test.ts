import { createHash } from "node:crypto";
import type { AdapterContext, ComputerRef, PageBrowserCommand } from "@rakazo/adapter-kit";
import { authenticatorKey, encodeLoginSecret } from "@rakazo/contracts";
import { createStreamingRedactor } from "@rakazo/core";
import { installAuditEventStore, runLoginKind } from "@rakazo/db";
import * as Logging from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  encodeRunCode,
  encodeRunLogin,
  findSiteLogin,
  LOGIN_CODE_CHANGED,
  LOGIN_CODE_TRIES,
  loadLoginPasswordRedactions,
  loadRunCodeRedactions,
  relabelVaultItem,
  storeBotSecret,
  UNSUPPORTED_ACCESS,
} from "./bot-secrets.js";
import { fakeDatabase } from "./bot-secrets.test-support.js";
import { ComputerBrowserProvider } from "./computer-browser.js";
import { resolveBotWorkspacePath } from "./computer-support.js";
import { FakeBrowserProvider } from "./fake-browser.js";
import type * as PurchaseServiceModule from "./purchase-service.js";
import { computerTools, pageBrowserTool } from "./run-tools-computer.js";
import { PERSON_HANDED_BACK } from "./screen-turn.js";
import { EncryptedSecretStore } from "./secrets.js";
import { DESKTOP_HELD_FOR_TAKEOVER_MESSAGE } from "./takeover-resume.js";
import { totpCode } from "./totp.js";
import { LOGIN_CODE_FIELD } from "./vault-card-use.js";

// Authenticator keys (the first is RFC 6238's), written in pieces so they never read as saved secrets.
const TEST_KEY = ("GEZDGNBV" + "GY3TQOJQ").repeat(2);
const OTHER_TEST_KEY = "MFRGGZDF" + "MZTWQ2LK" + "NNWG23TP" + "OBYXE43U";

vi.mock("./purchase-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof PurchaseServiceModule>()),
  resolvePurchaseCardFill: async () => ({
    text: "4242424242424242",
    origin: "https://shop.example.test",
    redactions: [],
  }),
  resolvePurchasePayTokenFill: async () => ({
    text: "tok",
    origin: "https://pay.example.test:8443",
    merchantAccountId: "acct_1",
    redactions: [],
  }),
}));

/** A computer row the screen gate finds nobody on. */
const freeComputer = { findUnique: async () => null };

/** A screen this run has not shared with a person. */
const freshScreen = () => ({
  unchangedVisualStreak: { count: 0 },
  turn: { controlFence: undefined as number | undefined, mustLook: false },
});

afterEach(() => installAuditEventStore(undefined));

/** The `credential.used` rows of the organization's audit log. */
function vaultUses() {
  const rows: Array<Record<string, unknown>> = [];
  installAuditEventStore({
    auditEvent: {
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        rows.push(...data);
        return { count: data.length };
      },
    },
    space: { findUnique: async () => ({ organizationId: "org-1", name: "Home" }) },
    member: { findUnique: async () => ({ role: "owner" }) },
  } as never);
  return () => rows.filter((row) => row.action === "credential.used");
}

const secret = 'zq"xv\\mk';
const url = "https://example.test/echo";
const computer: ComputerRef = { id: "c1", botId: "b1", kind: "fake", providerRef: "c1" };
const context: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "space",
  userId: "u",
  signal: new AbortController().signal,
};

/** A page that echoes a secret of the run into the page title, a button's name and an input's value. */
async function runPageTool(name: string, args: Record<string, unknown> = {}) {
  const html = `<!doctype html><html><head><title>Echo ${secret}</title></head><body>
    <button aria-label='${secret}'>Echo</button><input aria-label="Field" value='${secret}' /></body></html>`;
  const browser = new FakeBrowserProvider({ pages: { [url]: { title: `Echo ${secret}`, html } } });
  await browser.navigate(computer, { url }, context);
  const ctx = {
    deps: {
      prisma: {
        taughtSkill: { findFirst: async () => null },
        computer: freeComputer,
      },
    },
    run: { spaceId: "space", botId: "b1" },
    bot: { id: "b1" },
    context,
    computer: {
      heldForTakeover: false,
      stored: { id: "c1" },
      graphicalToolsAllowed: false,
      mode: "private",
      checkpoint: { markDirty: () => {} },
      get: async () => computer,
    },
    tools: { disabled: new Set<string>() },
    providers: { browser },
    secrets: new Set([secret]),
    state: { screen: freshScreen() },
  };
  const call = { name, args, finish: async (result: unknown) => result };
  const result = (await pageBrowserTool(ctx as never, call as never)) as {
    content?: Array<{ text: string }>;
    details?: unknown;
  };
  // What the model reads, and the details kept beside it.
  return `${result.content?.map((part) => part.text).join("") ?? ""}${JSON.stringify(result.details ?? result)}`;
}

describe("page tools hide the run's secrets, also where a snapshot quotes them", () => {
  it.each(["browser_snapshot", "browser_navigate"])("%s", async (name) => {
    const seen = await runPageTool(name, { url });
    expect(seen).not.toContain("xv");
    expect(seen).toContain("[redacted]");
  });
});

describe("page tools save a page's file downloads in the calling bot's own folder", () => {
  // A saved name never has a backslash: the helper turns one into an underscore.
  const nameSecret = 'zq"xv-mk';

  async function download(name: string, mode: "team" | "dedicated", botId: string, saved = true) {
    const requests: PageBrowserCommand[] = [];
    const markDirty = vi.fn();
    const browser = new ComputerBrowserProvider({
      liveDriver: async (_computer, request) => {
        requests.push(request);
        const folder = "downloads" in request ? request.downloads : undefined;
        return {
          ok: true,
          completed: 1,
          url: "https://bank.example/statements",
          title: "Statements",
          tree: '- link "Statement" [e1]',
          elements: [{ ref: "e1", role: "link", name: "Statement" }],
          ...(saved
            ? {
                downloads: [
                  {
                    name: `statement ${nameSecret}.pdf`,
                    path: `${folder}/statement ${nameSecret}.pdf`,
                    size: 4,
                    type: "application/pdf",
                  },
                ],
              }
            : {}),
        };
      },
    });
    const ctx = {
      deps: {
        prisma: {
          taughtSkill: { findFirst: async () => null },
          computer: freeComputer,
        },
      },
      run: { spaceId: "space", botId },
      bot: { id: botId },
      context,
      computer: {
        heldForTakeover: false,
        stored: { id: "c1" },
        graphicalToolsAllowed: false,
        mode,
        checkpoint: { markDirty },
        get: async () => ({ ...computer, kind: "docker" }),
      },
      tools: { disabled: new Set<string>() },
      providers: { browser },
      secrets: new Set([nameSecret]),
      state: { screen: freshScreen() },
    };
    const args =
      name === "browser_navigate"
        ? { url: "https://bank.example/files/statement.pdf" }
        : { actions: [{ kind: "click", ref: "e1" }] };
    const call = { name, args, finish: async (result: unknown) => result };
    const result = (await pageBrowserTool(ctx as never, call as never)) as {
      content?: Array<{ text: string }>;
      details?: unknown;
    };
    const text = result.content?.map((part) => part.text).join("") ?? JSON.stringify(result);
    return { requests, text, details: JSON.stringify(result.details ?? result), markDirty };
  }

  // A snapshot saves the PDF its tab shows, such as a report a page opened in a new tab.
  it.each(["browser_act", "browser_navigate", "browser_snapshot"])("%s", async (name) => {
    for (const [mode, botId, folder] of [
      ["team", "b1", "bots/b1/Downloads"],
      ["team", "b2", "bots/b2/Downloads"],
      ["dedicated", "b1", "Downloads"],
    ] as const) {
      const { requests, text, details, markDirty } = await download(name, mode, botId);
      expect(markDirty).toHaveBeenCalled();
      expect(requests).toEqual([expect.objectContaining({ downloads: folder })]);
      // The path the bot reads is the one its shell and file tools take, and leads back to the file.
      const path = "Downloads/statement [redacted].pdf";
      expect(JSON.parse(text).downloads).toEqual([
        { name: "statement [redacted].pdf", path, size: 4, type: "application/pdf" },
      ]);
      expect(resolveBotWorkspacePath(mode, botId, path)).toBe(`${folder}/statement [redacted].pdf`);
      expect(`${text}${details}`).not.toContain("xv");
    }
  });

  it.each(["browser_act", "browser_navigate", "browser_snapshot"])(
    "%s result from a helper that saved nothing is unchanged",
    async (name) => {
      const { text, markDirty } = await download(name, "team", "b1", false);
      expect(JSON.parse(text)).not.toHaveProperty("downloads");
      expect(markDirty).toHaveBeenCalledTimes(name === "browser_snapshot" ? 0 : 1);
    },
  );
});

describe("screen tools keep off the screen while a takeover holds it or teaching records it", () => {
  const teachingMessage = "Teaching is in progress. Stop teaching before using the computer.";
  const screenTools = [
    "open_path",
    "launch_app",
    "computer_observe",
    "computer_act",
    "browser_navigate",
  ];

  async function runScreenTool(
    name: string,
    held: boolean,
    teaching: boolean,
    screen = freshScreen(),
    controlFence = 0,
    observeFails = false,
  ) {
    const steps: string[] = [];
    const act = vi.fn(async () => {
      steps.push("act");
      return {};
    });
    const observe = vi.fn(async () => {
      if (observeFails) throw new Error("screen unavailable");
      return {};
    });
    const findFirst = vi.fn(async () => (teaching ? { id: "skill" } : null));
    const get = vi.fn(async () => computer);
    // Nobody holds the screen now; the fence counts each time a person took it.
    // Nobody holds the screen now; the fence counts each time a person took it.
    const findUnique = vi.fn(async () => ({
      controlHolder: "none",
      controlLeaseId: null,
      controlBotId: null,
      controlFence,
    }));
    const ctx = {
      deps: {
        prisma: {
          taughtSkill: { findFirst },
          computer: { findUnique },
        },
        sandbox: { act, observe },
        events: { append: async () => {} },
      },
      run: { spaceId: "space", botId: "b1" },
      bot: { id: "b1" },
      thread: { id: "t1" },
      context,
      computer: {
        heldForTakeover: held,
        stored: { id: "c1" },
        mode: "private",
        checkpoint: { markDirty: () => {} },
        get,
      },
      state: { screen },
      secrets: new Set<string>(),
    };
    const call = {
      name,
      args: { path: "https://example.test", application: "Firefox", url },
      finish: async (result: unknown) => result,
    };
    const handler = name === "browser_navigate" ? pageBrowserTool : computerTools[name];
    const result = await handler?.(ctx as never, call as never)?.catch((error: Error) => ({
      thrown: error.message,
    }));
    return { result, act, observe, findFirst, get, steps };
  }

  it.each(screenTools)("%s refuses while a takeover holds the screen", async (name) => {
    for (const teaching of [false, true]) {
      const run = await runScreenTool(name, true, teaching);
      expect(run.result).toEqual({ error: DESKTOP_HELD_FOR_TAKEOVER_MESSAGE });
      expect(run.findFirst).not.toHaveBeenCalled();
      expect(run.get).not.toHaveBeenCalled();
      expect(run.act).not.toHaveBeenCalled();
      expect(run.observe).not.toHaveBeenCalled();
    }
  });

  it.each(screenTools)("%s refuses while teaching records the screen", async (name) => {
    const run = await runScreenTool(name, false, true);
    expect(run.result).toEqual({ error: teachingMessage });
    expect(run.findFirst).toHaveBeenCalledWith({
      where: { spaceId: "space", botId: "b1", status: "recording" },
    });
    expect(run.get).not.toHaveBeenCalled();
    expect(run.act).not.toHaveBeenCalled();
    expect(run.observe).not.toHaveBeenCalled();
  });

  it.each(["open_path", "launch_app"])("%s acts when the screen is free", async (name) => {
    expect((await runScreenTool(name, false, false)).act).toHaveBeenCalledOnce();
  });

  it("asks for a look again when the screenshot after a person's use fails", async () => {
    const screen = { ...freshScreen(), turn: { controlFence: 1, mustLook: true } };
    const failed = await runScreenTool("computer_observe", false, false, screen, 1, true);
    expect(failed.observe).toHaveBeenCalledOnce();
    expect(screen.turn.mustLook).toBe(true);
    const refused = await runScreenTool("launch_app", false, false, screen, 1);
    expect(refused.result).toEqual({ error: PERSON_HANDED_BACK });
    expect(refused.act).not.toHaveBeenCalled();
    await runScreenTool("computer_observe", false, false, screen, 1);
    expect(screen.turn.mustLook).toBe(false);
  });

  it("looks again before acting once a person has used the screen in between", async () => {
    const screen = freshScreen();
    expect((await runScreenTool("launch_app", false, false, screen, 1)).act).toHaveBeenCalledOnce();
    const after = await runScreenTool("launch_app", false, false, screen, 2);
    expect(after.result).toEqual({ error: PERSON_HANDED_BACK });
    expect(after.act).not.toHaveBeenCalled();
    expect(
      (await runScreenTool("computer_observe", false, false, screen, 2)).observe,
    ).toHaveBeenCalledOnce();
    expect((await runScreenTool("launch_app", false, false, screen, 2)).act).toHaveBeenCalledOnce();
  });
});

describe("a run remembers the sites it typed an approved wallet purchase into", () => {
  it.each([
    [{ kind: "fill_card", ref: "e1", purchase: "p1", field: "number" }, "shop.example.test"],
    [{ kind: "fill_pay_token", purchase: "p1" }, "pay.example.test:8443"],
  ])("%j", async (action, host) => {
    const used = vaultUses();
    const walletHosts = new Set<string>();
    const browser = new FakeBrowserProvider({
      pages: { [url]: { title: "Pay", html: "<input aria-label='Card' />" } },
    });
    await browser.navigate(computer, { url }, context);
    const ctx = {
      deps: {
        prisma: {
          taughtSkill: { findFirst: async () => null },
          computer: freeComputer,
        },
        paymentWallet: {},
      },
      run: { spaceId: "space", botId: "b1" },
      bot: { id: "b1" },
      context,
      computer: {
        heldForTakeover: false,
        stored: { id: "c1" },
        mode: "private",
        checkpoint: { markDirty: () => {} },
        get: async () => computer,
      },
      tools: { disabled: new Set<string>() },
      providers: { browser },
      secrets: [],
      state: { walletHosts, screen: freshScreen() },
    };
    const call = {
      name: "browser_act",
      args: { actions: [action] },
      finish: async (r: unknown) => r,
    };
    await pageBrowserTool(ctx as never, call as never);
    expect([...walletHosts]).toEqual([host]);
    // A call that presses an approved purchase spends it: the card it types leaves no pass behind.
    walletHosts.clear();
    const approved = { steps: [], site: host, label: "Pay", amount: "$5" };
    await pageBrowserTool(
      ctx as never,
      { ...call, args: { actions: [action], purchaseApproval: approved } } as never,
    );
    expect([...walletHosts]).toEqual([]);
    // A wallet's purchase card is not a vault item.
    expect(used()).toEqual([]);
  });
});

describe("browser_act types a saved card only where the user approved it", () => {
  /**
   * `approval` names a card and site; it is bound to the card as saved unless it says otherwise.
   * The vault also holds a login for the page's site, and the run a login it didn't save.
   */
  async function fillSavedCard(approval?: Record<string, unknown>, fields = ["number"]) {
    const used = vaultUses();
    const db = fakeDatabase();
    const secretStore = new EncryptedSecretStore("test-only-encryption-key");
    const scope = { userId: "u", spaceId: "space" };
    const login = encodeLoginSecret({
      fields: [{ label: "Password", value: "saved-password-1", hidden: true }],
    });
    for (const [name, origin, type, plaintext] of [
      ["visa", "", "card", '{"number":"4242424242424242","expMonth":8,"expYear":2030,"cvc":"737"}'],
      ["site_login", "https://example.test", "login", login],
    ] as const) {
      await storeBotSecret({
        prisma: db.prisma,
        secretStore,
        scope,
        destination: { name, origin, auth: { type } },
        plaintext,
      });
    }
    const runLogin = {
      kind: runLoginKind("run-1", "typed_login"),
      ...(await secretStore.put(encodeRunLogin("https://example.test", login), context)),
    };
    Object.assign(db.prisma.secret, {
      findFirst: async ({ where }: { where: { kind: string } }) =>
        where.kind === runLogin.kind ? runLogin : null,
    });
    const walletHosts = new Set<string>();
    const secrets: string[] = [];
    const browser = new FakeBrowserProvider({
      pages: {
        [url]: {
          title: "Pay",
          html: "<input aria-label='Card number' /><input aria-label='Expiry' /><input aria-label='CVC' /><input aria-label='Password' type='password' />",
        },
      },
    });
    await browser.navigate(computer, { url }, context);
    await browser.snapshot(computer, {}, context);
    const ctx = {
      deps: {
        prisma: {
          ...db.prisma,
          taughtSkill: { findFirst: async () => null },
          computer: freeComputer,
        },
        secretStore,
      },
      run: { ...scope, id: "run-1", botId: "b1" },
      runId: "run-1",
      bot: { id: "b1", name: "Shopper" },
      thread: { id: "thread-1" },
      context,
      computer: {
        heldForTakeover: false,
        stored: { id: "c1" },
        mode: "private",
        checkpoint: { markDirty: () => {} },
        get: async () => computer,
      },
      tools: { disabled: new Set<string>() },
      providers: { browser },
      secrets,
      state: {
        walletHosts,
        vaultUses: new Set<string>(),
        screen: freshScreen(),
        reply: { pendingProgress: "", redactor: createStreamingRedactor([]) },
      },
    };
    const act = async (actions: unknown[], args = {}) =>
      JSON.stringify(
        await pageBrowserTool(
          ctx as never,
          {
            name: "browser_act",
            args: { actions, ...args },
            finish: async (r: unknown) => r,
          } as never,
        ),
      );
    const seen = await act(
      fields.map((field, index) => ({
        kind: "fill_card",
        ref: `e${index + 1}`,
        card: "visa",
        site: "https://example.test/checkout",
        field,
      })),
      approval
        ? { cardApproval: { savedAt: db.rows()[0]!.updatedAt!.toISOString(), ...approval } }
        : {},
    );
    const signIn = async (secret: string) => {
      const page = (await browser.snapshot(computer, {}, context)) as {
        elements: Array<{ ref: string; name: string }>;
      };
      const ref = page.elements.find((element) => element.name === "Password")!.ref;
      return act([{ kind: "fill_secret", ref, secret, field: "Password" }]);
    };
    return { seen, walletHosts, secrets, used, db, signIn, act };
  }

  it("refuses without the user's approval of this card on this site", async () => {
    for (const approval of [
      undefined,
      { card: "visa", site: "https://other.example.test", title: "Visa ·· 4242" },
      { card: "amex", site: "https://example.test", title: "Amex ·· 0005" },
    ]) {
      const { seen, walletHosts, secrets, used } = await fillSavedCard(approval);
      expect(seen).toContain("not approved");
      expect(walletHosts.size).toBe(0);
      expect(secrets).toEqual([]);
      expect(used()).toEqual([]);
    }
  });

  it("types it once approved and hides the number, leaving the pay click to ask", async () => {
    const approved = { card: "visa", site: "https://example.test", title: "Visa ·· 4242" };
    const { seen, walletHosts, secrets, used, db, signIn } = await fillSavedCard(approved, [
      "number",
      "expiry",
      "cvc",
    ]);
    expect(seen).toContain('\\"ok\\":true');
    expect(seen).not.toContain("4242424242424242");
    expect(secrets).toContain("4242424242424242");
    // Approving the card named no amount, so placing the order still asks.
    expect(walletHosts.size).toBe(0);
    // Each saved item the attempt typed is one use, however many fields or sign-ins; a login
    // typed for this run only was never saved.
    for (const secret of ["site_login", "site_login", "typed_login"]) {
      expect(await signIn(secret)).toContain('\\"ok\\":true');
    }
    const [card, login] = db.rows();
    const event = { organizationId: "org-1", spaceId: "space", spaceName: "Home" };
    const bot = {
      actorType: "bot",
      actorId: "b1",
      actorLabel: "Shopper",
      action: "credential.used",
    };
    const run = {
      outcome: "success",
      runId: "run-1",
      threadId: "thread-1",
      ip: null,
      userAgent: null,
    };
    // Whole rows, so it is clear no field value is in them.
    expect(used()).toEqual(
      [card!, login!].map((item, index) => ({
        ...event,
        ...bot,
        ...run,
        targetType: "vault_credential",
        targetId: item.id,
        targetLabel: item.name,
        metadata: {
          tool: "browser_act",
          scope: "account",
          name: item.name,
          kind: ["card", "login"][index],
          site: "https://example.test",
        },
      })),
    );
    expect(
      (await fillSavedCard({ ...approved, savedAt: "2026-01-01T00:00:00.000Z" })).seen,
    ).toContain("changed after the user approved");
    // Nothing was typed, so a batch refused at a later step records no use.
    const refused = await fillSavedCard(approved, ["number", "postal_code"]);
    expect(refused.seen).toContain("no billing postal code");
    expect(refused.used()).toEqual([]);
    // Nor does a fill the page refused before typing it; once typed, it is a use.
    const stale = { kind: "fill_secret", ref: "e99", secret: "site_login", field: "Password" };
    expect(await refused.act([stale])).toContain("Stale element ref");
    expect(refused.used()).toEqual([]);
    expect(await refused.signIn("site_login")).toContain('\\"ok\\":true');
    expect(refused.used()).toHaveLength(1);
  });
});

describe("browser_act signs in with a login that asks first only as the user approved", () => {
  const site = "https://example.test";
  async function signIn() {
    const used = vaultUses();
    const db = fakeDatabase();
    const secretStore = new EncryptedSecretStore("test-only-encryption-key");
    const scope = { userId: "u", spaceId: "space" };
    await storeBotSecret({
      prisma: db.prisma,
      secretStore,
      scope,
      destination: { name: "work", origin: site, auth: { type: "login" } },
      plaintext: encodeLoginSecret({
        fields: [
          { label: "Email", value: "alice@example.test", hidden: false },
          { label: "Password", value: "saved-password-2", hidden: true },
        ],
      }),
      policy: "ask",
    });
    Object.assign(db.prisma.secret, { findFirst: async () => null });
    const secrets: string[] = [];
    const browser = new FakeBrowserProvider({
      pages: {
        [`${site}/login`]: {
          title: "Sign in",
          html: "<input aria-label='Email' /><input aria-label='Password' type='password' />",
        },
      },
    });
    await browser.navigate(computer, { url: `${site}/login` }, context);
    const page = (await browser.snapshot(computer, {}, context)) as {
      elements: Array<{ ref: string; name: string }>;
    };
    const ref = (name: string) => page.elements.find((element) => element.name === name)!.ref;
    const ctx = {
      deps: {
        prisma: {
          ...db.prisma,
          taughtSkill: { findFirst: async () => null },
          computer: freeComputer,
        },
        secretStore,
      },
      run: { ...scope, id: "run-1", botId: "b1" },
      runId: "run-1",
      bot: { id: "b1", name: "Helper" },
      thread: { id: "thread-1" },
      context,
      computer: {
        heldForTakeover: false,
        stored: { id: "c1" },
        mode: "private",
        checkpoint: { markDirty: () => {} },
        get: async () => computer,
      },
      tools: { disabled: new Set<string>() },
      providers: { browser },
      secrets,
      state: {
        walletHosts: new Set<string>(),
        vaultUses: new Set<string>(),
        screen: freshScreen(),
        reply: { pendingProgress: "", redactor: createStreamingRedactor([]) },
      },
    };
    const approval = () => ({
      kind: "login",
      login: "work",
      site,
      title: "example.test",
      fields: ["Email", "Password"],
      savedAt: db.rows()[0]!.updatedAt!.toISOString(),
    });
    const act = async (fields: string[], loginApproval?: unknown, secret = "work") =>
      JSON.stringify(
        await pageBrowserTool(
          ctx as never,
          {
            name: "browser_act",
            args: {
              actions: fields.map((field) => ({
                kind: "fill_secret",
                ref: ref(field),
                secret,
                field,
              })),
              ...(loginApproval ? { loginApproval } : {}),
            },
            finish: async (r: unknown) => r,
          } as never,
        ),
      );
    return { db, secrets, used, approval, act, scope };
  }

  it("types every approved field of the call once approved, as one use", async () => {
    const { secrets, used, approval, act } = await signIn();
    // A name with spaces around it is the one the approval names, as the gate reads it.
    const seen = await act(["Email", "Password"], approval(), " work ");
    expect(seen).toContain('\\"ok\\":true');
    expect(seen).not.toContain("saved-password-2");
    expect(secrets).toContain("saved-password-2");
    expect(used()).toHaveLength(1);
  });

  it("types nothing without an approval, or one for another field, site or version", async () => {
    const { db, secrets, used, approval, act, scope } = await signIn();
    for (const [fields, given] of [
      [["Password"], undefined],
      [["Password"], { ...approval(), fields: ["Email"] }],
      [["Password"], { ...approval(), site: "https://other.example.test" }],
      [["Password"], { ...approval(), login: "other" }],
    ] as const) {
      expect(await act([...fields], given)).toContain("not approved");
    }
    // Saved again while the approval waited: the user approved what it was.
    const waited = approval();
    await relabelVaultItem(db.prisma, scope, "work", { title: "Work" });
    expect(await act(["Password"], waited)).toContain(
      "This login changed after the user approved it, so nothing was typed. Call browser_act again to ask them.",
    );
    // Blocked, or limited to another bot, while it waited: it is as if never saved.
    await relabelVaultItem(db.prisma, scope, "work", { bots: { allBots: false, botIds: [] } });
    expect(await act(["Password"], approval())).toContain("unavailable");
    expect(secrets).toEqual([]);
    expect(used()).toEqual([]);
  });
});

describe("browser_act fill_code", () => {
  const code = "482913";
  const origin = "https://login.example.test";
  const secretStore = new EncryptedSecretStore("test-only-encryption-key");

  /** A run holding a code its user entered for the page, and a page with a field for it. */
  async function runWithCode(held: { origin: string } | null = { origin }) {
    const browser = new FakeBrowserProvider({
      pages: {
        [`${origin}/verify`]: {
          title: "Verify",
          html: `<!doctype html><html><head><title>Verify</title></head><body>
            <input aria-label="Code" /></body></html>`,
        },
      },
    });
    await browser.navigate(computer, { url: `${origin}/verify` }, context);
    const rows: Array<Record<string, unknown>> = [];
    if (held) {
      const stored = await secretStore.put(
        encodeRunCode(held.origin, code),
        {
          operationId: "run-1",
          traceId: "run-1",
          spaceId: "space",
          userId: "u",
          signal: context.signal,
        },
        { ephemeral: true },
      );
      rows.push({ ...stored, userId: "u", spaceId: "space", kind: "run-code:run-1" });
    }
    const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
      Object.entries(where).every(([key, value]) => row[key] === value);
    const ctx = {
      deps: {
        prisma: {
          taughtSkill: { findFirst: async () => null },
          computer: freeComputer,
          secret: {
            findFirst: async ({ where }: { where: Record<string, unknown> }) =>
              rows.find((row) => matches(row, where)) ?? null,
            updateMany: async ({
              where,
              data,
            }: {
              where: Record<string, unknown>;
              data: Record<string, unknown>;
            }) => {
              const found = rows.filter((row) => matches(row, where));
              for (const row of found) Object.assign(row, data);
              return { count: found.length };
            },
          },
        },
        secretStore,
      },
      run: { id: "run-1", spaceId: "space", userId: "u", botId: "b1" },
      bot: { id: "b1" },
      context,
      computer: {
        heldForTakeover: false,
        stored: { id: "c1" },
        graphicalToolsAllowed: false,
        mode: "private",
        checkpoint: { markDirty: () => {} },
        get: async () => computer,
      },
      tools: { disabled: new Set<string>() },
      providers: { browser },
      secrets: [] as string[],
      state: {
        screen: freshScreen(),
        reply: {
          pendingProgress: "",
          redactor: { finish: () => "" },
        },
      },
    };
    const fill = async () => {
      const snapshot = (await browser.snapshot(computer, {}, context)) as {
        elements: Array<{ ref: string; name: string }>;
      };
      const ref = snapshot.elements.find((element) => element.name === "Code")!.ref;
      const call = {
        name: "browser_act",
        args: { actions: [{ kind: "fill_code", ref }] },
        finish: async (result: unknown) => result,
      };
      const result = (await pageBrowserTool(ctx as never, call as never)) as {
        content?: Array<{ text: string }>;
        details?: unknown;
      };
      return `${result.content?.map((part) => part.text).join("") ?? ""}${JSON.stringify(result.details ?? result)}`;
    };
    return { ctx, rows, fill };
  }

  it("types the code once, never shows it to the bot, and has none left to type again", async () => {
    const used = vaultUses();
    const { ctx, rows, fill } = await runWithCode();
    const first = await fill();
    expect(first).toContain('"ok":true');
    expect(first).not.toContain(code);
    expect(ctx.secrets).toContain(code);
    // The page took it: it stays only to be hidden, and is never typed again.
    expect(rows).toMatchObject([{ kind: "run-code-spent:run-1" }]);
    const second = await fill();
    expect(second).toContain("No code is waiting");
    expect(second).not.toContain(code);
    // A code is typed for this run only and never saved in the vault.
    expect(used()).toEqual([]);
  });

  it("refuses when the run has no code, and touches nothing", async () => {
    const { fill } = await runWithCode(null);
    expect(await fill()).toContain("No code is waiting");
  });

  it("refuses a code kept for plain HTTP, and keeps it", async () => {
    const { rows, fill } = await runWithCode({ origin: "http://login.example.test" });
    const result = await fill();
    expect(result).toContain("isn't HTTPS");
    expect(result).not.toContain(code);
    expect(rows).toHaveLength(1);
  });
});

describe("a login saved for more than one site", () => {
  const sites = {
    own: "https://login.example.test",
    other: "https://www.example.test",
    lookalike: "https://www.example.test.evil.test",
    plain: "http://www.example.test",
    elsewhere: "https://elsewhere.example.test",
    // Its host holds the login's visible value, which the run hides once it is typed.
    workspace: "https://acme.example.test",
  };

  async function savedLogin() {
    const db = fakeDatabase();
    const secretStore = new EncryptedSecretStore("test-only-encryption-key");
    const scope = { userId: "u", spaceId: "space" };
    const plaintext = encodeLoginSecret({
      fields: [
        { label: "Workspace", value: "acme", hidden: false },
        { label: "Password", value: "saved-password-1", hidden: true },
      ],
    });
    const destination = { name: "site_login", origin: sites.own, auth: { type: "login" as const } };
    await storeBotSecret({
      prisma: db.prisma,
      secretStore,
      scope,
      destination,
      plaintext,
      alsoOn: [`${sites.other}/sign-in`, sites.workspace],
    });
    const html = "<input aria-label='Workspace' /><input aria-label='Password' type='password' />";
    const browser = new FakeBrowserProvider({
      pages: Object.fromEntries(
        Object.values(sites).map((site) => [`${site}/sign-in`, { title: "Sign in", html }]),
      ),
    });
    const ctx = {
      deps: {
        prisma: {
          ...db.prisma,
          taughtSkill: { findFirst: async () => null },
          computer: freeComputer,
        },
        secretStore,
      },
      run: { ...scope, id: "run-1", botId: "b1" },
      bot: { id: "b1", name: "Shopper" },
      thread: { id: "thread-1" },
      context,
      computer: {
        heldForTakeover: false,
        stored: { id: "c1" },
        mode: "private",
        checkpoint: { markDirty: () => {} },
        get: async () => computer,
      },
      tools: { disabled: new Set<string>() },
      providers: { browser },
      secrets: [] as string[],
      state: {
        vaultUses: new Set<string>(),
        screen: freshScreen(),
        reply: { pendingProgress: "", redactor: createStreamingRedactor([]) },
      } as { pageUrl?: string },
    };
    const tool = async (name: string, args: Record<string, unknown>) =>
      JSON.stringify(
        await pageBrowserTool(
          ctx as never,
          { name, args, finish: async (r: unknown) => r } as never,
        ),
      );
    /** Opens the site's sign-in page as the bot would, then fills the password there. */
    const fill = async (field: string) => {
      const page = (await browser.snapshot(computer, {}, context)) as {
        elements: Array<{ ref: string; name: string }>;
      };
      const ref = page.elements.find((element) => element.name === field)!.ref;
      return tool("browser_act", {
        actions: [{ kind: "fill_secret", ref, secret: "site_login", field }],
      });
    };
    const signInOn = async (site: string, afterVisit?: () => Promise<unknown>) => {
      await tool("browser_navigate", { url: `${site}/sign-in` });
      await afterVisit?.();
      return fill("Password");
    };
    return { db, secretStore, scope, destination, plaintext, browser, ctx, tool, fill, signInOn };
  }

  it("keeps filling on an extra site whose host holds a value the run now hides", async () => {
    const { tool, fill } = await savedLogin();
    await tool("browser_navigate", { url: `${sites.workspace}/sign-in` });
    expect(await fill("Workspace")).toContain('"ok":true');
    // That result's page address reads as hidden text, but the next fill goes by the real one.
    expect(await fill("Password")).toContain('"ok":true');
  });

  it("fills on its own site and its other sites, and nowhere else", async () => {
    const { signInOn } = await savedLogin();
    expect(await signInOn(sites.other)).toContain('"ok":true');
    expect(await signInOn(sites.own)).toContain('"ok":true');
    expect(await signInOn(sites.lookalike)).toContain(`This login is saved for ${sites.own}`);
    expect(await signInOn(sites.plain)).toContain("only be filled on HTTPS");
  });

  it("asks the page to fill on the page's own site when it is one of the login's, else on the saved site", async () => {
    const { browser, signInOn } = await savedLogin();
    const act = vi.spyOn(browser, "act");
    const sent = () =>
      (act.mock.lastCall?.[1].actions?.[0] as { origin?: string } | undefined)?.origin;
    // The page checks a frame's own site against this one, so a sign-in frame fills only on the
    // saved site, and only while the page around it isn't on one of the login's other sites.
    await signInOn(sites.other);
    expect(sent()).toBe(sites.other);
    await signInOn(sites.elsewhere);
    expect(sent()).toBe(sites.own);
  });

  it("is refused when the page moved off the site the run saw, saying to fill again only on its sites", async () => {
    const { browser, tool, fill } = await savedLogin();
    // The desktop moved the page to another of the login's sites: refused, then filled there.
    await tool("browser_navigate", { url: `${sites.own}/sign-in` });
    await browser.navigate(computer, { url: `${sites.other}/sign-in` }, context);
    const refused = await fill("Password");
    expect(refused).not.toContain('"ok":true');
    expect(refused).toContain("Call browser_act again to fill it there.");
    expect(await fill("Password")).toContain('"ok":true');
    // Moved to a site the login isn't for: refused, and never told to fill again.
    await browser.navigate(computer, { url: `${sites.elsewhere}/sign-in` }, context);
    const elsewhere = await fill("Password");
    expect(elsewhere).toContain(`This login is saved for ${sites.other}`);
    expect(elsewhere).not.toContain("fill it there");
  });

  it("is found by site only when it is the one login saved there, or else the one also there", async () => {
    const { db, secretStore, scope } = await savedLogin();
    const save = (name: string, origin: string, alsoOn?: string[]) =>
      storeBotSecret({
        prisma: db.prisma,
        secretStore,
        scope,
        destination: { name, origin, auth: { type: "login" } },
        plaintext: encodeLoginSecret({
          fields: [{ label: "Password", value: "saved-password-2", hidden: true }],
        }),
        alsoOn,
      });
    // A login saved at the site itself, which another login is also on, is the one found there.
    await save("www_login", sites.other);
    expect(await findSiteLogin(db.prisma, scope, sites.other)).toMatchObject({
      name: "www_login",
    });
    // Two logins only also on a site: neither is chosen.
    await save("other_login", "https://other.example.test", [sites.elsewhere]);
    await save("third_login", "https://third.example.test", [sites.elsewhere]);
    expect(await findSiteLogin(db.prisma, scope, sites.elsewhere)).toBeNull();
  });

  it("keeps the page the run saw when a refusal reports no address", async () => {
    const { browser, tool, fill } = await savedLogin();
    await tool("browser_navigate", { url: `${sites.other}/sign-in` });
    const act = vi.spyOn(browser, "act");
    // The computer's refusal of a fill carries no page address.
    act.mockResolvedValueOnce({
      ok: false,
      completed: 0,
      uncertain: false,
      url: "",
      title: "",
      error: "The field did not keep focus, so nothing was typed.",
    });
    expect(await fill("Password")).not.toContain('"ok":true');
    expect(await fill("Password")).toContain('"ok":true');
    expect((act.mock.lastCall?.[1].actions?.[0] as { origin?: string } | undefined)?.origin).toBe(
      sites.other,
    );
  });

  it("says nothing of the login's other site when a later step stopped the call", async () => {
    const { browser, tool } = await savedLogin();
    await tool("browser_navigate", { url: `${sites.own}/sign-in` });
    const page = (await browser.snapshot(computer, {}, context)) as {
      elements: Array<{ ref: string; name: string }>;
    };
    const ref = page.elements.find((element) => element.name === "Password")!.ref;
    // The fill went through; the click after it failed once the page had gone to the other site.
    const stopped = { ok: false, completed: 1, url: `${sites.other}/home`, title: "Home" };
    for (const own of [{ note: "Do not replay completed or uncertain actions." }, {}]) {
      vi.spyOn(browser, "act").mockResolvedValueOnce({
        ...stopped,
        uncertain: false,
        error: "The element is gone.",
        ...own,
      });
      const result = await tool("browser_act", {
        actions: [
          { kind: "fill_secret", ref, secret: "site_login", field: "Password" },
          { kind: "click", ref },
        ],
      });
      expect(result).not.toContain("Call browser_act again to fill it there.");
      if ("note" in own) expect(result).toContain(own.note);
      await tool("browser_navigate", { url: `${sites.own}/sign-in` });
    }
  });

  it("is found for its other sites, and only its owner sets them", async () => {
    const { db, secretStore, scope, destination, plaintext } = await savedLogin();
    expect(await findSiteLogin(db.prisma, scope, sites.other)).toMatchObject({
      name: "site_login",
    });
    expect(await findSiteLogin(db.prisma, scope, sites.lookalike)).toBeNull();
    // Only the exact origin: not another port, a subdomain, plain HTTP or a lookalike letter.
    for (const near of [
      "https://www.example.test:8443",
      "https://evil.www.example.test",
      "https://example.test",
      sites.plain,
      new URL("https://www.exаmple.test").origin,
    ])
      expect(await findSiteLogin(db.prisma, scope, near), near).toBeNull();
    // The owner can't save one with a user name in it, which reads as another host.
    await expect(
      storeBotSecret({
        prisma: db.prisma,
        secretStore,
        scope,
        destination,
        plaintext,
        alsoOn: ["https://www.example.test@evil.test"],
      }),
    ).rejects.toThrow("every other site must be an HTTPS address a login can be saved for");
    const bot = { ...scope, botId: "b1" };
    const save = (alsoOn?: string[]) =>
      storeBotSecret({
        prisma: db.prisma,
        secretStore,
        scope: bot,
        destination,
        plaintext,
        alsoOn,
      });
    await expect(save([sites.lookalike])).rejects.toThrow(UNSUPPORTED_ACCESS);
    // A bot's save of the login, such as a card the user answered, keeps the sites.
    await save();
    expect(db.rows()[0]).toMatchObject({ alsoOn: [sites.other, sites.workspace] });
  });
});

describe("a saved login's authenticator key in what a run reads", () => {
  it("is hidden in every form a page shows it, even while the login is blocked", async () => {
    const db = fakeDatabase();
    const secretStore = new EncryptedSecretStore("test-only-encryption-key");
    const scope = { userId: "u", spaceId: "space" };
    const seed = OTHER_TEST_KEY;
    await storeBotSecret({
      prisma: db.prisma,
      secretStore,
      scope,
      destination: { name: "bank", origin: "https://bank.example.test", auth: { type: "login" } },
      plaintext: encodeLoginSecret({
        fields: [{ label: "Password", value: "fake-bank-pass", hidden: true }],
        otp: `otpauth://totp/Bank:alice?secret=${seed.toLowerCase()}&issuer=Bank`,
      }),
    });
    db.rows()[0]!.policy = "off";
    const logged = vi.fn();
    const logger = vi
      .spyOn(Logging, "getLogger")
      .mockReturnValue({ warn: logged, info: logged, error: logged, debug: logged } as never);
    const secrets = await loadLoginPasswordRedactions(db.prisma, secretStore, scope);
    logger.mockRestore();
    const groups = seed.match(/.{4}/g)!;
    const shown = [
      seed,
      seed.toLowerCase(),
      groups.join(" "),
      groups.join(" ").toLowerCase(),
      groups.join("-"),
      groups.join("-").toLowerCase(),
    ];
    // A security page showing the key as text, grouped, and inside its setup link.
    const link = `otpauth://totp/Bank:alice?secret=${seed.toLowerCase()}&amp;issuer=Bank`;
    const html = `<!doctype html><html><head><title>Security ${seed}</title></head><body>
      ${[...shown, link].map((form) => `<input aria-label="Key" value="${form}" />`).join("")}
      </body></html>`;
    const browser = new FakeBrowserProvider({
      pages: { [url]: { title: "Security", html } },
    });
    await browser.navigate(computer, { url }, context);
    const ctx = {
      deps: { prisma: { taughtSkill: { findFirst: async () => null }, computer: freeComputer } },
      run: { spaceId: "space", botId: "b1" },
      bot: { id: "b1" },
      context,
      computer: {
        heldForTakeover: false,
        stored: { id: "c1" },
        graphicalToolsAllowed: false,
        mode: "private",
        checkpoint: { markDirty: () => {} },
        get: async () => computer,
      },
      tools: { disabled: new Set<string>() },
      providers: { browser },
      secrets: new Set(secrets),
      state: { screen: freshScreen() },
    };
    const result = JSON.stringify(
      await pageBrowserTool(
        ctx as never,
        { name: "browser_snapshot", args: {}, finish: async (r: unknown) => r } as never,
      ),
    );
    expect(result).toContain("Security");
    for (const form of shown) expect(result).not.toContain(form);
    expect(JSON.stringify(logged.mock.calls).toUpperCase()).not.toContain(seed);
  });
});

describe("browser_act fill_code with a saved login's authenticator key", () => {
  const origin = "https://login.example.test";
  const otp = TEST_KEY;
  const now = Date.parse("2026-11-05T09:00:10.000Z");
  const code = totpCode(authenticatorKey(otp)!, now);

  afterEach(() => vi.useRealTimers());
  const shownForms = (seed: string) => [
    seed.match(/.{4}/g)!.join(" "),
    seed.match(/.{4}/g)!.join("-").toLowerCase(),
  ];

  async function codeFill(
    options: {
      key?: string;
      page?: string;
      policy?: string;
      security?: string;
      alsoOn?: string[];
      /** More sites with the same sign-in page. */
      more?: string[];
    } = {},
  ) {
    vi.useFakeTimers({ toFake: ["Date"], now });
    const used = vaultUses();
    const db = fakeDatabase();
    const secretStore = new EncryptedSecretStore("test-only-encryption-key");
    const scope = { userId: "u", spaceId: "space" };
    await storeBotSecret({
      prisma: db.prisma,
      secretStore,
      scope,
      destination: { name: "site_login", origin, auth: { type: "login" } },
      alsoOn: options.alsoOn,
      plaintext: encodeLoginSecret({
        fields: [{ label: "Password", value: "saved-password-1", hidden: true }],
        ...(options.key === "" ? {} : { otp: options.key ?? otp }),
      }),
    });
    if (options.policy) db.rows()[0]!.policy = options.policy;
    const page = `${options.page ?? origin}/verify`;
    const verify = {
      title: "Verify",
      html: "<input aria-label='Code' /><input aria-label='Password' type='password' />",
    };
    // A security page that shows a key as text, as a setup page does.
    const security = (seed: string) => ({
      title: "Security",
      html: [seed, seed.toLowerCase(), ...shownForms(seed)]
        .map((form) => `<input aria-label="Key" value="${form}" />`)
        .join(""),
    });
    const browser = new FakeBrowserProvider({
      pages: {
        [page]: verify,
        [`${origin}/verify`]: verify,
        ...Object.fromEntries((options.more ?? []).map((site) => [`${site}/verify`, verify])),
        [`${origin}/security`]: security(options.security ?? otp),
      },
    });
    await browser.navigate(computer, { url: page }, context);
    const ctx = {
      deps: {
        prisma: {
          ...db.prisma,
          taughtSkill: { findFirst: async () => null },
          computer: freeComputer,
        },
        secretStore,
      },
      run: { ...scope, id: "run-1", botId: "b1" },
      runId: "run-1",
      bot: { id: "b1", name: "Shopper" },
      thread: { id: "thread-1" },
      context,
      computer: {
        heldForTakeover: false,
        stored: { id: "c1" },
        mode: "private",
        checkpoint: { markDirty: () => {} },
        get: async () => computer,
      },
      tools: { disabled: new Set<string>() },
      providers: { browser },
      secrets: [] as string[],
      state: {
        vaultUses: new Set<string>(),
        screen: freshScreen(),
        reply: { pendingProgress: "", redactor: createStreamingRedactor([]) },
      },
    };
    const tool = async (name: string, args: Record<string, unknown>) =>
      JSON.stringify(
        await pageBrowserTool(
          ctx as never,
          { name, args, finish: async (r: unknown) => r } as never,
        ),
      );
    const act = async (
      name: string,
      action: Record<string, unknown>,
      args: Record<string, unknown> = {},
    ) => {
      const snapshot = (await browser.snapshot(computer, {}, context)) as {
        elements: Array<{ ref: string; name: string }>;
      };
      const ref = snapshot.elements.find((element) => element.name === name)!.ref;
      return tool("browser_act", { actions: [{ ...action, ref, secret: "site_login" }], ...args });
    };
    const fill = () => act("Code", { kind: "fill_code" });
    const fillPassword = () => act("Password", { kind: "fill_secret", field: "Password" });
    return { act, fill, fillPassword, tool, ctx, used, db, secretStore, scope, browser };
  }

  // An approved call is replayed first in a fresh attempt, whose run state has no page URL yet.
  const replay = async (sites: { approved: string; alsoOn: string[] }) => {
    const other = "https://www.login.example.test";
    const run = await codeFill({ page: other, alsoOn: [other], policy: "ask" });
    run.db.rows()[0]!.alsoOn = sites.alsoOn;
    const approved = (fields: string[]) => ({
      loginApproval: {
        kind: "login",
        login: "site_login",
        site: sites.approved,
        title: "login.example.test",
        fields,
        savedAt: run.db.rows()[0]!.updatedAt!.toISOString(),
      },
    });
    return {
      password: () =>
        run.act("Password", { kind: "fill_secret", field: "Password" }, approved(["Password"])),
      code: () => run.act("Code", { kind: "fill_code" }, approved([LOGIN_CODE_FIELD])),
    };
  };

  it("types an approved Ask first login and its code on the other site the user approved", async () => {
    const other = "https://www.login.example.test";
    const run = await replay({ approved: other, alsoOn: [other] });
    expect(await run.password()).toContain('"ok":true');
    expect(await run.code()).toContain('"ok":true');
  });

  it("refuses an approval for a site that is no longer one of the login's", async () => {
    const run = await replay({ approved: "https://www.login.example.test", alsoOn: [] });
    expect(await run.password()).toContain("not approved");
    expect(await run.code()).toContain("not approved");
  });

  it("types the login's code on one of its other sites, the one the run saw", async () => {
    const other = "https://www.login.example.test";
    const run = await codeFill({ page: other, alsoOn: [other] });
    await run.tool("browser_snapshot", {});
    expect(await run.fill()).toContain('"ok":true');
  });

  it("types the login's current code once in the run, hidden from the bot in every attempt", async () => {
    const { fill, ctx, used, db, secretStore, scope } = await codeFill();
    const first = await fill();
    expect(first).toContain('"ok":true');
    expect(first).not.toContain(code);
    expect(first).not.toContain(otp);
    expect(ctx.secrets).toContain(code);
    expect(used()).toEqual([expect.objectContaining({ action: "credential.used" })]);
    // A new attempt of the run starts with nothing in memory: the code is reloaded to hide it,
    // and the same code is not typed again.
    ctx.secrets.length = 0;
    ctx.state.vaultUses.clear();
    const reloaded = await loadRunCodeRedactions(db.prisma, secretStore, scope, "run-1");
    expect(reloaded).toContain(code);
    // The bot is told to wait for the next code, not to ask the user, and no use is recorded.
    const repeat = await fill();
    expect(repeat).toContain("This code was already typed in this run.");
    expect(repeat).not.toContain("request_secret");
    expect(used()).toHaveLength(1);
    expect(db.secrets()).toHaveLength(1);
    // A claim that found the code not yet typed, but whose row was written past the lock: the
    // loser is told the same, never to ask the user.
    vi.mocked(db.prisma.secret.findMany).mockResolvedValueOnce([]);
    const loser = await fill();
    expect(loser).toContain("This code was already typed in this run.");
    expect(loser).not.toContain("request_secret");
    expect(used()).toHaveLength(1);
    // Its id is keyed with the server's secret, so a reader of the table can't try every code.
    const loginId = db.rows()[0]!.id;
    const plain = createHash("sha256").update(`run-1:${loginId}:${code}`).digest("hex");
    expect(db.secrets()[0]!.id).not.toContain(plain.slice(0, 32));
  });

  it("types no code and no password on the old sites once a card a bot asked for moves the login", async () => {
    const moved = "https://new.example.test";
    const also = "https://www.example.test";
    const { db, secretStore, scope, fill, act, tool } = await codeFill({
      page: moved,
      alsoOn: [also],
      more: [also],
    });
    // As a login card the person answered for the site the bot proposed saves it.
    await storeBotSecret({
      prisma: db.prisma,
      secretStore,
      scope: { ...scope, botId: "b1" },
      destination: { name: "site_login", origin: moved, auth: { type: "login" } },
      plaintext: encodeLoginSecret({
        fields: [{ label: "Password", value: "new-password-1", hidden: true }],
      }),
      replaces: db.rows()[0]!.id,
    });
    expect.soft(db.rows()[0]).toMatchObject({ origin: moved, alsoOn: [] });
    expect.soft(await fill()).toContain("no authenticator key");
    // The other site the owner set for the old one is no longer one of its sites.
    await tool("browser_navigate", { url: `${also}/verify` });
    const typed = await act("Password", { kind: "fill_secret", field: "Password" });
    expect.soft(typed).toContain(`This login is saved for ${moved}`);
  });

  it("types the code of the last moment of a step, then the next step's code", async () => {
    const { fill, ctx } = await codeFill();
    const end = (Math.floor(now / 30_000) + 1) * 30_000;
    vi.setSystemTime(end - 1);
    expect(await fill()).toContain('"ok":true');
    expect(ctx.secrets).toContain(totpCode(authenticatorKey(otp)!, end - 1));
    vi.setSystemTime(end);
    expect(await fill()).toContain('"ok":true');
    expect(ctx.secrets).toContain(totpCode(authenticatorKey(otp)!, end));
  });

  it("types no code the authenticator moved on from while the call was being prepared", async () => {
    const { tool, fill, ctx, secretStore, browser } = await codeFill();
    const end = (Math.floor(now / 30_000) + 1) * 30_000;
    const snapshot = (await browser.snapshot(computer, {}, context)) as {
      elements: Array<{ ref: string; name: string }>;
    };
    const ref = (name: string) => snapshot.elements.find((element) => element.name === name)!.ref;
    // The code is made as its step is read; reading the password step after it takes the time
    // to the authenticator's next code.
    const load = secretStore.load.bind(secretStore);
    let loads = 0;
    vi.spyOn(secretStore, "load").mockImplementation(async (...args) => {
      if (++loads === 2) vi.setSystemTime(end);
      return load(...args);
    });
    const result = await tool("browser_act", {
      actions: [
        { kind: "fill_code", ref: ref("Code"), secret: "site_login" },
        { kind: "fill_secret", field: "Password", ref: ref("Password"), secret: "site_login" },
      ],
    });
    expect(result).toContain(LOGIN_CODE_CHANGED);
    expect(result).not.toContain('"ok":true');
    // Nothing was typed: the next call types the new code.
    expect(await fill()).toContain('"ok":true');
    expect(ctx.secrets).toContain(totpCode(authenticatorKey(otp)!, end));
  });

  it("stops typing codes a site keeps refusing, and sends the bot to ask the user", async () => {
    // A wrong key makes a new code every step that the site refuses each time.
    const { fill, db } = await codeFill();
    for (let step = 0; step < 3; step++) {
      vi.setSystemTime(now + step * 30_000);
      expect(await fill()).toContain('"ok":true');
    }
    vi.setSystemTime(now + 3 * 30_000);
    const stopped = await fill();
    expect(stopped).toContain("request_secret with oneTimeCode");
    expect(stopped).not.toContain('"ok":true');
    expect(db.secrets()).toHaveLength(3);
  });

  it("types no code of a key a run used up in later runs, until the owner saves the login again", async () => {
    const { fill, db, ctx, secretStore, scope } = await codeFill();
    const savedAt = db.rows()[0]!.updatedAt;
    // The run types its three codes and never asks for a fourth, as a run that gave up does.
    for (let step = 0; step < LOGIN_CODE_TRIES; step++) {
      vi.setSystemTime(now + step * 30_000);
      expect(db.rows()[0]!.codesStoppedAt ?? null).toBeNull();
      expect(await fill()).toContain('"ok":true');
    }
    expect(db.rows()[0]!.codesStoppedAt).toBeInstanceOf(Date);
    // Stopping changes nothing an approval was given for.
    expect(db.rows()[0]!.updatedAt).toEqual(savedAt);
    const nextRun = (id: string) => {
      ctx.run.id = id;
      ctx.runId = id;
      ctx.state.vaultUses.clear();
    };
    nextRun("run-2");
    vi.setSystemTime(now + 10 * 30_000);
    const later = await fill();
    expect(later).toContain("request_secret with oneTimeCode");
    expect(later).not.toContain('"ok":true');
    // The owner saves the login, as after fixing its key.
    await storeBotSecret({
      prisma: db.prisma,
      secretStore,
      scope,
      destination: { name: "site_login", origin, auth: { type: "login" } },
      plaintext: encodeLoginSecret({
        fields: [{ label: "Password", value: "saved-password-1", hidden: true }],
        otp,
      }),
    });
    nextRun("run-3");
    expect(await fill()).toContain('"ok":true');
  });

  it("gives a third code the page refused back without stopping the login, and stops it once the third is typed", async () => {
    const other = "https://other.example.test";
    const { fill, db, browser } = await codeFill({ more: [other] });
    for (let step = 0; step < LOGIN_CODE_TRIES - 1; step++) {
      vi.setSystemTime(now + step * 30_000);
      expect(await fill()).toContain('"ok":true');
    }
    // The third is refused before anything is typed: the page is on another site.
    vi.setSystemTime(now + 2 * 30_000);
    await browser.navigate(computer, { url: `${other}/verify` }, context);
    expect(await fill()).toContain(`This login is saved for ${origin}`);
    expect(db.secrets()).toHaveLength(LOGIN_CODE_TRIES - 1);
    expect(db.rows()[0]!.codesStoppedAt ?? null).toBeNull();
    // Typed on its site, it is the run's last.
    await browser.navigate(computer, { url: `${origin}/verify` }, context);
    expect(await fill()).toContain('"ok":true');
    expect(db.secrets()).toHaveLength(LOGIN_CODE_TRIES);
    expect(db.rows()[0]!.codesStoppedAt).toBeInstanceOf(Date);
    vi.setSystemTime(now + 3 * 30_000);
    expect(await fill()).toContain("request_secret with oneTimeCode");
  });

  it("hides a key the owner saved while the run went on, once a fill used the login", async () => {
    const seed = OTHER_TEST_KEY;
    // The run started before the login had this key, so its start loaded none to hide.
    for (const use of ["fillCode", "fillPassword"] as const) {
      const run = await codeFill({ key: use === "fillCode" ? "" : otp, security: seed });
      await storeBotSecret({
        prisma: run.db.prisma,
        secretStore: run.secretStore,
        scope: run.scope,
        destination: { name: "site_login", origin, auth: { type: "login" } },
        plaintext: encodeLoginSecret({
          fields: [{ label: "Password", value: "saved-password-1", hidden: true }],
          // Pasted as a link with upper-case names and the key in dashed groups.
          otp: `otpauth://totp/x?SECRET=${seed.match(/.{4}/g)!.join("-").toLowerCase()}`,
        }),
      });
      expect(await (use === "fillCode" ? run.fill() : run.fillPassword())).toContain('"ok":true');
      await run.tool("browser_navigate", { url: `${origin}/security` });
      const page = await run.tool("browser_snapshot", {});
      expect(page).toContain("Key");
      for (const form of [seed, seed.toLowerCase(), ...shownForms(seed)])
        expect(page).not.toContain(form);
    }
  });

  it("gives a code the page refused back for the right site, and keeps one it may have typed", async () => {
    const { fill, browser, db, used } = await codeFill({ page: "https://other.example.test" });
    // Refused before anything was typed: the code is the run's to type again, on its site.
    expect(await fill()).toContain(`This login is saved for ${origin}`);
    expect(db.secrets()).toHaveLength(0);
    await browser.navigate(computer, { url: `${origin}/verify` }, context);
    expect(await fill()).toContain('"ok":true');
    expect(db.secrets()).toHaveLength(1);
    expect(used()).toHaveLength(1);
    // The page may have typed it before failing: the code stays spent and isn't typed again.
    const unsure = await codeFill();
    vi.spyOn(unsure.browser, "act").mockResolvedValueOnce({
      ok: false,
      uncertain: true,
      completed: 0,
      url: `${origin}/verify`,
      title: "Verify",
      error: "The page stopped answering.",
    });
    expect(await unsure.fill()).toContain('"uncertain":true');
    expect(unsure.db.secrets()).toHaveLength(1);
    expect(await unsure.fill()).toContain("This code was already typed in this run.");
    expect(unsure.used()).toHaveLength(1);
  });

  it("shows no use for a code the page clearly never typed", async () => {
    const refused = await codeFill();
    vi.spyOn(refused.browser, "act").mockResolvedValueOnce({
      ok: false,
      uncertain: false,
      completed: 0,
      url: `${origin}/verify`,
      title: "Verify",
      error: "Stale element ref",
    });
    expect(await refused.fill()).toContain("Stale element ref");
    expect(refused.db.secrets()).toHaveLength(0);
    expect(refused.used()).toEqual([]);
    // Typed next time, it is one use.
    expect(await refused.fill()).toContain('"ok":true');
    expect(refused.used()).toHaveLength(1);
  });

  it("shows each site a login was typed on in one attempt, once each", async () => {
    const other = "https://www.login.example.test";
    const run = await codeFill({ alsoOn: [other], more: [other] });
    expect(await run.fillPassword()).toContain('"ok":true');
    expect(await run.fillPassword()).toContain('"ok":true');
    await run.tool("browser_navigate", { url: `${other}/verify` });
    expect(await run.fillPassword()).toContain('"ok":true');
    expect(run.used().map((row) => (row.metadata as { site: string }).site)).toEqual([
      origin,
      other,
    ]);
  });

  it("is refused on another site, for a blocked login, and for a login without a key", async () => {
    const elsewhere = await (await codeFill({ page: "https://other.example.test" })).fill();
    expect(elsewhere).toContain(`This login is saved for ${origin}`);
    expect(elsewhere).not.toContain(code);
    expect(await (await codeFill({ policy: "off" })).fill()).toContain("Login is unavailable");
    expect(await (await codeFill({ key: "" })).fill()).toContain("has no authenticator key");
  });
});
