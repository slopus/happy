import type { AdapterContext, ComputerRef, PageBrowserCommand } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserProvider, resolveBrowserProviderKind } from "./browser-provider-factory.js";
import { ComputerBrowserProvider } from "./computer-browser.js";
import { FakeBrowserProvider } from "./fake-browser.js";
import { pageBrowserSessionKey } from "./page-browser-session.js";

const baseContext: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

const pages = {
  "https://example.test/a": {
    title: "A",
    html: `<!doctype html><html><head><title>A</title></head><body>
      <input aria-label="Secret" value="from-bot-a" />
    </body></html>`,
  },
};

describe("browser provider factory", () => {
  const previous = process.env.BROWSER_PROVIDER;
  afterEach(() => {
    if (previous === undefined) delete process.env.BROWSER_PROVIDER;
    else process.env.BROWSER_PROVIDER = previous;
  });

  it("defaults production kind to computer, not fake", () => {
    delete process.env.BROWSER_PROVIDER;
    expect(resolveBrowserProviderKind({})).toBe("computer");
    expect(resolveBrowserProviderKind({ BROWSER_PROVIDER: "" })).toBe("computer");
    expect(createBrowserProvider().describe().id).toBe("computer");
    // API/worker pass undefined kind with a sandbox; still computer.
    expect(createBrowserProvider(undefined, {}).describe().id).toBe("computer");
  });

  it("selects fake or emulator only when BROWSER_PROVIDER asks for them", () => {
    expect(resolveBrowserProviderKind({ BROWSER_PROVIDER: "fake" })).toBe("fake");
    expect(createBrowserProvider("fake").describe().id).toBe("fake");
    expect(resolveBrowserProviderKind({ BROWSER_PROVIDER: "emulator" })).toBe("emulator");
    expect(createBrowserProvider("emulator").describe().id).toBe("emulator");
  });
});

