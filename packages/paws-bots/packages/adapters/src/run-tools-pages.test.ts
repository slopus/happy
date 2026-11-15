import { beforeEach, describe, expect, it, vi } from "vitest";

const publishMessage = vi.fn();
vi.mock("./run-messages.js", async (importActual) => ({
  ...(await importActual<typeof import("./run-messages.js")>()),
  publishMessage: (...args: unknown[]) => publishMessage(...args),
}));

const { holdSharedPageSave, pageTools } = await import("./run-tools-pages.js");
const { redactBlocks } = await import("./run-messages.js");

const source = (heading: string) =>
  `const App = () => (\n  <Page title="${heading}">\n    <Text>Hi</Text>\n  </Page>\n);\nexport default App;\n`;

function context(
  tx: Record<string, unknown>,
  existing?: { currentVersion: number; visibility?: "private" | "link" },
  secrets: string[] = [],
  skipApprovals = false,
) {
  const prisma = {
    page: {
      findFirst: vi.fn(async () =>
        existing
          ? {
              id: "page-1",
              title: "Plan",
              visibility: existing.visibility ?? "private",
              currentVersion: existing.currentVersion,
              versions: [{ source: source("Plan") }],
            }
          : null,
      ),
    },
    $transaction: vi.fn(async (work: (client: unknown) => unknown) => work(tx)),
  };
  return {
    deps: { prisma },
    run: { id: "run-1", spaceId: "space-1", userId: "user-1", threadId: "t-1", botId: "bot-1" },
    bot: { id: "bot-1" },
    thread: { groupId: null },
    secrets,
    state: { tainted: false },
    trust: { loadAutoReviewPreference: async () => ({ skipApprovals }) },
  } as never;
}

const call = (args: Record<string, unknown>, approval: Record<string, unknown> = {}) =>
  ({ args, bypassApproval: false, ...approval, finish: (result: unknown) => result }) as never;

const request = (args: Record<string, unknown>, nextApprovedTool?: string) =>
  ({ args, nextApprovedTool, heldForApproval: false, fleetSummary: undefined }) as {
    args: Record<string, unknown>;
    effectRequest?: unknown;
    nextApprovedTool: string | undefined;
    heldForApproval: boolean;
    fleetSummary: { title: string; lines: string[] } | undefined;
  };

