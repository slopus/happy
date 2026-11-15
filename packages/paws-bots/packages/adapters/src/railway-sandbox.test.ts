import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ComputerRef, ProcessEvent } from "@rakazo/adapter-kit";
import { screenDisplayArgv, shellQuote } from "@rakazo/core/node/desktop-runtime";
import type { RailwayGraphQLErrorItem, SandboxInfo } from "railway";
import {
  RailwayGraphQLError,
  Sandbox,
  SandboxFileNotFoundError,
  SandboxNotFoundError,
  SandboxTimeoutError,
} from "railway";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { LinuxDesktop } from "./linux-desktop.js";
import { RailwaySandboxProvider } from "./railway-sandbox.js";
import { isSandboxGoneError } from "./sandbox-errors.js";
import { assertSandboxWorkspaceContract } from "./sandbox-test-support.js";

const sdk = { connect: Sandbox.connect, create: Sandbox.create };
vi.spyOn(Sandbox, "connect");
vi.spyOn(Sandbox, "create");

const ctx = {
  operationId: "op",
  traceId: "trace",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};
const computer: ComputerRef = {
  id: "sandbox",
  providerRef: "sandbox",
  kind: "railway",
  botId: "bot",
};
const provider = new RailwaySandboxProvider({ token: "test", environmentId: "environment" });
const sandbox = {
  id: "sandbox",
  domains: [{ port: 6080, domain: "screen-test.up.railway.app" }],
  status: "RUNNING",
  networkIsolation: "PRIVATE",
  destroy: vi.fn(),
  heartbeat: vi.fn(),
  exec: vi.fn(),
  files: { read: vi.fn(), write: vi.fn(), list: vi.fn() },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function sandboxInfo(overrides: Partial<SandboxInfo> = {}): SandboxInfo {
  return {
    id: "sandbox",
    status: "RUNNING",
    networkIsolation: "PRIVATE",
    environmentId: "environment",
    region: "us-west2",
    idleTimeoutMinutes: 15,
    createdAt: new Date().toISOString(),
    domains: [{ prefix: "screen-test", port: 6080, domain: "screen-test.up.railway.app" }],
    ...overrides,
  };
}

/** A stateful Railway GraphQL API behind the real SDK and the adapter's transport. */
function backboard(stored?: Partial<SandboxInfo>) {
  vi.mocked(Sandbox.connect).mockImplementation(sdk.connect);
  vi.mocked(Sandbox.create).mockImplementation(sdk.create);
  const sandboxes = new Map<string, SandboxInfo>();
  if (stored) sandboxes.set("sandbox", sandboxInfo(stored));
  const operations: string[] = [];
  const failures = new Map<string, RailwayGraphQLErrorItem>();
  const failureStatus = new Map<string, number>();
  const created: Array<Record<string, unknown>> = [];
  const rejected: Array<Record<string, unknown>> = [];
  // Hobby and Pro allow 1-120 minutes or 0 (never); Trial and Free allow 1-5 and never 0.
  // Railway does not document the rejection's wording.
  const plan = {
    maxIdleTimeoutMinutes: 120,
    allowsNever: true,
    rejection: "idle timeout must be between 1 and 5 minutes",
  };
  const reply = (body: object, status = 200) => new Response(JSON.stringify(body), { status });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: unknown, init?: RequestInit) => {
      const { query, variables } = JSON.parse(String(init?.body));
      const operation = /(?:query|mutation) (\w+)/.exec(query)?.[1] ?? "";
      operations.push(operation);
      const failure = failures.get(operation);
      if (failure) return reply({ errors: [failure] }, failureStatus.get(operation));
      const existing = sandboxes.get(variables.id);
      switch (operation) {
        case "RailwaySandbox":
          return reply({ data: { sandbox: existing ?? null } });
        case "RailwaySandboxCreate": {
          const idle = variables.input.idleTimeoutMinutes;
          if (
            typeof idle === "number" &&
            (idle > plan.maxIdleTimeoutMinutes || (idle <= 0 && !plan.allowsNever))
          ) {
            rejected.push(variables.input);
            return reply({ errors: [{ message: plan.rejection }] });
          }
          created.push(variables.input);
          const info = sandboxInfo({ id: `created-${created.length}` });
          sandboxes.set(info.id, info);
          return reply({ data: { sandboxCreate: info } });
        }
        case "RailwaySandboxDestroy":
          if (!existing) return reply({ errors: [{ message: "Sandbox not found" }] });
          existing.status = "DESTROYING";
          return reply({ data: { sandboxDestroy: existing } });
        case "RailwaySandboxHeartbeat":
          return reply({
            data: { sandboxHeartbeat: existing?.status === "RUNNING" ? existing : null },
          });
        default:
          throw new Error(`Unexpected Railway operation ${operation}`);
      }
    }),
  );
  return {
    sandboxes,
    operations,
    failures,
    failureStatus,
    created,
    rejected,
    plan,
  };
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const reconnect = {
  botId: "bot",
  homePath: "/unused",
  providerRef: "sandbox",
  providerKind: "railway" as const,
};

