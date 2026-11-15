import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import { serializeModelSecret } from "./model-secret.js";
import { OAUTH_RECONNECT_REQUIRED_ERROR } from "./pi-oauth.js";
import { promptVersion } from "./prompt-version.js";
import { withModelRoles } from "./testing/model-roles.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  acquireDedicatedScreenLeaseFence: async (
    _prisma: unknown,
    input: { computerId: string; botId: string; runId: string },
  ) => ({ ...input, fence: 7 }),
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
  renewComputerExecutionLease: async () => true,
}));

const USER_ID = "user-1";
const PRIMARY = { provider: "openai-codex", modelId: "gpt-6-luna" };
const BACKUP = { provider: "openrouter", modelId: "openai/gpt-4o" };
const stamp = new Date("2026-08-30T00:00:00.000Z");

type Credential = {
  id: string;
  userId: string;
  provider: string;
  label: string;
  secretId: string;
  supportsImages: boolean;
  createdAt: Date;
  updatedAt: Date;
};
type ProviderFilter = string | { in: string[] };

const matchesProvider = (filter: ProviderFilter | undefined, provider: string) =>
  filter === undefined ||
  (typeof filter === "string" ? filter === provider : filter.in.includes(provider));

function connection(provider: string, secretId: string): Credential {
  return {
    id: `credential-${provider}`,
    userId: USER_ID,
    provider,
    label: provider,
    secretId,
    supportsImages: false,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

const plaintexts: Record<string, string> = {
  "secret-primary": serializeModelSecret({
    kind: "oauth",
    credential: { type: "oauth", access: "fake-access", refresh: "fake-refresh", expires: 1 },
  }),
  "secret-backup": serializeModelSecret({ kind: "api_key", key: "fake-backup-key" }),
};

/**
 * Runs one unpinned turn for a member whose main model is PRIMARY with BACKUP after it.
 * `primaryConnected` keeps PRIMARY's connection; `backupConnected` keeps BACKUP's.
 */
async function runTurn({
  primaryConnected,
  backupConnected = true,
}: {
  primaryConnected: boolean;
  backupConnected?: boolean;
}) {
  const run: Record<string, unknown> = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: USER_ID,
    status: "queued",
    trigger: "user",
    leaseFence: 0,
  };
  const state = {
    credentials: [
      ...(primaryConnected ? [connection(PRIMARY.provider, "secret-primary")] : []),
      ...(backupConnected ? [connection(BACKUP.provider, "secret-backup")] : []),
    ],
    secrets: ["secret-primary", "secret-backup"].map((id) => ({
      id,
      userId: USER_ID,
      spaceId: null,
      kind: "model",
      ciphertext: `cipher-${id}`,
    })),
  };
  const credentialsFor = (where: { userId?: string; provider?: ProviderFilter }) =>
    state.credentials.filter(
      (row) => row.userId === where.userId && matchesProvider(where.provider, row.provider),
    );
  const tx = {
    userModelCredential: {
      findFirst: vi.fn(
        async (args: { where: { id: string } }) =>
          state.credentials.find((row) => row.id === args.where.id) ?? null,
      ),
      delete: vi.fn(async (args: { where: { id: string } }) => {
        const index = state.credentials.findIndex((row) => row.id === args.where.id);
        return index < 0 ? null : state.credentials.splice(index, 1)[0];
      }),
      count: vi.fn(async () => 0),
    },
    userVoiceCredential: { count: vi.fn(async () => 0) },
    $executeRaw: vi.fn(async () => 0),
    secret: {
      findFirst: vi.fn(
        async (args: { where: { id: string } }) =>
          state.secrets.find((row) => row.id === args.where.id) ?? null,
      ),
      findUnique: vi.fn(
        async (args: { where: { id: string } }) =>
          state.secrets.find((row) => row.id === args.where.id) ?? null,
      ),
      deleteMany: vi.fn(async (args: { where: { id: string } }) => {
        state.secrets = state.secrets.filter((row) => row.id !== args.where.id);
        return { count: 1 };
      }),
      update: vi.fn(async () => null),
    },
  };
  let request: AgentRunRequest | undefined;
  const runtimeRun = vi.fn(async function* (next: AgentRunRequest) {
    request = next;
    yield { type: "done" as const, text: "Done" };
  });
  const prisma = withModelRoles(
    {
      $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
      user: { findUnique: vi.fn(async () => null) },
      spaceMember: { findUnique: async () => ({ id: "member-1" }) },
      run: {
        findUnique: vi.fn(async () => run),
        findUniqueOrThrow: vi.fn(async () => run),
        findFirst: vi.fn(async () => ({
          bot: { notifyOnFinish: false },
          thread: { groupId: null },
        })),
        updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(run, data);
          return { count: 1 };
        }),
      },
      chatGroup: { findMany: vi.fn(async () => []) },
      bot: {
        findUniqueOrThrow: vi.fn(async () => ({
          id: "bot-1",
          name: "Assistant",
          title: "Assistant",
          description: "Test assistant",
          modelProvider: null,
          modelId: null,
          thinkingLevel: null,
          computerId: "computer-1",
          computerSwitching: false,
          memoryScope: null,
          computer: { id: "computer-1", scope: "dedicated" },
        })),
        findMany: vi.fn(async () => []),
      },
      attempt: {
        create: vi.fn(async () => ({ id: "attempt-1" })),
        update: vi.fn(),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      thread: {
        findUniqueOrThrow: vi.fn(async () => ({
          id: "thread-1",
          groupId: null,
          historyCompactionSummary: null,
          historyCompactedUpToSeq: null,
          nextMessageSeq: 2,
        })),
      },
      message: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        findFirst: vi.fn(async () => null),
      },
      task: { findUniqueOrThrow: vi.fn(async () => ({ id: "task-1", prompt: "hello" })) },
      computer: { updateMany: vi.fn(async () => ({ count: 1 })) },
      connection: { findMany: vi.fn(async () => []) },
      userModelPreference: {
        findMany: vi.fn(async () => []),
        findFirst: vi.fn(async () => null),
      },
      userModelCredential: {
        findMany: vi.fn(
          async ({ where }: { where: { userId?: string; provider?: ProviderFilter } }) =>
            credentialsFor(where),
        ),
        findFirst: vi.fn(async () => null),
      },
      secret: {
        findMany: vi.fn(async () => []),
        findFirst: vi.fn(
          async (args: { where: { id: string } }) =>
            state.secrets.find((row) => row.id === args.where.id) ?? null,
        ),
      },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
      taughtSkill: { findMany: vi.fn(async () => []) },
      vaultCredential: { findMany: vi.fn(async () => []) },
      agentSkill: { findMany: vi.fn(async () => []) },
      scratchpadItem: { findMany: vi.fn(async () => []) },
      externalEffect: { findMany: vi.fn(async () => []) },
      userActionApprovalRule: { findMany: vi.fn(async () => []) },
      userActionAutoReviewPreference: { findUnique: vi.fn(async () => null) },
      artifact: { findMany: vi.fn(async () => []) },
    },
    [
      { userId: USER_ID, role: "main", position: 0, thinkingLevel: null, ...PRIMARY },
      { userId: USER_ID, role: "main", position: 1, thinkingLevel: null, ...BACKUP },
    ],
  );
  // The run's lease runs in a transaction too.
  Object.assign(tx, {
    $queryRaw: vi.fn(async () => []),
    space: { findUnique: vi.fn(async () => null) },
    run: prisma.run,
  });
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const executor = createRunExecutor({
    prisma,
    billingEnabled: false,
    secretStore: {
      load: vi.fn(async (_ciphertext: string, secretId: string) => plaintexts[secretId]),
      put: vi.fn(async () => ({ ciphertext: "sealed-marker" })),
      delete: vi.fn(async () => undefined),
    },
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    sandbox: {
      describe: () => ({ capabilities: { graphical: false } }),
      listFiles: vi.fn(async () => []),
      readFile: vi.fn().mockRejectedValue(new Error("missing")),
      exportWorkspace: vi.fn(async function* () {
        yield* [];
      }),
    },
    home: { commit: vi.fn(async () => "fixture-revision") },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    events: { append: vi.fn(async () => undefined), finalizeRun },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  await executor.continueRun("run-1", "worker-1");
  return { request, run, runtimeRun, finalizeRun };
}

describe("a main model that cannot start runs on the member's backup", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts on the backup when the main model has no connection", async () => {
    const { request, run, finalizeRun } = await runTurn({ primaryConnected: false });

    expect(request?.model).toMatchObject({
      provider: BACKUP.provider,
      id: BACKUP.modelId,
      apiKey: "fake-backup-key",
    });
    expect(request?.fallbackModels).toEqual([]);
    expect(run).toMatchObject({
      modelProvider: BACKUP.provider,
      modelId: BACKUP.modelId,
      promptVersion: promptVersion(),
    });
    expect(finalizeRun).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
  });

  it("starts on the backup when the provider rejects the main model's sign-in", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "invalid_grant", error_description: "revoked" }), {
          status: 400,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { request, run, finalizeRun } = await runTurn({ primaryConnected: true });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(request?.model).toMatchObject({ provider: BACKUP.provider, id: BACKUP.modelId });
    expect(request?.model.oauth).toBeUndefined();
    expect(run).toMatchObject({ modelProvider: BACKUP.provider, modelId: BACKUP.modelId });
    expect(finalizeRun).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
  });

  it("fails as before when no backup can start either", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "invalid_grant", error_description: "revoked" }), {
            status: 400,
          }),
      ),
    );

    const { runtimeRun, finalizeRun } = await runTurn({
      primaryConnected: true,
      backupConnected: false,
    });

    expect(runtimeRun).not.toHaveBeenCalled();
    expect(finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failed", error: OAUTH_RECONNECT_REQUIRED_ERROR }),
    );
  });
});
