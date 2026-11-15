import type { ComputerRef } from "@rakazo/adapter-kit";
import { encodeLoginSecret } from "@rakazo/contracts";
import { runLoginKind } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeRunLogin } from "./bot-secrets.js";
import { builtinAgentTools } from "./builtin-tools.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import { EncryptedSecretStore } from "./secrets.js";

const COMPUTER: ComputerRef = {
  id: "sandbox-1",
  botId: "home-1",
  kind: "e2b",
  providerRef: "sandbox-1",
};

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  acquireDedicatedScreenLeaseFence: async () => null,
  provisionComputer: async () => COMPUTER,
}));

type ExecuteTool = (
  name: string,
  args: Record<string, unknown>,
  executionId: string,
) => Promise<unknown>;

/** Every database call, by model and method, so a test can check what was written anywhere. */
function recordingPrisma(models: Record<string, Record<string, unknown>>, calls: unknown[]) {
  const fallback: Record<string, (...args: unknown[]) => unknown> = {
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
    count: async () => 0,
    updateMany: async () => ({ count: 0 }),
  };
  const prisma: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_target, model: string) => {
        if (model === "$transaction") {
          return async (fn: (tx: unknown) => unknown) => fn(prisma);
        }
        // The member's settings lock always finds the membership row.
        if (model === "$queryRaw") return async () => [{ locked: 1 }];
        const methods = models[model] ?? {};
        return new Proxy(methods, {
          get: (target, method: string) => {
            const impl = (target[method] ?? fallback[method]) as
              | ((...args: unknown[]) => unknown)
              | undefined;
            return async (...args: unknown[]) => {
              calls.push([model, method, args]);
              return impl ? impl(...args) : null;
            };
          },
        });
      },
    },
  );
  return prisma;
}

const ORIGIN = "https://login.example.test";
const DESTINATION = { name: "site_login", origin: ORIGIN, auth: { type: "login" } };
const secretStore = new EncryptedSecretStore("test-only-encryption-key");
const scope = { userId: "user-1", spaceId: "space-1", botId: "bot-1" };

/** A login a run kept with "Save to Vault" off, as the answer stores it. */
async function runLogin(runId: string, origin = ORIGIN) {
  const stored = await secretStore.put(
    encodeRunLogin(
      origin,
      encodeLoginSecret({
        fields: [
          { label: "Username", value: "fake-user", hidden: false },
          { label: "Password", value: "fake-password-1", hidden: true },
        ],
      }),
    ),
    { ...scope, operationId: runId, traceId: runId, signal: new AbortController().signal },
    { ephemeral: true },
  );
  return {
    ...stored,
    userId: scope.userId,
    spaceId: scope.spaceId,
    kind: runLoginKind(runId, "site_login"),
  };
}

