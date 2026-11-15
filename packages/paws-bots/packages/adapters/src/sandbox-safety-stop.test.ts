import type { AgentHomeStore, JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { DesktopSandbox, SandboxNotFoundError } from "novita-sandbox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { provisionComputer } from "./computer-lifecycle.js";
import { createRunSandbox } from "./host-aware-sandbox.js";
import { nativeNovitaApi, runningNovitaDesktop } from "./novita-sandbox.js";
import {
  isSandboxDamagedError,
  isSandboxGoneError,
  SandboxUnsafeStopError,
} from "./sandbox-errors.js";

const native = vi.hoisted(() => ({
  desktop: { create: vi.fn(), connect: vi.fn() },
  sandbox: { pause: vi.fn(), kill: vi.fn(), getInfo: vi.fn(), setTimeout: vi.fn() },
}));
vi.mock("novita-sandbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("novita-sandbox")>()),
  Novita: vi.fn(
    class {
      desktop = native.desktop;
      sandbox = native.sandbox;
    },
  ),
}));

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected network call");
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("unsafe computer stop", () => {
  it("does not turn an unconfirmed stop's nested provider error into automatic replacement", () => {
    const failure = new SandboxUnsafeStopError(
      "stop unconfirmed",
      new SandboxNotFoundError("guest missing"),
    );
    expect(isSandboxGoneError(failure)).toBe(false);
    expect(isSandboxDamagedError(failure)).toBe(false);
  });

  it("persists recovery across independent API/worker adapters and never resumes on a heartbeat or read", async () => {
    let cloudState = "running";
    const computer = { id: "computer", kind: "novita", providerRef: "guest", state: "running" };
    const updateMany = vi.fn(async ({ where, data }) => {
      expect(where).toEqual({ kind: "novita", providerRef: "guest" });
      expect(data).toMatchObject({
        state: "quarantined",
        screenUrl: null,
        screenGeneration: { increment: 1 },
        controlFence: { increment: 1 },
        controlLeaseId: null,
      });
      computer.state = data.state;
      return { count: 1 };
    });
    const prisma = {
      computer: {
        updateMany,
        findMany: vi.fn(async () => []),
        findUniqueOrThrow: vi.fn(async () => computer),
      },
    } as unknown as PrismaClient;
    const handle = {
      wait: vi.fn(() => new Promise(() => undefined)),
      kill: vi.fn(async () => {
        throw new Error("kill unavailable");
      }),
      disconnect: vi.fn(async () => undefined),
      stdout: "",
    };
    const desktop = { sandboxId: "guest", commands: { run: vi.fn(async () => handle) } };
    native.desktop.create.mockResolvedValue(desktop);
    native.sandbox.pause.mockImplementation(async () => {
      expect(computer.state).toBe("quarantined");
      cloudState = "paused";
      return true;
    });
    native.sandbox.getInfo.mockImplementation(async () => ({ state: cloudState }));
    native.sandbox.setTimeout.mockImplementation(async () => {
      if (cloudState !== "running") throw new SandboxNotFoundError("paused");
    });
    const fullInfo = vi
      .spyOn(DesktopSandbox, "getFullInfo")
      .mockImplementation(async () => ({ state: cloudState }));
    const worker = await createRunSandbox("novita", { novitaApiKey: "test-key", prisma });
    const ref = await worker.provision({ botId: "bot", homePath: "/unused" }, context);
    const controller = new AbortController();
    const pending = (async () => {
      for await (const _event of worker.execute(
        ref,
        { argv: ["side-effect"] },
        { ...context, signal: controller.signal },
      )) {
      }
    })();
    await vi.waitFor(() => expect(handle.wait).toHaveBeenCalled());
    controller.abort();
    await expect(pending).rejects.toThrow("command may remain suspended");
    expect(handle.kill).toHaveBeenCalledTimes(3);
    expect(cloudState).toBe("paused");
    expect(updateMany).toHaveBeenCalledOnce();

    const api = await createRunSandbox("novita", { novitaApiKey: "test-key", prisma });
    await expect(api.keepAlive!(ref)).rejects.toBeInstanceOf(SandboxNotFoundError);
    await expect(api.readFile(ref, "notes", context)).rejects.toThrow("paused");
    expect(fullInfo).toHaveBeenCalledOnce();
    await expect(
      provisionComputer(
        {
          prisma,
          sandbox: api,
          home: {} as AgentHomeStore,
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
        },
        "computer",
        { ...context, runId: "scheduled-run" },
      ),
    ).rejects.toThrow("requires recovery");
    expect(native.desktop.connect).not.toHaveBeenCalled();
    expect(native.desktop.create).toHaveBeenCalledOnce();
    expect(cloudState).toBe("paused");
  });

  it.each(["paused", "starting", "unknown", undefined])(
    "refuses implicit handles for state %s",
    async (state) => {
      vi.spyOn(DesktopSandbox, "getFullInfo").mockResolvedValue({
        sandboxId: "guest",
        envdVersion: "0.0.0",
        state,
      });
      await expect(
        runningNovitaDesktop(await nativeNovitaApi("test-key"), "guest"),
      ).rejects.toThrow("paused");
      expect(native.desktop.connect).not.toHaveBeenCalled();
    },
  );

  it("constructs a running handle with a GET and no connect/resume request", async () => {
    const getInfo = vi
      .spyOn(DesktopSandbox, "getFullInfo")
      .mockResolvedValue({ sandboxId: "guest", envdVersion: "0.0.0", state: "running" });
    const extend = vi.spyOn(DesktopSandbox, "setTimeout").mockResolvedValue(undefined);
    const desktop = await runningNovitaDesktop(await nativeNovitaApi("test-key"), "guest");
    expect(desktop.sandboxId).toBe("guest");
    expect(extend).toHaveBeenCalled();
    expect(getInfo).toHaveBeenCalledWith("guest", { apiKey: "test-key", requestTimeoutMs: 15_000 });
    expect(native.desktop.connect).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