describe("Railway sandbox lifecycle", () => {
  it.each<{
    name: string;
    stored?: Partial<SandboxInfo>;
    failure?: RailwayGraphQLErrorItem;
    destroys: boolean;
    replaces: boolean;
  }>([
    { name: "a running PRIVATE sandbox", stored: {}, destroys: false, replaces: false },
    {
      name: "a running sandbox without PRIVATE networking",
      stored: { networkIsolation: "ISOLATED" },
      destroys: true,
      replaces: true,
    },
    {
      name: "a sandbox stuck creating",
      stored: { status: "CREATING", createdAt: minutesAgo(11) },
      destroys: true,
      replaces: true,
    },
    {
      name: "a sandbox with an unreadable creation time",
      stored: { status: "CREATING", createdAt: "" },
      destroys: true,
      replaces: true,
    },
    {
      name: "a destroying sandbox",
      stored: { status: "DESTROYING" },
      destroys: false,
      replaces: true,
    },
    {
      name: "a destroyed sandbox",
      stored: { status: "DESTROYED" },
      destroys: false,
      replaces: true,
    },
    {
      name: "a destroyed sandbox without PRIVATE networking",
      stored: { status: "DESTROYED", networkIsolation: "ISOLATED" },
      destroys: false,
      replaces: true,
    },
    { name: "a failed sandbox", stored: { status: "FAILED" }, destroys: false, replaces: true },
    { name: "a missing sandbox", destroys: false, replaces: true },
    {
      name: "a sandbox Railway reports as not found",
      failure: { message: "Sandbox not found" },
      destroys: false,
      replaces: true,
    },
  ])("provisioning over $name", async ({ stored, failure, destroys, replaces }) => {
    const api = backboard(stored);
    if (failure) api.failures.set("RailwaySandbox", failure);
    const ref = await provider.provision(reconnect, ctx);
    expect(ref).toMatchObject(
      replaces
        ? { providerRef: "created-1", fresh: true }
        : { providerRef: "sandbox", fresh: false },
    );
    expect(api.operations.includes("RailwaySandboxDestroy")).toBe(destroys);
    expect(api.created).toHaveLength(replaces ? 1 : 0);
    if (destroys)
      expect(api.operations.indexOf("RailwaySandboxDestroy")).toBeLessThan(
        api.operations.indexOf("RailwaySandboxCreate"),
      );
  });

  it("waits for a sandbox that is still within its creation window", async () => {
    const api = backboard({ status: "CREATING", createdAt: minutesAgo(2) });
    await expect(provider.provision(reconnect, ctx)).rejects.toThrow("still starting");
    expect(api.operations).toEqual(["RailwaySandbox"]);
  });

  it.each([
    { name: "authentication", lookup: { message: "Not Authorized" } },
    { name: "a failed replacement deletion", destroy: { message: "Not Authorized" } },
  ])("does not allocate a replacement after $name errors", async ({ lookup, destroy }) => {
    const api = backboard({ networkIsolation: "ISOLATED" });
    if (lookup) api.failures.set("RailwaySandbox", lookup);
    if (destroy) api.failures.set("RailwaySandboxDestroy", destroy);
    await expect(provider.provision(reconnect, ctx)).rejects.toBeInstanceOf(RailwayGraphQLError);
    expect(api.created).toHaveLength(0);
  });

  it.each<[string, Partial<SandboxInfo> | undefined, boolean]>([
    ["RUNNING with PRIVATE networking", {}, true],
    ["RUNNING without PRIVATE networking", { networkIsolation: "ISOLATED" }, false],
    ["CREATING", { status: "CREATING" }, false],
    ["DESTROYING", { status: "DESTROYING" }, false],
    ["DESTROYED", { status: "DESTROYED" }, false],
    ["FAILED", { status: "FAILED" }, false],
    ["missing", undefined, false],
  ])("reports a %s sandbox as running: %s", async (_name, stored, running) => {
    backboard(stored);
    expect(await provider.isRunning(computer, ctx)).toBe(running);
  });

  it("reports a sandbox Railway cannot find as stopped but surfaces other API errors", async () => {
    const api = backboard({});
    api.failures.set("RailwaySandbox", { message: "Sandbox not found" });
    expect(await provider.isRunning(computer, ctx)).toBe(false);
    api.failures.set("RailwaySandbox", { message: "Not Authorized" });
    await expect(provider.isRunning(computer, ctx)).rejects.toBeInstanceOf(RailwayGraphQLError);
  });

  it.each([
    ["DESTROYING", { status: "DESTROYING" }],
    ["DESTROYED", { status: "DESTROYED" }],
    ["FAILED", { status: "FAILED" }],
    ["DESTROYED without PRIVATE networking", { status: "DESTROYED", networkIsolation: "ISOLATED" }],
  ] satisfies Array<[string, Partial<SandboxInfo>]>)(
    "reports a %s sandbox as gone to commands, files and keepalive",
    async (_name, stored) => {
      const api = backboard(stored);
      for (const operation of [
        provider.listFiles(computer, ".", ctx),
        provider.readFile(computer, "note", ctx),
        provider.keepAlive(computer),
      ]) {
        const error = await operation.then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(error).toBeInstanceOf(SandboxNotFoundError);
        expect(isSandboxGoneError(error)).toBe(true);
      }
      expect(api.operations).not.toContain("RailwaySandboxHeartbeat");
    },
  );

  it("refuses commands on a running sandbox without PRIVATE networking", async () => {
    backboard({ networkIsolation: "ISOLATED" });
    await expect(provider.listFiles(computer, ".", ctx)).rejects.toThrow("PRIVATE networking");
    await expect(provider.keepAlive(computer)).rejects.toThrow("PRIVATE networking");
  });

  it.each<[string, RailwayGraphQLErrorItem | undefined]>([
    ["no data", undefined],
    ["a not-found error", { message: "Sandbox not found" }],
  ])(
    "reports a sandbox destroyed between lookup and heartbeat (%s) as gone",
    async (_name, failure) => {
      const api = backboard({});
      const sandbox = api.sandboxes.get("sandbox");
      if (failure) api.failures.set("RailwaySandboxHeartbeat", failure);
      else if (sandbox) {
        // The lookup still sees it running; the heartbeat finds it gone.
        vi.mocked(Sandbox.connect).mockImplementationOnce(async (id, options) => {
          const connected = await sdk.connect(id, options);
          sandbox.status = "DESTROYED";
          return connected;
        });
      }
      await expect(provider.keepAlive(computer)).rejects.toBeInstanceOf(SandboxNotFoundError);
    },
  );

  it("renews a running PRIVATE sandbox", async () => {
    const api = backboard({});
    await provider.keepAlive(computer);
    expect(api.operations).toEqual(["RailwaySandbox", "RailwaySandboxHeartbeat"]);
  });

  it.each<{
    name: string;
    stored?: Partial<SandboxInfo>;
    failure?: RailwayGraphQLErrorItem;
    destroys: boolean;
  }>([
    { name: "a running sandbox", stored: {}, destroys: true },
    { name: "a creating sandbox", stored: { status: "CREATING" }, destroys: true },
    { name: "a destroying sandbox", stored: { status: "DESTROYING" }, destroys: false },
    { name: "a destroyed sandbox", stored: { status: "DESTROYED" }, destroys: false },
    { name: "a failed sandbox", stored: { status: "FAILED" }, destroys: false },
    { name: "a missing sandbox", destroys: false },
    {
      name: "a sandbox removed before its deletion",
      stored: {},
      failure: { message: "Sandbox not found" },
      destroys: true,
    },
  ])("destroys $name idempotently", async ({ stored, failure, destroys }) => {
    const api = backboard(stored);
    if (failure) api.failures.set("RailwaySandboxDestroy", failure);
    await expect(provider.destroy(computer, ctx)).resolves.toBeUndefined();
    await expect(provider.destroy(computer, ctx)).resolves.toBeUndefined();
    expect(api.operations.filter((name) => name === "RailwaySandboxDestroy")).toHaveLength(
      destroys ? (failure ? 2 : 1) : 0,
    );
  });

  it("surfaces deletion failures that do not mean the sandbox is gone", async () => {
    const api = backboard({});
    api.failures.set("RailwaySandboxDestroy", { message: "Not Authorized" });
    await expect(provider.destroy(computer, ctx)).rejects.toBeInstanceOf(RailwayGraphQLError);
  });

  it.each<[string | undefined, number]>([
    [undefined, 15],
    ["30000", 1],
    ["1800000", 45],
    ["4800000", 120],
    ["4860000", 0],
    ["10800000", 0],
    ["0", 0],
  ])("creates sandboxes that outlast idle sleep with SANDBOX_IDLE_MS=%s", async (idle, minutes) => {
    if (idle !== undefined) vi.stubEnv("SANDBOX_IDLE_MS", idle);
    const api = backboard();
    await provider.provision({ botId: "bot", homePath: "/unused" }, ctx);
    expect(api.created).toEqual([
      expect.objectContaining({ idleTimeoutMinutes: minutes, networkIsolation: "PRIVATE" }),
    ]);
  });

  it.each<[string | undefined, number, string]>([
    [undefined, 15, "idle timeout must be between 1 and 5 minutes"],
    [undefined, 15, "Invalid input: value must be between 1 and 5"],
    [undefined, 15, "Problem processing request"],
    ["0", 0, "Invalid input: value must be between 1 and 5"],
    ["180000", 5, "Invalid input: value must be between 1 and 5"],
  ])(
    "creates sandboxes on a Trial or Free plan with SANDBOX_IDLE_MS=%s when Railway says %j",
    async (idle, minutes, rejection) => {
      if (idle !== undefined) vi.stubEnv("SANDBOX_IDLE_MS", idle);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const api = backboard();
      Object.assign(api.plan, { maxIdleTimeoutMinutes: 5, allowsNever: false, rejection });
      try {
        expect(await provider.provision({ botId: "bot", homePath: "/unused" }, ctx)).toMatchObject({
          providerRef: "created-1",
          fresh: true,
        });
        const rejected = minutes > 5 || minutes === 0;
        expect(api.rejected).toEqual(
          rejected ? [expect.objectContaining({ idleTimeoutMinutes: minutes })] : [],
        );
        expect(api.created).toEqual([
          rejected
            ? expect.not.objectContaining({ idleTimeoutMinutes: expect.anything() })
            : expect.objectContaining({ idleTimeoutMinutes: minutes }),
        ]);
        expect(warn).toHaveBeenCalledTimes(rejected ? 1 : 0);
      } finally {
        warn.mockRestore();
      }
    },
  );

  it.each<[string, string, number | undefined, string]>([
    ["a full sandbox cap", "Sandbox limit of 10 reached", undefined, "LIMIT_EXCEEDED"],
    ["an authorization error", "Not Authorized", undefined, "UNAUTHORIZED"],
    ["an HTTP 401", "fake-secret", 401, "REQUEST_FAILED"],
    ["an HTTP 403", "fake-secret", 403, "REQUEST_FAILED"],
  ])("does not retry a create rejected by %s", async (_name, message, status, code) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const api = backboard();
    api.failures.set("RailwaySandboxCreate", { message });
    if (status) api.failureStatus.set("RailwaySandboxCreate", status);
    try {
      await expect(provider.provision({ botId: "bot", homePath: "/unused" }, ctx)).rejects.toThrow(
        `Railway API request failed (${code})`,
      );
      expect(api.operations.filter((name) => name === "RailwaySandboxCreate")).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("does not retry a create after its caller cancels", async () => {
    const api = backboard();
    api.failures.set("RailwaySandboxCreate", { message: "Problem processing request" });
    const controller = new AbortController();
    const transport = vi.mocked(fetch);
    const respond = transport.getMockImplementation();
    transport.mockImplementationOnce(async (...args) => {
      controller.abort(new Error("provision canceled"));
      if (!respond) throw new Error("Missing fake Railway API");
      return respond(...args);
    });
    await expect(
      provider.provision(
        { botId: "bot", homePath: "/unused" },
        { ...ctx, signal: controller.signal },
      ),
    ).rejects.toThrow("provision canceled");
    expect(api.operations.filter((name) => name === "RailwaySandboxCreate")).toHaveLength(1);
  });

  it.each<[string, () => Response]>([
    [
      "a server error",
      () => new Response('{"errors":[{"message":"Bad gateway"}]}', { status: 502 }),
    ],
    [
      "a lost reply",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
  ])("does not retry a create after %s that may hide a created sandbox", async (_name, lose) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const api = backboard();
    const transport = vi.mocked(fetch);
    const respond = transport.getMockImplementation();
    // Railway creates the sandbox, but its reply never reaches the adapter.
    transport.mockImplementationOnce(async (...args) => {
      await respond?.(...args);
      return lose();
    });
    try {
      await expect(
        provider.provision({ botId: "bot", homePath: "/unused" }, ctx),
      ).rejects.toThrow();
      expect(api.created).toHaveLength(1);
      expect(api.operations.filter((name) => name === "RailwaySandboxCreate")).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it.each<[string, RailwayGraphQLErrorItem, string]>([
    ["a missing sandbox", { message: "Sandbox fake-secret not found" }, "NOT_FOUND"],
    [
      "a full sandbox cap",
      { message: "Sandbox limit of 50 reached for fake-secret" },
      "LIMIT_EXCEEDED",
    ],
    [
      "a coded error",
      { message: "fake-secret", extensions: { code: "INTERNAL_SERVER_ERROR" } },
      "INTERNAL_SERVER_ERROR",
    ],
    [
      "a code carrying data",
      { message: "fake-secret", extensions: { code: "token fake-secret" } },
      "REQUEST_FAILED",
    ],
    ["an unrecognised error", { message: "fake-secret" }, "REQUEST_FAILED"],
  ])("classifies %s without exposing the upstream error", async (_name, failure, code) => {
    const api = backboard();
    api.failures.set("RailwaySandboxCreate", failure);
    const error = await provider.provision({ botId: "bot", homePath: "/unused" }, ctx).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(RailwayGraphQLError);
    if (!(error instanceof RailwayGraphQLError)) return;
    expect(error.message).toBe(`Railway API request failed (${code})`);
    expect(error.errors).toEqual([{ message: error.message, extensions: { code } }]);
    expect(JSON.stringify(error.responseBody)).not.toContain("fake-secret");
  });
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(Sandbox.connect).mockResolvedValue(sandbox as unknown as Sandbox);
  vi.mocked(Sandbox.create).mockResolvedValue(sandbox as unknown as Sandbox);
  sandbox.exec.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
});

describe("Railway computers", () => {
  it("pins endpoints, disables SDK logging, and keeps the token outside sandbox env", async () => {
    const ref = await provider.provision({ botId: "bot", homePath: "/unused" }, ctx);
    expect(Sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "https://backboard.railway.com/graphql/v2",
        tcpProxyWsEndpoint: "wss://ssh.railway.com:2226/ws/exec",
        verbose: false,
        networkIsolation: "PRIVATE",
        domains: [{ port: 6080 }],
      }),
    );
    expect(vi.mocked(Sandbox.create).mock.calls[0]?.[0]).not.toHaveProperty("env");
    expect(vi.mocked(Sandbox.create).mock.calls[0]?.[0]).not.toHaveProperty("region");
    expect(JSON.stringify(ref)).not.toContain('"token"');
  });

  it("creates computers in the configured region and reconnects without one", async () => {
    const regional = new RailwaySandboxProvider({
      token: "test",
      environmentId: "environment",
      region: "asia-southeast1-eqsg3a",
    });
    await regional.provision({ botId: "bot", homePath: "/unused" }, ctx);
    expect(Sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({ region: "asia-southeast1-eqsg3a" }),
    );
    await regional.keepAlive(computer);
    expect(vi.mocked(Sandbox.connect).mock.calls.at(-1)?.[1]).not.toHaveProperty("region");
  });

  it("destroys a new sandbox if Railway does not confirm PRIVATE networking", async () => {
    vi.mocked(Sandbox.create).mockResolvedValue({
      ...sandbox,
      networkIsolation: "ISOLATED",
    } as unknown as Sandbox);
    await expect(provider.provision({ botId: "bot", homePath: "/unused" }, ctx)).rejects.toThrow(
      "PRIVATE networking",
    );
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  it("cleans up a sandbox whose readiness wait times out", async () => {
    const timeout = new SandboxTimeoutError({
      resource: "sandbox",
      id: "created",
      lastStatus: "CREATING",
      timeoutMs: 300_000,
    });
    vi.mocked(Sandbox.create).mockRejectedValue(timeout);
    await expect(provider.provision({ botId: "bot", homePath: "/unused" }, ctx)).rejects.toBe(
      timeout,
    );
    expect(Sandbox.connect).toHaveBeenCalledWith("created", expect.anything());
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  it("cleans up a known sandbox when polling fails after creation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response('{"data":{"sandboxCreate":{"id":"created"}}}')),
    );
    vi.mocked(Sandbox.create).mockImplementation(async (options) => {
      await options?.fetch?.("https://backboard.railway.com/graphql/v2");
      throw new Error("poll failed");
    });
    await expect(provider.provision({ botId: "bot", homePath: "/unused" }, ctx)).rejects.toThrow(
      "poll failed",
    );
    expect(Sandbox.connect).toHaveBeenCalledWith("created", expect.anything());
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  it("cleans up a partial GraphQL create response without exposing its errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: { sandboxCreate: { id: "created" } },
            errors: [{ message: "fake-secret" }],
          }),
        ),
      ),
    );
    vi.mocked(Sandbox.create).mockImplementation(async (options) => {
      const response = await options?.fetch?.("https://backboard.railway.com/graphql/v2");
      throw new Error(await response?.text());
    });
    await expect(provider.provision({ botId: "bot", homePath: "/unused" }, ctx)).rejects.toThrow(
      "Railway API request failed",
    );
    expect(Sandbox.connect).toHaveBeenCalledWith("created", expect.anything());
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  it("aborts a stalled API body at the request deadline", async () => {
    await provider.provision({ botId: "bot", homePath: "/unused" }, ctx);
    const transport = vi.mocked(Sandbox.create).mock.calls[0]?.[0]?.fetch;
    if (!transport) throw new Error("Missing transport");
    const controller = new AbortController();
    const deadline = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }))));
    try {
      const pending = transport("https://backboard.railway.com/graphql/v2");
      const assertion = expect(pending).rejects.toThrow("deadline");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      controller.abort(new Error("deadline"));
      await assertion;
      expect(deadline).toHaveBeenCalledWith(30_000);
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      deadline.mockRestore();
    }
  });

  it("captures and destroys a sandbox when canceled before the create response is read", async () => {
    const controller = new AbortController();
    const reason = new Error("provision canceled");
    let acceptRequest!: () => void;
    const accepted = new Promise<void>((resolve) => {
      acceptRequest = resolve;
    });
    let sendResponse!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      sendResponse = resolve;
    });
    const fetchMock = vi.fn((_input, _init) => {
      acceptRequest();
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(Sandbox.create).mockImplementation(async (options) => {
      await options?.fetch?.("https://backboard.railway.com/graphql/v2");
      return sandbox as unknown as Sandbox;
    });

    const pending = provider.provision(
      { botId: "bot", homePath: "/unused" },
      { ...ctx, signal: controller.signal },
    );
    const assertion = expect(pending).rejects.toBe(reason);
    await accepted;
    controller.abort(reason);
    sendResponse(new Response('{"data":{"sandboxCreate":{"id":"created"}}}'));
    await assertion;

    expect(fetchMock.mock.calls[0]?.[1]?.signal.aborted).toBe(false);
    expect(Sandbox.connect).toHaveBeenCalledWith("created", expect.anything());
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  it("destroys computers during canceled preparation rollback", async () => {
    const controller = new AbortController();
    controller.abort();
    await provider.destroy(computer, { ...ctx, signal: controller.signal });
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  it("bounds API reads, refuses other hosts and redirects, and sanitizes errors", async () => {
    await provider.provision({ botId: "bot", homePath: "/unused" }, ctx);
    const transport = vi.mocked(Sandbox.create).mock.calls[0]?.[0]?.fetch;
    if (!transport) throw new Error("Missing transport");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{"errors":[{"message":"fake-secret"}]}'));
    vi.stubGlobal("fetch", fetchMock);
    await expect(transport("https://other.example.test/graphql")).rejects.toThrow(
      "Invalid Railway API endpoint",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    const response = await transport("https://backboard.railway.com/graphql/v2");
    expect(await response.text()).not.toContain("fake-secret");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }),
    );
    fetchMock.mockResolvedValue(new Response(new Uint8Array(16 * 1024 * 1024 + 1)));
    await expect(transport("https://backboard.railway.com/graphql/v2")).rejects.toThrow(
      "Response is too large",
    );
    fetchMock.mockResolvedValue(new Response('{"unexpected":"fake-secret"}'));
    expect(
      await (await transport("https://backboard.railway.com/graphql/v2")).text(),
    ).not.toContain("fake-secret");
    fetchMock.mockResolvedValue(new Response("fake-secret", { status: 502 }));
    await expect(transport("https://backboard.railway.com/graphql/v2")).rejects.toThrow(
      "Invalid Railway API response",
    );
  });

  it("fails a checkpoint when its manifest was truncated", async () => {
    const stop = vi.spyOn(LinuxDesktop.prototype, "stopBrowsers").mockResolvedValue();
    sandbox.exec.mockResolvedValue({ exitCode: 0, stdout: "", truncated: true });
    try {
      await expect(provider.exportWorkspace(computer, ctx).next()).rejects.toThrow(
        "could not list Railway workspace",
      );
      expect(sandbox.files.read).not.toHaveBeenCalled();
      expect(sandbox.exec).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ maxOutputBytes: 16 * 1024 * 1024 }),
      );
    } finally {
      stop.mockRestore();
    }
  });

  it("closes a rejected SDK WebSocket handshake without re-entering its error handler", async () => {
    await provider.provision({ botId: "bot", homePath: "/unused" }, ctx);
    const Socket = vi.mocked(Sandbox.create).mock.calls[0]?.[0]?.webSocketImpl;
    if (!Socket) throw new Error("Railway WebSocket transport is missing");
    const server = createServer((_request, response) => response.writeHead(403).end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Server did not bind");
      const socket = new Socket(`ws://127.0.0.1:${address.port}`);
      if (!(socket instanceof WebSocket)) throw new Error("Unexpected WebSocket transport");
      const onError = vi.fn(() => socket.close(1000, ""));
      socket.onerror = onError;
      await new Promise<void>((resolve) => {
        socket.onclose = () => resolve();
      });
      expect(onError).toHaveBeenCalledOnce();
      expect(socket.readyState).toBe(WebSocket.CLOSED);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("satisfies the shared workspace contract through the Railway SDK", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rakazo-railway-contract-"));
    const localPath = (filePath: string) => filePath.replace("/home/rakazo", directory);
    sandbox.files.write.mockImplementation(
      async (filePath: string, content: Uint8Array, options?: { mode: number }) => {
        await mkdir(path.dirname(localPath(filePath)), { recursive: true });
        await writeFile(localPath(filePath), content, options);
      },
    );
    sandbox.files.read.mockImplementation(
      async (filePath: string) => new Uint8Array(await readFile(localPath(filePath))),
    );
    sandbox.files.list.mockImplementation(async (filePath: string) =>
      Promise.all(
        (await readdir(localPath(filePath))).map(async (name) => {
          const entry = await stat(path.join(localPath(filePath), name));
          return { name, isDir: entry.isDirectory(), size: entry.size, mode: entry.mode };
        }),
      ),
    );
    sandbox.exec.mockImplementation(async (command: string) => {
      if (
        command.includes("find . -regextype") ||
        command.startsWith("'echo'") ||
        command.startsWith("chmod ")
      ) {
        const result = await promisify(execFile)("bash", [
          "-c",
          command
            .replaceAll("/home/rakazo", directory)
            .replaceAll(
              "find . -regextype posix-extended",
              process.platform === "darwin" ? "find -E ." : "find . -regextype posix-extended",
            ),
        ]);
        return { ...result, exitCode: 0 };
      }
      return {
        exitCode: 0,
        stdout: command.includes("RAKAZO_DESKTOP=")
          ? "RAKAZO_DESKTOP=0:test-token"
          : command.includes("CURSOR")
            ? "aW1hZ2U=\nCURSOR X=1 Y=2"
            : "",
      };
    });
    try {
      await assertSandboxWorkspaceContract(provider, computer, ctx);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reuses an existing computer without marking its workspace fresh", async () => {
    expect(
      await provider.provision(
        { botId: "bot", homePath: "/unused", providerRef: "sandbox", providerKind: "railway" },
        ctx,
      ),
    ).toMatchObject({ providerRef: "sandbox", fresh: false });
    expect(Sandbox.create).not.toHaveBeenCalled();
  });

  it("destroys a new computer if its caller cancels during creation", async () => {
    const controller = new AbortController();
    vi.mocked(Sandbox.create).mockImplementation(async () => {
      controller.abort();
      return sandbox as unknown as Sandbox;
    });
    await expect(
      provider.provision(
        { botId: "bot", homePath: "/unused" },
        { ...ctx, signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  it("preserves output and reports timeout as a nonzero exit", async () => {
    sandbox.exec.mockResolvedValue({
      stdout: "partial",
      stderr: "timeout",
      exitCode: null,
      timedOut: true,
    });
    const events: ProcessEvent[] = [];
    for await (const event of provider.execute(
      computer,
      {
        argv: ["echo", "a; touch /tmp/unwanted"],
        cwd: "notes",
        env: { FAKE_TOKEN: "fake-secret" },
        timeoutMs: 5000,
      },
      ctx,
    ))
      events.push(event);
    expect(events).toEqual([
      { type: "stdout", data: "partial" },
      { type: "stderr", data: "timeout" },
      { type: "exit", code: 124 },
    ]);
    // Secrets go in the env field, never in command text.
    expect(sandbox.exec).toHaveBeenCalledWith(
      "'echo' 'a; touch /tmp/unwanted'",
      expect.objectContaining({
        cwd: "/home/rakazo/notes",
        env: expect.objectContaining({
          FAKE_TOKEN: "fake-secret",
          UV_CACHE_DIR: "/tmp/rakazo-cache/uv",
        }),
        timeoutSec: 5,
      }),
    );
  });

  it("runs a bot's commands on that bot's own screen", async () => {
    sandbox.exec.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
    for await (const _event of provider.execute(
      computer,
      { argv: ["ffmpeg", "out.mp4"] },
      { ...ctx, botId: "becky" },
    ));
    expect(sandbox.exec).toHaveBeenCalledWith(
      screenDisplayArgv(["ffmpeg", "out.mp4"], "becky", 1).map(shellQuote).join(" "),
      expect.anything(),
    );
  });

  it("reports output truncation as a command failure", async () => {
    sandbox.exec.mockResolvedValue({ exitCode: 0, stdout: "partial", truncated: true });
    await expect(
      provider
        .execute(computer, { argv: ["echo", "output"] }, ctx)
        [Symbol.asyncIterator]()
        .next(),
    ).rejects.toThrow("command output exceeds");
    expect(sandbox.exec).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ maxOutputBytes: 16 * 1024 * 1024 }),
    );
  });

  it("protects screen sockets with a per-screen token", async () => {
    sandbox.exec.mockResolvedValue({
      stdout: "RAKAZO_DESKTOP=0:screen-token",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });
    const screen = await provider.connectScreen(
      computer,
      { view: "stream", interactive: false },
      ctx,
    );
    if (!screen.url) throw new Error("missing screen URL");
    const url = new URL(screen.url);
    expect(url.origin).toBe("https://screen-test.up.railway.app");
    expect(sandbox.exec).toHaveBeenCalledWith(
      expect.stringContaining("0.0.0.0:6080 8>&-"),
      expect.anything(),
    );
    expect(url.searchParams.get("path")).toBe("websockify?token=screen-token");
    expect(url.searchParams.has("token")).toBe(false);
  });

  it.each([
    "127.0.0.1",
    "localhost",
    "other.example.test",
    "screen.up.railway.app@127.0.0.1",
    "screen.up.railway.app/redirect",
    "screen.up.railway.app:80",
    "screen.up.railway.app.evil.example.test",
  ])("rejects an untrusted screen domain %s", async (domain) => {
    vi.mocked(Sandbox.connect).mockResolvedValue({
      ...sandbox,
      domains: [{ port: 6080, domain }],
    } as unknown as Sandbox);
    sandbox.exec.mockResolvedValue({ stdout: "RAKAZO_DESKTOP=0:screen-token", exitCode: 0 });
    await expect(
      provider.connectScreen(computer, { view: "stream", interactive: false }, ctx),
    ).rejects.toThrow("Invalid Railway screen domain");
  });

  it("rejects oversized files instead of returning truncated content", async () => {
    sandbox.files.read.mockResolvedValue(new Uint8Array(4));
    await expect(provider.readFile(computer, "file", ctx, { maxBytes: 3 })).rejects.toThrow(
      "exceeds 3 bytes",
    );
  });

  it("keeps binary data and executable permissions on writes", async () => {
    const content = Uint8Array.from([0, 255, 128]);
    await provider.writeFile(computer, { path: "bin/tool", content, executable: true }, ctx);
    expect(sandbox.files.write).toHaveBeenCalledWith("/home/rakazo/bin/tool", content, {
      mode: 0o700,
    });
  });

  it("rejects paths outside the workspace", async () => {
    await expect(provider.readFile(computer, "../../secret", ctx)).rejects.toThrow();
    expect(sandbox.files.read).not.toHaveBeenCalled();
  });

  it("exports regular binary files without following links or reading FIFOs", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rakazo-railway-"));
    const stopBrowsers = vi.spyOn(LinuxDesktop.prototype, "stopBrowsers").mockResolvedValue();
    try {
      await mkdir(path.join(directory, "bin"));
      const content = Uint8Array.from([0, 255, 128]);
      await writeFile(path.join(directory, "bin/tool"), content, { mode: 0o700 });
      await writeFile(path.join(directory, "note"), "saved", { mode: 0o600 });
      for (const name of [
        "project/node_modules/pkg/data",
        ".cache/uv/data",
        ".yarn/cache/pkg",
        "core.123",
        "run.log",
      ]) {
        await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
        await writeFile(path.join(directory, name), "excluded");
      }

      await symlink("bin", path.join(directory, "linked-bin"));
      await promisify(execFile)("mkfifo", [path.join(directory, "pipe")]);
      sandbox.exec.mockImplementation(async (command: string) => {
        const result = await promisify(execFile)("bash", [
          "-c",
          command
            .replaceAll("/home/rakazo", directory)
            .replaceAll(
              "find . -regextype posix-extended",
              process.platform === "darwin" ? "find -E ." : "find . -regextype posix-extended",
            ),
        ]);
        return { ...result, exitCode: 0, timedOut: false };
      });
      sandbox.files.read.mockImplementation(
        async (filePath: string) =>
          new Uint8Array(await readFile(filePath.replace("/home/rakazo", directory))),
      );
      const exported = [];
      for await (const file of provider.exportWorkspace(computer, ctx)) exported.push(file);
      expect(exported).toEqual(
        expect.arrayContaining([
          { path: "bin/tool", content, executable: true },
          { path: "note", content: new TextEncoder().encode("saved"), executable: false },
        ]),
      );
      expect(exported).toHaveLength(2);
      expect(Sandbox.connect).toHaveBeenCalledTimes(2);
    } finally {
      stopBrowsers.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("restores binary files and permissions over one connection", async () => {
    const stopBrowsers = vi.spyOn(LinuxDesktop.prototype, "stopBrowsers").mockResolvedValue();
    const content = Uint8Array.from([0, 255, 128]);
    try {
      async function* files() {
        yield { path: "bin/tool", content, executable: true };
        yield { path: "note", content, executable: false };
      }
      await provider.importWorkspace(computer, files(), ctx);
      expect(Sandbox.connect).toHaveBeenCalledTimes(1);
      expect(sandbox.exec).toHaveBeenNthCalledWith(
        1,
        "chmod 700 -- '/home/rakazo'",
        expect.objectContaining({ signal: ctx.signal }),
      );
      const protectOrder = sandbox.exec.mock.invocationCallOrder[0];
      const writeOrder = sandbox.files.write.mock.invocationCallOrder[0];
      if (protectOrder === undefined || writeOrder === undefined)
        throw new Error("Missing restore operations");
      expect(protectOrder).toBeLessThan(writeOrder);
      expect(sandbox.files.write).toHaveBeenCalledWith("/home/rakazo/bin/tool", content);
      expect(sandbox.files.write).toHaveBeenCalledWith("/home/rakazo/note", content);
      expect(sandbox.exec).toHaveBeenCalledWith(
        "chmod 700 -- '/home/rakazo/bin/tool'",
        expect.objectContaining({ signal: ctx.signal }),
      );
      expect(sandbox.exec).toHaveBeenCalledWith(
        "chmod 600 -- '/home/rakazo/note'",
        expect.objectContaining({ signal: ctx.signal }),
      );
    } finally {
      stopBrowsers.mockRestore();
    }
  });

  it("restores many files without one exec connection per file", async () => {
    const stopBrowsers = vi.spyOn(LinuxDesktop.prototype, "stopBrowsers").mockResolvedValue();
    let active = 0;
    let peak = 0;
    sandbox.files.write.mockImplementation(async () => {
      peak = Math.max(peak, ++active);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      active--;
    });
    async function* files() {
      for (let index = 0; index < 130; index++)
        yield { path: `file-${index}`, content: Uint8Array.of(index) };
    }
    try {
      await provider.importWorkspace(computer, files(), ctx);
      expect(sandbox.files.write).toHaveBeenCalledTimes(130);
      expect(peak).toBe(4);
      expect(sandbox.exec).toHaveBeenCalledTimes(4);
      expect(sandbox.files.write.mock.calls.every((call) => call[2] === undefined)).toBe(true);
      sandbox.files.write.mockClear();
      sandbox.exec.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "denied" });
      await expect(provider.importWorkspace(computer, files(), ctx)).rejects.toThrow("permissions");
      expect(sandbox.files.write).not.toHaveBeenCalled();
    } finally {
      stopBrowsers.mockRestore();
    }
  });

  it("rejects oversized exports before reading and files that grow during a read", async () => {
    const stopBrowsers = vi.spyOn(LinuxDesktop.prototype, "stopBrowsers").mockResolvedValue();
    const bounded = new RailwaySandboxProvider({
      token: "test",
      environmentId: "environment",
      maxWorkspaceFileBytes: "4",
    });
    try {
      sandbox.exec.mockResolvedValue({ exitCode: 0, stdout: "large\u0000600\u00005\u0000" });
      await expect(bounded.exportWorkspace(computer, ctx).next()).rejects.toThrow(
        "exceeds 4 bytes",
      );
      expect(sandbox.files.read).not.toHaveBeenCalled();
      sandbox.exec.mockResolvedValue({ exitCode: 0, stdout: "growing\u0000600\u00004\u0000" });
      sandbox.files.read.mockResolvedValue(new Uint8Array(5));
      await expect(bounded.exportWorkspace(computer, ctx).next()).rejects.toThrow(
        "exceeds 4 bytes",
      );
      expect(sandbox.files.read).toHaveBeenCalledWith("/home/rakazo/growing", {
        format: "bytes",
        length: 5,
      });
    } finally {
      stopBrowsers.mockRestore();
    }
  });

  it("retries growing files separately within the read budget", async () => {
    const stopBrowsers = vi.spyOn(LinuxDesktop.prototype, "stopBrowsers").mockResolvedValue();
    const bounded = new RailwaySandboxProvider({
      token: "test",
      environmentId: "environment",
      maxWorkspaceFileBytes: "8",
    });
    sandbox.exec.mockResolvedValue({
      exitCode: 0,
      stdout: [0, 1, 2, 3].map((index) => `file-${index}\0${600}\0${2}\0`).join(""),
    });
    let reserved = 0;
    let peak = 0;
    sandbox.files.read.mockImplementation(async (_path, options) => {
      reserved += options.length;
      peak = Math.max(peak, reserved);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      reserved -= options.length;
      return new Uint8Array(Math.min(8, options.length));
    });
    try {
      const files = [];
      for await (const file of bounded.exportWorkspace(computer, ctx)) files.push(file);
      expect(files).toHaveLength(4);
      expect(files.map((file) => file.content.byteLength)).toEqual([8, 8, 8, 8]);
      expect(peak).toBe(12);
      expect(sandbox.files.read).toHaveBeenCalledTimes(8);
    } finally {
      stopBrowsers.mockRestore();
    }
  });

  it.each(["0", "-1", "1.5", "invalid"])("rejects an invalid export limit %s", (limit) => {
    expect(
      () =>
        new RailwaySandboxProvider({
          token: "test",
          environmentId: "environment",
          maxWorkspaceFileBytes: limit,
        }),
    ).toThrow();
  });

  it("bounds concurrent restore memory while copying every file", async () => {
    const stopBrowsers = vi.spyOn(LinuxDesktop.prototype, "stopBrowsers").mockResolvedValue();
    const content = new Uint8Array(3 * 1024 * 1024);
    let activeBytes = 0;
    let peakBytes = 0;
    sandbox.files.write.mockImplementation(async (_path: string, bytes: Uint8Array) => {
      activeBytes += bytes.byteLength;
      peakBytes = Math.max(peakBytes, activeBytes);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      activeBytes -= bytes.byteLength;
    });
    try {
      async function* files() {
        for (let index = 0; index < 20; index++) yield { path: `file-${index}`, content };
      }
      await provider.importWorkspace(computer, files(), ctx);
      expect(sandbox.files.write).toHaveBeenCalledTimes(20);
      expect(peakBytes).toBeGreaterThan(content.byteLength);
      expect(peakBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    } finally {
      stopBrowsers.mockRestore();
    }
  });

  it("exports oversized files alone and limits the bytes read together", async () => {
    const stopBrowsers = vi.spyOn(LinuxDesktop.prototype, "stopBrowsers").mockResolvedValue();
    const sizes = [3, 3, 3, 12, 3, 3].map((size) => size * 1024 * 1024);
    sandbox.exec.mockResolvedValue({
      exitCode: 0,
      stdout: sizes.map((size, index) => `file-${index}\0${600}\0${size}\0`).join(""),
    });
    let activeBytes = 0;
    let peakBytes = 0;
    sandbox.files.read.mockImplementation(async (filePath: string) => {
      const size = sizes[Number(filePath.split("-").at(-1))];
      if (size === undefined) throw new Error("Unexpected file");
      activeBytes += size;
      expect(activeBytes).toBeLessThanOrEqual(Math.max(size, 8 * 1024 * 1024));
      peakBytes = Math.max(peakBytes, activeBytes);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      activeBytes -= size;
      return new Uint8Array(size);
    });
    try {
      const lengths = [];
      for await (const file of provider.exportWorkspace(computer, ctx))
        lengths.push(file.content.byteLength);
      expect(lengths).toEqual(sizes);
      expect(peakBytes).toBe(12 * 1024 * 1024);
    } finally {
      stopBrowsers.mockRestore();
    }
  });

  it("skips a file removed during export but preserves other read failures", async () => {
    const stopBrowsers = vi.spyOn(LinuxDesktop.prototype, "stopBrowsers").mockResolvedValue();
    sandbox.exec.mockResolvedValue({
      exitCode: 0,
      stdout: "gone\u0000600\u00001\u0000kept\u0000600\u00001\u0000",
    });
    const content = Uint8Array.of(7);
    sandbox.files.read
      .mockRejectedValueOnce(
        new SandboxFileNotFoundError({ operation: "read", path: "gone", message: "missing" }),
      )
      .mockResolvedValue(content);
    try {
      const files = [];
      for await (const file of provider.exportWorkspace(computer, ctx)) files.push(file);
      expect(files).toEqual([{ path: "kept", content, executable: false }]);
      sandbox.files.read.mockRejectedValue(new Error("transfer failed"));
      await expect(provider.exportWorkspace(computer, ctx).next()).rejects.toThrow(
        "transfer failed",
      );
    } finally {
      stopBrowsers.mockRestore();
    }
  });
});
