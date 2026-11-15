import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { ComputerBrowserProvider } from "./computer-browser.js";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import { DockerSandboxProvider } from "./docker-sandbox.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { createRunSandbox, HostAwareSandbox, sandboxKindForBot } from "./host-aware-sandbox.js";
import { HostComputerSandbox } from "./host-computer-sandbox.js";

const ctx = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

describe("host-aware sandbox", () => {
  const hostRoot = mkdtempSync(path.join(tmpdir(), "rakazo-host-root-"));

  afterAll(() => {
    rmSync(hostRoot, { recursive: true, force: true });
  });

  afterEach(() => vi.restoreAllMocks());

  it("never falls back to backend execution when the native connection is missing", async () => {
    const provision = vi.spyOn(DesktopSandboxProvider.prototype, "provision");
    const sandbox = await createRunSandbox("docker", {
      prisma: {
        deploymentSettings: { findUnique: vi.fn(async () => ({ computerHost: "this-mac" })) },
      } as unknown as PrismaClient,
    });
    await expect(sandbox.provision({ botId: "host", homePath: "/unused" }, ctx)).rejects.toThrow(
      "requires the desktop app",
    );
    expect(provision).not.toHaveBeenCalled();
  });

  it("refuses an old host reference once the deployment switches back to Docker", async () => {
    const host = new DesktopSandboxProvider();
    const execute = vi.spyOn(host, "execute");
    const sandbox = new HostAwareSandbox(new FakeSandboxProvider(), host, async () => false);
    const computer: ComputerRef = {
      id: "old-host",
      botId: "host",
      kind: "desktop",
      providerRef: "old-host",
    };
    const attempt = async () => {
      for await (const _event of sandbox.execute(computer, { argv: ["echo", "no"] }, ctx)) {
      }
    };
    await expect(attempt()).rejects.toThrow("disabled");
    expect(execute).not.toHaveBeenCalled();
  });

  it("exposes and routes page commands through the production Docker wrapper", async () => {
    const result = {
      ok: true,
      url: "https://example.test",
      title: "Page",
      tree: "Page",
      elements: [],
    };
    const pageBrowser = vi
      .spyOn(DockerSandboxProvider.prototype, "pageBrowser")
      .mockResolvedValue(result);
    const sandbox = await createRunSandbox("docker", {
      prisma: { deploymentSettings: { findUnique: vi.fn() } } as unknown as PrismaClient,
    });
    const browser = new ComputerBrowserProvider({ sandbox });
    const computer: ComputerRef = {
      id: "computer",
      providerRef: "computer",
      botId: "home",
      kind: "docker",
    };
    expect(browser.describe().capabilities.page).toBe(true);
    expect(await browser.snapshot(computer, {}, ctx)).toMatchObject({
      title: "Page",
      tree: "Page",
    });
    expect(pageBrowser).toHaveBeenCalledWith(computer, { command: "snapshot" }, ctx);

    pageBrowser.mockClear();
    const hostResult = await browser.snapshot({ ...computer, kind: "desktop" }, {}, ctx);
    expect(hostResult.fallback).toBe("computer_act");
    expect(pageBrowser).not.toHaveBeenCalled();
  });

  it("routes billing capability by computer kind rather than the current host setting", () => {
    const isolated: SandboxProvider = new FakeSandboxProvider();
    isolated.billsWhileRunning = vi.fn(() => true);
    const sandbox = new HostAwareSandbox(isolated, new DesktopSandboxProvider(), async () => true);
    const computer: ComputerRef = {
      id: "computer",
      providerRef: "computer",
      botId: "home",
      kind: "fake",
    };
    expect(sandbox.billsWhileRunning(computer)).toBe(true);
    expect(isolated.billsWhileRunning).toHaveBeenCalledWith(computer);
    expect(sandbox.billsWhileRunning({ ...computer, kind: "desktop" })).toBe(false);
    expect(isolated.billsWhileRunning).toHaveBeenCalledOnce();
    expect(new DockerSandboxProvider("http://supervisor.test", "test-token")).not.toHaveProperty(
      "billsWhileRunning",
    );
  });

  it("does not expose page commands when neither provider supports them", () => {
    const sandbox = new HostAwareSandbox(
      new FakeSandboxProvider(),
      new DesktopSandboxProvider(),
      async () => false,
    );
    expect(sandbox.pageBrowser).toBeUndefined();
  });

  it("lets this-mac cwd run under a host root", async () => {
    const desktop = new DesktopSandboxProvider({ hostRoots: [hostRoot] });
    const computer = await desktop.provision({ botId: "host", homePath: "/tmp/host-home" }, ctx);
    let code = 1;
    for await (const event of desktop.execute(
      computer,
      { argv: ["echo", "ok"], cwd: hostRoot },
      ctx,
    )) {
      if (event.type === "exit") code = event.code;
    }
    expect(code).toBe(0);
    await desktop.destroy(computer, ctx);
  });

  it("still refuses paths outside home and host roots", async () => {
    const desktop = new DesktopSandboxProvider({ hostRoots: [hostRoot] });
    const computer = await desktop.provision({ botId: "deny", homePath: "/tmp/deny" }, ctx);
    let stderr = "";
    let code = 0;
    for await (const event of desktop.execute(
      computer,
      { argv: ["echo", "nope"], cwd: "/etc" },
      ctx,
    )) {
      if (event.type === "stderr") stderr += event.data;
      if (event.type === "exit") code = event.code;
    }
    expect(code).toBe(1);
    expect(stderr).toMatch(/outside this computer's home/i);
    await desktop.destroy(computer, ctx);
  });

  it("provisions on the host provider when enabled", async () => {
    const isolated = new FakeSandboxProvider();
    const host = new DesktopSandboxProvider();
    const sandbox = new HostAwareSandbox(isolated, host, async () => true);
    const computer = await sandbox.provision({ botId: "switch", homePath: "/tmp/switch" }, ctx);
    expect(computer.kind).toBe("desktop");
    await sandbox.destroy(computer, ctx);
  });

  it.each([
    [true, "desktop"],
    [false, "fake"],
  ])(
    "reports the kind it would provision without starting one (this-mac: %s)",
    async (hostEnabled, kind) => {
      const isolated = new FakeSandboxProvider();
      const provision = vi.spyOn(isolated, "provision");
      const sandbox = new HostAwareSandbox(
        isolated,
        new DesktopSandboxProvider(),
        async () => hostEnabled,
      );
      await expect(sandbox.provisionKind()).resolves.toBe(kind);
      expect(provision).not.toHaveBeenCalled();
    },
  );

  it("provisions on the isolated provider when this-mac is off", async () => {
    const isolated = new FakeSandboxProvider();
    const host = new DesktopSandboxProvider();
    const sandbox = new HostAwareSandbox(isolated, host, async () => false);
    const computer = await sandbox.provision({ botId: "iso", homePath: "/tmp/iso" }, ctx);
    expect(computer.kind).toBe("fake");
    await sandbox.destroy(computer, ctx);
  });

  it("maps the Linux bot home cwd onto the desktop home", async () => {
    const desktop = new DesktopSandboxProvider();
    const computer = await desktop.provision({ botId: "alias", homePath: "/tmp/alias" }, ctx);
    let code = 1;
    for await (const event of desktop.execute(
      computer,
      { argv: ["echo", "ok"], cwd: "/home/rakazo" },
      ctx,
    )) {
      if (event.type === "exit") code = event.code;
    }
    expect(code).toBe(0);
    await desktop.destroy(computer, ctx);
  });

  it("never runs bot commands on a production backend host", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      await expect(createRunSandbox("desktop", {})).rejects.toThrow(
        "SANDBOX_PROVIDER=desktop runs bot commands directly on this host",
      );
      // The desktop app's backend reaches this computer only through the authenticated bridge.
      const bridged = new HostAwareSandbox(
        new FakeSandboxProvider(),
        new HostComputerSandbox("", ""),
        async () => true,
      );
      expect(bridged.describe().id).toBe("fake");
      expect(new HostComputerSandbox("", "").describe().id).toBe("desktop");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("only switches docker deployments onto this Mac", () => {
    expect(sandboxKindForBot("docker", "this-mac")).toBe("desktop");
    expect(sandboxKindForBot("docker", "docker")).toBe("docker");
    expect(sandboxKindForBot("e2b", "this-mac")).toBe("e2b");
    expect(sandboxKindForBot("fake", "this-mac")).toBe("fake");
  });

  it("forwards pageBrowser to the routed provider", async () => {
    const isolated: SandboxProvider = new FakeSandboxProvider();
    const calls: unknown[] = [];
    isolated.pageBrowser = async (computer, request, context) => {
      calls.push({ computerId: computer.id, request, aborted: context.signal.aborted });
      return { ok: true, url: "https://example.test", title: "Example", tree: "", elements: [] };
    };
    const host = new DesktopSandboxProvider();
    const sandbox = new HostAwareSandbox(isolated, host, async () => false);
    const computer = await sandbox.provision({ botId: "page", homePath: "/tmp/page" }, ctx);
    expect(typeof sandbox.pageBrowser).toBe("function");
    await expect(
      sandbox.pageBrowser!(computer, { command: "snapshot" }, ctx),
    ).resolves.toMatchObject({
      ok: true,
      url: "https://example.test",
    });
    expect(calls).toEqual([
      { computerId: computer.id, request: { command: "snapshot" }, aborted: false },
    ]);
    await sandbox.destroy(computer, ctx);
  });
});

it("starts even when the saved computer settings cannot be read", async () => {
  const sandbox = await createRunSandbox("docker", {
    prisma: {
      deploymentSettings: {
        findUnique: vi.fn(async () => ({
          computerProvider: "wuying",
          computerProviderCipher: "c",
        })),
      },
    } as unknown as PrismaClient,
    secrets: {
      load: async () => {
        throw new Error("secret store unavailable");
      },
      onChange: () => () => {},
    },
  });
  expect(sandbox.describe().id).toBe("docker");
});