/** One run of the bot calling one tool, with an optional card the person already answered. */
async function runTool(
  call: { name: string; args: Record<string, unknown> },
  options: {
    answered?: Record<string, unknown>;
    secrets?: Array<Record<string, unknown>>;
    /** A login already saved in the vault under the requested name. */
    saved?: Record<string, unknown>;
    /** Every credential saved in the vault, when there is more than the requested one. */
    vault?: Array<Record<string, unknown>>;
    /** What the shell prints. */
    printed?: string;
  } = {},
) {
  const run = {
    id: "run-1",
    botId: scope.botId,
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: scope.spaceId,
    userId: scope.userId,
    status: "queued",
    trigger: "message",
    routineId: null,
    retryOfRunId: null,
    leaseFence: 0,
  };
  const calls: unknown[] = [];
  const toolResults: unknown[] = [];
  const pauseRunForInput = vi.fn(async (_input: { blocks: unknown[] }) => true);
  const runtimeRun = vi.fn(async function* (request: { executeTool?: ExecuteTool }) {
    toolResults.push(
      await request
        .executeTool?.(call.name, call.args, "exec-1")
        .catch((error: unknown) => ({ thrown: (error as Error).message })),
    );
    yield { type: "done" as const, text: "" };
  });
  const secrets = options.secrets ?? [];
  const matches = (row: Record<string, unknown>, where: Record<string, unknown> = {}) =>
    Object.entries(where).every(([key, value]) =>
      value && typeof value === "object" && "startsWith" in value
        ? String(row[key]).startsWith(String(value.startsWith))
        : row[key] === value,
    );
  const vault = options.vault ?? (options.saved ? [options.saved] : []);
  const inVault = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
    (["name", "origin"] as const).every((key) => !(key in where) || row[key] === where[key]) &&
    (!where.alsoOn ||
      ((row.alsoOn as string[] | undefined) ?? []).includes(
        (where.alsoOn as { has: string }).has,
      )) &&
    (!where.OR || (where.OR as Record<string, unknown>[]).some((branch) => inVault(row, branch))) &&
    (!where.AND ||
      (where.AND as Record<string, unknown>[]).every((branch) => inVault(row, branch)));
  const prisma = recordingPrisma(
    {
      spaceMember: { findUnique: async () => ({ id: "member-1" }) },
      run: {
        findUnique: async () => run,
        findUniqueOrThrow: async () => run,
        findFirst: async () => ({ bot: { notifyOnFinish: false }, thread: { groupId: null } }),
        updateMany: async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(run, data);
          return { count: 1 };
        },
      },
      bot: {
        findUniqueOrThrow: async () => ({
          id: run.botId,
          name: "Assistant",
          title: "Assistant",
          description: "Test assistant",
          modelProvider: null,
          modelId: null,
          thinkingLevel: null,
          computerId: "computer-1",
          computerSwitching: false,
          memoryScope: null,
          computer: { id: "computer-1", scope: "dedicated", kind: "e2b", homeKey: "home-1" },
        }),
        findMany: async () => [],
      },
      attempt: {
        create: async () => ({ id: "attempt-1" }),
        updateMany: async () => ({ count: 1 }),
      },
      thread: {
        findUniqueOrThrow: async () => ({
          id: run.threadId,
          groupId: null,
          historyCompactionSummary: null,
          historyCompactedUpToSeq: null,
          nextMessageSeq: 1,
        }),
        update: async () => ({ nextMessageSeq: 1, nextEventSeq: 1 }),
      },
      message: { create: async ({ data }: { data: object }) => ({ id: "message-1", ...data }) },
      event: { create: async ({ data }: { data: object }) => ({ seq: 1, ...data }) },
      task: { findUniqueOrThrow: async () => ({ id: run.taskId, prompt: "Sign in to the site" }) },
      vaultCredential: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) =>
          vault.find((row) => inVault(row, where)) ?? null,
        findMany: async ({ where }: { where: Record<string, unknown> }) =>
          vault.filter((row) => inVault(row, where)),
      },
      secret: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) =>
          secrets.find((row) => matches(row, where)) ?? null,
        findMany: async ({ where }: { where: Record<string, unknown> }) =>
          secrets.filter((row) => matches(row, where)),
        count: async ({ where }: { where: Record<string, unknown> }) =>
          secrets.filter((row) => matches(row, where)).length,
        deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
          const kept = secrets.filter((row) => !matches(row, where));
          const count = secrets.length - kept.length;
          secrets.splice(0, secrets.length, ...kept);
          return { count };
        },
      },
      deploymentSettings: {
        findUnique: async () => ({
          defaultModelProvider: "local",
          defaultModelId: "local-model",
        }),
      },
      // These runs act without approval cards; the card flow has its own tests.
      actionAutoReviewPreference: {
        findUnique: async () => ({ enabled: false, skipApprovals: true }),
      },
      userActionAutoReviewPreference: {
        findUnique: async () => ({ enabled: false, skipApprovals: true }),
      },
      externalEffect: {
        findUnique: async () =>
          options.answered
            ? {
                id: "effect-1",
                runId: run.id,
                spaceId: run.spaceId,
                kind: call.name,
                status: "approved",
                request: call.args,
                ...options.answered,
              }
            : null,
        create: async ({ data }: { data: Record<string, unknown> }) => ({
          id: `effect-${data.idempotencyKey}`,
          ...data,
        }),
        updateMany: async () => ({ count: 1 }),
      },
    },
    calls,
  );
  const executor = createRunExecutor({
    prisma,
    deploymentModelKey: "fake-deployment-key",
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    sandbox: {
      describe: () => ({ id: "e2b", capabilities: { graphical: true } }),
      releaseScreen: vi.fn(async () => undefined),
      execute: vi.fn(async function* () {
        if (options.printed) yield { type: "stdout" as const, data: options.printed };
        yield { type: "exit" as const, code: 0 };
      }),
      async *exportWorkspace() {
        yield* [];
      },
    },
    secretStore,
    home: { commit: vi.fn(async () => "fixture-revision") },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    artifacts: { get: vi.fn() },
    events: {
      append: vi.fn(async () => undefined),
      finalizeRun: vi.fn(async () => ({ continuationRunId: null })),
      pauseRunForTakeover: vi.fn(async () => false),
      pauseRunForInput,
      notify: vi.fn(async () => undefined),
    },
    jobs: { enqueue: vi.fn(async () => undefined) },
    notifications: { send: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  await executor.continueRun(run.id, "worker-1");
  return {
    toolResults,
    calls,
    cards: pauseRunForInput.mock.calls.flatMap(([input]) => input.blocks),
  };
}

const requestLogin = (extra: Record<string, unknown> = {}) => ({
  name: "request_secret",
  args: { label: "Sign in", purpose: "password", credential: DESTINATION, ...extra },
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("request_secret for a website login", () => {
  it("tells the bot a login may not be saved", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "request_secret")!;
    expect(tool.description).toContain("The user may choose not to save a login");
  });

  it("returns a saved login as before", async () => {
    const { toolResults } = await runTool(requestLogin(), {
      answered: { result: { credentialSaved: DESTINATION } },
      saved: { ...DESTINATION },
    });
    expect(toolResults).toEqual([{ saved: true, ...DESTINATION }]);
  });

  it("tells the bot a login sent with Save to Vault off is not saved, without its values", async () => {
    const { toolResults, calls } = await runTool(requestLogin(), {
      answered: { result: { credentialSaved: DESTINATION } },
      secrets: [await runLogin("run-1")],
    });
    expect(toolResults).toEqual([
      {
        saved: false,
        ...DESTINATION,
        fields: [
          { label: "Username", hidden: false },
          { label: "Password", hidden: true },
        ],
      },
    ]);
    expect(JSON.stringify(toolResults)).not.toContain("fake-password-1");
    expect(JSON.stringify(calls)).not.toContain("fake-password-1");
  });

  it("opens the card again for a login this run kept for another site", async () => {
    const { toolResults } = await runTool(requestLogin(), {
      secrets: [await runLogin("run-1", "https://old-login.example.test")],
    });
    expect(toolResults).toMatchObject([{ details: { secret: "paused" } }]);
  });

  it("opens the card again in a later run", async () => {
    const { toolResults } = await runTool(requestLogin(), {
      secrets: [await runLogin("run-0")],
    });
    expect(toolResults).toMatchObject([{ details: { secret: "paused" } }]);
  });

  describe("saved for the same site under another name", () => {
    const savedLogin = { name: "brand_login", origin: ORIGIN, auth: { type: "login" } };
    const paused = [{ details: { secret: "paused" } }];

    it("returns that login's name instead of asking again", async () => {
      const { toolResults, calls } = await runTool(requestLogin(), { vault: [savedLogin] });
      expect(toolResults).toEqual([{ saved: true, ...savedLogin }]);
      // Settled without a card, as for a login saved under the requested name.
      expect(JSON.stringify(calls)).toContain(
        '"data":{"status":"completed","result":{"saved":true,"name":"brand_login"',
      );
    });

    it("asks when two logins are saved for the site", async () => {
      const { toolResults } = await runTool(requestLogin(), {
        vault: [savedLogin, { ...savedLogin, name: "brand_login_2" }],
      });
      expect(toolResults).toMatchObject(paused);
    });

    it.each([
      ["another site", "https://other.example.test"],
      ["the same host with www.", "https://www.login.example.test"],
      ["the same host on another port", "https://login.example.test:8443"],
    ])("asks when the login is saved for %s", async (_case, origin) => {
      const { toolResults } = await runTool(requestLogin(), {
        vault: [{ ...savedLogin, origin }],
      });
      expect(toolResults).toMatchObject(paused);
    });

    it("passes over a saved row that no longer reads as a credential", async () => {
      const unreadable = { ...savedLogin, name: "Old Login!" };
      const reused = await runTool(requestLogin(), { vault: [unreadable, savedLogin] });
      expect(reused.toolResults).toEqual([{ saved: true, ...savedLogin }]);
      const asked = await runTool(requestLogin(), { vault: [unreadable] });
      expect(asked.toolResults).toMatchObject(paused);
    });

    it("asks when the bot asks to replace it", async () => {
      const { toolResults } = await runTool(requestLogin({ replace: true }), {
        vault: [savedLogin],
      });
      expect(toolResults).toMatchObject(paused);
    });

    it("leaves other credentials of the site to their own names", async () => {
      const { toolResults } = await runTool(
        requestLogin({ credential: { ...DESTINATION, auth: { type: "bearer" } } }),
        { vault: [savedLogin, { name: "brand_key", origin: ORIGIN, auth: { type: "bearer" } }] },
      );
      expect(toolResults).toMatchObject(paused);
    });

    it("is not used for a command variable", async () => {
      const { toolResults } = await runTool(
        requestLogin({ credential: { name: "deploy_key", auth: { type: "command" } } }),
        { vault: [savedLogin, { name: "brand_token", origin: "", auth: { type: "command" } }] },
      );
      expect(toolResults).toMatchObject(paused);
    });
  });

  it("can't be told by the bot whether to save the login", async () => {
    const { toolResults, calls } = await runTool(
      requestLogin({ remember: false, persist: false, save: false, once: true }),
    );
    // The card opens as usual, with the switch on; what is kept is decided only by the person.
    expect(toolResults).toMatchObject([{ details: { secret: "paused" } }]);
    expect(JSON.stringify(calls)).toContain('"kind":"request_secret"');
    expect(JSON.stringify(calls)).not.toContain('"secret","create"');
    expect(JSON.stringify(calls)).not.toContain('"vaultCredential","create"');
  });
});

describe("request_secret for a login saved for another site", () => {
  const SAVED = { id: "saved-login-1", ...DESTINATION, origin: "https://www.example.test" };
  const vaultWrites = (calls: unknown[]) =>
    JSON.stringify(calls).match(/"vaultCredential","(create|update|delete|deleteMany)"/g);

  it("names the saved site and both ways on, without removing anything", async () => {
    const { toolResults, calls, cards } = await runTool(requestLogin(), { saved: SAVED });
    expect(toolResults).toEqual([
      {
        error:
          "A login named site_login is saved for https://www.example.test. For a different site or account, use another name; ask again with replace true only if https://www.example.test was the wrong site for this same account, which replaces the saved login.",
      },
    ]);
    expect(JSON.stringify(toolResults)).not.toMatch(
      /forget_secret|Remove the existing|login\.example/,
    );
    expect(cards).toEqual([]);
    expect(vaultWrites(calls)).toBeNull();
  });

  it("reuses the login on one of its other sites, by its name or another, and never moves it", async () => {
    const both = { ...SAVED, alsoOn: [ORIGIN] };
    for (const credential of [DESTINATION, { ...DESTINATION, name: "other_name" }]) {
      const { toolResults, calls, cards } = await runTool(requestLogin({ credential }), {
        saved: both,
      });
      expect(toolResults).toEqual([
        expect.objectContaining({ saved: true, name: "site_login", origin: SAVED.origin }),
      ]);
      expect(cards).toEqual([]);
      expect(vaultWrites(calls)).toBeNull();
    }
    // With replace, the card asks for the login at its own site, not a move to this one.
    const { cards } = await runTool(requestLogin({ replace: true }), { saved: both });
    expect(cards).toEqual([
      expect.objectContaining({ credential: { ...DESTINATION, origin: SAVED.origin } }),
    ]);
    expect(cards[0]).not.toHaveProperty("replaces");
  });

  it("with replace, opens the card for the new site and changes nothing until it is answered", async () => {
    const { toolResults, calls, cards } = await runTool(requestLogin({ replace: true }), {
      saved: SAVED,
    });
    expect(toolResults).toMatchObject([{ details: { secret: "paused" } }]);
    expect(cards).toEqual([
      expect.objectContaining({
        kind: "ask",
        input: "secret",
        credential: DESTINATION,
        replaces: { id: "saved-login-1", origin: "https://www.example.test" },
      }),
    ]);
    expect(vaultWrites(calls)).toBeNull();
  });

  it("with replace, never moves a login that has other sites or an authenticator key", async () => {
    // RFC 6238's test key, written in pieces so it never reads as a saved secret.
    const otp = ("GEZDGNBV" + "GY3TQOJQ").repeat(2);
    const keyed = await secretStore.put(
      encodeLoginSecret({
        fields: [{ label: "Password", value: "fake-password-1", hidden: true }],
        otp,
      }),
      { ...scope, operationId: "test", traceId: "test", signal: new AbortController().signal },
      { recordId: SAVED.id },
    );
    // A card shows neither, and only the login's owner sets them, for the site it has.
    for (const saved of [
      { ...SAVED, alsoOn: ["https://shop.example.test"] },
      { ...SAVED, ciphertext: keyed.ciphertext },
    ]) {
      const { toolResults, calls, cards } = await runTool(requestLogin({ replace: true }), {
        saved,
      });
      expect(toolResults).toEqual([
        { error: expect.stringContaining("Ask the user to change its site in the Vault") },
      ]);
      expect(JSON.stringify(toolResults)).not.toContain(otp);
      expect(cards).toEqual([]);
      expect(vaultWrites(calls)).toBeNull();
    }
  });

  it("asks for an international site under the same punycode site it is saved for", async () => {
    const { cards } = await runTool(
      requestLogin({
        credential: { ...DESTINATION, origin: "https://bücher.example.test/login" },
        replace: true,
      }),
      { saved: SAVED },
    );
    expect(cards).toEqual([
      expect.objectContaining({
        credential: { ...DESTINATION, origin: "https://xn--bcher-kva.example.test" },
        replaces: { id: "saved-login-1", origin: "https://www.example.test" },
      }),
    ]);
  });

  it("returns the login saved for the new site once its card was answered", async () => {
    const { toolResults, cards } = await runTool(requestLogin({ replace: true }), {
      answered: { result: { credentialSaved: DESTINATION } },
      saved: { ...DESTINATION },
    });
    expect(toolResults).toEqual([{ saved: true, ...DESTINATION }]);
    expect(cards).toEqual([]);
  });

  it("never answers for the new site with the login still saved for the old one", async () => {
    const { toolResults } = await runTool(requestLogin({ replace: true }), {
      answered: { result: { credentialSaved: DESTINATION } },
      saved: SAVED,
    });
    expect(toolResults).toEqual([{ error: "The saved credential is no longer available." }]);
  });

  it("returns the login this run kept for the new site with Save to Vault off", async () => {
    for (const extra of [{ replace: true }, {}]) {
      const { toolResults, cards } = await runTool(requestLogin(extra), {
        answered: { result: { credentialSaved: DESTINATION } },
        saved: SAVED,
        secrets: [await runLogin("run-1")],
      });
      expect(toolResults).toEqual([
        expect.objectContaining({ saved: false, ...DESTINATION, fields: expect.any(Array) }),
      ]);
      expect(cards).toEqual([]);
    }
  });

  it("asks for the same site again without marking the card as a replacement", async () => {
    const { cards } = await runTool(requestLogin({ replace: true }), {
      saved: { ...SAVED, origin: DESTINATION.origin },
    });
    expect(cards).toEqual([expect.objectContaining({ credential: DESTINATION })]);
    expect(cards[0]).not.toHaveProperty("replaces");
  });

  it("keeps turning down a change of type or a site off HTTPS", async () => {
    vi.stubEnv("RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP", "1");
    try {
      const cases = [
        // Another kind of credential under the name, or a login asked for as another kind.
        [{ ...SAVED, auth: { type: "bearer" } }, DESTINATION],
        [SAVED, { ...DESTINATION, auth: { type: "bearer" } }],
        [
          { ...SAVED, auth: { type: "bearer" } },
          { ...DESTINATION, auth: { type: "bearer" } },
        ],
      ];
      for (const [saved, credential] of cases) {
        const { toolResults, cards } = await runTool(requestLogin({ credential, replace: true }), {
          saved,
        });
        expect(toolResults).toEqual([
          { error: "Remove the existing credential before changing its destination." },
        ]);
        expect(cards).toEqual([]);
      }
      // A login moved to plain HTTP on the local network, even with private HTTP allowed.
      const { toolResults, cards } = await runTool(
        requestLogin({
          credential: { ...DESTINATION, origin: "http://192.168.1.20" },
          replace: true,
        }),
        { saved: SAVED },
      );
      expect(toolResults).toEqual([{ error: expect.stringContaining("HTTPS origin") }]);
      expect(cards).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("this run's login that wasn't saved", () => {
  it("is hidden from what the run reads before the bot fills anything", async () => {
    const { toolResults } = await runTool(
      { name: "shell", args: { command: "read-page" } },
      {
        secrets: [await runLogin("run-1")],
        printed: "field=fake-password-1 user=fake-user other=kept",
      },
    );
    const text = JSON.stringify(toolResults);
    expect(text).not.toContain("fake-password-1");
    expect(text).not.toContain("fake-user");
    expect(text).toContain("other=kept");
  });
});

describe("forget_secret and generate_secret", () => {
  it("forgets this run's unsaved login before a saved one of the name", async () => {
    const secrets = [await runLogin("run-1")];
    const { toolResults, calls } = await runTool(
      { name: "forget_secret", args: { name: "site_login" } },
      { secrets, saved: { ...DESTINATION } },
    );
    expect(toolResults).toEqual([{ removed: true }]);
    expect(secrets).toEqual([]);
    expect(JSON.stringify(calls)).not.toContain('"vaultCredential","deleteMany"');
  });

  it("won't generate a login under the name of this run's unsaved one", async () => {
    const { toolResults, calls } = await runTool(
      { name: "generate_secret", args: { name: "site_login" } },
      { secrets: [await runLogin("run-1")] },
    );
    expect(toolResults).toMatchObject([{ error: expect.stringContaining("Use another name") }]);
    expect(JSON.stringify(calls)).not.toContain('"vaultCredential","create"');
  });
});