describe("computer browser provider", () => {
  it("falls back to computer_act when live Chrome is unavailable", async () => {
    const provider = new ComputerBrowserProvider({ pages });
    const computer: ComputerRef = {
      id: "team-1",
      botId: "home-key",
      kind: "docker",
      providerRef: "team-1",
    };
    const result = await provider.navigate(
      computer,
      { url: "https://example.test/a" },
      { ...baseContext, botId: "bot-a" },
    );
    expect(result).toMatchObject({
      fallback: "computer_act",
      error: expect.stringMatching(/not attached|computer_act|live page browser/i),
    });
  });

  it("drives the live page path when the CDP helper succeeds", async () => {
    const liveDriver = vi.fn(async (_c, request, _ctx) => {
      const { command } = request;
      if (command === "navigate") {
        return { ok: true, url: String(request.url), title: "Live" };
      }
      if (command === "snapshot") {
        return {
          ok: true,
          url: "https://example.test/live",
          title: "Live",
          tree: '- textbox "Secret" [e1] value="live-secret"',
          elements: [{ ref: "e1", role: "textbox", name: "Secret", value: "live-secret" }],
        };
      }
      return {
        ok: true,
        completed: 1,
        url: "https://example.test/live",
        title: "Live",
        tree: '- textbox "Secret" [e1] value="typed"',
        elements: [{ ref: "e1", role: "textbox", name: "Secret", value: "typed" }],
      };
    });
    const provider = new ComputerBrowserProvider({ pages, liveDriver });
    const computer: ComputerRef = {
      id: "team-1",
      botId: "home-key",
      kind: "docker",
      providerRef: "team-1",
    };
    const context = { ...baseContext, botId: "bot-a" };
    const nav = await provider.navigate(computer, { url: "https://example.test/live" }, context);
    expect(nav).toEqual({ url: "https://example.test/live", title: "Live" });
    const snap = await provider.snapshot(computer, {}, context);
    expect(snap.fallback).toBeUndefined();
    expect(snap.elements[0]?.value).toBe("live-secret");
    const act = await provider.act(
      computer,
      { actions: [{ kind: "fill", ref: "e1", text: "typed" }] },
      context,
    );
    expect(act.ok).toBe(true);
    expect(act.completed).toBe(1);
    expect(liveDriver).toHaveBeenCalled();
    expect(liveDriver.mock.calls[0]?.[1]).toEqual({
      command: "navigate",
      url: "https://example.test/live",
    });
  });

  it("passes on the page a live navigation reached, when the helper read it", async () => {
    const tree = '- link "Sign in" [e1]';
    const elements = [{ ref: "e1", role: "link", name: "Sign in" }];
    const computer: ComputerRef = { id: "c", botId: "b", kind: "docker", providerRef: "c" };
    const context = { ...baseContext, botId: "bot-a" };
    const navigate = (live: Record<string, unknown>) =>
      new ComputerBrowserProvider({
        pages,
        liveDriver: async () => ({
          ok: true,
          url: "https://example.test/",
          title: "Example",
          ...live,
        }),
      }).navigate(computer, { url: "https://example.test/" }, context);
    const bare = { url: "https://example.test/", title: "Example" };
    expect(await navigate({ tree, elements })).toEqual({ ...bare, tree, elements });
    expect(await navigate({ tree, elements, loading: true })).toMatchObject({
      tree,
      loading: true,
    });
    // A page that is not whole is not passed on, nor is a loading flag without a page.
    expect(await navigate({ tree, elements: "none" })).toEqual(bare);
    expect(await navigate({ tree: 7, elements })).toEqual(bare);
    expect(await navigate({ loading: true })).toEqual(bare);
  });

  it("passes on that the live page was still loading", async () => {
    const tree = '- link "Sign in" [e1]';
    const live = { ok: true, url: "https://example.test/", title: "Example", tree, elements: [] };
    const provider = new ComputerBrowserProvider({
      pages,
      liveDriver: vi
        .fn()
        .mockResolvedValueOnce({ ...live, loading: true })
        .mockResolvedValueOnce(live),
    });
    const computer: ComputerRef = { id: "c", botId: "b", kind: "docker", providerRef: "c" };
    const context = { ...baseContext, botId: "bot-a" };
    expect(await provider.snapshot(computer, {}, context)).toMatchObject({ tree, loading: true });
    expect(await provider.snapshot(computer, {}, context)).not.toHaveProperty("loading");
    // browser_act returns the page after its actions, which can still be loading too.
    const acting = new ComputerBrowserProvider({
      pages,
      liveDriver: async () => ({ ...live, completed: 1, loading: true }),
    });
    expect(
      await acting.act(computer, { actions: [{ kind: "click", ref: "e1" }] }, context),
    ).toMatchObject({ ok: true, completed: 1, tree, loading: true });
  });

  it("returns computer_act when the live driver reports failure", async () => {
    const provider = new ComputerBrowserProvider({
      pages,
      liveDriver: async () => ({
        ok: false,
        error: "chrome not listening",
        fallback: "computer_act",
      }),
    });
    const computer: ComputerRef = {
      id: "c1",
      botId: "home-key",
      kind: "docker",
      providerRef: "c1",
    };
    const result = await provider.snapshot(computer, {}, { ...baseContext, botId: "bot-a" });
    expect(result.fallback).toBe("computer_act");
    expect(result.error).toMatch(/chrome not listening/i);
  });

  it("uses in-process pages for fake computers", async () => {
    const provider = new ComputerBrowserProvider({ pages });
    const computer: ComputerRef = {
      id: "c1",
      botId: "bot-a",
      kind: "fake",
      providerRef: "c1",
    };
    const result = await provider.navigate(
      computer,
      { url: "https://example.test/a" },
      baseContext,
    );
    expect(result.fallback).toBeUndefined();
    expect(result.title).toBe("A");
  });
});

