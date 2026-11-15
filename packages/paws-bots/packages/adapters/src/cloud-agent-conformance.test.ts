import type { AdapterContext, CloudAgentProvider } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { CursorCloudAgentEmulator, EmulatorCloudAgentProvider } from "./cloud-agent-emulator.js";
import { cloudAgentsEnabled, createCloudAgentConnection } from "./cloud-agent-factory.js";
import { resolveCloudAgentProvider } from "./cloud-agent-provider-env.js";
import { CursorCloudAgentProvider } from "./cursor-cloud-agent.js";
import { T3CodeCloudAgentProvider } from "./t3code-cloud-agent.js";
import { T3_TOKEN, T3McpEmulator } from "./t3code-mcp-emulator.test-support.js";

const ctx: AdapterContext = {
  operationId: "operation",
  traceId: "trace",
  spaceId: "test-space",
  userId: "test-user",
  signal: new AbortController().signal,
};

interface Emulated {
  provider: CloudAgentProvider;
  complete: (id: string, failed?: boolean) => void;
}

// Every live provider runs this suite over an offline emulator of its wire protocol.
const providers: Array<{
  name: string;
  /** Cursor refuses a follow-up while a run is busy; T3 Code queues it as the next run. */
  busyReply: "rejects" | "queues";
  /** T3 Code may start the next run itself once one finishes, so a newer active run is followed. */
  followsNewerRun: boolean;
  create: () => Emulated;
}> = [
  {
    name: "Cursor",
    busyReply: "rejects",
    followsNewerRun: false,
    create() {
      const provider = new EmulatorCloudAgentProvider(
        new CursorCloudAgentEmulator({ autoFinishAfterGets: null }),
      );
      return {
        provider,
        complete: (id, failed = false) => provider.emulator.complete(id, { failed }),
      };
    },
  },
  {
    name: "T3 Code MCP",
    busyReply: "queues",
    followsNewerRun: true,
    create() {
      const emulator = new T3McpEmulator();
      return {
        provider: new T3CodeCloudAgentProvider({
          endpoint: "https://t3.example.test/mcp",
          token: T3_TOKEN,
          fetch: emulator.fetch,
          resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
        }),
        complete: (id, failed = false) => emulator.complete(id, failed ? "failed" : "completed"),
      };
    },
  },
];

describe.each(providers)(
  "cloud agent conformance over the $name wire emulator (offline)",
  ({ create, busyReply, followsNewerRun }) => {
    it("replays launch without duplicate agents and preserves a finished run through a follow-up", async () => {
      const { provider, complete } = create();
      const request = {
        idempotencyKey: "create-1",
        prompt: "Add a README",
        repository: "https://github.com/example/demo",
        openPr: true,
      };
      const first = await provider.launch(request, ctx);
      expect(first.status).toBe("running");
      expect((await provider.launch(request, ctx)).id).toBe(first.id);
      complete(first.id);
      const done = await provider.get(first.id, ctx);
      expect(done).toMatchObject({ status: "finished", branch: "emulator/task" });
      expect(done.prUrl).toContain("/pull/");
      const followup = await provider.reply(first.id, { prompt: "Also add tests" }, ctx);
      expect(followup.latestRunId).not.toBe(first.latestRunId);
      expect((await provider.get(first.id, ctx, first.latestRunId)).status).toBe(
        followsNewerRun ? "running" : "finished",
      );
      expect((await provider.get(first.id, ctx, followup.latestRunId)).status).toBe("running");
      // A run may end only once the agent stops; the poll asks again until it has.
      expect(["running", "cancelled"]).toContain((await provider.cancel(first.id, ctx)).status);
      expect((await provider.cancel(first.id, ctx)).status).toBe("cancelled");
    });
    it(`${busyReply === "rejects" ? "rejects" : "queues"} a follow-up while busy and observes failures`, async () => {
      const { provider, complete } = create();
      const first = await provider.launch({ idempotencyKey: "busy", prompt: "Task" }, ctx);
      const busy = provider.reply(first.id, { prompt: "Busy" }, ctx);
      if (busyReply === "rejects") await expect(busy).rejects.toThrow();
      else {
        const queued = await busy;
        expect(queued.latestRunId).not.toBe(first.latestRunId);
        expect((await provider.get(first.id, ctx, queued.latestRunId)).status).toBe("running");
      }
      complete(first.id, true);
      expect((await provider.get(first.id, ctx, first.latestRunId)).status).toBe("failed");
    });
    it("honors abort and does not open a PR when disabled", async () => {
      const { provider, complete } = create();
      await expect(
        provider.launch(
          { idempotencyKey: "aborted", prompt: "Task" },
          { ...ctx, signal: AbortSignal.abort() },
        ),
      ).rejects.toThrow();
      const first = await provider.launch(
        {
          idempotencyKey: "no-pr",
          prompt: "Task",
          openPr: false,
        },
        ctx,
      );
      complete(first.id);
      expect((await provider.get(first.id, ctx)).prUrl).toBeUndefined();
    });
  },
);

describe("cloud agent composition", () => {
  it("fails closed without explicit credential and Space configuration", () => {
    for (const source of [
      {},
      { CLOUD_AGENT_PROVIDER: "bogus" },
      { CLOUD_AGENT_PROVIDER: "cursor" },
      { CLOUD_AGENT_PROVIDER: "cursor", CURSOR_API_KEY: "fake-key" },
    ]) {
      expect(resolveCloudAgentProvider(source)).toBe("none");
      expect(createCloudAgentConnection(source)).toBeNull();
    }
    const connection = createCloudAgentConnection({
      CLOUD_AGENT_PROVIDER: "cursor",
      CURSOR_API_KEY: "fake-key",
      CLOUD_AGENT_SPACE_ID: "test-space",
    })!;
    expect(cloudAgentsEnabled(connection, "test-space")).toBe(true);
    expect(cloudAgentsEnabled(connection, "other-space")).toBe(false);
    expect(connection.key).not.toContain("fake-key");
    const rotated = createCloudAgentConnection({
      CLOUD_AGENT_PROVIDER: "cursor",
      CURSOR_API_KEY: "other-fake-key",
      CLOUD_AGENT_SPACE_ID: "test-space",
    })!;
    expect(rotated.key).not.toBe(connection.key);
  });
  it("never grants an unscoped live provider access", () => {
    expect(
      cloudAgentsEnabled(
        { provider: new CursorCloudAgentProvider({ apiKey: "fake-key" }), key: "test" },
        "test-space",
      ),
    ).toBe(false);
    expect(
      cloudAgentsEnabled(
        createCloudAgentConnection({ CLOUD_AGENT_PROVIDER: "emulator" }),
        "test-space",
      ),
    ).toBe(true);
  });
});
