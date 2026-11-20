import { expect, it } from "vitest";
import { once } from "node:events";
// Gateway has a native Node entrypoint, deliberately separate from Expo.
import { createGateway } from "../../../../../integrations/rakazo/gateway/server.mjs";
import { GatewayState } from "../../../../../integrations/rakazo/gateway/state.mjs";
import { encrypt, decrypt } from "../../../../paws-agent/src/crypto/encryption";
import { createSessionSteward } from "./sessionSteward.web";

it("routes a worker tool through the real HTTP/SSE bridge and decrypts exact remote execution results", async () => {
  const { serveSessionTools } = await import(
    /* @vite-ignore */ new URL(
      "../../../../paws-bots/apps/web/src/paws/session-tools.ts",
      import.meta.url,
    ).href
  );
  const { callPawsSessionTool } = await import(
    /* @vite-ignore */ new URL(
      "../../../../paws-bots/packages/adapters/src/paws-session-tools.ts",
      import.meta.url,
    ).href
  );
  const state = new GatewayState();
  const chiefId = "c" + "a".repeat(24),
    spaceId = "space";
  const config = {
    publicOrigin: "https://bots.test",
    parentOrigins: ["https://paws.test"],
    webUrl: new URL("http://127.0.0.1:9"),
    apiUrl: new URL("http://127.0.0.1:9"),
    bridgeSecret: "test-only-bridge-secret".repeat(2),
    identitySecret: "test-only-identity-secret".repeat(2),
  };
  const { server } = createGateway(config, { state });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const ticket = state.issue(
    { accountKey: chiefId, spaceId },
    { parentOrigin: "https://paws.test", platform: "web" },
  );
  const lease = state.redeem(ticket.ticket, "https://paws.test", "web");
  if (!lease) throw new Error("fixture lease missing");
  const key = new Uint8Array(32).fill(7);
  let active = true,
    seq = 0,
    resumes = 0,
    sends = 0;
  const stored: Array<{ seq: number; ciphertext: Uint8Array }> = [];
  const append = (value: unknown) =>
    stored.push({ seq: ++seq, ciphertext: encrypt(key, "dataKey", value) });
  const snapshot = () => ({
    id: "session",
    seq,
    active,
    metadata: {
      machineId: "machine",
      codexThreadId: "thread",
      summary: { text: "Remote fix" },
    },
    agentState: { turnStatus: { status: "completed" } },
  });
  const host = createSessionSteward({
    current: () => true,
    list: async () => ({
      sessions: [snapshot()],
      nextCursor: null,
      hasNext: false,
    }),
    get: async () => snapshot(),
    history: async (_id, input) => ({
      messages: stored
        .filter(
          (row) => input.afterSeq === undefined || row.seq > input.afterSeq,
        )
        .map((row) => ({
          id: String(row.seq),
          seq: row.seq,
          createdAt: row.seq,
          content: decrypt(key, "dataKey", row.ciphertext),
        })),
      hasMore: false,
    }),
    send: async (_id, text) => {
      sends++;
      append({ role: "user", content: { type: "text", text } });
      append({
        role: "session",
        content: {
          id: "start",
          time: 1,
          role: "agent",
          turn: "remote-turn",
          ev: { t: "turn-start", localIds: ["input-id"] },
        },
      });
      append({
        role: "session",
        content: {
          id: "reply",
          time: 2,
          role: "agent",
          turn: "remote-turn",
          ev: { t: "text", text: "remote-result-marker" },
        },
      });
      append({
        role: "session",
        content: {
          id: "end",
          time: 3,
          role: "agent",
          turn: "remote-turn",
          ev: { t: "turn-end", status: "completed" },
        },
      });
      return { localIds: ["input-id"] };
    },
    resume: async () => {
      resumes++;
      active = true;
      return { type: "success", sessionId: "session" };
    },
    waitForChange: async () => false,
  });
  const abort = new AbortController();
  let ready!: () => void;
  const connected = new Promise<void>((resolve) => (ready = resolve));
  const browserFetch: typeof fetch = async (input, init) => {
    const response = await fetch(new URL(String(input), base), {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init?.headers)),
        origin: "https://paws.test",
        "x-paws-rakazo-session": lease.sessionKey,
      },
    });
    if (String(input).endsWith("/stream")) ready();
    return response;
  };
  const serving = serveSessionTools(
    browserFetch,
    host.execute,
    abort.signal,
  ).catch(() => {});
  const env = {
    PAWS_BOTS_SESSION_TOOLS_URL: base,
    PAWS_BOTS_BRIDGE_SECRET: config.bridgeSecret,
  };
  const tool = (id: string, tool: string, args: Record<string, unknown>) =>
    callPawsSessionTool(
      { chiefId, spaceId, id, tool, args },
      abort.signal,
      env,
    ) as Promise<any>;
  try {
    await connected;
    const catalog = await tool("list", "paws_sessions_list", {});
    expect(catalog.sessions[0].title).toBe("Remote fix");
    const connectionId = catalog.connectionId;
    expect(typeof connectionId).toBe("string");
    const sent = await tool("send", "paws_session_send", {
      connectionId,
      sessionId: "session",
      text: "fix it",
    });
    expect(sent.status).toBe("queued");
    const result = await tool("result", "paws_session_result", {
      connectionId,
      sessionId: "session",
      commandId: sent.commandId,
    });
    expect(result).toMatchObject({
      status: "completed",
      turnId: "remote-turn",
    });
    expect(JSON.stringify(result)).toContain("remote-result-marker");
    const history = await tool("read", "paws_session_read", {
      connectionId,
      sessionId: "session",
    });
    expect(history.messages).toHaveLength(4);
    active = false;
    expect(
      await tool("resume", "paws_session_resume", {
        connectionId,
        sessionId: "session",
      }),
    ).toMatchObject({ status: "launch-acknowledged" });
    expect(sends).toBe(1);
    expect(resumes).toBe(1);
    expect(JSON.stringify([catalog, sent, result, history])).not.toContain(
      config.bridgeSecret,
    );
  } finally {
    abort.abort();
    await serving;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