describe("page browser session isolation", () => {
  it("keeps page state when the same bot reacquires after a lease fence renewal", async () => {
    const browser = new FakeBrowserProvider({ pages });
    const computer: ComputerRef = {
      id: "team-computer",
      botId: "team-home",
      kind: "fake",
      providerRef: "team-computer",
    };
    const first = { ...baseContext, botId: "bot-a", screenLeaseId: "run-1:1", runId: "run-1" };
    const resumed = { ...baseContext, botId: "bot-a", screenLeaseId: "run-1:8", runId: "run-1" };

    expect(pageBrowserSessionKey(computer, first)).toBe(pageBrowserSessionKey(computer, resumed));
    expect(pageBrowserSessionKey(computer, first)).toBe("team-computer::bot-a");

    await browser.navigate(computer, { url: "https://example.test/a" }, first);
    const snap = await browser.snapshot(computer, {}, resumed);
    expect(snap.url).toBe("https://example.test/a");
    expect(snap.elements.find((el) => el.name.includes("Secret"))?.value).toBe("from-bot-a");
  });

  it("keeps Team bots on the same computer in separate sessions", async () => {
    const browser = new FakeBrowserProvider({ pages });
    // Production Team computers share computer.botId (home key) across bots.
    const shared: ComputerRef = {
      id: "team-computer",
      botId: "team-home",
      kind: "fake",
      providerRef: "team-computer",
    };
    const contextA = { ...baseContext, botId: "bot-a" };
    const contextB = { ...baseContext, botId: "bot-b" };

    expect(pageBrowserSessionKey(shared, contextA)).not.toBe(
      pageBrowserSessionKey(shared, contextB),
    );

    await browser.navigate(shared, { url: "https://example.test/a" }, contextA);
    const snapA = await browser.snapshot(shared, {}, contextA);
    const secret = snapA.elements.find((el) => el.name.includes("Secret"));
    expect(secret?.value).toBe("from-bot-a");

    // Bot B has not navigated; its session must not see bot A's page.
    const snapB = await browser.snapshot(shared, {}, contextB);
    expect(snapB.url).toBe("about:blank");
    expect(snapB.elements.find((el) => el.name.includes("Secret"))).toBeUndefined();
  });
});

