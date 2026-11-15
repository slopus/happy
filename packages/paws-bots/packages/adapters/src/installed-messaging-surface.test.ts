import type {
  AdapterContext,
  MessagingInboundEvent,
  MessagingInboundMessage,
  MessagingInstallation,
  MessagingInstallationStore,
  MessagingInstallProvider,
  MessagingSurface,
} from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { InstalledMessagingSurface } from "./installed-messaging-surface.js";

const context: AdapterContext = {
  operationId: "op",
  traceId: "trace",
  userId: "user-a",
  spaceId: "space-a",
  signal: new AbortController().signal,
};
const inbound: MessagingInboundMessage = {
  type: "message",
  provider: "slack",
  handle: "1.001",
  threadId: "slack:C1:1.001",
  isDirect: true,
  from: "U1",
  fromLabel: "Sender",
  content: "hello",
  mediaUrl: null,
  participants: [],
  channelName: null,
};
function fixture() {
  const installations = new Map<string, MessagingInstallation>(
    ["a", "b"].map((id) => [
      id,
      {
        id,
        provider: "slack",
        workspaceId: `T${id}`,
        workspaceName: id,
        spaceId: `space-${id}`,
        userId: `user-${id}`,
        botId: `bot-${id}`,
        credential: `token-${id}`,
      },
    ]),
  );
  const store: MessagingInstallationStore = {
    get: vi.fn(
      async (provider, workspaceId) =>
        [...installations.values()].find(
          (row) => row.provider === provider && row.workspaceId === workspaceId,
        ) ?? null,
    ),
    getById: vi.fn(async (id) => installations.get(id) ?? null),
    removeWorkspace: vi.fn(async (provider, workspaceId) => {
      for (const [id, row] of installations)
        if (row.provider === provider && row.workspaceId === workspaceId) installations.delete(id);
    }),
  };
  const sends = vi.fn(async (_credential: string, request: unknown) => ({
    handle: "reply",
    request,
  }));
  const receipts = vi.fn(
    async (_credential: string, _threadId: string, _handle: string) => undefined,
  );
  const surfaces = vi.fn((credential: string) => {
    let sink: ((event: MessagingInboundEvent) => Promise<void>) | undefined;
    return {
      describe: () => ({
        id: "fake",
        contractVersion: "1",
        adapterVersion: "1",
        capabilities: { providers: ["slack"] },
      }),
      platforms: () => [
        { provider: "slack", capabilities: { direct: true, groups: true, receipt: "reaction" } },
      ],
      onInbound: (callback) => {
        sink = callback;
      },
      handleWebhook: async () => {
        await sink?.(inbound);
        return new Response(null, { status: 200 });
      },
      sendToThread: (request) => sends(credential, request),
      acknowledge: (threadId, handle) => receipts(credential, threadId, handle),
      openDirectThread: async (_provider, address) => `slack:D-${address}`,
      fetchThreadHistory: async () => [inbound],
      shutdown: vi.fn(async () => undefined),
    } as MessagingSurface;
  });
  const provider: MessagingInstallProvider = {
    provider: "slack",
    capabilities: { direct: true, groups: true, receipt: "reaction" },
    surface: surfaces,
    authorizeUrl: (state) => state,
    exchange: vi.fn(),
    parseWebhook: async (request) => ({
      request,
      workspaceId: new URL(request.url).searchParams.get("team") ?? undefined,
    }),
  };
  return {
    messaging: new InstalledMessagingSurface(store, provider),
    installations,
    store,
    provider,
    surfaces,
    sends,
    receipts,
  };
}
const webhook = (team = "Ta") =>
  new Request(`https://app.example.test/webhook?team=${team}`, { method: "POST", body: "{}" });