describe("save_page", () => {
  beforeEach(() => publishMessage.mockReset());

  it("keeps a saved page when its chat card cannot be posted, and says how to link it", async () => {
    publishMessage.mockRejectedValueOnce(new Error("run was cancelled"));
    const tx = { page: { create: vi.fn(async () => ({ id: "page-1", title: "Plan" })) } };
    const result = (await pageTools.save_page!(
      context(tx),
      call({ title: "Plan", source: source("Plan") }),
    )) as Record<string, unknown>;
    expect(tx.page.create).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ pageId: "page-1", version: 1, title: "Plan" });
    expect(result.error).toMatch(/saved, but its card could not be posted/);
    expect(result.error).toContain("[Plan](page:page-1)");
  });

  it("taints the run when it reads a page's stored source, but not when it saves one", async () => {
    const read = context({}, { currentVersion: 2 });
    const result = (await pageTools.save_page!(read, call({ pageId: "page-1" }))) as Record<
      string,
      unknown
    >;
    expect(result.source).toBe(source("Plan"));
    expect((read as { state: { tainted: boolean } }).state.tainted).toBe(true);

    const tx = { page: { create: vi.fn(async () => ({ id: "page-2", title: "New" })) } };
    const save = context(tx);
    await pageTools.save_page!(save, call({ title: "New", source: source("New") }));
    expect(tx.page.create).toHaveBeenCalledTimes(1);
    expect((save as { state: { tainted: boolean } }).state.tainted).toBe(false);
  });

  it("treats an empty edits list as not sent, as it does a blank title or source", async () => {
    const tx = { page: { create: vi.fn(async () => ({ id: "page-1", title: "Plan" })) } };
    const created = (await pageTools.save_page!(
      context(tx),
      call({ title: "Plan", source: source("Plan"), edits: [] }),
    )) as Record<string, unknown>;
    expect(created).toMatchObject({ pageId: "page-1", version: 1 });
    expect(tx.page.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        versions: { create: expect.objectContaining({ code: expect.stringContaining("Plan") }) },
      }),
    });
    // Reading a page back with an empty list returns its source rather than an error.
    const read = (await pageTools.save_page!(
      context({}, { currentVersion: 3 }),
      call({ pageId: "page-1", edits: [], source: "" }),
    )) as Record<string, unknown>;
    expect(read).toEqual({ pageId: "page-1", version: 3, title: "Plan", source: source("Plan") });
  });

  it("never stores a run secret in a page's source, title or chat card", async () => {
    const secret = "FAKE_PAGE_SECRET_7246";
    const tx = {
      page: {
        create: vi.fn(async ({ data }: { data: { title: string } }) => ({
          id: "page-1",
          title: data.title,
        })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      pageVersion: { create: vi.fn() },
    };
    const refused = [
      call({ title: "Plan", source: source(secret) }),
      call({ pageId: "page-1", source: source(secret) }),
      call({ pageId: "page-1", edits: [{ find: 'title="Plan"', replace: `title="${secret}"` }] }),
    ];
    for (const [index, args] of refused.entries()) {
      const existing = index === 0 ? undefined : { currentVersion: 1 };
      const result = (await pageTools.save_page!(context(tx, existing, [secret]), args)) as Record<
        string,
        unknown
      >;
      expect(result).toMatchObject({ unchanged: true, error: expect.stringMatching(/secret/) });
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    expect(tx.page.create).not.toHaveBeenCalled();
    expect(tx.pageVersion.create).not.toHaveBeenCalled();
    expect(publishMessage).not.toHaveBeenCalled();

    const titled = (await pageTools.save_page!(
      context(tx, undefined, [secret]),
      call({ title: `Keys ${secret}`, source: source("Plan") }),
    )) as Record<string, unknown>;
    expect(titled.title).toBe("Keys [redacted]");
    expect(JSON.stringify(tx.page.create.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(publishMessage.mock.calls)).not.toContain(secret);
    // A page card in a run's reply is redacted like its text.
    expect(
      redactBlocks(
        [{ kind: "page", pageId: "page-1", version: 1, title: `A ${secret}` }],
        [secret],
      ),
    ).toEqual([{ kind: "page", pageId: "page-1", version: 1, title: "A [redacted]" }]);
    // Step labels can come from tool arguments, so they are redacted like notes.
    expect(
      redactBlocks([{ kind: "steps", steps: [{ label: `Run ${secret}`, count: 1 }] }], [secret]),
    ).toEqual([{ kind: "steps", steps: [{ label: "Run [redacted]", count: 1 }] }]);
  });

  it("redacts a kept title that holds a secret this run learned after it was saved", async () => {
    const secret = "FAKE_PAGE_SECRET_9132";
    const tx = {
      page: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUniqueOrThrow: vi.fn(async () => ({ title: `Keys ${secret}` })),
        update: vi.fn(),
      },
      pageVersion: { create: vi.fn() },
    };
    const result = (await pageTools.save_page!(
      context(tx, { currentVersion: 1 }, [secret]),
      call({ pageId: "page-1", source: source("Plan") }),
    )) as Record<string, unknown>;
    expect(result.title).toBe("Keys [redacted]");
    expect(tx.page.update).toHaveBeenCalledWith({
      where: { id: "page-1" },
      data: { title: "Keys [redacted]" },
    });
    expect(JSON.stringify(tx.pageVersion.create.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(publishMessage.mock.calls)).not.toContain(secret);
  });
});

describe("saving a page shared by link", () => {
  const edit = { find: "Hi", replace: "Hello" };

  it("holds a change to a shared page for approval, showing what changes", async () => {
    const held = request({ pageId: "page-1", edits: [edit], approvedVersion: 9 });
    await holdSharedPageSave(context({}, { currentVersion: 1, visibility: "link" }), held as never);
    expect(held.heldForApproval).toBe(true);
    expect(held.fleetSummary).toEqual({
      title: "Update shared page “Plan”?",
      lines: ["-     <Text>Hi</Text>", "+     <Text>Hello</Text>"],
    });
    // The approval pins the version the card was shown against, never one the model sent.
    expect(held.args).toMatchObject({ approvedVersion: 1 });
    expect(held.effectRequest).toBe(held.args);

    // A whole new source shows only the lines that change too.
    const whole = request({ pageId: "page-1", source: source("Plan").replace("Hi", "Bye") });
    await holdSharedPageSave(
      context({}, { currentVersion: 1, visibility: "link" }),
      whole as never,
    );
    expect(whole.fleetSummary?.lines).toEqual(["-     <Text>Hi</Text>", "+     <Text>Bye</Text>"]);
  });

  it("lets a save that would fail anyway fail without a card", async () => {
    const shared = { currentVersion: 1, visibility: "link" as const };
    for (const args of [
      { pageId: "page-1", edits: [{ find: "Hi" }] },
      { pageId: "page-1", edits: [{ find: "Missing", replace: "x" }] },
      { pageId: "page-1", source: "not a page" },
    ]) {
      const held = request(args);
      expect(await holdSharedPageSave(context({}, shared), held as never)).toBeUndefined();
      expect(held.heldForApproval).toBe(false);
    }
  });

  it("shows only the changed part of a long line", async () => {
    const row = `const rows = [${Array.from({ length: 300 }, (_, index) => `"r${index}"`).join(", ")}];`;
    const withRow = source("Plan").replace("const App", `${row}\nconst App`);
    const ctx = context({}, { currentVersion: 1, visibility: "link" });
    (
      ctx as { deps: { prisma: { page: { findFirst: () => Promise<unknown> } } } }
    ).deps.prisma.page.findFirst = async () => ({
      title: "Plan",
      visibility: "link",
      currentVersion: 1,
      versions: [{ source: withRow }],
    });
    const held = request({ pageId: "page-1", edits: [{ find: '"r150"', replace: '"changed"' }] });
    expect(await holdSharedPageSave(ctx, held as never)).toBeUndefined();
    const [removed, added] = held.fleetSummary!.lines;
    expect(removed).toMatch(/^- ….*"r150".*…$/);
    expect(added).toMatch(/^\+ ….*"changed".*…$/);
    expect(removed!.length).toBeLessThan(120);
  });

  it("shows the title as it will be saved, and skips a save the secret check would refuse", async () => {
    const shared = { currentVersion: 1, visibility: "link" as const };
    const titled = request({ pageId: "page-1", title: "  New\nplan ", edits: [edit] });
    await holdSharedPageSave(context({}, shared), titled as never);
    expect(titled.fleetSummary?.lines[0]).toBe("Title: New plan");

    const secret = "FAKE_PAGE_SECRET_5521";
    const leaking = request({ pageId: "page-1", edits: [{ find: "Hi", replace: secret }] });
    await holdSharedPageSave(context({}, shared, [secret]), leaking as never);
    expect(leaking.heldForApproval).toBe(false);
  });

  it("refuses a change too long to show on the card", async () => {
    const long = Array.from({ length: 400 }, (_, index) => `<Text>Row ${index}</Text>`).join("\n");
    const held = request({ pageId: "page-1", edits: [{ find: "<Text>Hi</Text>", replace: long }] });
    const refused = await holdSharedPageSave(
      context({}, { currentVersion: 1, visibility: "link" }),
      held as never,
    );
    expect(refused?.error).toMatch(/smaller edits/);
    expect(held.heldForApproval).toBe(false);
  });

  it("refuses an approved change once the page moved past the version it was shown against", async () => {
    const tx = { page: { updateMany: vi.fn() }, pageVersion: { create: vi.fn() } };
    const result = (await pageTools.save_page!(
      context(tx, { currentVersion: 2, visibility: "link" }),
      call(
        { pageId: "page-1", edits: [edit], approvedVersion: 1 },
        { nextApprovedTool: "save_page" },
      ),
    )) as Record<string, unknown>;
    expect(result).toMatchObject({ unchanged: true, error: expect.stringMatching(/changed/) });
    expect(tx.page.updateMany).not.toHaveBeenCalled();
  });

  it("does not hold a private page, a read, a new page, or any save under Never ask", async () => {
    const cases = [
      [request({ pageId: "page-1", edits: [edit] }), context({}, { currentVersion: 1 })],
      [request({ pageId: "page-1" }), context({}, { currentVersion: 1, visibility: "link" })],
      [request({ title: "New", source: source("New") }), context({})],
      [
        request({ pageId: "page-1", edits: [edit] }),
        context({}, { currentVersion: 1, visibility: "link" }, [], true),
      ],
    ] as const;
    for (const [held, ctx] of cases) {
      await holdSharedPageSave(ctx, held as never);
      expect(held.heldForApproval).toBe(false);
    }
  });

  it("keeps an approved replay held so it claims its approval", async () => {
    const held = request({ pageId: "page-1", edits: [edit] }, "save_page");
    await holdSharedPageSave(context({}, { currentVersion: 1 }), held as never);
    expect(held.heldForApproval).toBe(true);
  });

  it("saves an unapproved change only while the page is still private", async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const tx = { page: { updateMany }, pageVersion: { create: vi.fn() } };
    const result = (await pageTools.save_page!(
      context(tx, { currentVersion: 1 }),
      call({ pageId: "page-1", edits: [edit] }),
    )) as Record<string, unknown>;
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ visibility: "private" }) }),
    );
    // Shared since the check: nothing is published, and the retry asks.
    expect(result).toMatchObject({ unchanged: true });
    expect(tx.pageVersion.create).not.toHaveBeenCalled();
  });

  it("tells the bot a page is shared when it saves an approved change", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const tx = {
      page: { updateMany, findUniqueOrThrow: vi.fn(async () => ({ title: "Plan" })) },
      pageVersion: { create: vi.fn() },
    };
    const result = (await pageTools.save_page!(
      context(tx, { currentVersion: 1, visibility: "link" }),
      call({ pageId: "page-1", edits: [edit] }, { nextApprovedTool: "save_page" }),
    )) as Record<string, unknown>;
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "page-1", currentVersion: 1 } }),
    );
    expect(result).toMatchObject({ version: 2, sharedByLink: true });
  });
});