describe("page browser safety", () => {
  const computer: ComputerRef = {
    id: "computer",
    botId: "team-home",
    kind: "docker",
    providerRef: "computer",
  };

  it("does not advertise unavailable providers", () => {
    expect(new ComputerBrowserProvider().describe().capabilities.page).toBe(false);
  });

  it.each([{}, { ok: true }])(
    "rejects malformed live results instead of claiming success: %j",
    async (payload) => {
      const provider = new ComputerBrowserProvider({ liveDriver: async () => payload });
      expect(
        await provider.act(computer, { actions: [{ kind: "click", ref: "e1" }] }, baseContext),
      ).toMatchObject({ ok: false, uncertain: true, completed: 0 });
    },
  );

  it("preserves partial progress and uncertain outcomes", async () => {
    const provider = new ComputerBrowserProvider({
      liveDriver: async () => ({ ok: false, completed: 1, uncertain: true }),
    });
    expect(
      await provider.act(
        computer,
        {
          actions: [
            { kind: "click", ref: "e1" },
            { kind: "click", ref: "e2" },
          ],
        },
        baseContext,
      ),
    ).toMatchObject({ ok: false, uncertain: true, completed: 1 });
  });

  it("shows the page as a stopped step left it", async () => {
    const elements = [{ ref: "e1", role: "textbox", name: "Digit 1", value: "4" }];
    const provider = new ComputerBrowserProvider({
      liveDriver: async () => ({
        ok: false,
        completed: 0,
        uncertain: false,
        url: "https://code.example.test/",
        title: "Code",
        elements,
        error:
          "Focus left the field while typing, after 1 of 6 characters, so the rest was not typed.",
      }),
    });
    const result = await provider.act(
      computer,
      { actions: [{ kind: "type", ref: "e1", text: "482913" }] },
      baseContext,
    );
    expect(result).toMatchObject({
      ok: false,
      uncertain: false,
      completed: 0,
      title: "Code",
      elements,
    });
    expect(result.tree).toContain("Digit 1");
  });

  it.each([
    { ok: true, completed: 2 },
    {
      ok: false,
      completed: 1,
      uncertain: false,
      error: "Stale element ref. Take a fresh snapshot.",
    },
    { ok: false, completed: 1, uncertain: true, error: "lost", fallback: "computer_act" as const },
  ])("keeps the files a call saved, also when a later step failed: %j", async (outcome) => {
    const downloads = [
      { name: "statement.pdf", path: "bots/b1/Downloads/statement.pdf", size: 4 },
      {
        name: "slow.pdf",
        path: "bots/b1/Downloads/slow.pdf",
        state: "downloading" as const,
        size: 1,
      },
    ];
    const liveDriver = vi.fn(async (_computer: ComputerRef, _request: PageBrowserCommand) => ({
      url: "https://bank.example/",
      title: "Bank",
      ...outcome,
      downloads,
    }));
    const result = await new ComputerBrowserProvider({ liveDriver }).act(
      computer,
      {
        actions: [
          { kind: "click", ref: "e1" },
          { kind: "click", ref: "e2" },
        ],
        downloads: "bots/b1/Downloads",
      },
      baseContext,
    );
    expect(liveDriver.mock.calls[0]?.[1]).toMatchObject({ downloads: "bots/b1/Downloads" });
    expect(result).toMatchObject({ ok: outcome.ok, downloads });
  });

  it("forwards the download folder with a snapshot and keeps the PDF it saved, and a new tab's note", async () => {
    const downloads = [{ name: "4b1d.pdf", path: "bots/b1/Downloads/4b1d.pdf", size: 4 }];
    const note =
      'A new tab opened, and page tools now read it: "4b1d" at blob:https://bank.example/4b1d.';
    const liveDriver = vi.fn(async (_computer: ComputerRef, _request: PageBrowserCommand) => ({
      ok: true,
      url: "blob:https://bank.example/4b1d",
      title: "",
      tree: "(no interactive elements)",
      elements: [],
      downloads,
      note,
    }));
    const result = await new ComputerBrowserProvider({ liveDriver }).snapshot(
      computer,
      { downloads: "bots/b1/Downloads" },
      baseContext,
    );
    expect(liveDriver.mock.calls[0]?.[1]).toEqual({
      command: "snapshot",
      downloads: "bots/b1/Downloads",
    });
    expect(result).toMatchObject({ downloads, note });
  });

  it("reports a refused saved-login fill as settled, without desktop tools", async () => {
    const error = "The page is not on the site this login was saved for.";
    const provider = new ComputerBrowserProvider({
      liveDriver: async () => ({ ok: false, completed: 1, uncertain: false, error }),
    });
    const result = await provider.act(
      computer,
      {
        actions: [
          { kind: "click", ref: "e1" },
          {
            kind: "fill",
            ref: "e2",
            text: "fake-password",
            origin: "https://login.example.test",
            field: "password",
          },
        ],
      },
      baseContext,
    );
    expect(result).toMatchObject({ ok: false, completed: 1, uncertain: false, error });
    expect(result).not.toHaveProperty("fallback");
    expect(result).not.toHaveProperty("tree");
  });

  it("passes on a refused purchase click as settled, with no desktop fallback", async () => {
    const provider = new ComputerBrowserProvider({
      liveDriver: async () => ({
        ok: false,
        completed: 0,
        uncertain: false,
        error: "This click would complete a purchase",
      }),
    });
    const result = await provider.act(
      computer,
      { actions: [{ kind: "click", ref: "e1" }] },
      baseContext,
    );
    expect(result).toMatchObject({ ok: false, uncertain: false });
    expect(result).not.toHaveProperty("fallback");
  });

  it("checks for a purchase without acting, and answers none when the computer cannot tell", async () => {
    const commands: unknown[] = [];
    const answer = {
      ok: true,
      url: "https://shop.example.test/pay",
      title: "Pay",
      site: "shop.example.test",
      origin: "https://shop.example.test",
      purchase: {
        steps: [1, "x", 2.5],
        label: "Pay $5",
        amount: "$5",
        amountFrom: "button",
        reason: "card_form",
      },
    };
    let reply: Record<string, unknown> = answer;
    const provider = new ComputerBrowserProvider({
      liveDriver: async (_computer, request) => {
        commands.push(request);
        return reply;
      },
    });
    const actions = [{ kind: "fill" }, { kind: "click", ref: "e1" }];
    expect(await provider.purchaseCheck(computer, { actions }, baseContext)).toEqual({
      purchase: {
        steps: [1],
        site: "shop.example.test",
        label: "Pay $5",
        amount: "$5",
        amountSource: "button",
      },
    });
    expect(commands).toEqual([{ command: "purchase_check", actions }]);
    // The order lines the page lists pass on; anything that is not a name and an amount is dropped.
    const items = [{ name: "Bananas × 6", amount: "$3.00" }];
    reply = {
      ...answer,
      purchase: { ...answer.purchase, items: [...items, "Tax $1", { name: 1 }] },
    };
    expect(await provider.purchaseCheck(computer, { actions }, baseContext)).toMatchObject({
      purchase: { label: "Pay $5", items },
    });
    reply = { ...answer, purchase: null };
    expect(await provider.purchaseCheck(computer, { actions }, baseContext)).toEqual({
      purchase: null,
    });
    // A page without a host (about:blank, data:, file:) still asks, naming no site.
    reply = { ...answer, site: "", origin: "null" };
    expect(await provider.purchaseCheck(computer, { actions }, baseContext)).toMatchObject({
      purchase: { steps: [1], site: "", label: "Pay $5" },
    });
    // An older image: the helper does not know the command.
    reply = { ok: false, error: "unknown command: purchase_check", fallback: "computer_act" };
    expect(await provider.purchaseCheck(computer, { actions }, baseContext)).toEqual({
      purchase: null,
    });
    // So is a computer without a page browser, or a supervisor from before the check.
    for (const error of [
      "Page browser is not attached to this computer's Chrome.",
      "page browser failed: 400",
    ]) {
      reply = { ok: false, error, fallback: "computer_act" };
      expect(await provider.purchaseCheck(computer, { actions }, baseContext)).toEqual({
        purchase: null,
      });
    }
    // Any other failure asks, naming no page and approving no click: a check that started and broke,
    // or a 500, which only an unhandled error answers.
    for (const error of [
      "unknown command: purchase_check, and then some",
      "page browser failed: 500",
      "Page browser timed out; the page may be busy or blocked by a dialog. Inspect the screen before continuing.",
      "The page did not answer in time.",
      "No unambiguous visible browser tab. Use desktop tools to select a tab.",
      "Page browser unavailable or interrupted. Inspect the screen before continuing.",
    ]) {
      reply = { ok: false, error, fallback: "computer_act" };
      expect(await provider.purchaseCheck(computer, { actions }, baseContext)).toEqual({
        purchase: { steps: [], site: "", label: "", amount: "", amountSource: "page" },
      });
    }
    const fake: ComputerRef = { id: "f", botId: "b", kind: "fake", providerRef: "f" };
    expect(await provider.purchaseCheck(fake, { actions }, baseContext)).toEqual({
      purchase: null,
    });
    expect(commands).toHaveLength(13);
  });

  it("keeps the page snapshot a settled refusal sends", async () => {
    const error = "A saved password can only be typed into a password field.";
    const elements = [
      { ref: "e1", role: "textbox", name: "Email" },
      { ref: "e2", role: "textbox", name: "Password" },
    ];
    const fill = {
      kind: "fill" as const,
      ref: "e1",
      text: "fake-password",
      origin: "https://login.example.test",
      field: "password" as const,
    };
    const withTree = new ComputerBrowserProvider({
      liveDriver: async () => ({
        ok: false,
        completed: 0,
        uncertain: false,
        error,
        tree: '- textbox "Password" [e2]',
        elements,
      }),
    });
    expect(await withTree.act(computer, { actions: [fill] }, baseContext)).toMatchObject({
      ok: false,
      uncertain: false,
      error,
      tree: '- textbox "Password" [e2]',
      elements,
    });
    const elementsOnly = new ComputerBrowserProvider({
      liveDriver: async () => ({ ok: false, completed: 0, uncertain: false, error, elements }),
    });
    const result = await elementsOnly.act(computer, { actions: [fill] }, baseContext);
    expect(result).toMatchObject({
      tree: '- textbox "Email" [e1]\n- textbox "Password" [e2]',
      elements,
    });
    expect(result).not.toHaveProperty("fallback");
  });

  it("propagates cancellation instead of suggesting another action", async () => {
    const signal = AbortSignal.abort();
    const driver = vi.fn(async () => ({ ok: true }));
    const provider = new ComputerBrowserProvider({ liveDriver: driver });
    await expect(provider.snapshot(computer, {}, { ...baseContext, signal })).rejects.toThrow();
    expect(driver).not.toHaveBeenCalled();
  });
});
