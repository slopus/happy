import type { AdapterContext, ManagedConnectorProvider } from "@rakazo/adapter-kit";
import type { ConnectionCatalogItem, MessageBlock } from "@rakazo/contracts";
import type * as db from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { connectApp } from "./connect-app.js";

const stored = vi.hoisted(() => [] as { blocks: MessageBlock[]; clientNonce: string }[]);
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof db>()),
  createThreadMessageInTransaction: vi.fn(async (_tx, input) => {
    stored.push(input);
    return { id: "card" };
  }),
  appendEventInTransaction: vi.fn(async () => ({ seq: 1, firstResponse: true })),
}));
const entry: ConnectionCatalogItem = {
  connectorId: "fake",
  slug: "gmail",
  name: "Gmail",
  logo: null,
  connected: false,
  noAuth: false,
};
function fixture(items = [entry]) {
  const tx = {
    $executeRaw: vi.fn(),
    message: {
      findMany: vi.fn(async () => stored),
      findFirst: vi.fn(
        async ({ where }: { where: { clientNonce: string } }) =>
          stored.find((message) => message.clientNonce === where.clientNonce) ?? null,
      ),
    },
  };
  const deps = {
    prisma: { $transaction: vi.fn(async (fn) => fn(tx)) },
    events: { notify: vi.fn() },
  } as unknown as Parameters<typeof connectApp>[0];
  const catalog = vi.fn(async () => items);
  const providers = [
    { describe: () => ({ id: items[0]?.connectorId }), catalog },
  ] as unknown as ManagedConnectorProvider[];
  const context = {
    spaceId: "space",
    userId: "user",
    botId: "bot",
    operationId: "test",
    traceId: "test",
    signal: new AbortController().signal,
  } as AdapterContext;
  const target = { id: "run", spaceId: "space", botId: "bot", threadId: "chat" };
  return {
    deps,
    providers,
    context,
    target,
    catalog,
    call: (app: unknown = "Gmail", effect = "effect") =>
      connectApp(deps, providers, context, target, app, effect),
  };
}
beforeEach(() => {
  stored.length = 0;
  vi.clearAllMocks();
});
describe("connect_app execution", () => {
  it("uses only catalog fields and actor context", async () => {
    const f = fixture();
    await f.call("GMAIL");
    expect(stored).toEqual([
      {
        threadId: "chat",
        botId: "bot",
        runId: "run",
        role: "bot",
        blocks: [
          {
            kind: "app_connect",
            connectorId: "fake",
            provider: "gmail",
            name: "Gmail",
            description: "Search, read, draft, and send email.",
            logo: null,
            status: "pending",
          },
        ],
        clientNonce: "connect-app:effect",
      },
    ]);
    expect(f.catalog).toHaveBeenCalledWith(f.context, "GMAIL");
    expect(f.deps.events.notify).toHaveBeenCalledWith("chat", 1, "run");
    expect(f.deps.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 20_000,
    });
  });
  it("does not accept model card objects or unknown apps", async () => {
    const f = fixture();
    await f.call({ app: "Gmail", name: "untrusted", logo: "untrusted" });
    expect(await f.call("unavailable")).toHaveProperty("error");
    expect(stored).toHaveLength(0);
  });
  it("returns connected state without posting", async () => {
    const f = fixture([{ ...entry, connected: true }]);
    expect(await f.call()).toMatchObject({ status: "connected" });
    expect(stored).toHaveLength(0);
  });
  it("dedupes replay even after the original card connects", async () => {
    const f = fixture();
    await f.call();
    stored[0]!.blocks = stored[0]!.blocks.map(
      (block) => ({ ...block, status: "connected" }) as MessageBlock,
    );
    await f.call();
    expect(stored).toHaveLength(1);
  });
  it("reuses a pending card from a different effect", async () => {
    const f = fixture();
    await f.call();
    await f.call("gmail", "another-effect");
    expect(stored).toHaveLength(1);
  });
});

it("falls back to the catalog when search does not recognize a featured alias", async () => {
  const f = fixture();
  f.catalog.mockImplementation(async (_context?: unknown, query?: string) =>
    query ? [] : [{ ...entry, slug: "googlecalendar", name: "Google Calendar" }],
  );
  await f.call("gcal");
  expect(stored[0]?.blocks[0]).toMatchObject({
    provider: "googlecalendar",
    name: "Google Calendar",
  });
});

it("treats an app connected through a later provider as connected", async () => {
  const f = fixture();
  const providers = [
    { describe: () => ({ id: "fake" }), catalog: async () => [entry] },
    {
      describe: () => ({ id: "other" }),
      catalog: async () => [{ ...entry, connectorId: "other", connected: true }],
    },
  ] as unknown as ManagedConnectorProvider[];
  const result = await connectApp(f.deps, providers, f.context, f.target, "Gmail", "effect");
  expect(result).toMatchObject({ status: "connected" });
  expect(stored).toHaveLength(0);
});

describe("connected apps that need reconnecting", () => {
  it.each([false, true])("handles provider reconnect requirement %s", async (reconnect) => {
    const f = fixture([{ ...entry, connected: true }]);
    const needsReconnect = vi.fn(async () => reconnect);
    f.providers[0]!.needsReconnect = needsReconnect;
    expect(await f.call()).toMatchObject({ status: reconnect ? "pending" : "connected" });
    expect(needsReconnect).toHaveBeenCalledWith(f.context, entry.slug);
    expect(stored.map((message) => message.blocks)).toEqual(
      reconnect ? [[expect.objectContaining({ connectorId: "fake", status: "pending" })]] : [],
    );
  });
  it("tells the bot to reconnect and reuses the pending card on replay", async () => {
    const f = fixture([{ ...entry, connected: true }]);
    f.providers[0]!.needsReconnect = async () => true;
    expect(await f.call()).toMatchObject({
      status: "pending",
      message:
        "Connection card shown. The saved connection gives this app no tools, so the user must reconnect it. Wait for them to do so.",
    });
    expect(await f.call("Gmail", "another-effect")).toMatchObject({
      status: "pending",
      message:
        "Connection card already shown. The saved connection gives this app no tools, so the user must reconnect it. Wait for them to do so.",
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.blocks[0]).toMatchObject({ status: "pending" });
  });
});
