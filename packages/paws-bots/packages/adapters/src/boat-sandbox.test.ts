import { createHash } from "node:crypto";
import type * as TimersPromises from "node:timers/promises";
import type { FileUrlResponse, SandboxStateEnum } from "@boatdev/sdk";
import { FetchError, ResponseError } from "@boatdev/sdk";
import type { ComputerRef, PortableFile, StreamedPortableFile } from "@rakazo/adapter-kit";
import {
  SandboxDamagedError,
  SandboxRateLimitError,
  SandboxSizeUnavailableError,
  SandboxUnavailableError,
  SandboxUnresponsiveError,
  WorkspaceTooLargeError,
} from "@rakazo/adapter-kit";
import {
  desktopWorkCommand,
  screenDisplayArgv,
  shellQuote,
} from "@rakazo/core/node/desktop-runtime";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { parse } from "shell-quote";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOAT_COMPUTER_SNAPSHOT, BoatSandboxProvider } from "./boat-sandbox.js";
import type { BoatRecovery } from "./boat-sandbox.test-support.js";
import {
  BOAT_ARTIFACT_MAX_BYTES,
  boatError,
  FakeBoatApi,
  serveFakeBoatDownload,
} from "./boat-sandbox.test-support.js";
import { computerSnapshotName } from "./computer-base-snapshot.js";
import { ComputerBrowserProvider } from "./computer-browser.js";
import { PREPARE_LINUX_DESKTOP } from "./linux-desktop.js";
import { installPageBrowserCommand } from "./page-browser-install.js";
import { isSandboxGoneError } from "./sandbox-errors.js";

// Polling waits advance a virtual clock, so state and deadline tests run instantly.
vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof TimersPromises>()),
  setTimeout: async (ms = 0) => {
    vi.setSystemTime(Date.now() + ms);
  },
}));

