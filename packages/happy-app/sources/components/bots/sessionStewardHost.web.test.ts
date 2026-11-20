import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSessionStewardHost } from "./sessionStewardHost.web";

const state = vi.hoisted(() => {
  const detached = {
    decryptMetadata: vi.fn(async () => ({ flavor: "codex", summary: { text: "Test" } })),
    decryptAgentState: vi.fn(async () => ({})),
    decryptMessages: vi.fn(async () => []),
  };
  return {
    credentials: { token: "test-only" },
    encryption: { getSessionEncryption: () => ({ createDetached: () => detached }) },
    request: vi.fn(async (path: string) => {
      const cursor = Number(new URL(path, "https://test.invalid").searchParams.get("before_seq"));
      // The real messages table stores seq as PostgreSQL int4.
      return cursor > 2_147_483_647
        ? new Response(null, { status: 500 })
        : Response.json({ messages: [], hasMore: false });
    }),
  };
});
vi.mock("@/sync/messageMeta", () => ({ resolveMessageModeMeta: vi.fn() }));
vi.mock("@/sync/apiSessions", () => ({
  fetchSessionSnapshot: vi.fn(async () => ({ id: "test", seq: 1, active: true, metadata: "encrypted", metadataVersion: 1, agentState: null, agentStateVersion: 0 })),
  fetchSessionSnapshotPage: vi.fn(),
}));
vi.mock("@/sync/apiSocket", () => ({ apiSocket: { request: state.request } }));
vi.mock("@/sync/storage", () => ({ storage: { getState: () => ({ sessions: {}, machines: {}, settings: {} }) } }));
vi.mock("@/sync/sync", () => ({ sync: { encryption: state.encryption, getCredentials: () => state.credentials, ensureSessionHydrated: async () => true } }));
vi.mock("@/sync/ops", () => ({ machineResumeSession: vi.fn() }));
vi.mock("@/utils/machineUtils", () => ({ isMachineOnline: vi.fn() }));
vi.mock("@/utils/sessionResumeAvailability", () => ({ resolveSessionResumeAvailability: vi.fn() }));
vi.mock("@/sync/serverConfig", () => ({ getServerUrl: () => "https://test.invalid" }));

beforeEach(() => { vi.stubGlobal("window", new EventTarget()); state.request.mockClear(); });
afterEach(() => vi.unstubAllGlobals());
it("reads initial history within the server int4 range and preserves older-page cursors", async () => {
  const host = createSessionStewardHost();
  try {
    const result = await host.execute({ id: "first", tool: "paws_session_read", args: { sessionId: "test" } }, new AbortController().signal);
    expect(result).not.toHaveProperty("error");
    expect(new URL(state.request.mock.calls[0][0], "https://test.invalid").searchParams.get("before_seq")).toBe("2147483647");
    await host.execute({ id: "older", tool: "paws_session_read", args: { sessionId: "test", beforeSeq: 17 } }, new AbortController().signal);
    expect(new URL(state.request.mock.calls[1][0], "https://test.invalid").searchParams.get("before_seq")).toBe("17");
  } finally { host.dispose(); }
});