describe("installed messaging isolation", () => {
  it("namespaces the same Slack user, message and channel separately in each workspace", async () => {
    const f = fixture();
    const events: MessagingInboundEvent[] = [];
    f.messaging.onInbound(async (event) => {
      events.push(event);
    });
    await f.messaging.handleWebhook("slack", webhook("Ta"));
    await f.messaging.handleWebhook("slack", webhook("Tb"));
    expect(events).toMatchObject([
      {
        from: "Ta:U1",
        handle: "Ta:1.001",
        threadId: "slack~a:C1:1.001",
        installationSpaceId: "space-a",
        installationBotId: "bot-a",
      },
      {
        from: "Tb:U1",
        handle: "Tb:1.001",
        threadId: "slack~b:C1:1.001",
        installationSpaceId: "space-b",
        installationBotId: "bot-b",
      },
    ]);
  });

  it("resolves workspace credentials for queued replies, even in a fresh worker", async () => {
    const f = fixture();
    await f.messaging.sendToThread({ threadId: "slack~a:C1:1.001", body: "reply" }, context);
    expect(f.sends).toHaveBeenCalledWith("token-a", { threadId: "slack:C1:1.001", body: "reply" });
    await f.messaging.acknowledge("slack~a:C1:1.001", "Ta:1.001", context);
    expect(f.receipts).toHaveBeenCalledWith("token-a", "slack:C1:1.001", "1.001");
    expect(f.surfaces).toHaveBeenCalledTimes(1);
    await expect(f.messaging.acknowledge("slack~a:C1", "Tb:1.001", context)).rejects.toThrow(
      "another workspace",
    );
  });

  it("rejects cross-space sends and unscoped Slack threads before constructing an adapter", async () => {
    const f = fixture();
    await expect(
      f.messaging.sendToThread({ threadId: "slack~b:C1", body: "secret" }, context),
    ).rejects.toMatchObject({ message: "Messaging workspace unavailable", permanent: true });
    await expect(
      f.messaging.sendToThread({ threadId: "slack:C1", body: "secret" }, context),
    ).rejects.toThrow("scoped");
    expect(f.surfaces).not.toHaveBeenCalled();
  });

  it("checks storage on every send so disconnect and token replacement take effect immediately", async () => {
    const f = fixture();
    await f.messaging.sendToThread({ threadId: "slack~a:C1", body: "first" }, context);
    f.installations.set("a", { ...f.installations.get("a")!, credential: "replacement" });
    await f.messaging.sendToThread({ threadId: "slack~a:C1", body: "second" }, context);
    expect(f.sends).toHaveBeenLastCalledWith("replacement", expect.anything());
    f.installations.delete("a");
    // A removed workspace never takes the send, so its delivery fails at once instead of retrying.
    await expect(
      f.messaging.sendToThread({ threadId: "slack~a:C1", body: "third" }, context),
    ).rejects.toMatchObject({ message: "Messaging workspace unavailable", permanent: true });
    expect(f.sends).toHaveBeenCalledTimes(2);
  });

  it("ignores uninstalled workspaces and rejects unsigned webhooks before looking up credentials", async () => {
    const f = fixture();
    await f.messaging.handleWebhook("slack", webhook("unknown"));
    expect(f.surfaces).not.toHaveBeenCalled();
    vi.mocked(f.store.get).mockClear();
    f.provider.parseWebhook = async () => {
      throw new Error("signature");
    };
    expect((await f.messaging.handleWebhook("slack", webhook()))?.status).toBe(401);
    expect(f.store.get).not.toHaveBeenCalled();
  });

  it("accepts the signed verification challenge before any workspace is installed", async () => {
    const f = fixture();
    f.provider.parseWebhook = async (request) => ({ request, challenge: "challenge" });
    expect(await (await f.messaging.handleWebhook("slack", webhook()))?.json()).toEqual({
      challenge: "challenge",
    });
    expect(f.store.get).not.toHaveBeenCalled();
  });

  it("removes only the verified workspace when Slack uninstalls the app", async () => {
    const f = fixture();
    f.provider.parseWebhook = async (request) => ({
      request,
      workspaceId: "Ta",
      uninstalled: true,
    });
    await f.messaging.handleWebhook("slack", webhook());
    expect(f.installations.has("a")).toBe(false);
    expect(f.installations.has("b")).toBe(true);
    expect(f.surfaces).not.toHaveBeenCalled();
  });

  it("opens DMs with a scoped sender and scopes fetched history for the same workspace", async () => {
    const f = fixture();
    expect(await f.messaging.openDirectThread("slack", "Ta:U1", context)).toBe("slack~a:D-U1");
    expect(
      await f.messaging.fetchThreadHistory(
        "slack~a:C1:1.001",
        { before: "Ta:1.001", limit: 10 },
        context,
      ),
    ).toMatchObject([{ from: "Ta:U1", handle: "Ta:1.001", workspaceId: "Ta" }]);
  });
});

it("keeps a new installation separate from retained channel history", async () => {
  const f = fixture();
  const events: MessagingInboundEvent[] = [];
  f.messaging.onInbound(async (event) => {
    events.push(event);
  });
  await f.messaging.handleWebhook("slack", webhook());
  f.installations.delete("a");
  f.installations.set("new", {
    id: "new",
    provider: "slack",
    workspaceId: "Ta",
    workspaceName: "Reinstalled",
    spaceId: "space-new",
    userId: "user-new",
    botId: "bot-new",
    credential: "new-token",
  });
  await f.messaging.handleWebhook("slack", webhook());
  expect(events).toMatchObject([
    { conversationKey: "a:slack:C1:1.001" },
    { conversationKey: "new:slack:C1:1.001", installationSpaceId: "space-new" },
  ]);
});

it("shuts down cached adapters on replacement, removal and process shutdown", async () => {
  const f = fixture();
  await f.messaging.sendToThread({ threadId: "slack~a:C1", body: "first" }, context);
  const original = f.surfaces.mock.results[0]!.value;
  f.installations.set("a", { ...f.installations.get("a")!, credential: "replacement" });
  await f.messaging.sendToThread({ threadId: "slack~a:C1", body: "second" }, context);
  expect(original.shutdown).toHaveBeenCalledTimes(1);
  const replacement = f.surfaces.mock.results[1]!.value;
  await f.messaging.shutdown();
  expect(replacement.shutdown).toHaveBeenCalledTimes(1);
});