const context = {
  operationId: "test",
  traceId: "trace",
  spaceId: "workspace",
  userId: "user",
  botId: "bot-a",
  signal: new AbortController().signal,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // Workspace exports download their archive from the sandbox; nothing leaves the test.
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (url) => serveFakeBoatDownload(String(url)) ?? new Response(null, { status: 404 }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function boat() {
  const api = new FakeBoatApi();
  const provider = new BoatSandboxProvider({ apiKey: "test-key" }, api);
  const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
  return { api, provider, computer };
}

/** The script of every command the adapter sent, without the timeout wrapper. */
function scripts(command: { mock: { calls: [unknown, ...unknown[]][] } }): string[] {
  return command.mock.calls
    .map(([request]) => (request as { commandRequest: { command: string } }).commandRequest.command)
    .map((wrapped) => String(parse(wrapped).at(-1)));
}

/** Every exported file with its bytes, reading streamed ones in order. */
async function readExport(files: AsyncIterable<PortableFile | StreamedPortableFile>) {
  const read: Array<PortableFile & { streamed?: boolean }> = [];
  for await (const file of files) {
    if (!("body" in file)) {
      read.push(file);
      continue;
    }
    const chunks: Uint8Array[] = [];
    for await (const chunk of file.body) chunks.push(chunk);
    read.push({
      path: file.path,
      executable: file.executable,
      content: Buffer.concat(chunks),
      streamed: true,
    });
  }
  return read;
}

function exportAll(provider: BoatSandboxProvider, computer: ComputerRef, signal?: AbortSignal) {
  return readExport(
    provider.exportWorkspace(computer, { ...context, ...(signal ? { signal } : {}) }),
  );
}

function archivesLeft(api: FakeBoatApi, computer: ComputerRef): string[] {
  return [...api.files(computer.id).keys()].filter((path) =>
    path.startsWith("/tmp/rakazo-workspace-archive-"),
  );
}

async function drain(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of events) {
    // Only the outcome matters.
  }
}

function reconnect(provider: BoatSandboxProvider, computer: ComputerRef, savedAt?: Date) {
  return provider.provision(
    {
      botId: computer.botId,
      homePath: "/unused",
      providerRef: computer.providerRef,
      providerKind: "boat",
      savedAt,
    },
    context,
  );
}

describe("BoatSandboxProvider", () => {
  describe("computer sizes", () => {
    it("creates a new computer on the machine type for its size", async () => {
      const api = new FakeBoatApi();
      const provider = new BoatSandboxProvider({ apiKey: "test-key" }, api);
      await provider.provision({ botId: "bot-a", homePath: "/unused", size: "large" }, context);
      expect(api.creates.at(-1)?.type).toBe("large");
      await provider.provision({ botId: "bot-b", homePath: "/unused" }, context);
      expect(api.creates.at(-1)?.type).toBeUndefined();
    });

    it("moves a stopped computer to its size on resume and leaves a running one alone", async () => {
      const resume = vi.spyOn(FakeBoatApi.prototype, "resume");
      const { api, provider, computer } = await boat();
      const request = {
        botId: computer.botId,
        homePath: "/unused",
        providerRef: computer.providerRef,
        providerKind: "boat" as const,
        size: "xlarge" as const,
      };
      api.availableTypes.add("xlarge");

      await expect(provider.provision(request, context)).resolves.toMatchObject({
        started: false,
      });
      expect(resume).not.toHaveBeenCalled();

      api.setState(computer.id, "archived");
      await expect(provider.provision(request, context)).resolves.toMatchObject({
        started: true,
      });
      expect(resume).toHaveBeenCalledWith(
        {
          sandboxId: computer.id,
          resumeRequest: { noEnv: true, ttlSeconds: 7200, type: "xlarge" },
        },
        { signal: expect.any(AbortSignal) },
      );
    });

    it("moves a computer Boat recovers by resuming to its size", async () => {
      const resume = vi.spyOn(FakeBoatApi.prototype, "resume");
      const { api, provider, computer } = await boat();
      api.fail(computer.id, "no_machine");

      await provider.provision(
        {
          botId: computer.botId,
          homePath: "/unused",
          providerRef: computer.providerRef,
          providerKind: "boat",
          size: "large",
        },
        context,
      );

      expect(resume).toHaveBeenCalledWith(
        {
          sandboxId: computer.id,
          resumeRequest: { noEnv: true, ttlSeconds: 7200, type: "large" },
        },
        { signal: expect.any(AbortSignal) },
      );
    });

    it("reports a size Boat refuses as unavailable and keeps the computer as it was", async () => {
      const { api, provider, computer } = await boat();
      api.setState(computer.id, "archived");
      const request = {
        botId: computer.botId,
        homePath: "/unused",
        providerRef: computer.providerRef,
        providerKind: "boat" as const,
      };

      await expect(provider.provision({ ...request, size: "xlarge" }, context)).rejects.toEqual(
        expect.objectContaining({ name: "SandboxSizeUnavailableError", reason: "not_offered" }),
      );
      api.tooSmallTypes.add("default");
      await expect(provider.provision({ ...request, size: "standard" }, context)).rejects.toEqual(
        expect.objectContaining({ name: "SandboxSizeUnavailableError", reason: "too_small" }),
      );
      expect(api.state(computer.id)).toBe("archived");
      // Without a size it resumes as it was.
      await expect(provider.provision(request, context)).resolves.toMatchObject({
        providerRef: computer.providerRef,
        started: true,
      });

      await expect(
        provider.provision({ botId: "bot-b", homePath: "/unused", size: "xlarge" }, context),
      ).rejects.toBeInstanceOf(SandboxSizeUnavailableError);
    });
  });

  it("logs actual creates and resumes without counting reuse or exposing request content", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    try {
      const { api, provider, computer } = await boat();
      await reconnect(provider, computer);
      api.setState(computer.id, "archived");
      await reconnect(provider, computer);
      api.setState(computer.id, "archived");
      api.rateLimit();
      await expect(reconnect(provider, computer)).rejects.toBeInstanceOf(SandboxRateLimitError);
      expect(sink.events.map(({ operation, outcome }) => ({ operation, outcome }))).toEqual([
        { operation: "create", outcome: "accepted" },
        { operation: "resume", outcome: "accepted" },
        { operation: "resume", outcome: "rate_limited" },
      ]);
      for (const event of sink.events) {
        const failed = event.outcome !== "accepted";
        expect(Object.keys(event).sort()).toEqual([
          "durationMs",
          ...(failed ? ["error"] : []),
          "level",
          "message",
          "operation",
          "outcome",
          "provider",
          "service.name",
          "timestamp",
        ]);
        expect(event.message).toBe("sandbox.start");
        if (failed) expect(event.error).toMatchObject({ name: "SandboxRateLimitError" });
      }
    } finally {
      installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
    }
  });

  it("creates no-env sandboxes and implements execution and file operations", async () => {
    const api = new FakeBoatApi();
    const create = vi.spyOn(api, "create");
    const command = vi.spyOn(api, "command");
    const provider = new BoatSandboxProvider({ apiKey: "test-key" }, api);
    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);

    expect(computer).toMatchObject({
      id: "bx_fake1",
      providerRef: "bx_fake1",
      kind: "boat",
      fresh: true,
    });
    expect(create).toHaveBeenCalledWith(
      {
        createSandboxRequest: {
          ttlSeconds: 7200,
          noEnv: true,
          env: { RAKAZO_BOT_ID: "bot-a", RAKAZO_SANDBOX: "computer" },
          from: BOAT_COMPUTER_SNAPSHOT,
        },
      },
      { signal: context.signal },
    );

    await provider.prepare(computer, context);
    expect(
      command.mock.calls.some(([request]) =>
        "commandRequest" in request
          ? request.commandRequest.command.includes("rakazo-home/.browser-profiles")
          : false,
      ),
    ).toBe(true);

    const events = [];
    for await (const event of provider.execute(
      computer,
      { argv: ["echo", "hello"], cwd: "notes", env: { TEST_VALUE: "works" }, unsetEnv: ["FAILED"] },
      context,
    )) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "stdout", data: "hello\n" },
      { type: "exit", code: 0 },
    ]);
    const executeRequest = command.mock.calls
      .map(([request]) => ("commandRequest" in request ? request.commandRequest : undefined))
      .find((request) => request?.command.includes("hello"));
    expect(executeRequest?.command).not.toContain("works");
    expect(parse(executeRequest?.command ?? "").at(-1)).toMatch(
      /; 'env' '-u' 'FAILED' '--' 'sh' '-c' '.*' 'sh' 'echo' 'hello'$/s,
    );
    expect(executeRequest?.cwd).toBe("rakazo-home/notes");

    await provider.writeFile(
      computer,
      { path: "bin/tool", content: Uint8Array.from([0, 255, 1]), executable: true },
      context,
    );
    expect(await provider.readFile(computer, "bin/tool", context)).toEqual(
      Uint8Array.from([0, 255, 1]),
    );
    expect(await provider.listFiles(computer, "bin", context)).toEqual([
      { path: "bin/tool", kind: "file", size: 3, executable: true },
    ]);
    const exported = [];
    exported.push(...(await readExport(provider.exportWorkspace(computer, context))));
    expect(exported).toEqual([
      { path: "bin/tool", content: Uint8Array.from([0, 255, 1]), executable: true },
    ]);
  });

  // Node's fetch drops a response with no headers after 300 seconds, however long Boat would wait.
  it("follows the workspace archive in the background instead of waiting on one request", async () => {
    const command = vi.spyOn(FakeBoatApi.prototype, "command");
    const { provider, computer } = await boat();
    await provider.writeFile(
      computer,
      { path: "notes.txt", content: Uint8Array.from([1]) },
      context,
    );

    await readExport(provider.exportWorkspace(computer, context));
    const archive = command.mock.calls
      .map(([request]) => request.commandRequest)
      .find((request) => request.command.includes("rakazo-workspace-archive-"));
    expect(archive).toMatchObject({ detached: true });
    expect(archive).not.toHaveProperty("timeoutSeconds");
  });

  it("keeps command secrets out of command text and removes the env file as the command starts", async () => {
    const command = vi.spyOn(FakeBoatApi.prototype, "command");
    const writeFile = vi.spyOn(FakeBoatApi.prototype, "writeFile");
    const { api, provider, computer } = await boat();
    const secret = "fake-secret-'value' $HOME";

    const events = [];
    for await (const event of provider.execute(
      computer,
      { argv: ["printenv", "FAKE_TOKEN"], env: { FAKE_TOKEN: secret } },
      context,
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "stdout", data: `${secret}\n` },
      { type: "exit", code: 0 },
    ]);
    const commands = command.mock.calls.map(([request]) => request.commandRequest.command);
    expect(commands.some((text) => text.includes("fake-secret"))).toBe(false);
    expect(commands.some((text) => text.includes("mkdir -p -m 700"))).toBe(true);
    const [written] = writeFile.mock.calls.map(([request]) => request.fileWriteRequest);
    const envFile = written?.path ?? "";
    expect(envFile).toMatch(/^\/home\/user\/\.rakazo-command-env\/[0-9a-f-]{36}$/);
    expect(Buffer.from(written?.content ?? "", "base64").toString("utf8")).toContain("fake-secret");
    // The same command opens, deletes, and loads the file before running argv.
    const run = parse(commands.find((text) => text.includes(envFile)) ?? "").at(-1);
    expect(run).toBe(
      `exec 3< '${envFile}' || exit 1; rm -f -- '${envFile}'; eval "$(cat <&3 || echo exit 1)" || exit 1; exec 3<&-; ${screenDisplayArgv(["printenv", "FAKE_TOKEN"], context.botId, 20).map(shellQuote).join(" ")}`,
    );
    expect(api.files(computer.id).has(envFile)).toBe(false);
  });

  it("rejects env names that are not shell identifiers before writing anything", async () => {
    const command = vi.spyOn(FakeBoatApi.prototype, "command");
    const writeFile = vi.spyOn(FakeBoatApi.prototype, "writeFile");
    const { provider, computer } = await boat();

    const run = async () => {
      for await (const _ of provider.execute(
        computer,
        { argv: ["true"], env: { "BAD;NAME": "fake-secret" } },
        context,
      ));
    };
    await expect(run()).rejects.toThrow("invalid environment variable name");
    expect(writeFile).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
  });

  it("reports a timed out command that has no env file", async () => {
    const command = FakeBoatApi.prototype.command;
    vi.spyOn(FakeBoatApi.prototype, "command").mockImplementation(async function (
      this: FakeBoatApi,
      request,
    ) {
      const text = request.commandRequest.command;
      // The command is still running when its timeout fires, so it never marks itself done.
      if (text.startsWith("test -f") && text.includes("completed-124")) {
        return {
          ok: true,
          type: "command.finished",
          success: false,
          exitCode: 1,
          stdout: "",
          stderr: "",
          timedOut: false,
        };
      }
      return text.includes("still-working")
        ? {
            ok: true,
            type: "command.finished",
            success: false,
            exitCode: 124,
            stdout: "",
            stderr: "",
            timedOut: false,
          }
        : command.call(this, request);
    });
    const { provider, computer } = await boat();

    const events = [];
    for await (const event of provider.execute(
      computer,
      { argv: ["still-working"], timeoutMs: 1_000 },
      context,
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "stderr", data: "command timed out after 1000 ms\n" },
      { type: "exit", code: 124 },
    ]);
  });

  it("removes the env file when the command never starts", async () => {
    const command = vi.spyOn(FakeBoatApi.prototype, "command");
    const write = FakeBoatApi.prototype.writeFile;
    vi.spyOn(FakeBoatApi.prototype, "writeFile").mockImplementationOnce(async function (
      this: FakeBoatApi,
      request,
    ) {
      await write.call(this, request);
      throw new Error("connection reset");
    });
    const { api, provider, computer } = await boat();

    const run = async () => {
      for await (const _ of provider.execute(
        computer,
        { argv: ["true"], env: { FAKE_TOKEN: "fake-secret" } },
        context,
      ));
    };
    await expect(run()).rejects.toThrow("connection reset");
    const commands = command.mock.calls.map(([request]) => request.commandRequest.command);
    expect(commands.at(-1)).toMatch(
      /^rm -f -- '\/home\/user\/\.rakazo-command-env\/[0-9a-f-]{36}'$/,
    );
    expect(
      [...api.files(computer.id).keys()].some((file) => file.includes(".rakazo-command-env")),
    ).toBe(false);
  });

  it("resumes an archived sandbox with no inherited environment", async () => {
    const resume = vi.spyOn(FakeBoatApi.prototype, "resume");
    const { api, provider, computer } = await boat();
    api.setState(computer.id, "archived");

    await expect(reconnect(provider, computer)).resolves.toMatchObject({
      providerRef: computer.providerRef,
      fresh: false,
      started: true,
    });
    expect(resume).toHaveBeenCalledWith(
      { sandboxId: computer.id, resumeRequest: { noEnv: true, ttlSeconds: 7200 } },
      { signal: expect.any(AbortSignal) },
    );
  });

  // Every Boat state, error and recover answer either leaves a usable sandbox or reports it gone
  // so the caller replaces it from its checkpoint. Nothing may keep failing on the same ref: one
  // that only Boat's snapshot can bring back is unavailable until a reconnect rolls it back.
  type Outcome = "kept" | "started" | "rolled back" | "replaced";
  const stateOutcomes: Record<SandboxStateEnum, Outcome> = {
    init: "kept",
    provisioning: "kept",
    provisioned: "kept",
    cloning: "kept",
    ready: "kept",
    idle: "kept",
    running: "kept",
    archiving: "started",
    archived: "started",
    error: "started",
    cancelled: "replaced",
  };
  const recoveryOutcomes: Record<BoatRecovery, Outcome> = {
    recovers: "started",
    no_machine: "started",
    too_soon: "started",
    sandbox_is_reachable: "started",
    stuck: "replaced",
    recover_unsupported: "replaced",
    reset_failed: "replaced",
  };
  const lifecycle: [string, (api: FakeBoatApi, id: string) => void, Outcome][] = [
    ...Object.entries(stateOutcomes).map(
      ([state, outcome]): [string, (api: FakeBoatApi, id: string) => void, Outcome] => [
        `state ${state}`,
        (api, id) =>
          state === "error" ? api.fail(id) : api.setState(id, state as SandboxStateEnum),
        outcome,
      ],
    ),
    ...Object.entries(recoveryOutcomes).map(
      ([recovery, outcome]): [string, (api: FakeBoatApi, id: string) => void, Outcome] => [
        `error state, recover answers ${recovery}`,
        (api, id) => api.fail(id, recovery as BoatRecovery),
        outcome,
      ],
    ),
    // One that never answers again is force-stopped to its last good snapshot and resumed.
    ...(["stuck", "recover_unsupported", "reset_failed"] as const).map(
      (recovery): [string, (api: FakeBoatApi, id: string) => void, Outcome] => [
        `error state with a snapshot, recover answers ${recovery}`,
        (api, id) => {
          api.saveSnapshot(id);
          api.fail(id, recovery);
        },
        "rolled back",
      ],
    ),
    ["snapshot data expired", (api, id) => api.expire(id), "replaced"],
    ["deleted", (api, id) => api.delete(id), "replaced"],
  ];

  it.each(lifecycle)(
    "prepare on %s either works or reports the sandbox gone",
    async (_name, setup, outcome) => {
      const { api, provider, computer } = await boat();
      setup(api, computer.id);

      const result = await provider.prepare(computer, context).then(
        () => "ready",
        (error: unknown) => error,
      );
      if (outcome === "replaced") expect(isSandboxGoneError(result)).toBe(true);
      else if (outcome === "rolled back") expect(result).toBeInstanceOf(SandboxUnavailableError);
      else expect(result).toBe("ready");
    },
  );

  it.each(lifecycle)(
    "reconnecting on %s keeps a usable sandbox or replaces it",
    async (_name, setup, outcome) => {
      const { api, provider, computer } = await boat();
      setup(api, computer.id);

      const ref = await reconnect(provider, computer);
      await provider.prepare(ref, context);
      expect(ref.providerRef === computer.providerRef).toBe(outcome !== "replaced");
      expect(ref.fresh).toBe(outcome === "replaced");
      if (outcome !== "replaced") expect(ref.started).toBe(outcome !== "kept");
      expect(["ready", "idle", "running"]).toContain(api.state(ref.providerRef));
    },
  );

  it("resumes a sandbox Boat archived on its own and retries the refused work once", async () => {
    const resume = vi.spyOn(FakeBoatApi.prototype, "resume");
    const { api, provider, computer } = await boat();
    await provider.prepare(computer, context);
    await provider.writeFile(computer, { path: "kept.txt", content: Uint8Array.of(1) }, context);
    // The TTL ran out with no sleep job to stop it first.
    api.setState(computer.id, "archived");

    expect(await provider.readFile(computer, "kept.txt", context)).toEqual(Uint8Array.of(1));
    expect(resume).toHaveBeenCalledOnce();
    api.setState(computer.id, "archived");
    const events = [];
    for await (const event of provider.execute(computer, { argv: ["echo", "awake"] }, context)) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "stdout", data: "awake\n" },
      { type: "exit", code: 0 },
    ]);

    api.setState(computer.id, "archived");
    api.expire(computer.id);
    const error = await provider.readFile(computer, "kept.txt", context).catch((e: unknown) => e);
    expect(isSandboxGoneError(error)).toBe(true);
  });

  it("recovers a sandbox whose machine stopped underneath it and retries the work once", async () => {
    const recover = vi.spyOn(FakeBoatApi.prototype, "recover");
    const command = FakeBoatApi.prototype.command;
    let machineStops = false;
    vi.spyOn(FakeBoatApi.prototype, "command").mockImplementation(async function (
      this: FakeBoatApi,
      ...args
    ) {
      if (!machineStops) return command.apply(this, args);
      machineStops = false;
      this.fail(args[0].sandboxId);
      throw boatError(409, "machine_not_running", "Sandbox machine is not running.");
    });
    const { provider, computer } = await boat();
    await provider.prepare(computer, context);
    machineStops = true;

    const events = [];
    for await (const event of provider.execute(computer, { argv: ["echo", "awake"] }, context)) {
      events.push(event);
    }
    expect(recover).toHaveBeenCalledOnce();
    expect(events).toEqual([
      { type: "stdout", data: "awake\n" },
      { type: "exit", code: 0 },
    ]);
  });

  it("reports a machine still refused as stopped after waking it as a computer that did not start", async () => {
    const command = FakeBoatApi.prototype.command;
    let machineStops = false;
    vi.spyOn(FakeBoatApi.prototype, "command").mockImplementation(async function (
      this: FakeBoatApi,
      ...args
    ) {
      if (!machineStops) return command.apply(this, args);
      throw boatError(409, "machine_not_running", "Sandbox machine is not running.");
    });
    const { provider, computer } = await boat();
    await provider.prepare(computer, context);
    machineStops = true;

    const error = await (async () => {
      for await (const _ of provider.exportWorkspace(computer, context));
    })().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(SandboxUnavailableError);
  });

  it("waits for a resume another job already started instead of failing", async () => {
    const resume = vi.spyOn(FakeBoatApi.prototype, "resume");
    const { api, provider, computer } = await boat();
    await provider.prepare(computer, context);
    await provider.writeFile(computer, { path: "kept.txt", content: Uint8Array.of(1) }, context);
    api.setState(computer.id, "archived");
    resume.mockImplementationOnce(async ({ sandboxId }) => {
      // The other resume finishes while this one is refused.
      api.setState(sandboxId, "provisioning");
      throw boatError(409, "sandbox_resuming", "A resume for this sandbox is already in progress.");
    });

    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    try {
      expect(await provider.readFile(computer, "kept.txt", context)).toEqual(Uint8Array.of(1));
    } finally {
      installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
    }
    expect(resume).toHaveBeenCalledOnce();
    expect(sink.events).toEqual([
      expect.objectContaining({
        level: "info",
        message: "sandbox.start",
        operation: "resume",
        outcome: "in_progress",
      }),
    ]);
  });

  it("retries a request that never reached Boat once, whatever the call", async () => {
    const run = vi.spyOn(FakeBoatApi.prototype, "command");
    const { provider, computer } = await boat();
    await provider.prepare(computer, context);
    const timeout = Object.assign(new Error("Connect Timeout Error"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
    });
    const unreached = [
      new Error("The request failed", { cause: new TypeError("fetch failed", { cause: timeout }) }),
      // Boat's proxy could not connect to the sandbox machine.
      boatError(502, "sandbox_direct_failed", "connect ECONNREFUSED 192.0.2.1:21034"),
    ];
    for (const failure of unreached) {
      run.mockRejectedValueOnce(failure);
      const events = [];
      for await (const event of provider.execute(computer, { argv: ["echo", "awake"] }, context)) {
        events.push(event);
      }
      expect(events).toEqual([
        { type: "stdout", data: "awake\n" },
        { type: "exit", code: 0 },
      ]);
    }
  });

  it("retries a Boat server error once for reads but never resends a command", async () => {
    const lookup = FakeBoatApi.prototype.get;
    const get = vi.spyOn(FakeBoatApi.prototype, "get");
    const run = vi.spyOn(FakeBoatApi.prototype, "command");
    const { api, provider, computer } = await boat();
    await provider.prepare(computer, context);
    get.mockRejectedValueOnce(boatError(500, "internal", "Something went wrong"));
    get.mockImplementation(lookup);

    await provider.stop(computer, context);
    expect(api.state(computer.id)).toBe("archived");

    await provider.prepare(computer, context);
    run.mockClear();
    run.mockRejectedValueOnce(boatError(500, "internal", "Something went wrong"));
    const error = await (async () => {
      for await (const _ of provider.execute(computer, { argv: ["true"] }, context)) {
        // drain
      }
    })().catch((failure: unknown) => failure);
    expect((error as Error).message).toContain("HTTP 500");
    expect(run).toHaveBeenCalledOnce();
  });

  it("keeps an errored sandbox when Boat refuses recover without a known code", async () => {
    const recover = vi.spyOn(FakeBoatApi.prototype, "recover");
    const { api, provider, computer } = await boat();
    api.fail(computer.id);
    recover.mockRejectedValueOnce(
      new ResponseError(new Response("upstream HTML", { status: 409 }), "conflict"),
    );

    const error = await provider.prepare(computer, context).catch((failure: unknown) => failure);
    expect((error as Error).message).toContain("HTTP 409");
    expect(isSandboxGoneError(error)).toBe(false);
  });

  describe.each(["recover_unsupported", "reset_failed"] as const)(
    "a sandbox Boat cannot power-cycle (%s)",
    (recovery) => {
      /** Runs `effect` on each read once the adapter first saw the sandbox in `error`. */
      function onRead(effect: (api: FakeBoatApi, id: string, elapsedMs: number) => void) {
        let since: number | undefined;
        const get = FakeBoatApi.prototype.get;
        vi.spyOn(FakeBoatApi.prototype, "get").mockImplementation(async function (
          this: FakeBoatApi,
          request,
        ) {
          if (since === undefined && this.state(request.sandboxId) === "error") since = Date.now();
          if (since !== undefined) effect(this, request.sandboxId, Date.now() - since);
          return get.call(this, request);
        });
      }

      it("waits for it to answer again and never stops it", async () => {
        const stop = vi.spyOn(FakeBoatApi.prototype, "stop");
        // It answers again two minutes later, as Boat says most do.
        onRead((fake, id, elapsedMs) => {
          if (elapsedMs >= 2 * 60_000 && fake.state(id) === "error") fake.setState(id, "running");
        });
        const { api, provider, computer } = await boat();
        api.saveSnapshot(computer.id);
        api.fail(computer.id, recovery);

        const ref = await reconnect(provider, computer);

        expect(ref).toMatchObject({ providerRef: computer.providerRef, fresh: false });
        expect(stop).not.toHaveBeenCalled();
      });

      it("force-stops it to its last good snapshot and resumes that when it never answers", async () => {
        const sink = createTestSink();
        installLogger(createLogger({ service: "test", sinks: [sink] }));
        try {
          const stop = vi.spyOn(FakeBoatApi.prototype, "stop");
          const resume = vi.spyOn(FakeBoatApi.prototype, "resume");
          const { api, provider, computer } = await boat();
          const file = (path: string) => ({ path, content: Uint8Array.of(1) });
          await provider.writeFile(computer, file("saved.txt"), context);
          // The caller's own save is older than Boat's snapshot.
          const savedAt = new Date();
          vi.setSystemTime(Date.now() + 60_000);
          api.saveSnapshot(computer.id);
          vi.setSystemTime(Date.now() + 60_000);
          await provider.writeFile(computer, file("unsaved.txt"), context);
          api.fail(computer.id, recovery);
          const failedAt = Date.now();

          const ref = await reconnect(provider, computer, savedAt);

          expect(Date.now() - failedAt).toBeGreaterThanOrEqual(5 * 60_000);
          expect(stop).toHaveBeenCalledExactlyOnceWith(
            { sandboxId: computer.id, stopRequest: { force: true } },
            { signal: context.signal },
          );
          expect(resume).toHaveBeenCalledOnce();
          expect(ref).toMatchObject({
            providerRef: computer.providerRef,
            fresh: false,
            started: true,
          });
          expect(api.state(computer.id)).toBe("ready");
          // Boat's snapshot is the newest saved state; what came after it is lost.
          expect(await provider.readFile(ref, "saved.txt", context)).toEqual(Uint8Array.of(1));
          await expect(provider.readFile(ref, "unsaved.txt", context)).rejects.toThrow();
          const steps = sink.events.filter((event) => event.message === "sandbox.recover");
          expect(steps).toEqual([
            expect.objectContaining({
              level: "warn",
              provider: "boat",
              step: "wait",
              reason: recovery,
            }),
            expect.objectContaining({ level: "warn", provider: "boat", step: "force_stop" }),
            expect.objectContaining({ level: "warn", provider: "boat", step: "resumed" }),
          ]);
          expect(JSON.stringify(steps)).not.toContain(computer.id);
        } finally {
          installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
        }
      });

      it("reports it gone without stopping it when the caller's save is newer", async () => {
        const sink = createTestSink();
        installLogger(createLogger({ service: "test", sinks: [sink] }));
        try {
          const stop = vi.spyOn(FakeBoatApi.prototype, "stop");
          const { api, provider, computer } = await boat();
          api.saveSnapshot(computer.id);
          vi.setSystemTime(Date.now() + 60_000);
          const savedAt = new Date();
          api.fail(computer.id, recovery);

          const ref = await reconnect(provider, computer, savedAt);

          expect(ref.fresh).toBe(true);
          expect(ref.providerRef).not.toBe(computer.providerRef);
          expect(stop).not.toHaveBeenCalled();
          expect(sink.events).toContainEqual(
            expect.objectContaining({
              level: "warn",
              message: "sandbox.recover",
              step: "gone",
              reason: "checkpoint_newer",
            }),
          );
        } finally {
          installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
        }
      });

      it("reports it gone without stopping it when Boat has no snapshot of it", async () => {
        const stop = vi.spyOn(FakeBoatApi.prototype, "stop");
        const { api, provider, computer } = await boat();
        api.fail(computer.id, recovery);

        const error = await provider
          .prepare(computer, context)
          .catch((failure: unknown) => failure);
        expect(isSandboxGoneError(error)).toBe(true);

        const ref = await reconnect(provider, computer);
        expect(ref.fresh).toBe(true);
        expect(ref.providerRef).not.toBe(computer.providerRef);
        expect(stop).not.toHaveBeenCalled();
      });

      it("stops waiting without stopping it when the caller gives up", async () => {
        const stop = vi.spyOn(FakeBoatApi.prototype, "stop");
        const caller = new AbortController();
        const cancelled = new Error("run cancelled");
        onRead((_fake, _id, elapsedMs) => {
          if (elapsedMs >= 60_000) caller.abort(cancelled);
        });
        const { api, provider, computer } = await boat();
        api.saveSnapshot(computer.id);
        api.fail(computer.id, recovery);

        const error = await provider
          .provision(
            {
              botId: computer.botId,
              homePath: "/unused",
              providerRef: computer.providerRef,
              providerKind: "boat",
            },
            { ...context, signal: caller.signal },
          )
          .catch((failure: unknown) => failure);

        expect(error).toBe(cancelled);
        expect(stop).not.toHaveBeenCalled();
        expect(api.state(computer.id)).toBe("error");
      });

      it("leaves the rollback to the next reconnect when work in progress finds it down", async () => {
        const stop = vi.spyOn(FakeBoatApi.prototype, "stop");
        const { api, provider, computer } = await boat();
        await provider.prepare(computer, context);
        api.saveSnapshot(computer.id);
        api.fail(computer.id, recovery);

        const error = await provider
          .readFile(computer, "notes.txt", context)
          .catch((failure: unknown) => failure);

        expect(error).toBeInstanceOf(SandboxUnavailableError);
        expect(isSandboxGoneError(error)).toBe(false);
        expect(stop).not.toHaveBeenCalled();
        expect(api.state(computer.id)).toBe("error");
      });
    },
  );

  it("reports a sandbox that never becomes runnable as unavailable, not gone", async () => {
    const get = FakeBoatApi.prototype.get;
    vi.spyOn(FakeBoatApi.prototype, "get").mockImplementation(async function (
      this: FakeBoatApi,
      request,
    ) {
      const response = await get.call(this, request);
      return { ...response, sandbox: { ...response.sandbox, state: "provisioning" } };
    });
    const { provider, computer } = await boat();

    const error = await reconnect(provider, computer).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(SandboxUnavailableError);
    expect(isSandboxGoneError(error)).toBe(false);
    expect((error as Error).cause).toMatchObject({
      message: `Boat ${computer.id} did not become ready`,
    });
  });

  it("keeps why desktop tool setup failed without changing the reported message", async () => {
    const run = FakeBoatApi.prototype.command;
    vi.spyOn(FakeBoatApi.prototype, "command").mockImplementation(async function (
      this: FakeBoatApi,
      request,
    ) {
      if (!request.commandRequest.command.includes("apt-get")) return run.call(this, request);
      return {
        ok: true,
        type: "command.finished",
        success: false,
        exitCode: 100,
        stdout: "",
        stderr: "Reading package lists...\nE: Could not get lock /var/lib/dpkg/lock-frontend\n",
        timedOut: false,
      };
    });
    const { provider, computer } = await boat();

    const error = await provider.prepare(computer, context).catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      message: "could not prepare computer desktop tools",
      cause: { message: "exit 100: E: Could not get lock /var/lib/dpkg/lock-frontend" },
    });
  });

  it.each([
    'Executable not found in $PATH: "systemd-run"',
    "ENOENT: no such file or directory, posix_spawn 'systemd-run'",
    "environment: line 7: /usr/bin/grep: cannot execute: required file not found\nenvironment: line 8: /usr/bin/grep: cannot execute: required file not found",
  ])("reports a machine that cannot start programs as damaged: %s", async (stderr) => {
    vi.spyOn(FakeBoatApi.prototype, "command").mockResolvedValue({
      ok: true,
      type: "command.finished",
      success: false,
      exitCode: 1,
      stdout: "",
      stderr,
      timedOut: false,
    });
    const { provider, computer } = await boat();

    await expect(provider.prepare(computer, context)).rejects.toBeInstanceOf(SandboxDamagedError);
    const events = [];
    const run = provider.execute(computer, { argv: ["ls"] }, context);
    await expect(
      (async () => {
        for await (const event of run) events.push(event);
      })(),
    ).rejects.toBeInstanceOf(SandboxDamagedError);
  });

  it("says what Boat reports about a damaged machine and checks it again on the next prepare", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    try {
      const command = vi.spyOn(FakeBoatApi.prototype, "command");
      const { api, provider, computer } = await boat();
      await provider.prepare(computer, context);
      api.damage(computer.id);
      command.mockClear();

      await expect(drain(provider.execute(computer, { argv: ["ls"] }, context))).rejects.toThrow(
        SandboxDamagedError,
      );
      await expect(provider.prepare(computer, context)).rejects.toThrow(SandboxDamagedError);

      expect(command).toHaveBeenCalledTimes(2);
      expect(sink.events).toContainEqual(
        expect.objectContaining({
          level: "warn",
          message: "sandbox.damaged",
          provider: "boat",
          hydrated: false,
          lastSnapshotStatus: "failed",
        }),
      );
    } finally {
      installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
    }
  });

  describe("a stop Boat refuses because its saves fail", () => {
    it("waits on Boat's retries without forcing it unless asked", async () => {
      const stop = vi.spyOn(FakeBoatApi.prototype, "stop");
      const { api, provider, computer } = await boat();
      api.damage(computer.id);

      const stopped = provider.stop(computer, context);
      await expect(stopped).rejects.toBeInstanceOf(SandboxUnresponsiveError);
      await expect(stopped).rejects.toThrow("did not reach archived");

      expect(stop).toHaveBeenCalledExactlyOnceWith(
        { sandboxId: computer.id },
        { signal: context.signal },
      );
      expect(api.state(computer.id)).toBe("ready");
    });

    it("forces it to Boat's last good snapshot when the caller may discard unsaved work", async () => {
      const stop = vi.spyOn(FakeBoatApi.prototype, "stop");
      const { api, provider, computer } = await boat();
      const file = (path: string) => ({ path, content: Uint8Array.of(1) });
      await provider.writeFile(computer, file("saved.txt"), context);
      api.saveSnapshot(computer.id);
      await provider.writeFile(computer, file("unsaved.txt"), context);
      api.damage(computer.id);

      await provider.stop(computer, context, { discardUnsaved: true });

      expect(stop).toHaveBeenLastCalledWith(
        { sandboxId: computer.id, stopRequest: { force: true } },
        { signal: context.signal },
      );
      expect(api.state(computer.id)).toBe("archived");
      expect([...api.files(computer.id).keys()]).toEqual([expect.stringMatching(/\/saved\.txt$/)]);
    });

    it("never forces a stop Boat completes", async () => {
      const stop = vi.spyOn(FakeBoatApi.prototype, "stop");
      const { api, provider, computer } = await boat();

      await provider.stop(computer, context, { discardUnsaved: true });

      expect(stop).toHaveBeenCalledExactlyOnceWith(
        { sandboxId: computer.id },
        { signal: context.signal },
      );
      expect(api.state(computer.id)).toBe("archived");
    });
  });

  describe("a sandbox Boat already stopped", () => {
    it("is reported running only while it can run, without being started", async () => {
      const resume = vi.spyOn(FakeBoatApi.prototype, "resume");
      const get = FakeBoatApi.prototype.get;
      const outage = new Error("Boat status unavailable");
      let failing = false;
      vi.spyOn(FakeBoatApi.prototype, "get").mockImplementation(async function (
        this: FakeBoatApi,
        ...args: Parameters<FakeBoatApi["get"]>
      ) {
        if (failing) throw outage;
        return get.apply(this, args);
      });
      const { api, provider, computer } = await boat();
      expect(await provider.isRunning(computer, context)).toBe(true);
      failing = true;
      await expect(provider.isRunning(computer, context)).rejects.toBe(outage);
      failing = false;
      expect(await provider.isRunning({ ...computer, kind: "e2b" }, context)).toBe(false);
      await provider.stop(computer, context);

      expect(await provider.isRunning(computer, context)).toBe(false);
      api.delete(computer.id);
      expect(await provider.isRunning(computer, context)).toBe(false);
      expect(resume).not.toHaveBeenCalled();
    });

    it("bounds a running check by its own deadline as well as the caller's", async () => {
      const get = vi.spyOn(FakeBoatApi.prototype, "get");
      const { provider, computer } = await boat();
      const timeout = vi.spyOn(AbortSignal, "timeout");
      const statusRead = async () => {
        const deadline = new AbortController();
        const caller = new AbortController();
        timeout.mockReturnValueOnce(deadline.signal);
        await provider.isRunning(computer, { ...context, signal: caller.signal });
        const [, init] = get.mock.calls.at(-1) as unknown[];
        return { deadline, caller, signal: (init as RequestInit).signal };
      };
      const byDeadline = await statusRead();
      expect(timeout).toHaveBeenCalledWith(10_000);
      expect(byDeadline.signal?.aborted).toBe(false);
      byDeadline.deadline.abort();
      expect(byDeadline.signal?.aborted).toBe(true);
      const byCaller = await statusRead();
      expect(byCaller.signal?.aborted).toBe(false);
      byCaller.caller.abort();
      expect(byCaller.signal?.aborted).toBe(true);
    });

    it("is reported stopped without being started", async () => {
      const resume = vi.spyOn(FakeBoatApi.prototype, "resume");
      const { api, provider, computer } = await boat();
      expect(await provider.isStopped(computer, context)).toBe(false);
      await provider.stop(computer, context);

      expect(await provider.isStopped(computer, context)).toBe(true);
      api.expire(computer.id);
      expect(await provider.isStopped(computer, context)).toBe(false);
      api.delete(computer.id);
      expect(await provider.isStopped(computer, context)).toBe(false);
      expect(resume).not.toHaveBeenCalled();
    });

    it("resumes when its snapshot is newer than the caller's save", async () => {
      const { api, provider, computer } = await boat();
      const savedAt = new Date();
      vi.setSystemTime(Date.now() + 60_000);
      await provider.stop(computer, context);

      const ref = await reconnect(provider, computer, savedAt);

      expect(ref).toMatchObject({ providerRef: computer.providerRef, fresh: false, started: true });
      expect(api.state(computer.id)).toBe("ready");
    });

    it("is gone when the caller saved after its last good snapshot", async () => {
      const resume = vi.spyOn(FakeBoatApi.prototype, "resume");
      const { api, provider, computer } = await boat();
      api.saveSnapshot(computer.id);
      api.damage(computer.id);
      await provider.stop(computer, context, { discardUnsaved: true });
      vi.setSystemTime(Date.now() + 60_000);

      const ref = await reconnect(provider, computer, new Date());

      expect(ref).toMatchObject({ fresh: true });
      expect(ref.providerRef).not.toBe(computer.providerRef);
      expect(resume).not.toHaveBeenCalled();
      // Boat's older copy stays stopped rather than deleted.
      expect(api.state(computer.id)).toBe("archived");
    });
  });

  it("leaves a command's own failure to start a program to the command", async () => {
    vi.spyOn(FakeBoatApi.prototype, "command").mockResolvedValue({
      ok: true,
      type: "command.finished",
      success: false,
      exitCode: 126,
      stdout: "",
      stderr: "bash: ./run.sh: cannot execute: required file not found\n",
      timedOut: false,
    });
    const { provider, computer } = await boat();

    const events = [];
    for await (const event of provider.execute(computer, { argv: ["./run.sh"] }, context)) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "stderr", data: "bash: ./run.sh: cannot execute: required file not found\n" },
      { type: "exit", code: 126 },
    ]);
  });

  it("replaces a sandbox whose data expires between the lookup and the resume", async () => {
    const lookup = FakeBoatApi.prototype.get;
    const get = vi.spyOn(FakeBoatApi.prototype, "get");
    const resume = vi.spyOn(FakeBoatApi.prototype, "resume");
    const { api, provider, computer } = await boat();
    api.setState(computer.id, "archived");
    get.mockImplementationOnce(async (request) => {
      const response = await lookup.call(api, request);
      api.expire(computer.id);
      return response;
    });

    const replacement = await reconnect(provider, computer);
    expect(resume).toHaveBeenCalledOnce();
    expect(replacement).toMatchObject({ fresh: true });
    expect(replacement.providerRef).not.toBe(computer.providerRef);
  });

  it("reports Boat's machine-start limit as a rate limit, not a gone sandbox", async () => {
    const { api, provider, computer } = await boat();
    api.rateLimit();

    // Reconnecting to a running sandbox is not a start.
    await expect(reconnect(provider, computer)).resolves.toMatchObject({ fresh: false });

    api.setState(computer.id, "archived");
    const resumed = await reconnect(provider, computer).catch((error: unknown) => error);
    expect(resumed).toBeInstanceOf(SandboxRateLimitError);
    expect(isSandboxGoneError(resumed)).toBe(false);
    expect(((resumed as Error).cause as Error).message).toContain("HTTP 429, rate_limited");

    await expect(
      provider.provision({ botId: "bot-b", homePath: "/unused" }, context),
    ).rejects.toBeInstanceOf(SandboxRateLimitError);
  });

  it("holds every Boat request for the wait Boat names after refusing this host's request rate", async () => {
    const { api, provider, computer } = await boat();
    await provider.prepare(computer, context);
    api.limitRequests(30);

    const refused = await drain(
      provider.execute(computer, { argv: ["echo", "first"] }, context),
    ).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SandboxRateLimitError);
    expect(refused).toMatchObject({ retryAfterMs: 30_000 });

    const refusedAt = Date.now();
    api.requestTimes.length = 0;
    await Promise.all([
      drain(provider.execute(computer, { argv: ["echo", "second"] }, context)),
      drain(provider.execute(computer, { argv: ["echo", "third"] }, context)),
    ]);
    expect(api.requestTimes.length).toBeGreaterThanOrEqual(2);
    expect(Math.min(...api.requestTimes)).toBeGreaterThanOrEqual(refusedAt + 30_000);
  });

  it("finishes a resume when Boat's per-IP limit refuses the status check that follows", async () => {
    const accept = FakeBoatApi.prototype.resume;
    const resume = vi.spyOn(FakeBoatApi.prototype, "resume");
    const { api, provider, computer } = await boat();
    api.setState(computer.id, "archived");
    let refusedAt = 0;
    resume.mockImplementationOnce(async (request) => {
      const accepted = await accept.call(api, request);
      refusedAt = Date.now();
      api.limitRequests(30);
      return accepted;
    });

    await expect(reconnect(provider, computer)).resolves.toMatchObject({ fresh: false });
    expect(api.state(computer.id)).toBe("ready");
    expect(api.requestTimes.at(-1)).toBeGreaterThanOrEqual(refusedAt + 30_000);
  });

  it("surfaces a create rate limit without creating a second billed sandbox", async () => {
    const api = new FakeBoatApi();
    const create = vi
      .spyOn(api, "create")
      .mockRejectedValueOnce(
        new ResponseError(
          Response.json({ code: "IP_RATE_LIMIT_EXCEEDED", retryAfter: 12 }, { status: 429 }),
        ),
      );
    const provider = new BoatSandboxProvider({ apiKey: "test-key" }, api);

    await expect(
      provider.provision({ botId: "bot-a", homePath: "/unused" }, context),
    ).rejects.toBeInstanceOf(SandboxRateLimitError);
    expect(create).toHaveBeenCalledOnce();
  });

  it("surfaces a command start rate limit without running the command twice", async () => {
    const command = vi.spyOn(FakeBoatApi.prototype, "command");
    const { provider, computer } = await boat();
    await provider.prepare(computer, context);
    command.mockClear();
    command.mockRejectedValueOnce(
      new ResponseError(
        Response.json({ code: "IP_RATE_LIMIT_EXCEEDED", retryAfter: 12 }, { status: 429 }),
      ),
    );

    await expect(
      drain(provider.execute(computer, { argv: ["echo", "once"] }, context)),
    ).rejects.toBeInstanceOf(SandboxRateLimitError);
    expect(command).toHaveBeenCalledOnce();
  });

  it("resends an idempotent resume after a short rate limit", async () => {
    const resume = vi
      .spyOn(FakeBoatApi.prototype, "resume")
      .mockRejectedValueOnce(
        new ResponseError(
          Response.json({ code: "rate_limited", window: "minute" }, { status: 429 }),
        ),
      );

    const { api, provider, computer } = await boat();
    api.setState(computer.id, "archived");
    await expect(reconnect(provider, computer)).resolves.toMatchObject({ fresh: false });
    expect(resume).toHaveBeenCalledTimes(2);
  });

  it("fails a delete Boat refuses for its per-IP limit without resending it", async () => {
    const remove = vi.spyOn(FakeBoatApi.prototype, "deleteSandbox");
    const { api, provider, computer } = await boat();
    api.limitRequests(30);

    await expect(provider.destroy(computer, context)).rejects.toBeInstanceOf(SandboxRateLimitError);
    expect(remove).toHaveBeenCalledOnce();
  });

  // The SDK's idle timer aborts its own attach: once the request is sent, the runtime reports a
  // FetchError caused by the abort; while the attach still waits at the request gate, the abort
  // itself.
  const idleAbort = () => new DOMException("This operation was aborted", "AbortError");
  it.each([
    ["a rate limit", undefined],
    ["the SDK's idle timeout on the request", new FetchError(idleAbort(), "The request failed")],
    ["the SDK's idle timeout at the request gate", idleAbort()],
  ])(
    "finishes a long command by polling when %s ends the attach to its output",
    async (_name, attachError) => {
      const run = FakeBoatApi.prototype.command;
      const command = vi.spyOn(FakeBoatApi.prototype, "command");
      const attach = vi.spyOn(FakeBoatApi.prototype, "attachCommandRaw");
      const { api, provider, computer } = await boat();
      await provider.prepare(computer, context);
      api.detachedRunMs = 60_000;
      command.mockImplementationOnce(async (request) => {
        const started = await run.call(api, request);
        if (attachError) attach.mockRejectedValueOnce(attachError);
        else api.limitRequests(90);
        return started;
      });

      const events = [];
      for await (const event of provider.execute(
        computer,
        { argv: ["echo", "polled"], timeoutMs: 20 * 60_000 },
        context,
      )) {
        events.push(event);
      }
      expect(events).toEqual([
        { type: "stdout", data: "polled\n" },
        { type: "exit", code: 0 },
      ]);
      expect(attach).toHaveBeenCalledOnce();
      const sent = command.mock.calls.map(([request]) => request.commandRequest.command);
      expect(sent.filter((script) => script.includes("pkill"))).toEqual([]);
    },
  );

  it.each([
    ["an unexpected failure", new Error("attach broke"), "Error"],
    ["a Boat server error", boatError(500, "internal", "upstream"), "SandboxUnresponsiveError"],
  ])(
    "fails and stops a long command when %s ends the attach to its output",
    async (_name, failure, name) => {
      const command = vi.spyOn(FakeBoatApi.prototype, "command");
      const attach = vi.spyOn(FakeBoatApi.prototype, "attachCommandRaw");
      const status = vi.spyOn(FakeBoatApi.prototype, "commandStatus");
      const { provider, computer } = await boat();
      await provider.prepare(computer, context);
      attach.mockRejectedValue(failure);

      await expect(
        drain(provider.execute(computer, { argv: ["echo", "x"], timeoutMs: 20 * 60_000 }, context)),
      ).rejects.toMatchObject({ name });
      expect(status).not.toHaveBeenCalled();
      const sent = command.mock.calls.map(([request]) => request.commandRequest.command);
      expect(sent.some((script) => script.includes("pkill"))).toBe(true);
    },
  );

  it("follows a long command on Boat's output stream, reattaching where each connection ended", async () => {
    const attach = vi.spyOn(FakeBoatApi.prototype, "attachCommandRaw");
    const status = vi.spyOn(FakeBoatApi.prototype, "commandStatus");
    const { api, provider, computer } = await boat();
    await provider.prepare(computer, context);
    api.attachReconnects = 2;

    const events = [];
    for await (const event of provider.execute(
      computer,
      { argv: ["echo", "streamed output"], timeoutMs: 20 * 60_000 },
      context,
    )) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "stdout", data: "streamed output\n" },
      { type: "exit", code: 0 },
    ]);
    expect(attach.mock.calls.map(([request]) => request.stdoutOffset)).toEqual([0, 8, 12]);
    expect(status).not.toHaveBeenCalled();
  });

  it("keeps the same byte budget of streamed output that a status poll reads", async () => {
    const { provider, computer } = await boat();
    await provider.prepare(computer, context);

    let stdout = "";
    for await (const event of provider.execute(
      computer,
      { argv: ["echo", "é".repeat(600_000)], timeoutMs: 20 * 60_000 },
      context,
    )) {
      if (event.type === "stdout") stdout += event.data;
    }
    expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(1_000_000);
    expect(stdout).toMatch(/^é+\n$/);
  });

  it("polls a long command with backoff when the sandbox cannot stream its output", async () => {
    const polledAt: number[] = [];
    const commandStatus = FakeBoatApi.prototype.commandStatus;
    vi.spyOn(FakeBoatApi.prototype, "commandStatus").mockImplementation(function (
      this: FakeBoatApi,
      request,
    ) {
      polledAt.push(Date.now());
      return commandStatus.call(this, request);
    });
    const { api, provider, computer } = await boat();
    await provider.prepare(computer, context);
    api.attachOutdated = true;
    api.detachedRunMs = 10 * 60_000;

    const events = [];
    for await (const event of provider.execute(
      computer,
      { argv: ["echo", "polled"], timeoutMs: 20 * 60_000 },
      context,
    )) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "stdout", data: "polled\n" },
      { type: "exit", code: 0 },
    ]);
    const gaps = polledAt.slice(1).map((at, index) => at - (polledAt[index] ?? 0));
    expect(gaps.slice(0, 6)).toEqual([500, 1_000, 2_000, 4_000, 5_000, 5_000]);
    // Ten minutes at a fixed 500 ms would be 1,200 polls.
    expect(polledAt.length).toBeLessThanOrEqual(125);
  });

  it("keeps the sandbox when Boat rejects the credentials", async () => {
    const { api, provider, computer } = await boat();
    api.unauthorized();

    const error = await reconnect(provider, computer).catch((failure: unknown) => failure);
    expect((error as Error).message).toContain("HTTP 401, unauthorized");
    expect(isSandboxGoneError(error)).toBe(false);
    expect(error).not.toBeInstanceOf(SandboxRateLimitError);
  });

  it("downloads binary files over the JSON endpoint limit through the SDK artifact route", async () => {
    const content = Buffer.alloc(6 * 1024 * 1024, 0xff);
    content[0] = 0;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(content, { headers: { "content-length": String(content.byteLength) } }),
      );
    const provider = new BoatSandboxProvider({
      apiKey: "test-key",
      apiUrl: "https://boat.test/api/v1",
    });
    const computer = {
      id: "bx_testbox2",
      providerRef: "bx_testbox2",
      kind: "boat" as const,
      botId: "bot-a",
    };
    const filePath = "notes/a file & more.bin";
    const downloaded = await provider.readFile(computer, filePath, context);

    expect(Buffer.from(downloaded).equals(content)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [request, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(request));
    expect(url.pathname).toBe("/api/v1/sandboxes/bx_testbox2/artifacts");
    expect(url.searchParams.get("path")).toBe(`/home/user/rakazo-home/${filePath}`);
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-key");
    expect(init?.signal).toBe(context.signal);
  });

  it("restores mixed workspace files through inline writes and private binary uploads", async () => {
    const create = vi.spyOn(FakeBoatApi.prototype, "create");
    const resume = vi.spyOn(FakeBoatApi.prototype, "resume");
    const inline = vi.spyOn(FakeBoatApi.prototype, "writeFile");
    const upload = vi.spyOn(FakeBoatApi.prototype, "createUploadUrl");
    const { api, provider, computer } = await boat();
    create.mockClear();
    const exact = Buffer.alloc(5 * 1024 * 1024, 0xab);
    const large = Buffer.alloc(exact.length + 1, 0xff);
    large[0] = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      api.completeUpload(String(url), new Uint8Array(init?.body as Buffer));
      return new Response(null, { status: 204 });
    });
    async function* files() {
      yield { path: "exact.bin", content: exact };
      yield { path: ".browser-profiles/chrome/Default/History", content: large };
      yield { path: "bin/a tool", content: large, executable: true };
    }

    await provider.importWorkspace(computer, files(), context);

    expect(inline).toHaveBeenCalledOnce();
    expect(upload).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(create).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    for (const [path, expected, executable] of [
      ["exact.bin", exact, false],
      [".browser-profiles/chrome/Default/History", large, false],
      ["bin/a tool", large, true],
    ] as const) {
      const restored = api.files(computer.id).get(`/home/user/rakazo-home/${path}`);
      expect(restored?.executable).toBe(executable);
      expect(Buffer.from(restored!.content).equals(expected)).toBe(true);
    }
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toMatchObject({ method: "PUT", credentials: "omit", redirect: "error" });
      expect(new Headers(init?.headers).get("Authorization")).toBeNull();
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it.each([
    { url: "not a URL" },
    { url: "http://uploads.on.boat.dev/file" },
    { url: "https://127.0.0.1/file" },
    { url: "https://on.boat.dev.attacker.test/file" },
    { url: "https://user:secret@uploads.on.boat.dev/file" },
    { url: "https://uploads.on.boat.dev:8443/file" },
    { url: "https://uploads.on.boat.dev/file#fragment" },
    { path: "/tmp/other.bin" },
    { method: "POST" },
    { ok: false },
  ])("rejects invalid upload capabilities before sending bytes: %j", async (override) => {
    const mint = FakeBoatApi.prototype.createUploadUrl;
    vi.spyOn(FakeBoatApi.prototype, "createUploadUrl").mockImplementation(async function (
      this: FakeBoatApi,
      request,
    ) {
      return { ...(await mint.call(this, request)), ...override } as FileUrlResponse;
    });
    const { provider, computer } = await boat();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected fetch"));
    await expect(
      provider.writeFile(
        computer,
        {
          path: "large.bin",
          content: Buffer.alloc(5 * 1024 * 1024 + 1),
        },
        context,
      ),
    ).rejects.toThrow("Boat returned an invalid file upload URL");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["transport", "http"])(
    "fails uploads without exposing signed URLs or response bodies (%s)",
    async (failure) => {
      const command = vi.spyOn(FakeBoatApi.prototype, "command");
      const { api, provider, computer } = await boat();
      command.mockClear();
      const secret = "fake-private-upload-token";
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        if (failure === "transport")
          throw new Error(`https://uploads.on.boat.dev/?token=${secret}`);
        return new Response(secret, { status: 503 });
      });
      const error = await provider
        .writeFile(
          computer,
          {
            path: "large.bin",
            content: Buffer.alloc(5 * 1024 * 1024 + 1),
            executable: true,
          },
          context,
        )
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(SandboxUnresponsiveError);
      expect((error as Error).message).toBe(
        failure === "transport" ? "Boat file upload failed" : "Boat file upload failed (HTTP 503)",
      );
      expect((error as Error).cause).toBeUndefined();
      expect((error as Error).stack).not.toContain(secret);
      expect(command).not.toHaveBeenCalled();
      expect(api.files(computer.id).has("/home/user/rakazo-home/large.bin")).toBe(false);
    },
  );

  it("cancels in-flight uploads with the caller's signal", async () => {
    const { provider, computer } = await boat();
    const controller = new AbortController();
    const reason = new Error("test cancelled");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      controller.abort(reason);
      init?.signal?.throwIfAborted();
      throw new Error("expected cancellation");
    });
    await expect(
      provider.writeFile(
        computer,
        {
          path: "large.bin",
          content: Buffer.alloc(5 * 1024 * 1024 + 1),
        },
        { ...context, signal: controller.signal },
      ),
    ).rejects.toBe(reason);
  });

  it("exports the whole workspace through one archive download, whatever its file count", async () => {
    const artifactRaw = vi.spyOn(FakeBoatApi.prototype, "artifactRaw");
    const createDownloadUrl = vi.spyOn(FakeBoatApi.prototype, "createDownloadUrl");
    const command = vi.spyOn(FakeBoatApi.prototype, "command");
    const { api, provider, computer } = await boat();
    const files = api.files(computer.id);
    const expected: [string, Buffer, boolean][] = [];
    const put = (path: string, content: Buffer, executable = false) => {
      files.set(`/home/user/rakazo-home/${path}`, { content, executable });
      expected.push([path, content, executable]);
    };
    for (let index = 0; index < 500; index++) {
      put(`project/src/pkg-${index}/index.js`, Buffer.from(`module ${index}`));
    }
    const large = Buffer.alloc(BOAT_ARTIFACT_MAX_BYTES + 1, 0xcd);
    large[0] = 0;
    put("data/archive.bin", large, true);
    put("data/binary.bin", Buffer.from([0, 255, 1, 128, 0, 10, 13]));
    put("data/empty", Buffer.alloc(0));
    put("notes/tab\there/new\nline.txt", Buffer.from("odd"));
    put("unicode/café 日本語 🙂.txt", Buffer.from("unicode"));
    put(".browser-profiles/chrome/Default/History", Buffer.from("history"));
    files.set("/home/user/rakazo-home/.browser-profiles/chrome/Default/Cache/data_0", {
      content: Buffer.from("cache"),
      executable: false,
    });
    files.set("/home/user/outside.txt", {
      content: Buffer.from("not exported"),
      executable: false,
    });
    command.mockClear();
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockClear();

    const exported = await exportAll(provider, computer);

    // Digests, so a mismatch in the large file does not print 50 MiB.
    const digest = (content: Uint8Array) => createHash("sha256").update(content).digest("hex");
    expect(
      exported
        .map((file) => [file.path, digest(file.content), file.executable ?? false])
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
    ).toEqual(
      expected
        .map(([path, content, executable]) => [path, digest(content), executable])
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
    );
    // Only the file too large to hold in memory comes as a stream.
    expect(exported.filter((file) => file.streamed).map((file) => file.path)).toEqual([
      "data/archive.bin",
    ]);
    expect(artifactRaw).not.toHaveBeenCalled();
    expect(createDownloadUrl).toHaveBeenCalledOnce();
    expect(createDownloadUrl.mock.calls[0]?.[0].fileUrlRequest.path).toMatch(
      /^\/tmp\/rakazo-workspace-archive-[0-9a-f-]+\.tar\.gz$/,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "error" });
    expect(new Headers(init?.headers).get("Authorization")).toBeNull();
    // Stopping the browsers, archiving, and removing the archive.
    expect(command).toHaveBeenCalledTimes(3);
    expect(command.mock.calls.at(-1)?.[0].commandRequest.command).toMatch(
      /^rm -f -- '\/tmp\/rakazo-workspace-archive-/,
    );
    expect(archivesLeft(api, computer)).toEqual([]);
  });

  it("archives the workspace in one walk, without browser caches or links", async () => {
    const command = vi.spyOn(FakeBoatApi.prototype, "command");
    const { provider, computer } = await boat();

    await exportAll(provider, computer);

    const script = scripts(command).find((text) => text.startsWith("archive="));
    expect(script).toContain("-printf '%p\\0'");
    expect(script).toContain("-type f");
    expect(script).toContain("Code Cache");
    expect(script).toContain("-prune");
    expect(script).toContain("--hard-dereference");
    expect(script).toContain("--format=pax");
    expect(script).toContain("--null --no-recursion");
    // Only an entry that vanished mid-walk is tolerated; other find errors fail the archive.
    expect(script).toContain("grep -qv -e 'No such file or directory$'");
    expect(script).toContain("-e 'file changed as we read it$'");
  });

  it("downloads a file the artifact route could not send before Boat's proxy timed out", async () => {
    const read = FakeBoatApi.prototype.artifactRaw;
    const artifactRaw = vi.spyOn(FakeBoatApi.prototype, "artifactRaw");
    const { api, provider, computer } = await boat();
    api.files(computer.id).set("/home/user/rakazo-home/report.pdf", {
      content: Buffer.from("slow but small"),
      executable: false,
    });
    artifactRaw.mockImplementation(async function (this: FakeBoatApi, request) {
      if (request.path.endsWith("/report.pdf")) {
        throw boatError(502, "sandbox_direct_failed", "Request timeout after 74997ms");
      }
      return read.call(this, request);
    });
    const fetchMock = vi.mocked(globalThis.fetch);

    const content = await provider.readFile(computer, "report.pdf", context);

    expect(Buffer.from(content).toString()).toBe("slow but small");
    // The sandbox already had the request; resending it would only time out again.
    expect(artifactRaw).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("reports a command Boat's proxy timed out as an unresponsive sandbox without resending it", async () => {
    const run = vi.spyOn(FakeBoatApi.prototype, "command");
    const { provider, computer } = await boat();
    await provider.prepare(computer, context);
    run.mockClear();
    run.mockRejectedValueOnce(
      boatError(502, "sandbox_direct_failed", "Request timeout after 74997ms"),
    );

    const error = await provider
      .listFiles(computer, "", context)
      .catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(SandboxUnresponsiveError);
    expect(isSandboxGoneError(error)).toBe(false);
    expect(run).toHaveBeenCalledOnce();
  });

  it("restores over read-only files a kept disk already holds", async () => {
    const { api, provider, computer } = await boat();
    const pack = "/home/user/rakazo-home/repo/.git/objects/pack/pack-1.idx";
    api.files(computer.id).set(pack, {
      content: Uint8Array.from([1]),
      executable: false,
      readOnly: true,
    });
    async function* files() {
      yield { path: "repo/.git/objects/pack/pack-1.idx", content: Uint8Array.from([2]) };
    }

    await provider.importWorkspace(computer, files(), context);

    expect(api.files(computer.id).get(pack)?.content).toEqual(Uint8Array.from([2]));
  });

  it("lists a folder that is not there as empty", async () => {
    const { provider, computer } = await boat();

    expect(await provider.listFiles(computer, "deleted", context)).toEqual([]);
  });

  it.each([
    ["exit 1", { exitCode: 1, timedOut: false }, "could not list Boat workspace (exit 1)"],
    ["timeout", { exitCode: 124, timedOut: true }, "could not list Boat workspace (timed out)"],
  ])("reports a failed directory listing by its %s, not its output", async (_, ending, message) => {
    const output = `${Buffer.from("/home/user/rakazo-home/private.txt").toString("base64")}\tfile\t1\t0\n`;
    const run = FakeBoatApi.prototype.command;
    vi.spyOn(FakeBoatApi.prototype, "command").mockImplementation(async function (
      this: FakeBoatApi,
      request,
    ) {
      if (!request.commandRequest.command.includes("directory=")) return run.call(this, request);
      return {
        ok: true,
        type: "command.finished",
        success: false,
        stdout: output.repeat(1_000),
        stderr: "",
        ...ending,
      };
    });
    const { provider, computer } = await boat();

    const error = await provider
      .listFiles(computer, "", context)
      .catch((failure: Error) => failure);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(message);
  });

  it("reports why a workspace archive failed without the paths it names", async () => {
    const stderr = [
      "find: './Client: Acme/notes.txt': No space left on device",
      "find: File system loop detected; './private' is part of the same file system loop as '.'.",
      "tar: ./private.txt: Cannot open: Input/output error",
      "find: './other.txt': No space left on device",
    ].join("\n");
    const run = FakeBoatApi.prototype.command;
    vi.spyOn(FakeBoatApi.prototype, "command").mockImplementation(async function (
      this: FakeBoatApi,
      request,
    ) {
      if (!request.commandRequest.command.includes("archive=")) return run.call(this, request);
      return {
        ok: true,
        type: "command.finished",
        success: false,
        stdout: "",
        stderr,
        exitCode: 1,
        timedOut: false,
      };
    });
    const { provider, computer } = await boat();

    const error = await exportAll(provider, computer).catch((failure: Error) => failure);

    expect((error as Error).message).toBe(
      "could not archive Boat workspace (exit 1: No space left on device; Input/output error)",
    );
  });

  it.each([
    ["timed out", { exitCode: 124, timedOut: true }, "timed out"],
    ["met an unreadable file", { exitCode: 3, timedOut: false }, "an entry could not be read"],
  ])("reports a workspace archive that %s without its output", async (_, ending, status) => {
    const output = "/home/user/rakazo-home/private.txt\n";
    const run = FakeBoatApi.prototype.command;
    vi.spyOn(FakeBoatApi.prototype, "command").mockImplementation(async function (
      this: FakeBoatApi,
      request,
    ) {
      if (!request.commandRequest.command.includes("archive=")) return run.call(this, request);
      return {
        ok: true,
        type: "command.finished",
        success: false,
        stdout: output.repeat(1_000),
        stderr: output,
        ...ending,
      };
    });
    const createDownloadUrl = vi.spyOn(FakeBoatApi.prototype, "createDownloadUrl");
    const { provider, computer } = await boat();

    const error = await exportAll(provider, computer).catch((failure: Error) => failure);

    expect((error as Error).message).toBe(`could not archive Boat workspace (${status})`);
    expect(createDownloadUrl).not.toHaveBeenCalled();
  });

  it("fails an export whose archive download was cut short and removes the archive", async () => {
    const { api, provider, computer } = await boat();
    api.files(computer.id).set("/home/user/rakazo-home/notes.txt", {
      content: Buffer.alloc(100_000, 7),
      executable: false,
    });
    vi.mocked(globalThis.fetch).mockImplementation(async (url) => {
      const whole = Buffer.from(await serveFakeBoatDownload(String(url))!.arrayBuffer());
      return new Response(whole.subarray(0, Math.floor(whole.length / 2)));
    });

    await expect(exportAll(provider, computer)).rejects.toThrow();
    expect(archivesLeft(api, computer)).toEqual([]);
  });

  it("stops the archive download with the caller's signal", async () => {
    const { api, provider, computer } = await boat();
    api.files(computer.id).set("/home/user/rakazo-home/notes.txt", {
      content: Buffer.from("kept"),
      executable: false,
    });
    const controller = new AbortController();
    const reason = new DOMException("checkpoint cancelled", "AbortError");
    vi.mocked(globalThis.fetch).mockImplementation(async (_url, init) => {
      const signal = init?.signal as AbortSignal;
      const body = new ReadableStream({
        start(stream) {
          signal.addEventListener("abort", () => stream.error(signal.reason));
          controller.abort(reason);
        },
      });
      return new Response(body);
    });

    await expect(exportAll(provider, computer, controller.signal)).rejects.toBe(reason);
    expect(archivesLeft(api, computer)).toEqual([]);
  });

  it("refuses a workspace over the save limits from its listing, before archiving it", async () => {
    const createDownloadUrl = vi.spyOn(FakeBoatApi.prototype, "createDownloadUrl");
    const { api, provider, computer } = await boat();
    const files = api.files(computer.id);
    for (const name of ["a", "b", "c"]) {
      files.set(`/home/user/rakazo-home/${name}.txt`, {
        content: Buffer.alloc(10),
        executable: false,
      });
    }
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(
      readExport(provider.exportWorkspace(computer, context, { maxBytes: 29, maxFiles: 10 })),
    ).rejects.toEqual(new WorkspaceTooLargeError("bytes"));
    await expect(
      readExport(provider.exportWorkspace(computer, context, { maxBytes: 100, maxFiles: 2 })),
    ).rejects.toEqual(new WorkspaceTooLargeError("files"));
    expect(createDownloadUrl).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(archivesLeft(api, computer)).toEqual([]);
  });

  it("refuses a capped read of a file over the artifact limit without downloading it", async () => {
    const download = vi.spyOn(FakeBoatApi.prototype, "createDownloadUrl");
    const { api, provider, computer } = await boat();
    api.files(computer.id).set("/home/user/rakazo-home/large.bin", {
      content: Buffer.alloc(BOAT_ARTIFACT_MAX_BYTES + 1),
      executable: false,
    });

    await expect(
      provider.readFile(computer, "large.bin", context, { maxBytes: 1024 }),
    ).rejects.toThrow("computer file exceeds 1024 bytes");
    expect(download).not.toHaveBeenCalled();
  });

  it.each([
    { url: "http://downloads.on.boat.dev/file" },
    { url: "https://on.boat.dev.attacker.test/file" },
    { type: "file.upload_url" },
    { method: "PUT" },
    { path: "/tmp/other.bin" },
  ])("rejects invalid download capabilities before fetching: %j", async (override) => {
    const mint = FakeBoatApi.prototype.createDownloadUrl;
    vi.spyOn(FakeBoatApi.prototype, "createDownloadUrl").mockImplementation(async function (
      this: FakeBoatApi,
      request,
    ) {
      return { ...(await mint.call(this, request)), ...override } as FileUrlResponse;
    });
    const { api, provider, computer } = await boat();
    api.files(computer.id).set("/home/user/rakazo-home/large.bin", {
      content: Buffer.alloc(BOAT_ARTIFACT_MAX_BYTES + 1),
      executable: false,
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected fetch"));

    await expect(provider.readFile(computer, "large.bin", context)).rejects.toThrow(
      "Boat returned an invalid file download URL",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["transport", "http"])(
    "fails downloads without exposing signed URLs or response bodies (%s)",
    async (failure) => {
      const { api, provider, computer } = await boat();
      api.files(computer.id).set("/home/user/rakazo-home/large.bin", {
        content: Buffer.alloc(BOAT_ARTIFACT_MAX_BYTES + 1),
        executable: false,
      });
      const secret = "fake-private-download-token";
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        if (failure === "transport")
          throw new Error(`https://downloads.on.boat.dev/?token=${secret}`);
        return new Response(secret, { status: 503 });
      });

      const error = await provider
        .readFile(computer, "large.bin", context)
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(SandboxUnresponsiveError);
      expect((error as Error).message).toBe(
        failure === "transport"
          ? "Boat file download failed"
          : "Boat file download failed (HTTP 503)",
      );
      expect((error as Error).cause).toBeUndefined();
      expect((error as Error).stack).not.toContain(secret);
    },
  );

  it.each([undefined, "1", "20"])(
    "cancels oversized downloads with content-length %s",
    async (contentLength) => {
      const artifactRaw = vi.spyOn(FakeBoatApi.prototype, "artifactRaw");
      const { provider, computer } = await boat();
      const cancel = vi.fn();
      const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
        controller.enqueue(Uint8Array.from([1, 2, 3]));
      });
      const body = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
      artifactRaw.mockResolvedValueOnce({
        raw: new Response(body, {
          headers: contentLength ? { "content-length": contentLength } : undefined,
        }),
        value: async () => new Blob(),
      });

      await expect(
        provider.readFile(computer, "large.bin", context, { maxBytes: 4 }),
      ).rejects.toThrow("computer file exceeds 4 bytes");
      expect(pull).toHaveBeenCalledTimes(contentLength === "20" ? 0 : 2);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(body.locked).toBe(false);
    },
  );

  it("accepts empty files and files exactly at the download limit", async () => {
    const { api, provider, computer } = await boat();
    const files = api.files(computer.id);
    files.set("/home/user/rakazo-home/empty.bin", { content: new Uint8Array(), executable: false });
    files.set("/home/user/rakazo-home/exact.bin", {
      content: Uint8Array.from([0, 255]),
      executable: false,
    });

    expect(await provider.readFile(computer, "empty.bin", context, { maxBytes: 0 })).toHaveLength(
      0,
    );
    expect(await provider.readFile(computer, "exact.bin", context, { maxBytes: 2 })).toEqual(
      Uint8Array.from([0, 255]),
    );
  });

  it("reports a missing file without calling the sandbox gone", async () => {
    const { provider, computer } = await boat();
    const error = await provider
      .readFile(computer, "missing.txt", context)
      .catch((failure: unknown) => failure);
    expect((error as Error).message).toContain("HTTP 404, not_found");
    expect(isSandboxGoneError(error)).toBe(false);
  });

  it("propagates interrupted downloads instead of returning partial files", async () => {
    const artifactRaw = vi.spyOn(FakeBoatApi.prototype, "artifactRaw");
    const { provider, computer } = await boat();
    const aborted = new DOMException("download aborted", "AbortError");
    let first = true;
    const body = new ReadableStream({
      pull(controller) {
        if (first) controller.enqueue(Uint8Array.from([1, 2, 3]));
        else controller.error(aborted);
        first = false;
      },
    });
    artifactRaw.mockResolvedValueOnce({
      raw: new Response(body),
      value: async () => new Blob(),
    });

    await expect(provider.readFile(computer, "partial.bin", context)).rejects.toBe(aborted);
    expect(body.locked).toBe(false);
  });

  it("captures independent desktops and exposes protected ports", async () => {
    const command = vi.spyOn(FakeBoatApi.prototype, "command");
    const { provider, computer } = await boat();
    await provider.prepare(computer, context);

    const observation = await provider.observe(computer, context);
    expect(observation).toMatchObject({
      mimeType: "image/png",
      width: 1280,
      height: 800,
      cursor: { x: 10, y: 20 },
    });
    expect(observation.image).toEqual(Uint8Array.from([1, 2, 3]));

    const screen = await provider.connectScreen(
      computer,
      { view: "stream", interactive: false },
      context,
    );
    expect(new URL(screen.url!).searchParams.get("path")).toMatch(/^\/websockify\?token=view-/);
    expect(screen.url).not.toContain("_token");
    expect(screen.headers).toEqual({ cookie: "_port_auth=secret" });
    expect(
      command.mock.calls.some(
        ([request]) =>
          "commandRequest" in request &&
          request.commandRequest.command.includes("0.0.0.0:6100 8>&-"),
      ),
    ).toBe(true);

    await provider.act(
      computer,
      { actions: [{ kind: "pointer", type: "click", x: 100, y: 200 }], observe: false },
      context,
    );
    expect(
      command.mock.calls.some(([request]) =>
        "commandRequest" in request
          ? request.commandRequest.command.includes("xdotool mousemove 100 200 click 1")
          : false,
      ),
    ).toBe(true);

    await expect(provider.observe(computer, { ...context, botId: "bot-b" })).resolves.toMatchObject(
      { width: 1280 },
    );
    expect(provider.describe().capabilities.multiScreen).toBe(true);
  });

  it("installs the page browser and drives this screen's Chrome with the request on stdin", async () => {
    const command = vi.spyOn(FakeBoatApi.prototype, "command");
    const { api, provider, computer } = await boat();
    await provider.prepare(computer, context);
    expect(scripts(command)).toContain(installPageBrowserCommand());

    const seen: Array<{ command: string; input: string }> = [];
    api.withInput = (script, input) => {
      seen.push({ command: script, input });
      return {
        stdout: JSON.stringify({
          ok: true,
          completed: 1,
          url: "https://example.com/",
          title: "Example",
          tree: '- textbox "Password" [e1]',
          elements: [{ ref: "e1", role: "textbox", name: "Password" }],
        }),
      };
    };
    const fill = {
      kind: "fill" as const,
      ref: "e1",
      text: "hunter2",
      origin: "https://example.com",
      field: "password" as const,
    };
    const browser = new ComputerBrowserProvider({ sandbox: provider });
    expect(browser.describe().capabilities.page).toBe(true);
    await expect(browser.act(computer, { actions: [fill] }, context)).resolves.toMatchObject({
      ok: true,
      completed: 1,
      url: "https://example.com/",
    });

    // The saved login reaches the helper on stdin, never in a command Boat logs.
    expect(seen).toEqual([
      {
        command: desktopWorkCommand(
          "bot-a",
          undefined,
          0,
          "DISPLAY=:20 RAKAZO_CDP_PORT=9241 HOME='/home/user/rakazo-home' RAKAZO_BROWSER_ARGS_STDIN=1 /usr/local/bin/rakazo-page-browser act",
        ),
        input: `${JSON.stringify({ command: "act", actions: [fill] })}\n`,
      },
    ]);
    expect(scripts(command).some((script) => script.includes("hunter2"))).toBe(false);
  });

  it("still prepares the computer when the page browser cannot be installed", async () => {
    const { api, provider, computer } = await boat();
    const command = api.command.bind(api);
    vi.spyOn(api, "command").mockImplementation(async (request) =>
      String(parse(request.commandRequest.command).at(-1)) === installPageBrowserCommand()
        ? {
            ok: true,
            type: "command.finished",
            success: false,
            exitCode: 22,
            stdout: "",
            stderr: "curl: (22) The requested URL returned error: 503\n",
            timedOut: false,
          }
        : command(request),
    );

    await expect(provider.prepare(computer, context)).resolves.toBeUndefined();
    await expect(provider.observe(computer, context)).resolves.toMatchObject({ width: 1280 });
  });

  it("falls back to desktop tools when the page browser cannot answer", async () => {
    const { api, provider, computer } = await boat();
    await provider.prepare(computer, context);
    const browser = new ComputerBrowserProvider({ sandbox: provider });

    api.withInput = () => ({
      stdout: JSON.stringify({
        ok: false,
        error: "CDP not ready on port 9241: refused",
        fallback: "computer_act",
      }),
    });
    await expect(browser.snapshot(computer, {}, context)).resolves.toMatchObject({
      fallback: "computer_act",
      error: "CDP not ready on port 9241: refused",
    });

    // An older computer image refuses a command it does not know with exit 2.
    api.withInput = () => ({
      exitCode: 2,
      stdout: JSON.stringify({
        ok: false,
        error: "unknown command: purchase_check",
        fallback: "computer_act",
      }),
    });
    await expect(
      browser.purchaseCheck(
        computer,
        { desktop: true, enter: false, points: [{ x: 10, y: 10 }], unplaced: false },
        context,
      ),
    ).resolves.toEqual({ purchase: null });

    api.withInput = () => ({ exitCode: 1, stdout: "Traceback" });
    await expect(
      browser.act(computer, { actions: [{ kind: "click", ref: "e1" }] }, context),
    ).resolves.toMatchObject({
      ok: false,
      uncertain: true,
      fallback: "computer_act",
      error: "Page browser unavailable or interrupted",
    });

    api.withInput = () => ({ stdout: JSON.stringify({ ok: true }) });
    await expect(
      browser.navigate(computer, { url: "https://example.com" }, context),
    ).resolves.toMatchObject({ fallback: "computer_act" });
  });

  it("authenticates takeover and terminal streams without a browser cookie bootstrap", async () => {
    const { provider, computer } = await boat();
    await provider.prepare(computer, context);
    const control = await provider.connectScreen(
      computer,
      { view: "stream", interactive: true, controlToken: "fake-control" },
      context,
    );
    const terminal = await provider.connectTerminal(
      computer,
      { controlToken: "fake-control" },
      context,
    );
    for (const session of [control, terminal]) {
      expect(session.headers).toEqual({ cookie: "_port_auth=secret" });
      expect(session.url).not.toContain("_token");
      expect(new URL(session.url!).searchParams.get("path")).toContain("token=");
    }
  });

  it("refuses a desktop URL that is not served over HTTPS", async () => {
    vi.spyOn(FakeBoatApi.prototype, "hostPort").mockResolvedValue({
      ok: true,
      type: "sandbox.host",
      url: "http://boat-test-6100.on.boat.dev?_token=secret",
    });
    const { provider, computer } = await boat();
    await provider.prepare(computer, context);
    await expect(
      provider.connectScreen(computer, { view: "stream", interactive: false }, context),
    ).rejects.toThrow("Boat desktop URL is not protected");
  });

  it("archives on stop and permanently deletes on destroy", async () => {
    const stop = vi.spyOn(FakeBoatApi.prototype, "stop");
    const { api, provider, computer } = await boat();

    await provider.stop(computer, context);
    expect(stop).toHaveBeenCalledWith({ sandboxId: computer.id }, { signal: context.signal });
    expect(api.state(computer.id)).toBe("archived");
    await provider.destroy(computer, context);
    expect(api.state(computer.id)).toBeUndefined();
    await expect(provider.stop(computer, context)).resolves.toBeUndefined();
    await expect(provider.destroy(computer, context)).resolves.toBeUndefined();
  });

  it("bounds a stalled permanent-delete request", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new BoatSandboxProvider({ apiKey: "test-key" });

    const pending = provider.destroy(
      { id: "boat-test", providerRef: "boat-test", botId: "bot-test", kind: "boat" },
      context,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    deadline.abort(new DOMException("Timed out", "TimeoutError"));

    await expect(pending).rejects.toThrow("Boat boat-test was not deleted within 60 seconds");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(deadline.signal);
  });

  it("keeps the same deadline on permanent-delete status polling", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockImplementationOnce(
        async (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new BoatSandboxProvider({ apiKey: "test-key" });

    const pending = provider.destroy(
      { id: "boat-test", providerRef: "boat-test", botId: "bot-test", kind: "boat" },
      context,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    deadline.abort(new DOMException("Timed out", "TimeoutError"));

    await expect(pending).rejects.toThrow("Boat boat-test was not deleted within 60 seconds");
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(deadline.signal);
    expect(fetchMock.mock.calls[1]?.[1]?.signal).toBe(deadline.signal);
  });

  it("leaves a sandbox another API key created to its creator", async () => {
    const forbidden = (code: string) =>
      new Response(JSON.stringify({ code, message: "Forbidden" }), { status: 403 });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(forbidden("api_key_action_forbidden"))
      .mockResolvedValueOnce(forbidden("forbidden"));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new BoatSandboxProvider({ apiKey: "test-key" });
    const computer = {
      id: "boat-test",
      providerRef: "boat-test",
      botId: "bot-test",
      kind: "boat" as const,
    };
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    try {
      await expect(provider.destroy(computer, context)).resolves.toBeUndefined();
      expect(sink.events).toContainEqual(
        expect.objectContaining({ message: "sandbox.destroy", outcome: "not_owned" }),
      );
      // Any other refusal still fails, so the computer is kept for a retry.
      await expect(provider.destroy(computer, context)).rejects.toThrow("HTTP 403, forbidden");
    } finally {
      installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
    }
  });
});

describe("Boat computer snapshot", () => {
  function provision(provider: BoatSandboxProvider) {
    return provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
  }

  it("names the snapshot after the setup it captures", () => {
    expect(BOAT_COMPUTER_SNAPSHOT).toMatch(/^rakazo-computer-[0-9a-f]{12}$/);
    expect(computerSnapshotName(["mkdir -p a", PREPARE_LINUX_DESKTOP])).not.toBe(
      computerSnapshotName(["mkdir -p b", PREPARE_LINUX_DESKTOP]),
    );
    expect(computerSnapshotName(["a", "b"])).toBe(computerSnapshotName(["a", "b"]));
  });

  it("carries agent-browser but leaves the page-browser files to each boot", async () => {
    const command = vi.spyOn(FakeBoatApi.prototype, "command");
    const api = new FakeBoatApi();
    api.savedSnapshots.clear();
    await new BoatSandboxProvider({ apiKey: "test-key" }, api).buildComputerSnapshot();
    const setup = scripts(command).join("\n");
    expect(setup).toContain("agent-browser-linux-");
    expect(setup).not.toContain("rakazo-page-browser");
  });

  it("starts new computers from the ready snapshot with only their own env", async () => {
    const api = new FakeBoatApi();
    const provider = new BoatSandboxProvider({ apiKey: "test-key" }, api);

    await provision(provider);
    await provision(provider);

    expect(api.creates).toEqual([
      {
        ttlSeconds: 7200,
        noEnv: true,
        env: { RAKAZO_BOT_ID: "bot-a", RAKAZO_SANDBOX: "computer" },
        from: BOAT_COMPUTER_SNAPSHOT,
      },
      expect.objectContaining({ from: BOAT_COMPUTER_SNAPSHOT }),
    ]);
  });

  it("installs on a plain sandbox and builds the snapshot once when it is missing", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    try {
      const api = new FakeBoatApi();
      api.savedSnapshots.clear();
      const remove = vi.spyOn(api, "deleteSandbox");
      const provider = new BoatSandboxProvider({ apiKey: "test-key" }, api);

      const first = await provision(provider);
      const second = await provision(provider);
      await vi.waitFor(() =>
        expect(api.savedSnapshots.get(BOAT_COMPUTER_SNAPSHOT)?.status).toBe("ready"),
      );
      await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
      const third = await provision(provider);

      const computers = api.creates.filter((request) => request.env?.RAKAZO_BOT_ID);
      expect(computers.map((request) => request.from)).toEqual([
        undefined,
        undefined,
        BOAT_COMPUTER_SNAPSHOT,
      ]);
      const builds = api.creates.filter((request) => !request.env?.RAKAZO_BOT_ID);
      expect(builds).toEqual([{ ttlSeconds: 1800, noEnv: true }]);
      const buildId = api.savedSnapshots.get(BOAT_COMPUTER_SNAPSHOT)?.sourceSandboxId;
      expect([first.id, second.id, third.id]).not.toContain(buildId);
      expect(remove).toHaveBeenCalledWith(buildId);
      expect(api.state(buildId!)).toBeUndefined();
      expect(
        sink.events
          .filter((event) => event.message === "sandbox.base_image")
          .map(({ outcome }) => outcome),
      ).toEqual(["missing", "built"]);
    } finally {
      installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
    }
  });

  it("falls back to a plain sandbox when Boat no longer has the snapshot", async () => {
    const api = new FakeBoatApi();
    const create = vi.spyOn(api, "create");
    const provider = new BoatSandboxProvider({ apiKey: "test-key" }, api);
    await provision(provider);
    api.savedSnapshots.clear();
    create.mockClear();
    const build = vi.spyOn(provider, "buildComputerSnapshot");

    const computer = await provision(provider);

    const attempts = create.mock.calls.map(([request]) => request?.createSandboxRequest);
    expect(attempts.slice(0, 2)).toEqual([
      expect.objectContaining({ from: BOAT_COMPUTER_SNAPSHOT }),
      {
        ttlSeconds: 7200,
        noEnv: true,
        env: { RAKAZO_BOT_ID: "bot-a", RAKAZO_SANDBOX: "computer" },
      },
    ]);
    expect(computer.id).toBe("bx_fake2");
    expect(build).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(api.savedSnapshots.get(BOAT_COMPUTER_SNAPSHOT)?.status).toBe("ready"),
    );
  });

  it("builds from a clean sandbox, checks the desktop, and skips a ready snapshot", async () => {
    const api = new FakeBoatApi();
    api.savedSnapshots.clear();
    const command = vi.spyOn(api, "command");
    const provider = new BoatSandboxProvider({ apiKey: "test-key" }, api);

    await expect(provider.buildComputerSnapshot()).resolves.toEqual({
      name: BOAT_COMPUTER_SNAPSHOT,
      built: true,
    });
    expect(api.creates).toEqual([{ ttlSeconds: 1800, noEnv: true }]);
    const commands = command.mock.calls.map(([request]) => request.commandRequest.command);
    expect(commands.some((line) => line.includes("apt-get install"))).toBe(true);
    expect(commands.some((line) => line.includes("xdpyinfo -display :99"))).toBe(true);
    expect(commands.join("\n")).not.toContain("RAKAZO_BOT_ID");

    await expect(provider.buildComputerSnapshot()).resolves.toEqual({
      name: BOAT_COMPUTER_SNAPSHOT,
      built: false,
    });
    expect(api.creates).toHaveLength(1);
  });

  it("waits for a save already in progress instead of building again", async () => {
    const api = new FakeBoatApi();
    api.savedSnapshots.set(BOAT_COMPUTER_SNAPSHOT, {
      name: BOAT_COMPUTER_SNAPSHOT,
      status: "saving",
      sourceSandboxId: "bx_other",
      createdAt: new Date(0),
    });
    const provider = new BoatSandboxProvider({ apiKey: "test-key" }, api);

    await expect(provider.buildComputerSnapshot()).resolves.toEqual({
      name: BOAT_COMPUTER_SNAPSHOT,
      built: false,
    });
    expect(api.creates).toEqual([]);
  });

  it("keeps using the snapshot after a boot is cancelled during its lookup", async () => {
    const api = new FakeBoatApi();
    const lookup = vi.spyOn(api, "getSavedSnapshot");
    const provider = new BoatSandboxProvider({ apiKey: "test-key" }, api);
    const cancelled = new AbortController();
    lookup.mockImplementationOnce(async () => {
      cancelled.abort(new Error("boot cancelled"));
      throw cancelled.signal.reason;
    });

    await expect(
      provider.provision(
        { botId: "bot-a", homePath: "/unused" },
        { ...context, signal: cancelled.signal },
      ),
    ).rejects.toThrow("boot cancelled");
    await provision(provider);

    expect(api.creates).toEqual([expect.objectContaining({ from: BOAT_COMPUTER_SNAPSHOT })]);
  });

  it("does not save a snapshot whose desktop check fails", async () => {
    const api = new FakeBoatApi();
    api.savedSnapshots.clear();
    const run = api.command.bind(api);
    vi.spyOn(api, "command").mockImplementation(async (request) =>
      request.commandRequest.command.includes("xdpyinfo -display :99")
        ? {
            ok: true,
            type: "command.finished",
            success: false,
            exitCode: 1,
            stdout: "",
            stderr: "Xvfb did not start\n",
            timedOut: false,
          }
        : run(request),
    );
    const remove = vi.spyOn(api, "deleteSandbox");
    const provider = new BoatSandboxProvider({ apiKey: "test-key" }, api);

    await expect(provider.buildComputerSnapshot()).rejects.toMatchObject({
      cause: { message: "exit 1: Xvfb did not start" },
    });
    expect(api.savedSnapshots.size).toBe(0);
    expect(remove).toHaveBeenCalledWith("bx_fake1");
  });
});
