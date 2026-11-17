import type * as NodeFsPromises from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { resolveSupervisorToken } from "@rakazo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMPUTER_IMAGE,
  computerBridgeNameFor,
  computerNetworkNameFor,
  computerNetworkOwnerFor,
  containerNameFor,
  hostComputerUser,
  screenPorts,
} from "./computer-spec.js";

const mocks = vi.hoisted(() => ({
  docker: {
    version: vi.fn(),
    getImage: vi.fn(),
    getContainer: vi.fn(),
    listContainers: vi.fn(),
    createContainer: vi.fn(),
    createNetwork: vi.fn(),
    getNetwork: vi.fn(),
    listNetworks: vi.fn(),
  },
  assertHomeWritable: vi.fn(),
  verifyRestrictedEgress: vi.fn(),
}));
vi.mock("dockerode", () => ({
  default: class {
    version = mocks.docker.version;
    getImage = mocks.docker.getImage;
    getContainer = mocks.docker.getContainer;
    listContainers = mocks.docker.listContainers;
    createContainer = mocks.docker.createContainer;
    createNetwork = mocks.docker.createNetwork;
    getNetwork = mocks.docker.getNetwork;
    listNetworks = mocks.docker.listNetworks;
  },
}));
vi.mock("./home-ownership.js", () => ({ assertComputerHomeWritable: mocks.assertHomeWritable }));
vi.mock("./egress-probe.js", () => ({
  EgressNotEnforced: class EgressNotEnforced extends Error {},
  verifyRestrictedEgress: mocks.verifyRestrictedEgress,
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFsPromises>()),
  mkdir: vi.fn(),
}));

let screen: http.Server;
let screenPort: string;

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.verifyRestrictedEgress.mockResolvedValue(undefined);
  vi.stubEnv("HOSTNAME", "");
  vi.stubEnv("DATA_DIR", "/tmp/rakazo-loopback-test");
  vi.stubEnv("SANDBOX_SCREEN_NETWORK", "published");
  vi.stubEnv("SANDBOX_SCREEN_HOST", "127.0.0.1");
  screen = http.createServer((_req, res) => res.end("ok"));
  await new Promise<void>((resolve) => screen.listen(0, "127.0.0.1", resolve));
  const address = screen.address();
  if (!address || typeof address === "string") throw new Error("expected a TCP address");
  screenPort = String(address.port);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => {
    screen.close(() => resolve());
    screen.closeAllConnections();
  });
});

describe("computer loopback provision lifecycle", () => {
  it.each([
    { error: new Error("daemon unavailable"), status: 500 },
    { error: Object.assign(new Error("permission denied"), { statusCode: 403 }), status: 500 },
    { error: Object.assign(new Error("container missing"), { statusCode: 404 }), status: 404 },
  ])("reports inspection failures correctly when stopping: $status", async ({ error, status }) => {
    const { supervisorApp } = await import("./index.js");
    const container = { inspect: vi.fn().mockRejectedValue(error), stop: vi.fn(), exec: vi.fn() };
    mocks.docker.getContainer.mockReturnValue(container);
    const response = await supervisorApp.request("/computers/inspect-failure/stop", {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
        "x-rakazo-bot-id": "bot",
        "x-rakazo-space-id": "space",
      },
    });
    expect(response.status).toBe(status);
    expect(container.stop).not.toHaveBeenCalled();
    expect(container.exec).not.toHaveBeenCalled();
  });

  it("rejects another computer identity without stopping its container", async () => {
    const { supervisorApp } = await import("./index.js");
    const container = {
      inspect: vi.fn().mockResolvedValue({
        Config: {
          Labels: { "rakazo.managed": "true", "rakazo.botId": "other", "rakazo.spaceId": "other" },
        },
      }),
      stop: vi.fn(),
      exec: vi.fn(),
    };
    mocks.docker.getContainer.mockReturnValue(container);
    const response = await supervisorApp.request("/computers/identity-mismatch/stop", {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
        "x-rakazo-bot-id": "bot",
        "x-rakazo-space-id": "space",
      },
    });
    expect(response.status).toBe(403);
    expect(container.stop).not.toHaveBeenCalled();
    expect(container.exec).not.toHaveBeenCalled();
  });

  it("rechecks stopped state after a concurrent stop owns the screen lock", async () => {
    const { supervisorApp } = await import("./index.js");
    let running = true;
    let releaseStop!: () => void;
    let stopStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      stopStarted = resolve;
    });
    const stopped = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const container = {
      inspect: vi.fn(async () => ({
        Config: {
          Labels: { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" },
        },
        State: { Running: running },
      })),
      exec: vi.fn(async () => {
        if (!running) throw new Error("container stopped");
        return { start: async () => Readable.from([]), inspect: async () => ({ ExitCode: 0 }) };
      }),
      stop: vi.fn(async () => {
        stopStarted();
        await stopped;
        running = false;
      }),
    };
    mocks.docker.getContainer.mockReturnValue(container);
    const stop = () =>
      supervisorApp.request("/computers/concurrent-stop/stop", {
        method: "POST",
        headers: {
          authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
          "x-rakazo-bot-id": "bot",
          "x-rakazo-space-id": "space",
        },
      });
    const first = stop();
    await started;
    const second = stop();
    await vi.waitFor(() => expect(container.inspect).toHaveBeenCalledTimes(3));
    releaseStop();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(container.stop).toHaveBeenCalledOnce();
    expect(container.exec).toHaveBeenCalledOnce();
  });

  it("stops the computer after a failed checkpoint while reporting the failure", async () => {
    const { supervisorApp } = await import("./index.js");
    const container = {
      inspect: vi.fn(async () => ({
        Config: {
          Labels: { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" },
        },
        State: { Running: true },
      })),
      exec: vi.fn(async () => ({
        start: async () => Readable.from([]),
        inspect: async () => ({ ExitCode: 1 }),
      })),
      stop: vi.fn(async () => {}),
    };
    mocks.docker.getContainer.mockReturnValue(container);
    const response = await supervisorApp.request("/computers/failed-checkpoint/stop", {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
        "x-rakazo-bot-id": "bot",
        "x-rakazo-space-id": "space",
      },
    });
    expect(response.status).toBe(500);
    expect(container.stop).toHaveBeenCalledOnce();
  });

  it("stops a computer whose work is discarded without running a checkpoint in it", async () => {
    const { supervisorApp } = await import("./index.js");
    const container = {
      inspect: vi.fn(async () => ({
        Config: {
          Labels: { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" },
        },
        State: { Running: true },
      })),
      exec: vi.fn(),
      stop: vi.fn(async () => {}),
    };
    mocks.docker.getContainer.mockReturnValue(container);
    const response = await supervisorApp.request("/computers/wedged/stop", {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
        "x-rakazo-bot-id": "bot",
        "x-rakazo-space-id": "space",
        "x-rakazo-discard-unsaved": "1",
      },
    });
    expect(response.status).toBe(200);
    expect(container.exec).not.toHaveBeenCalled();
    expect(container.stop).toHaveBeenCalledOnce();
  });

  it("stops a discarded computer while a stuck screen command holds its screen lock", async () => {
    const { supervisorApp } = await import("./index.js");
    const { withComputerScreenLock } = await import("./locks.js");
    const container = {
      inspect: vi.fn(async () => ({
        Config: {
          Labels: { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" },
        },
        State: { Running: true },
      })),
      exec: vi.fn(),
      stop: vi.fn(async () => {}),
    };
    mocks.docker.getContainer.mockReturnValue(container);
    let release = () => {};
    const held = withComputerScreenLock(
      "wedged",
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    try {
      const response = await supervisorApp.request("/computers/wedged/stop", {
        method: "POST",
        headers: {
          authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
          "x-rakazo-bot-id": "bot",
          "x-rakazo-space-id": "space",
          "x-rakazo-discard-unsaved": "1",
        },
      });
      expect(response.status).toBe(200);
      expect(container.stop).toHaveBeenCalledOnce();
    } finally {
      release();
      await held;
    }
  });

  it("kills a computer that does not stop when asked", async () => {
    const { supervisorApp } = await import("./index.js");
    let running = true;
    const container = {
      inspect: vi.fn(async () => ({
        Config: {
          Labels: { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" },
        },
        State: { Running: running },
      })),
      exec: vi.fn(),
      stop: vi.fn(async () => {
        throw new Error("did not receive an exit event");
      }),
      kill: vi.fn(async () => {
        running = false;
      }),
    };
    mocks.docker.getContainer.mockReturnValue(container);
    const response = await supervisorApp.request("/computers/wedged/stop", {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
        "x-rakazo-bot-id": "bot",
        "x-rakazo-space-id": "space",
        "x-rakazo-discard-unsaved": "1",
      },
    });
    expect(response.status).toBe(200);
    expect(container.kill).toHaveBeenCalledOnce();
  });

  it("quiesces browser profiles with Browser.close before stopping the container", async () => {
    const { supervisorApp } = await import("./index.js");
    const container = {
      inspect: vi.fn(async () => ({
        Config: {
          Labels: { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" },
        },
        State: { Running: true },
      })),
      exec: vi.fn(async (_options: { Cmd?: string[] }) => ({
        start: async () => Readable.from([]),
        inspect: async () => ({ ExitCode: 0 }),
      })),
      stop: vi.fn(async () => {}),
    };
    mocks.docker.getContainer.mockReturnValue(container);
    const response = await supervisorApp.request("/computers/quiesce-before-stop/stop", {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
        "x-rakazo-bot-id": "bot",
        "x-rakazo-space-id": "space",
      },
    });
    expect(response.status).toBe(200);
    const command = String(container.exec.mock.calls[0]?.[0]?.Cmd?.[2] ?? "");
    expect(command).toContain("Browser.close");
    expect(command).toContain(".browser-profiles'/chromium ");
    expect(command).toContain(".browser-profiles'/chromium-bot-");
    expect(command).toContain(".browser-profiles'/chromium-screen-");
    expect(container.exec).toHaveBeenCalledOnce();
    expect(container.exec.mock.invocationCallOrder[0]).toBeLessThan(
      container.stop.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it.each([
    { enabled: true, hosts: [], resumed: false },
    { enabled: true, hosts: ["127.0.0.1"], resumed: true },
    { enabled: true, hosts: ["0.0.0.0", "127.0.0.1"], resumed: false },
    { enabled: false, hosts: ["127.0.0.1"], resumed: false },
    { enabled: false, hosts: ["0.0.0.0"], resumed: false },
    { enabled: false, hosts: [], resumed: true },
  ])("matches publication on stopped container reuse: %j", async ({ enabled, hosts, resumed }) => {
    vi.stubEnv("SANDBOX_CONTROL_VIA_LOOPBACK", String(enabled));
    const { supervisorApp } = await import("./index.js");
    const homePath = path.join(process.env.DATA_DIR!, "homes", "bot");
    const info = {
      Image: "test-image-id",
      Config: {
        User: hostComputerUser(),
        Labels: { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" },
      },
      HostConfig: {
        NetworkMode: computerNetworkNameFor("bot"),
        PortBindings: { "7070/tcp": hosts.map((HostIp) => ({ HostIp, HostPort: "0" })) },
      },
      State: { Running: false },
      NetworkSettings: {
        Ports: { "6080/tcp": [{ HostIp: "127.0.0.1", HostPort: screenPort }] },
        Networks: { [computerNetworkNameFor("bot")]: { NetworkID: "bot-network" } },
      },
    };
    const existing = {
      id: "existing",
      inspect: vi.fn().mockResolvedValue(info),
      start: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const replacement = {
      id: "replacement",
      inspect: vi.fn().mockResolvedValue(info),
      start: vi.fn().mockResolvedValue(undefined),
    };
    mocks.docker.getImage.mockReturnValue({
      inspect: vi.fn().mockResolvedValue({ Id: info.Image }),
    });
    mocks.docker.getContainer.mockReturnValue(existing);
    mocks.docker.listContainers.mockResolvedValue([{ Id: existing.id }]);
    mocks.docker.createContainer.mockResolvedValue(replacement);
    mocks.docker.createNetwork.mockResolvedValue({});
    mocks.docker.getNetwork.mockReturnValue({
      inspect: vi.fn().mockResolvedValue({ Id: "bot-network" }),
    });

    const response = await supervisorApp.request("/computers", {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
        "content-type": "application/json",
        "x-rakazo-bot-id": "bot",
        "x-rakazo-space-id": "space",
      },
      body: JSON.stringify({ botId: "bot", spaceId: "space", homePath }),
    });
    expect(await response.json()).toMatchObject({
      resumed,
      id: resumed ? "existing" : "replacement",
      ...(resumed ? { started: true } : {}),
    });
    expect(response.status).toBe(200);
    if (resumed) {
      expect(mocks.docker.createNetwork).not.toHaveBeenCalled();
      expect(existing.start).toHaveBeenCalledOnce();
      expect(existing.remove).not.toHaveBeenCalled();
      expect(mocks.docker.createContainer).not.toHaveBeenCalled();
    } else {
      expect(existing.remove).toHaveBeenCalledWith({ force: true });
      expect(replacement.start).toHaveBeenCalledOnce();
      const [options] = mocks.docker.createContainer.mock.calls[0]!;
      expect(options.HostConfig.PortBindings["7070/tcp"]).toEqual(
        enabled ? [{ HostIp: "127.0.0.1", HostPort: "0" }] : undefined,
      );
      expect(options.HostConfig.Binds).toEqual([`${homePath}:/home/rakazo`]);
      expect(options.Env).toContainEqual(
        expect.stringMatching(/^RAKAZO_COMPUTER_CONTROL_TOKEN=.+/),
      );
    }
  });
});

describe("provisioning network rollback", () => {
  function fixture() {
    const network = { remove: vi.fn().mockResolvedValue(undefined) };
    const container = {
      id: "new-computer",
      start: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    mocks.docker.getImage.mockReturnValue({ inspect: vi.fn().mockResolvedValue({ Id: "image" }) });
    mocks.docker.listContainers.mockResolvedValue([]);
    mocks.docker.createNetwork.mockResolvedValue(network);
    mocks.docker.createContainer.mockResolvedValue(container);
    return { network, container };
  }

  async function provision(homePath = path.join(process.env.DATA_DIR!, "homes", "bot")) {
    const { supervisorApp } = await import("./index.js");
    return supervisorApp.request("/computers", {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
        "content-type": "application/json",
        "x-rakazo-bot-id": "bot",
        "x-rakazo-space-id": "space",
      },
      body: JSON.stringify({ botId: "bot", spaceId: "space", homePath }),
    });
  }

  function proxyFixture(atLimit = false) {
    const { container } = fixture();
    vi.stubEnv("SANDBOX_SCREEN_NETWORK", "isolated");
    vi.stubEnv("SANDBOX_COMPUTER_EGRESS", "proxy");
    vi.stubEnv("HOSTNAME", "supervisor");
    const members = new Set<string>();
    let exists = false, guestExists = false, running = false;
    let labels: Record<string, string> = {};
    const supervisor = { Id: "supervisor", Config: { Labels: { "com.docker.compose.project": "qa" } }, Mounts: [] };
    const network = {
      inspect: vi.fn(async () => ({ Internal: true, EnableIPv6: false,
        Options: { "com.docker.network.bridge.gateway_mode_ipv4": "isolated" }, Labels: labels,
        Containers: Object.fromEntries([...members].map(id => [id, {}])) })),
      connect: vi.fn(async ({ Container }: { Container: string }) => { members.add(Container); }),
      disconnect: vi.fn(async ({ Container }: { Container: string }) => { members.delete(Container); }),
      remove: vi.fn(async () => {
        if (members.size) throw new Error("active endpoints");
        exists = false;
      }),
    };
    mocks.docker.getContainer.mockImplementation(id => id === "supervisor"
      ? { inspect: async () => supervisor } : container);
    mocks.docker.getNetwork.mockReturnValue(network);
    mocks.docker.createNetwork.mockImplementation(async (options: { Labels: Record<string, string> }) => {
      if (exists) throw new Error("network already exists");
      exists = true; labels = options.Labels;
      return network;
    });
    mocks.docker.listContainers.mockImplementation(async (options?: { filters?: { label?: string[]; network?: string[] } }) => {
      if (options?.filters?.network) return [...members].map(Id => ({ Id }));
      const filters = options?.filters?.label ?? [];
      if (filters.some(label => label.startsWith("rakazo.botId="))) return [];
      if (filters.includes("com.docker.compose.service=computer-egress")) return [{ Id: "proxy" }];
      if (filters.includes("com.docker.compose.service=web")) return [{ Id: "web" }];
      return atLimit ? [{ Id: "at-cap", Labels: { "rakazo.managed": "true", "rakazo.spaceId": "space" } }] : [];
    });
    mocks.docker.createContainer.mockImplementation(async () => { guestExists = true; return container; });
    container.start.mockImplementation(async () => { running = true; members.add(container.id); });
    container.remove.mockImplementation(async () => {
      if (running) throw new Error("cannot remove running guest");
      guestExists = false; members.delete(container.id);
    });
    return { container, network, members, exists: () => exists, guestExists: () => guestExists,
      markRunning: () => { running = true; members.add(container.id); } };
  }

  it("does not allocate a proxy network when the space is at its cap", async () => {
    proxyFixture(true);
    vi.stubEnv("SANDBOX_MAX_COMPUTERS_PER_SPACE", "1");
    expect((await provision()).status).toBe(429);
    expect(mocks.docker.createNetwork).not.toHaveBeenCalled();
  });

  it("does not allocate a proxy network when home validation fails", async () => {
    proxyFixture();
    mocks.assertHomeWritable.mockRejectedValue(new Error("home refused"));
    expect((await provision()).status).toBe(500);
    expect(mocks.docker.createNetwork).not.toHaveBeenCalled();
  });

  it.each(["create", "start"])("reclaims a proxy-only network after a guest %s failure", async phase => {
    const f = proxyFixture();
    if (phase === "create") mocks.docker.createContainer.mockRejectedValue(new Error("create refused"));
    else f.container.start.mockRejectedValue(new Error("start refused"));
    expect((await provision()).status).toBe(500);
    expect(f.guestExists()).toBe(false);
    expect(f.exists()).toBe(false);
    expect(f.members.size).toBe(0);
  });

  it("preserves a running guest and its proxy after a lost start response", async () => {
    const f = proxyFixture();
    f.container.start.mockImplementation(async () => { f.markRunning(); throw new Error("start response lost"); });
    expect((await provision()).status).toBe(500);
    expect(f.exists()).toBe(true);
    expect(f.members).toEqual(new Set(["proxy", f.container.id]));
    expect(f.network.remove).not.toHaveBeenCalled();
  });

  it.each(["1.44", "1.45"])(
    "provisions named-volume homes only with subpath support (%s)",
    async (apiVersion) => {
      fixture();
      vi.stubEnv("SANDBOX_SCREEN_NETWORK", "internal");
      vi.stubEnv("HOSTNAME", "supervisor");
      mocks.docker.version.mockResolvedValue({ ApiVersion: apiVersion });
      mocks.docker.getContainer.mockReturnValue({
        inspect: vi.fn().mockResolvedValue({
          NetworkSettings: { Networks: { shared: {} } },
          Mounts: [
            {
              Type: "volume",
              Name: "example_appdata",
              Destination: process.env.DATA_DIR,
              Source: "/var/lib/docker/volumes/example_appdata/_data",
            },
          ],
        }),
      });
      const response = await provision();
      if (apiVersion === "1.44") {
        expect(response.status).toBe(500);
        expect(mocks.docker.createContainer).not.toHaveBeenCalled();
        expect(mocks.docker.createNetwork).not.toHaveBeenCalled();
      } else {
        expect(response.status).toBe(200);
        expect(mocks.docker.createContainer).toHaveBeenCalledWith(
          expect.objectContaining({
            User: "1000:1000",
            HostConfig: expect.objectContaining({
              Mounts: [
                expect.objectContaining({
                  Type: "volume",
                  Source: "example_appdata",
                  Target: "/home/rakazo",
                  VolumeOptions: { NoCopy: true, Subpath: "homes/bot" },
                }),
              ],
            }),
          }),
        );
      }
    },
  );

  it("does not allocate a network for an invalid home", async () => {
    fixture();
    expect((await provision("/invalid-home")).status).toBe(500);
    expect(mocks.docker.createNetwork).not.toHaveBeenCalled();
  });

  it("does not allocate a network when home validation fails", async () => {
    fixture();
    mocks.assertHomeWritable.mockRejectedValue(new Error("home is not writable"));
    expect((await provision()).status).toBe(500);
    expect(mocks.docker.createNetwork).not.toHaveBeenCalled();
  });

  it("removes the new network on every failed container creation, then can retry", async () => {
    const { network } = fixture();
    mocks.docker.createContainer.mockRejectedValue(new Error("container creation failed"));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await provision();
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "container creation failed" });
      expect(network.remove).toHaveBeenCalledTimes(attempt + 1);
      expect(network.remove).toHaveBeenLastCalledWith();
    }
    const { network: retryNetwork } = fixture();
    expect((await provision()).status).toBe(200);
    expect(retryNetwork.remove).not.toHaveBeenCalled();
  });

  it("removes a failed new container before its new network", async () => {
    const { network, container } = fixture();
    container.start.mockRejectedValue(new Error("container start failed"));
    const response = await provision();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "container start failed" });
    expect(container.remove).toHaveBeenCalledExactlyOnceWith();
    expect(network.remove).toHaveBeenCalledExactlyOnceWith();
    expect(container.remove.mock.invocationCallOrder[0]).toBeLessThan(
      network.remove.mock.invocationCallOrder[0]!,
    );
  });

  it("preserves the existing computer when its replacement network cannot be allocated", async () => {
    fixture();
    const existing = {
      id: "existing-computer",
      remove: vi.fn().mockResolvedValue(undefined),
      inspect: vi.fn().mockResolvedValue({
        Image: "old-image",
        Config: {
          Labels: { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" },
        },
        HostConfig: { PortBindings: {} },
        State: { Running: true },
      }),
    };
    mocks.docker.listContainers.mockResolvedValue([{ Id: existing.id }]);
    mocks.docker.getContainer.mockReturnValue(existing);
    mocks.docker.createNetwork.mockRejectedValue(new Error("address pools exhausted"));
    const response = await provision();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "address pools exhausted" });
    expect(existing.remove).not.toHaveBeenCalled();
    expect(mocks.docker.createContainer).not.toHaveBeenCalled();
  });

  it("starts the computer on an IPv4-only network when the daemon cannot do IPv6", async () => {
    fixture();
    mocks.docker.createNetwork
      .mockRejectedValueOnce(
        new Error(
          "could not find an available, non-overlapping IPv6 address pool among the defaults to assign to the network",
        ),
      )
      .mockResolvedValueOnce({});
    const response = await provision();
    expect(response.status).toBe(200);
    expect(mocks.docker.createNetwork).toHaveBeenCalledTimes(2);
    const [dualStack, ipv4Only] = mocks.docker.createNetwork.mock.calls;
    expect(dualStack?.[0].EnableIPv6).toBe(true);
    expect(ipv4Only?.[0]).not.toHaveProperty("EnableIPv6");
  });

  it("removes the IPv4-fallback network when the container fails to start", async () => {
    const { container } = fixture();
    const fallbackNetwork = { remove: vi.fn().mockResolvedValue(undefined) };
    mocks.docker.createNetwork
      .mockRejectedValueOnce(
        new Error(
          "could not find an available, non-overlapping IPv6 address pool among the defaults to assign to the network",
        ),
      )
      .mockResolvedValueOnce(fallbackNetwork);
    container.start.mockRejectedValue(new Error("start failed"));
    const response = await provision();
    expect(response.status).toBe(500);
    expect(fallbackNetwork.remove).toHaveBeenCalledOnce();
  });

  it("does not remove an existing network after failed creation", async () => {
    const { network } = fixture();
    mocks.docker.createNetwork.mockRejectedValue(new Error("network already exists"));
    mocks.docker.createContainer.mockRejectedValue(new Error("container creation failed"));
    expect((await provision()).status).toBe(500);
    expect(network.remove).not.toHaveBeenCalled();
  });

  it("preserves the provision error if Docker refuses cleanup of active resources", async () => {
    const { network, container } = fixture();
    container.start.mockRejectedValue(new Error("start response lost"));
    container.remove.mockRejectedValue(new Error("container is running"));
    network.remove.mockRejectedValue(new Error("network has active endpoints"));
    const response = await provision();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "start response lost" });
    expect(container.remove).toHaveBeenCalledExactlyOnceWith();
    expect(network.remove).toHaveBeenCalledExactlyOnceWith();
  });

  it("does not allocate or delete the shared internal network", async () => {
    fixture();
    vi.stubEnv("SANDBOX_SCREEN_NETWORK", "internal");
    vi.stubEnv("HOSTNAME", "supervisor");
    mocks.docker.getContainer.mockReturnValue({
      inspect: vi.fn().mockResolvedValue({
        NetworkSettings: { Networks: { shared: {} } },
        Mounts: [],
      }),
    });
    mocks.docker.createContainer.mockRejectedValue(new Error("container creation failed"));
    const response = await provision();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "container creation failed" });
    expect(mocks.docker.createContainer).toHaveBeenCalledOnce();
    expect(mocks.docker.createNetwork).not.toHaveBeenCalled();
  });
});

describe("restricted egress rekeying", () => {
  function setupExisting(botNet: string) {
    const homePath = path.join(process.env.DATA_DIR!, "homes", "bot");
    const info = {
      Image: "test-image-id",
      Config: {
        User: hostComputerUser(),
        Labels: { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" },
      },
      HostConfig: { NetworkMode: botNet, PortBindings: {} },
      State: { Running: false },
      NetworkSettings: {
        Ports: { "6080/tcp": [{ HostIp: "127.0.0.1", HostPort: screenPort }] },
        Networks: { [botNet]: { NetworkID: "bot-network" } },
      },
    };
    const existing = {
      id: "existing",
      inspect: vi.fn().mockResolvedValue(info),
      start: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const replacement = {
      id: "replacement",
      inspect: vi.fn().mockResolvedValue(info),
      start: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    mocks.docker.getImage.mockReturnValue({
      inspect: vi.fn().mockResolvedValue({ Id: info.Image }),
    });
    mocks.docker.getContainer.mockReturnValue(existing);
    mocks.docker.listContainers.mockResolvedValue([{ Id: existing.id }]);
    mocks.docker.createContainer.mockResolvedValue(replacement);
    return { homePath, existing, replacement };
  }

  async function provision() {
    const { supervisorApp } = await import("./index.js");
    const homePath = path.join(process.env.DATA_DIR!, "homes", "bot");
    return supervisorApp.request("/computers", {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
        "content-type": "application/json",
        "x-rakazo-bot-id": "bot",
        "x-rakazo-space-id": "space",
      },
      body: JSON.stringify({ botId: "bot", spaceId: "space", homePath }),
    });
  }

  it("replaces a computer whose network lacks the named bridge", async () => {
    vi.stubEnv("SANDBOX_COMPUTER_EGRESS", "restricted");
    const botNet = computerNetworkNameFor("bot");
    const { existing } = setupExisting(botNet);
    const network = {
      inspect: vi.fn().mockResolvedValue({ Id: "bot-network", Options: {} }),
      disconnect: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    mocks.docker.getNetwork.mockReturnValue(network);
    mocks.docker.createNetwork.mockResolvedValue({});

    const response = await provision();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ resumed: false, id: "replacement" });
    expect(existing.remove).toHaveBeenCalledWith({ force: true });
    expect(existing.start).not.toHaveBeenCalled();
  });

  it.each(["auto", "restricted"])("probes %s egress with configured computer DNS", async (mode) => {
    vi.stubEnv("SANDBOX_COMPUTER_EGRESS", mode);
    vi.stubEnv("SANDBOX_COMPUTER_DNS", "1.1.1.1, 9.9.9.9");
    setupExisting(computerNetworkNameFor("bot"));
    await provision();
    expect(mocks.verifyRestrictedEgress).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      COMPUTER_IMAGE,
      ["1.1.1.1", "9.9.9.9"],
    );
  });

  it("refuses restricted computers until the host ruleset is verified", async () => {
    vi.stubEnv("SANDBOX_COMPUTER_EGRESS", "restricted");
    const { existing } = setupExisting(computerNetworkNameFor("bot"));
    mocks.verifyRestrictedEgress.mockRejectedValueOnce(new Error("egress is not enforced"));

    const response = await provision();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "egress is not enforced" });
    expect(existing.start).not.toHaveBeenCalled();
    expect(mocks.docker.createContainer).not.toHaveBeenCalled();
    expect(mocks.docker.createNetwork).not.toHaveBeenCalled();
  });

  it("auto egress stays open only after a probe shows the rules are missing", async () => {
    vi.stubEnv("SANDBOX_COMPUTER_EGRESS", "auto");
    const { existing } = setupExisting(computerNetworkNameFor("bot"));
    const { EgressNotEnforced } = await import("./egress-probe.js");
    mocks.verifyRestrictedEgress
      .mockRejectedValueOnce(new Error("probe timed out"))
      .mockRejectedValueOnce(new EgressNotEnforced("a computer bridge reached the host"));

    // A probe that could not finish decides nothing: refuse, and probe again next time.
    const refused = await provision();
    expect(refused.status).toBe(500);
    expect(existing.start).not.toHaveBeenCalled();

    mocks.docker.getNetwork.mockReturnValue({
      inspect: vi.fn().mockResolvedValue({ Id: "bot-network", Options: {} }),
      disconnect: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    });
    mocks.docker.createNetwork.mockResolvedValue({});
    const opened = await provision();
    expect(await opened.clone().text()).not.toMatch(/probe/);
    expect(opened.status).toBe(200);
    // The completed answer is kept: no third probe.
    await provision();
    expect(mocks.verifyRestrictedEgress).toHaveBeenCalledTimes(2);
  });

  it("resumes a computer whose network has the named bridge", async () => {
    vi.stubEnv("SANDBOX_COMPUTER_EGRESS", "restricted");
    const botNet = computerNetworkNameFor("bot");
    const { existing } = setupExisting(botNet);
    const network = {
      inspect: vi.fn().mockResolvedValue({
        Id: "bot-network",
        Options: { "com.docker.network.bridge.name": computerBridgeNameFor("bot") },
      }),
      disconnect: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    mocks.docker.getNetwork.mockReturnValue(network);
    mocks.docker.createNetwork.mockResolvedValue({});

    const response = await provision();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ resumed: true, id: "existing" });
    expect(existing.start).toHaveBeenCalledOnce();
    expect(mocks.docker.createContainer).not.toHaveBeenCalled();
    expect(mocks.docker.createNetwork).not.toHaveBeenCalled();
  });

  it("stops the computer instead of restoring unrestricted egress when rekey removal fails", async () => {
    vi.stubEnv("SANDBOX_COMPUTER_EGRESS", "restricted");
    const botNet = computerNetworkNameFor("bot");
    const { existing } = setupExisting(botNet);
    const stop = vi.fn().mockResolvedValue(undefined);
    const kill = vi.fn().mockResolvedValue(undefined);
    Object.assign(existing, { stop, kill });
    const peer = {
      inspect: vi.fn().mockResolvedValue({ Config: { Labels: { "rakazo.botId": "other" } } }),
      stop: vi.fn().mockResolvedValue(undefined),
      kill: vi.fn().mockResolvedValue(undefined),
    };
    mocks.docker.getContainer.mockImplementation((id: string) => (id === "peer" ? peer : existing));
    const network = {
      inspect: vi.fn().mockResolvedValue({
        Id: "bot-network",
        Options: {},
        Containers: { existing: {}, peer: {} },
      }),
      disconnect: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockRejectedValue(new Error("network has active endpoints")),
    };
    mocks.docker.getNetwork.mockReturnValue(network);
    mocks.docker.createNetwork.mockRejectedValue(new Error("network already exists"));

    const response = await provision();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: expect.stringContaining("failed to replace unrestricted network"),
    });
    for (const id of ["existing", "peer"]) {
      expect(network.disconnect).toHaveBeenCalledWith({ Container: id, Force: true });
    }
    expect(network.connect).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledWith({ t: 1 });
    expect(peer.stop).not.toHaveBeenCalled();
    expect(existing.remove).not.toHaveBeenCalled();
    expect(existing.start).not.toHaveBeenCalled();
  });

  it("stops the named computer when endpoint inspection fails during rekey", async () => {
    vi.stubEnv("SANDBOX_COMPUTER_EGRESS", "restricted");
    const botNet = computerNetworkNameFor("bot");
    const { existing } = setupExisting(botNet);
    const info = await existing.inspect();
    let seen = 0;
    existing.inspect.mockImplementation(async () => {
      seen += 1;
      if (seen > 2) throw new Error("inspect failed");
      return info;
    });
    const stop = vi.fn().mockResolvedValue(undefined);
    const kill = vi.fn().mockResolvedValue(undefined);
    Object.assign(existing, { stop, kill });
    const peer = {
      inspect: vi.fn().mockResolvedValue({ Config: { Labels: { "rakazo.botId": "other" } } }),
      stop: vi.fn().mockResolvedValue(undefined),
      kill: vi.fn().mockResolvedValue(undefined),
    };
    mocks.docker.getContainer.mockImplementation((id: string) => (id === "peer" ? peer : existing));
    const network = {
      inspect: vi.fn().mockResolvedValue({
        Id: "bot-network",
        Options: {},
        Containers: { existing: {}, peer: {} },
      }),
      disconnect: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockRejectedValue(new Error("network has active endpoints")),
    };
    mocks.docker.getNetwork.mockReturnValue(network);
    mocks.docker.createNetwork.mockRejectedValue(new Error("network already exists"));

    const response = await provision();
    expect(response.status).toBe(500);
    expect(network.connect).not.toHaveBeenCalled();
    expect(mocks.docker.getContainer).toHaveBeenCalledWith(containerNameFor("bot"));
    expect(stop).toHaveBeenCalledWith({ t: 1 });
    expect(peer.stop).not.toHaveBeenCalled();
  });
});

describe("space computer limit enforcement", () => {
  function setupContainerFixture() {
    const network = { remove: vi.fn().mockResolvedValue(undefined) };
    const container = {
      id: "new-container-id",
      start: vi.fn().mockResolvedValue(undefined),
      inspect: vi.fn().mockResolvedValue({
        State: { Running: true },
        HostConfig: { PortBindings: {} },
      }),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    mocks.docker.getImage.mockReturnValue({ inspect: vi.fn().mockResolvedValue({ Id: "image" }) });
    mocks.docker.createNetwork.mockResolvedValue(network);
    mocks.docker.createContainer.mockResolvedValue(container);
    return { network, container };
  }

  async function provisionBot(
    botId = "bot-new",
    spaceId = "space-1",
    homePath = path.join(process.env.DATA_DIR!, "homes", botId),
  ) {
    const { supervisorApp } = await import("./index.js");
    return supervisorApp.request("/computers", {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
        "content-type": "application/json",
        "x-rakazo-bot-id": botId,
        "x-rakazo-space-id": spaceId,
      },
      body: JSON.stringify({ botId, spaceId, homePath }),
    });
  }

  it("rejects new container creation with 429 when space container limit is reached", async () => {
    setupContainerFixture();
    vi.stubEnv("SANDBOX_MAX_COMPUTERS_PER_SPACE", "2");

    mocks.docker.listContainers.mockImplementation(
      async (opts?: { filters?: { label?: string[] } }) => {
        const labels = opts?.filters?.label ?? [];
        // For findBotContainer check
        if (labels.some((l: string) => l.startsWith("rakazo.botId="))) {
          return [];
        }
        // For countSpaceContainers
        return [
          { Id: "c1", Labels: { "rakazo.managed": "true", "rakazo.spaceId": "space-1" } },
          { Id: "c2", Labels: { "rakazo.managed": "true", "rakazo.spaceId": "space-1" } },
        ];
      },
    );

    const response = await provisionBot("bot-new", "space-1");
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: "Computer limit reached for space (max: 2)",
    });
    expect(mocks.docker.createContainer).not.toHaveBeenCalled();
  });

  it("allows new container creation when under space limit", async () => {
    setupContainerFixture();
    vi.stubEnv("SANDBOX_MAX_COMPUTERS_PER_SPACE", "2");

    mocks.docker.listContainers.mockImplementation(
      async (opts?: { filters?: { label?: string[] } }) => {
        const labels = opts?.filters?.label ?? [];
        if (labels.some((l: string) => l.startsWith("rakazo.botId="))) {
          return [];
        }
        return [{ Id: "c1", Labels: { "rakazo.managed": "true", "rakazo.spaceId": "space-1" } }];
      },
    );

    const response = await provisionBot("bot-new", "space-1");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: "new-container-id",
    });
    expect(mocks.docker.createContainer).toHaveBeenCalledOnce();
  });

  it("resumes existing container even if space is at limit", async () => {
    setupContainerFixture();
    vi.stubEnv("SANDBOX_MAX_COMPUTERS_PER_SPACE", "1");

    const existing = {
      id: "existing-container",
      inspect: vi.fn().mockResolvedValue({
        Image: "image",
        Config: {
          User: hostComputerUser(process.getuid?.(), process.getgid?.()),
          Labels: {
            "rakazo.managed": "true",
            "rakazo.botId": "bot-existing",
            "rakazo.spaceId": "space-1",
          },
        },
        State: { Running: true },
        HostConfig: {
          NetworkMode: computerNetworkNameFor("bot-existing"),
          PortBindings: {},
          Mounts: [],
        },
        NetworkSettings: { Networks: { [computerNetworkNameFor("bot-existing")]: {} } },
      }),
      start: vi.fn().mockResolvedValue(undefined),
    };

    mocks.docker.getContainer.mockReturnValue(existing);
    mocks.docker.listContainers.mockImplementation(
      async (opts?: { filters?: { label?: string[] } }) => {
        const labels = opts?.filters?.label ?? [];
        if (labels.some((l: string) => l === "rakazo.botId=bot-existing")) {
          return [
            {
              Id: existing.id,
              Labels: {
                "rakazo.managed": "true",
                "rakazo.botId": "bot-existing",
                "rakazo.spaceId": "space-1",
              },
            },
          ];
        }
        return [
          { Id: existing.id, Labels: { "rakazo.managed": "true", "rakazo.spaceId": "space-1" } },
        ];
      },
    );

    const response = await provisionBot("bot-existing", "space-1");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: "existing-container",
      resumed: true,
    });
    expect(mocks.docker.createContainer).not.toHaveBeenCalled();
  });

  it("replaces a running container that lost its network attachment", async () => {
    setupContainerFixture();

    // A named network deleted out from under a container (e.g. a failed rekey)
    // leaves HostConfig.NetworkMode set while NetworkSettings has no endpoint —
    // resuming it would report success with zero connectivity, so it must be
    // replaced instead.
    const existing = {
      id: "detached-container",
      inspect: vi.fn().mockResolvedValue({
        Image: "image",
        Config: {
          User: hostComputerUser(process.getuid?.(), process.getgid?.()),
          Labels: {
            "rakazo.managed": "true",
            "rakazo.botId": "bot-detached",
            "rakazo.spaceId": "space-1",
          },
        },
        State: { Running: true },
        HostConfig: {
          NetworkMode: computerNetworkNameFor("bot-detached"),
          PortBindings: {},
          Mounts: [],
        },
        NetworkSettings: { Networks: {} },
      }),
      start: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };

    mocks.docker.getContainer.mockReturnValue(existing);
    mocks.docker.listContainers.mockImplementation(
      async (opts?: { filters?: { label?: string[] } }) => {
        const labels = opts?.filters?.label ?? [];
        if (labels.some((l: string) => l === "rakazo.botId=bot-detached")) {
          return [
            {
              Id: existing.id,
              Labels: {
                "rakazo.managed": "true",
                "rakazo.botId": "bot-detached",
                "rakazo.spaceId": "space-1",
              },
            },
          ];
        }
        return [];
      },
    );

    const response = await provisionBot("bot-detached", "space-1");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: "new-container-id",
      resumed: false,
    });
    expect(existing.remove).toHaveBeenCalledWith({ force: true });
    expect(mocks.docker.createContainer).toHaveBeenCalled();
  });

  it("counts legacy workspaceId COMPUTER_IMAGE containers toward the limit", async () => {
    setupContainerFixture();
    vi.stubEnv("SANDBOX_MAX_COMPUTERS_PER_SPACE", "1");

    mocks.docker.listContainers.mockImplementation(
      async (opts?: { filters?: { label?: string[] } }) => {
        const labels = opts?.filters?.label ?? [];
        if (labels.some((l: string) => l.startsWith("rakazo.botId="))) {
          return [];
        }
        // Legacy managed computer: COMPUTER_IMAGE + workspaceId, no rakazo.managed.
        return [
          {
            Id: "legacy",
            Image: COMPUTER_IMAGE,
            Labels: { "rakazo.workspaceId": "space-1", "rakazo.botId": "legacy-bot" },
          },
        ];
      },
    );

    const response = await provisionBot("bot-new", "space-1");
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: "Computer limit reached for space (max: 1)",
    });
    expect(mocks.docker.createContainer).not.toHaveBeenCalled();
  });

  it("serializes concurrent creates for different bots in the same space", async () => {
    const { container } = setupContainerFixture();
    vi.stubEnv("SANDBOX_MAX_COMPUTERS_PER_SPACE", "1");

    let created = 0;
    mocks.docker.listContainers.mockImplementation(
      async (opts?: { filters?: { label?: string[] } }) => {
        const labels = opts?.filters?.label ?? [];
        if (labels.some((l: string) => l.startsWith("rakazo.botId="))) {
          return [];
        }
        return Array.from({ length: created }, (_, index) => ({
          Id: `c${index}`,
          Labels: { "rakazo.managed": "true", "rakazo.spaceId": "space-1" },
        }));
      },
    );
    mocks.docker.createContainer.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      created += 1;
      return {
        ...container,
        id: `new-container-${created}`,
      };
    });

    const [first, second] = await Promise.all([
      provisionBot("bot-a", "space-1"),
      provisionBot("bot-b", "space-1"),
    ]);
    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 429]);
    expect(mocks.docker.createContainer).toHaveBeenCalledOnce();
    const rejected = first.status === 429 ? first : second;
    expect(await rejected.json()).toEqual({
      error: "Computer limit reached for space (max: 1)",
    });
  });

  it("serializes incompatible replace with a concurrent fresh create at the cap", async () => {
    const { container } = setupContainerFixture();
    vi.stubEnv("SANDBOX_MAX_COMPUTERS_PER_SPACE", "1");

    const present = new Set<string>(["existing-incompatible"]);
    const existing = {
      id: "existing-incompatible",
      inspect: vi.fn().mockResolvedValue({
        Image: "stale-image",
        Config: {
          User: hostComputerUser(process.getuid?.(), process.getgid?.()),
          Labels: {
            "rakazo.managed": "true",
            "rakazo.botId": "bot-existing",
            "rakazo.spaceId": "space-1",
          },
        },
        State: { Running: true },
        HostConfig: {
          NetworkMode: computerNetworkNameFor("bot-existing"),
          PortBindings: {},
          Mounts: [],
        },
      }),
      start: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        present.delete("existing-incompatible");
      }),
    };

    mocks.docker.getContainer.mockImplementation((id: string) =>
      id === existing.id ? existing : container,
    );
    mocks.docker.listContainers.mockImplementation(
      async (opts?: { filters?: { label?: string[] } }) => {
        const labels = opts?.filters?.label ?? [];
        if (labels.some((l: string) => l === "rakazo.botId=bot-existing")) {
          return present.has(existing.id)
            ? [
                {
                  Id: existing.id,
                  Labels: {
                    "rakazo.managed": "true",
                    "rakazo.botId": "bot-existing",
                    "rakazo.spaceId": "space-1",
                  },
                },
              ]
            : [];
        }
        if (labels.some((l: string) => l.startsWith("rakazo.botId="))) {
          return [];
        }
        return [...present].map((Id) => ({
          Id,
          Labels: { "rakazo.managed": "true", "rakazo.spaceId": "space-1" },
        }));
      },
    );
    mocks.docker.createContainer.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      const id = `created-${present.size + 1}`;
      present.add(id);
      return { ...container, id };
    });

    const [replaceResponse, createResponse] = await Promise.all([
      provisionBot("bot-existing", "space-1"),
      provisionBot("bot-new", "space-1"),
    ]);
    // With the space lock, the incompatible replace keeps its slot and must succeed;
    // the concurrent fresh create must see the space still at capacity.
    expect(replaceResponse.status).toBe(200);
    expect(createResponse.status).toBe(429);
    expect(mocks.docker.createContainer).toHaveBeenCalledOnce();
    expect(present.size).toBe(1);
    expect(await createResponse.json()).toEqual({
      error: "Computer limit reached for space (max: 1)",
    });
  });
});

describe("screen release status", () => {
  const headers = {
    authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
    "content-type": "application/json",
    "x-rakazo-bot-id": "bot",
    "x-rakazo-space-id": "space",
    "x-rakazo-screen-id": "writer",
  };

  function managedContainer(exec?: ReturnType<typeof vi.fn>) {
    return {
      inspect: vi.fn(async () => ({
        Config: {
          Labels: { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" },
        },
        HostConfig: { NetworkMode: computerNetworkNameFor("bot") },
        State: { Running: true },
        NetworkSettings: {
          Ports: { "6080/tcp": [{ HostIp: "127.0.0.1", HostPort: screenPort }] },
        },
      })),
      exec:
        exec ??
        vi.fn(async () => ({
          start: async () => Readable.from([]),
          inspect: async () => ({ ExitCode: 0 }),
        })),
    };
  }

  it("returns 404 only when the computer is already missing", async () => {
    const { supervisorApp } = await import("./index.js");
    const missing = {
      inspect: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("no such container"), { statusCode: 404 })),
    };
    mocks.docker.getContainer.mockReturnValue(missing);
    const response = await supervisorApp.request("/computers/missing-screen/screen", {
      method: "DELETE",
      headers,
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "computer not found" });
  });

  it("rejects another computer identity without releasing its screen", async () => {
    const { supervisorApp } = await import("./index.js");
    const container = {
      inspect: vi.fn().mockResolvedValue({
        Config: {
          Labels: { "rakazo.managed": "true", "rakazo.botId": "other", "rakazo.spaceId": "other" },
        },
      }),
      exec: vi.fn(),
    };
    mocks.docker.getContainer.mockReturnValue(container);
    const response = await supervisorApp.request("/computers/identity-screen/screen", {
      method: "DELETE",
      headers: { ...headers, "x-rakazo-preserve-screen": "1" },
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "invalid computer identity" });
    expect(container.exec).not.toHaveBeenCalled();
  });

  it.each(["run-1:1", "screen-view-writer:0"])(
    "keeps the browser across release and reacquisition (%s)",
    async (leaseId) => {
      const { supervisorApp } = await import("./index.js");
      const container = managedContainer();
      mocks.docker.getContainer.mockReturnValue(container);
      const open = (lease: string) =>
        supervisorApp.request("/computers/persistent/screen-mode", {
          method: "POST",
          headers: { ...headers, "x-rakazo-screen-lease-id": lease },
          body: JSON.stringify({ interactive: false, revokeControl: false }),
        });
      const first = await open(leaseId);
      expect(first.status).toBe(200);
      const firstView = await first.json();
      container.exec.mockClear();

      const released = await supervisorApp.request("/computers/persistent/screen", {
        method: "DELETE",
        headers: { ...headers, "x-rakazo-screen-lease-id": leaseId },
      });
      expect(released.status).toBe(200);
      const releaseCommand = container.exec.mock.calls
        .map(([options]) => options.Cmd.join(" "))
        .join("\n");
      expect(releaseCommand).toContain("sockets/view-1-");
      expect(releaseCommand).toContain("sockets/control-1-");
      expect(releaseCommand).not.toContain("Browser.close");
      expect(releaseCommand).not.toContain("browser-profile-");
      expect(releaseCommand).not.toContain("Xvfb");
      container.exec.mockClear();

      const next = await open("run-2:2");
      expect(next.status).toBe(200);
      expect(await next.json()).not.toEqual(firstView);
      const setupCommand = container.exec.mock.calls
        .map(([options]) => options.Cmd.join(" "))
        .join("\n");
      expect(setupCommand).toContain("browser-profile-1");
      expect(setupCommand).toContain("browser_running || launch_browser");
      expect(setupCommand).not.toContain("Browser.close");
      expect(setupCommand).not.toContain("for marker in /tmp/rakazo/browser-profile-*");
    },
  );

  it("hands back an existing control lease without rebuilding the desktop", async () => {
    const { supervisorApp } = await import("./index.js");
    const container = managedContainer(
      vi.fn(async (options: { Cmd: string[] }) => ({
        start: async () =>
          Readable.from(
            options.Cmd.join(" ").includes("RAKAZO_CONTROL_RELEASED")
              ? [Buffer.from("RAKAZO_CONTROL_RELEASED\n")]
              : [],
          ),
        inspect: async () => ({ ExitCode: 0 }),
      })),
    );
    const inspect = await container.inspect();
    container.inspect.mockResolvedValue({
      ...inspect,
      State: { Running: true, StartedAt: "boot-1" },
    } as never);
    mocks.docker.getContainer.mockReturnValue(container);
    const post = (interactive: boolean) =>
      supervisorApp.request("/computers/fast-handback/screen-mode", {
        method: "POST",
        headers,
        body: JSON.stringify({
          interactive,
          controlToken: "human-control",
          ...(interactive ? { revokeControl: false } : {}),
        }),
      });
    expect((await post(true)).status).toBe(200);
    container.exec.mockClear();
    expect((await post(false)).status).toBe(200);
    const commands = container.exec.mock.calls.map(([options]) =>
      options.Cmd.join(" "),
    );
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("RAKAZO_CONTROL_RELEASED");
    expect(commands[0]).not.toContain("browser_running");
    expect(commands[0]).not.toContain("xdpyinfo");
  });

  it("restores active control on every screen ensure and fails visibly if restoration fails", async () => {
    const { supervisorApp } = await import("./index.js");
    let failControl = false;
    const container = managedContainer(
      vi.fn(async (options: { Cmd?: string[] }) => ({
        start: async () => Readable.from([]),
        inspect: async () => ({
          ExitCode:
            failControl &&
            options.Cmd?.join(" ").includes("nohup x11vnc -display :1 -forever -shared -nopw")
              ? 1
              : 0,
        }),
      })),
    );
    mocks.docker.getContainer.mockReturnValue(container);
    const open = (interactive: boolean) =>
      supervisorApp.request("/computers/control-rebuild/screen-mode", {
        method: "POST",
        headers,
        body: JSON.stringify({
          interactive,
          controlToken: interactive ? "human-control" : undefined,
          revokeControl: false,
        }),
      });
    const takeover = await open(true);
    expect(takeover.status).toBe(200);
    expect(
      decodeURIComponent(((await takeover.json()) as { screenUrl: string }).screenUrl),
    ).toContain("token=human-control");
    container.exec.mockClear();
    expect((await open(false)).status).toBe(200);
    expect(
      container.exec.mock.calls.map(([options]) => options.Cmd.join(" ")).join("\n"),
    ).toContain("nohup x11vnc -display :1 -forever -shared -nopw");
    failControl = true;
    const failed = await open(false);
    expect(failed.status).toBe(400);
    expect(await failed.json()).toEqual({ error: "control screen failed to start" });
    const failedTakeover = await open(true);
    expect(failedTakeover.status).toBe(400);
    expect(await failedTakeover.json()).toEqual({ error: "control screen failed to start" });
    const viewer = await supervisorApp.request("/computers/control-rebuild/screen", { headers });
    expect(viewer.status).toBe(302);
    expect(decodeURIComponent(viewer.headers.get("location")!)).not.toContain(
      "token=human-control",
    );
    const terminal = await supervisorApp.request("/computers/control-rebuild/terminal", {
      method: "POST",
      headers,
      body: JSON.stringify({ controlToken: "human-control" }),
    });
    expect(terminal.status).toBe(200);
    const revoked = await supervisorApp.request("/computers/control-rebuild/screen-mode", {
      method: "POST",
      headers,
      body: JSON.stringify({ interactive: false }),
    });
    expect(revoked.status).toBe(200);
    expect((await open(false)).status).toBe(200);
  });

  it("returns 500 when cancellation leaves the browser running", async () => {
    const { supervisorApp } = await import("./index.js");
    let failStop = false;
    const container = managedContainer(
      vi.fn(async (options: { Cmd?: string[] }) => {
        const command = options.Cmd?.join(" ") ?? "";
        const code = failStop && command.includes("Browser.close") ? 1 : 0;
        return {
          start: async () => Readable.from([]),
          inspect: async () => ({ ExitCode: code }),
        };
      }),
    );
    mocks.docker.getContainer.mockReturnValue(container);
    const opened = await supervisorApp.request("/computers/release-failed/screen-mode", {
      method: "POST",
      headers,
      body: JSON.stringify({ interactive: false, revokeControl: false }),
    });
    expect(opened.status).toBe(200);

    failStop = true;
    const released = await supervisorApp.request("/computers/release-failed/screen", {
      method: "DELETE",
      headers: {
        ...headers,
        "x-rakazo-screen-lease-id": "run-1:1",
        "x-rakazo-cancel-run-work": "1",
      },
    });
    expect(released.status).toBe(500);
    await expect(released.json()).resolves.toEqual({ error: "computer screen failed to stop" });
  });

  it("fully tears down a screen when control revocation is uncertain", async () => {
    const { supervisorApp } = await import("./index.js");
    const commands: string[] = [];
    let failNextCommand = false;
    const container = managedContainer(
      vi.fn(async (options: { Cmd?: string[] }) => {
        const command = options.Cmd?.join(" ") ?? "";
        commands.push(command);
        const code = failNextCommand ? 1 : 0;
        failNextCommand = false;
        return {
          start: async () => Readable.from([]),
          inspect: async () => ({ ExitCode: code }),
        };
      }),
    );
    mocks.docker.getContainer.mockReturnValue(container);
    const opened = await supervisorApp.request("/computers/revoke-failed/screen-mode", {
      method: "POST",
      headers,
      body: JSON.stringify({ interactive: false, revokeControl: false }),
    });
    expect(opened.status).toBe(200);

    failNextCommand = true;
    const released = await supervisorApp.request("/computers/revoke-failed/screen", {
      method: "DELETE",
      headers: {
        ...headers,
        "x-rakazo-screen-lease-id": "run-1:1",
        "x-rakazo-preserve-screen": "1",
      },
    });
    expect(released.status).toBe(200);
    expect(commands.at(-2)).not.toContain("Browser.close");
    expect(commands.at(-1)).toContain("Browser.close");
  });

  it("returns 500 when exec.start 404s after the container was found", async () => {
    const { supervisorApp } = await import("./index.js");
    let failStart = false;
    const container = managedContainer(
      vi.fn(async () => ({
        start: async () => {
          if (failStart) throw Object.assign(new Error("no such exec"), { statusCode: 404 });
          return Readable.from([]);
        },
        inspect: async () => ({ ExitCode: 0 }),
      })),
    );
    mocks.docker.getContainer.mockReturnValue(container);
    const opened = await supervisorApp.request("/computers/exec-start-404/screen-mode", {
      method: "POST",
      headers,
      body: JSON.stringify({ interactive: false, revokeControl: false }),
    });
    expect(opened.status).toBe(200);
    expect(container.inspect).toHaveBeenCalled();

    failStart = true;
    const released = await supervisorApp.request("/computers/exec-start-404/screen", {
      method: "DELETE",
      headers: { ...headers, "x-rakazo-screen-lease-id": "run-1:1" },
    });
    expect(released.status).toBe(500);
    await expect(released.json()).resolves.toEqual({ error: "no such exec" });
  });
});

describe("computer deletion", () => {
  const headers = {
    authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
    "content-type": "application/json",
    "x-rakazo-bot-id": "bot",
    "x-rakazo-space-id": "space",
    "x-rakazo-screen-id": "writer",
  };
  const dockerError = (statusCode: number) =>
    Object.assign(new Error(`docker ${statusCode}`), { statusCode });

  function computer(botId = "bot") {
    const commands: string[] = [];
    const container = {
      inspect: vi.fn(async () => ({
        Config: {
          Labels: { "rakazo.managed": "true", "rakazo.botId": botId, "rakazo.spaceId": "space" },
        },
        HostConfig: { NetworkMode: computerNetworkNameFor("bot") },
        State: { Running: true },
        NetworkSettings: {
          Ports: { "6080/tcp": [{ HostIp: "127.0.0.1", HostPort: screenPort }] },
        },
      })),
      exec: vi.fn(async ({ Cmd }: { Cmd: string[] }) => {
        commands.push(Cmd.join(" "));
        return { start: async () => Readable.from([]), inspect: async () => ({ ExitCode: 0 }) };
      }),
      remove: vi.fn(),
    };
    mocks.docker.getContainer.mockReturnValue(container);
    mocks.docker.getNetwork.mockReturnValue({
      inspect: vi.fn().mockRejectedValue(dockerError(404)),
    });
    const resets = () =>
      commands.filter((command) => command.includes("for marker in /tmp/rakazo/browser-profile-*"))
        .length;
    return { container, resets };
  }

  it.each([
    { fail: "inspect", error: dockerError(500), status: 500 },
    { fail: "inspect", error: dockerError(404), status: 404 },
    { fail: "remove", error: dockerError(500), status: 500 },
    { fail: "remove", error: dockerError(404), status: 200 },
  ])("answers $status when $fail fails with $error.message", async ({ fail, error, status }) => {
    const { supervisorApp } = await import("./index.js");
    const { container } = computer();
    (fail === "inspect" ? container.inspect : container.remove).mockRejectedValue(error);
    const response = await supervisorApp.request("/computers/computer", {
      method: "DELETE",
      headers,
    });
    expect(response.status).toBe(status);
    if (status === 404)
      await expect(response.json()).resolves.toEqual({ error: "computer not found" });
    expect(container.remove).toHaveBeenCalledTimes(fail === "inspect" ? 0 : 1);
  });

  it("rejects another computer identity without removing its container", async () => {
    const { supervisorApp } = await import("./index.js");
    const { container } = computer("other");
    const response = await supervisorApp.request("/computers/computer", {
      method: "DELETE",
      headers,
    });
    expect(response.status).toBe(403);
    expect(container.remove).not.toHaveBeenCalled();
  });

  it("forgets the computer's screens only once it is removed", async () => {
    const { supervisorApp } = await import("./index.js");
    const { container, resets } = computer();
    const view = () =>
      supervisorApp.request("/computers/computer/screen-mode", {
        method: "POST",
        headers,
        body: JSON.stringify({ interactive: false, revokeControl: false }),
      });
    const remove = () =>
      supervisorApp.request("/computers/computer", { method: "DELETE", headers });
    expect((await view()).status).toBe(200);
    expect(resets()).toBe(1);

    container.remove.mockRejectedValueOnce(dockerError(500));
    expect((await remove()).status).toBe(500);
    expect((await view()).status).toBe(200);
    expect(resets()).toBe(1);

    container.remove.mockResolvedValueOnce(undefined);
    expect((await remove()).status).toBe(200);
    expect((await view()).status).toBe(200);
    expect(resets()).toBe(2);
  });
});

describe("screen registry across run boundaries", () => {
  it("discards a first failed setup left releasing when the container restarts", async () => {
    const logic = await import("./supervisor-logic.js");
    const currentScreens = vi.spyOn(logic, "currentComputerScreens");
    const { supervisorApp } = await import("./index.js");
    let boot = "boot-1";
    let running = true;
    let failSetup = true;
    const commands: string[] = [];
    const container = {
      inspect: vi.fn(async () => ({
        Config: {
          Labels: { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" },
        },
        State: { Running: running, StartedAt: boot },
        HostConfig: { NetworkMode: computerNetworkNameFor("bot") },
        NetworkSettings: {
          Ports: { "6080/tcp": [{ HostIp: "127.0.0.1", HostPort: screenPort }] },
        },
      })),
      exec: vi.fn(async ({ Cmd }: { Cmd: string[] }) => {
        const command = Cmd.join(" ");
        commands.push(command);
        if (!running) throw new Error("container stopped");
        let code = 0;
        if (failSetup && command.includes("computer browser CDP not ready")) {
          failSetup = false;
          running = false;
          code = 1;
        }
        return { start: async () => Readable.from([]), inspect: async () => ({ ExitCode: code }) };
      }),
    };
    mocks.docker.getContainer.mockReturnValue(container);
    const view = () =>
      supervisorApp.request("/computers/failed-first-setup/screen-mode", {
        method: "POST",
        headers: {
          authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
          "content-type": "application/json",
          "x-rakazo-bot-id": "bot",
          "x-rakazo-space-id": "space",
          "x-rakazo-screen-id": "writer",
        },
        body: JSON.stringify({ interactive: false, revokeControl: false }),
      });
    const failed = await view();
    expect(failed.status).toBe(400);
    expect(await failed.json()).toEqual({ error: "container stopped" });
    const [registry, boots] = currentScreens.mock.calls.at(-1)!;
    const stale = registry.get("failed-first-setup");
    expect(stale?.get("writer")?.releasing).toBe(true);

    boot = "boot-2";
    running = true;
    expect((await view()).status).toBe(200);
    expect(registry.get("failed-first-setup")).not.toBe(stale);
    expect(registry.get("failed-first-setup")?.get("writer")).toMatchObject({ index: 0 });
    expect(boots.get("failed-first-setup")).toBe("boot-2");
    expect(
      commands.filter((command) => command.includes("for marker in /tmp/rakazo/browser-profile-*")),
    ).toHaveLength(2);
    expect((await view()).status).toBe(200);
    expect(
      commands.filter((command) => command.includes("for marker in /tmp/rakazo/browser-profile-*")),
    ).toHaveLength(2);
  });

  it.each([
    { phase: "reset", continuous: false },
    { phase: "reset", continuous: true },
    { phase: "ensure", continuous: false },
    { phase: "ensure", continuous: true },
  ])(
    "retries setup when the boot changes during $phase (continuous: $continuous)",
    async ({ phase, continuous }) => {
      const logic = await import("./supervisor-logic.js");
      const currentScreens = vi.spyOn(logic, "currentComputerScreens");
      const { supervisorApp } = await import("./index.js");
      let boot = 1;
      let restart = true;
      let claiming = true;
      const commands: string[] = [];
      const container = {
        inspect: vi.fn(async () => ({
          Config: {
            Labels: { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" },
          },
          HostConfig: { NetworkMode: computerNetworkNameFor("bot") },
          State: { Running: true, StartedAt: `boot-${boot}` },
          NetworkSettings: {
            Ports: { "6080/tcp": [{ HostIp: "127.0.0.1", HostPort: screenPort }] },
          },
        })),
        exec: vi.fn(async ({ Cmd }: { Cmd: string[] }) => {
          const command = Cmd.join(" ");
          // Reset starts without a registry; ensure has a pending marker for its inspected boot.
          if (claiming) {
            const [, boots] = currentScreens.mock.calls.at(-1)!;
            expect(boots.has("mid-claim")).toBe(
              !command.includes("for marker in /tmp/rakazo/browser-profile-*"),
            );
          }
          commands.push(command);
          const restartsDuringCommand =
            phase === "reset"
              ? command.includes("for marker in /tmp/rakazo/browser-profile-*")
              : command.includes("computer browser CDP not ready");
          if (restartsDuringCommand && restart) {
            boot += 1;
            restart = continuous;
          }
          return { start: async () => Readable.from([]), inspect: async () => ({ ExitCode: 0 }) };
        }),
      };
      mocks.docker.getContainer.mockReturnValue(container);
      const view = () =>
        supervisorApp.request("/computers/mid-claim/screen-mode", {
          method: "POST",
          headers: {
            authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
            "content-type": "application/json",
            "x-rakazo-bot-id": "bot",
            "x-rakazo-space-id": "space",
            "x-rakazo-screen-id": "writer",
          },
          body: JSON.stringify({ interactive: false, revokeControl: false }),
        });
      const response = await view();
      claiming = false;
      expect(response.status).toBe(continuous ? 400 : 200);
      expect(
        commands.filter((command) =>
          command.includes("for marker in /tmp/rakazo/browser-profile-*"),
        ).length,
      ).toBe(continuous ? 3 : 2);
      if (continuous) {
        expect(await response.json()).toEqual({ error: "computer restarted during screen setup" });
        restart = false;
      }
      const next = await view();
      expect(next.status).toBe(200);
      if (!continuous) expect(await next.json()).toEqual(await response.json());
      const resets = commands.filter((command) =>
        command.includes("for marker in /tmp/rakazo/browser-profile-*"),
      ).length;
      expect((await view()).status).toBe(200);
      expect(
        commands.filter((command) =>
          command.includes("for marker in /tmp/rakazo/browser-profile-*"),
        ).length,
      ).toBe(resets);
    },
  );

  it("waits for screen setup before replacing a container and clears its metadata", async () => {
    const logic = await import("./supervisor-logic.js");
    const clearRegistry = vi.spyOn(logic, "clearComputerScreenRegistry");
    const { supervisorApp } = await import("./index.js");
    const commands: string[] = [];
    let block = false;
    let signalBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => {
      signalBlocked = resolve;
    });
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const info = {
      Image: "old-image",
      Config: {
        User: hostComputerUser(),
        Labels: { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" },
      },
      HostConfig: { NetworkMode: computerNetworkNameFor("bot") },
      State: { Running: true, StartedAt: "boot-1" },
      NetworkSettings: { Ports: { "6080/tcp": [{ HostIp: "127.0.0.1", HostPort: screenPort }] } },
    };
    const existing = {
      id: "existing-screen",
      inspect: vi.fn().mockResolvedValue(info),
      remove: vi.fn().mockResolvedValue(undefined),
      exec: vi.fn(async ({ Cmd }: { Cmd: string[] }) => {
        commands.push(Cmd.join(" "));
        if (block) {
          block = false;
          signalBlocked();
          await gate;
        }
        return { start: async () => Readable.from([]), inspect: async () => ({ ExitCode: 0 }) };
      }),
    };
    mocks.docker.getContainer.mockReturnValue(existing);
    mocks.docker.listContainers.mockResolvedValue([{ Id: existing.id }]);
    mocks.docker.getImage.mockReturnValue({
      inspect: vi.fn().mockResolvedValue({ Id: "new-image" }),
    });
    mocks.docker.createContainer.mockResolvedValue({ id: "replacement", start: vi.fn() });
    mocks.docker.createNetwork.mockResolvedValue({});
    const headers = {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
      "x-rakazo-bot-id": "bot",
      "x-rakazo-space-id": "space",
    };
    const view = () =>
      supervisorApp.request("/computers/existing-screen/screen-mode", {
        method: "POST",
        headers,
        body: JSON.stringify({ interactive: false, revokeControl: false }),
      });
    expect((await view()).status).toBe(200);
    block = true;
    const claim = view();
    await blocked;
    const replacement = supervisorApp.request("/computers", {
      method: "POST",
      headers,
      body: JSON.stringify({
        botId: "bot",
        spaceId: "space",
        homePath: path.join(process.env.DATA_DIR!, "homes", "bot"),
      }),
    });
    await vi.waitFor(() => expect(mocks.docker.createNetwork).toHaveBeenCalled());
    expect(existing.remove).not.toHaveBeenCalled();
    unblock();
    expect((await claim).status).toBe(200);
    expect((await replacement).status).toBe(200);
    expect(existing.remove).toHaveBeenCalledWith({ force: true });
    const cleanup = clearRegistry.mock.calls.find(([, , id]) => id === existing.id);
    expect(cleanup).toBeDefined();
    const [registry, boots] = cleanup!;
    expect(registry.has(existing.id)).toBe(false);
    expect(boots.has(existing.id)).toBe(false);
    // Let the mock answer for the old ID to observe whether its registry was forgotten.
    const resets = commands.filter((command) =>
      command.includes("for marker in /tmp/rakazo/browser-profile-*"),
    ).length;
    expect((await view()).status).toBe(200);
    expect(
      commands.filter((command) => command.includes("for marker in /tmp/rakazo/browser-profile-*"))
        .length,
    ).toBe(resets + 1);
  });

  it.each(["POST", "DELETE"])(
    "re-inspects the boot after a queued %s screen request acquires the lock",
    async (method) => {
      const { supervisorApp } = await import("./index.js");
      const commands: string[] = [];
      let startedAt = "boot-1";
      let blockCommand = false;
      let signalBlocked!: () => void;
      const blocked = new Promise<void>((resolve) => {
        signalBlocked = resolve;
      });
      let unblock!: () => void;
      const gate = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      let signalQueued!: () => void;
      const queuedInspection = new Promise<void>((resolve) => {
        signalQueued = resolve;
      });
      let waitingForInspection = false;
      const container = {
        inspect: vi.fn(async () => {
          if (waitingForInspection) signalQueued();
          return {
            Config: {
              Labels: {
                "rakazo.managed": "true",
                "rakazo.botId": "bot",
                "rakazo.spaceId": "space",
              },
            },
            HostConfig: { NetworkMode: computerNetworkNameFor("bot") },
            State: { Running: true, StartedAt: startedAt },
            NetworkSettings: {
              Ports: { "6080/tcp": [{ HostIp: "127.0.0.1", HostPort: screenPort }] },
            },
          };
        }),
        exec: vi.fn(async ({ Cmd }: { Cmd: string[] }) => {
          commands.push(Cmd.join(" "));
          if (blockCommand) {
            blockCommand = false;
            signalBlocked();
            await gate;
          }
          return { start: async () => Readable.from([]), inspect: async () => ({ ExitCode: 0 }) };
        }),
      };
      mocks.docker.getContainer.mockReturnValue(container);
      const headers = {
        authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
        "content-type": "application/json",
        "x-rakazo-bot-id": "bot",
        "x-rakazo-space-id": "space",
        "x-rakazo-screen-id": "writer",
      };
      const view = (leaseId = "run-2:2") =>
        supervisorApp.request("/computers/restarted/screen-mode", {
          method: "POST",
          headers: { ...headers, "x-rakazo-screen-lease-id": leaseId },
          body: JSON.stringify({ interactive: false, revokeControl: false }),
        });
      const resets = () =>
        commands.filter((command) =>
          command.includes("for marker in /tmp/rakazo/browser-profile-*"),
        ).length;
      expect((await view()).status).toBe(200);
      blockCommand = true;
      const holder = view();
      await blocked;
      waitingForInspection = true;
      const queued =
        method === "POST"
          ? view()
          : supervisorApp.request("/computers/restarted/screen", {
              method: "DELETE",
              headers: { ...headers, "x-rakazo-screen-lease-id": "run-1:1" },
            });
      await queuedInspection;
      startedAt = "boot-2";
      unblock();
      const held = await holder;
      expect(held.status).toBe(200);
      const response = await queued;
      expect(response.status).toBe(200);
      if (method === "DELETE") {
        // A delayed release cannot invalidate the holder's new screen or token.
        const next = await view();
        expect(next.status).toBe(200);
        expect(await next.json()).toEqual(await held.json());
      } else {
        expect(resets()).toBe(2);
        const screen = await response.json();
        const next = await view();
        expect(next.status).toBe(200);
        // Reusing the registry preserves the screen's view token as well as its desktop.
        expect(await next.json()).toEqual(screen);
      }
      expect((await view()).status).toBe(200);
      expect(resets()).toBe(2);
      // A screen created in the new boot keeps its marker on later requests.
      expect((await view()).status).toBe(200);
      expect(resets()).toBe(2);
    },
  );

  it("does not reset the desktop when a screen is requested after the last one is released", async () => {
    const { supervisorApp } = await import("./index.js");
    const commands: string[] = [];
    const container = {
      inspect: vi.fn().mockResolvedValue({
        Config: {
          Labels: { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" },
        },
        HostConfig: { NetworkMode: computerNetworkNameFor("bot") },
        State: { Running: true },
        NetworkSettings: {
          Ports: { "6080/tcp": [{ HostIp: "127.0.0.1", HostPort: screenPort }] },
        },
      }),
      exec: vi.fn(async ({ Cmd }: { Cmd: string[] }) => {
        commands.push(Cmd.join(" "));
        return { start: async () => Readable.from([]), inspect: async () => ({ ExitCode: 0 }) };
      }),
    };
    mocks.docker.getContainer.mockReturnValue(container);
    const headers = {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
      "x-rakazo-bot-id": "bot",
      "x-rakazo-space-id": "space",
      "x-rakazo-screen-id": "writer",
    };
    const view = () =>
      supervisorApp.request("/computers/registry/screen-mode", {
        method: "POST",
        headers,
        body: JSON.stringify({ interactive: false, revokeControl: false }),
      });
    const resets = () =>
      commands.filter((command) => command.includes("for marker in /tmp/rakazo/browser-profile-*"))
        .length;

    expect((await view()).status).toBe(200);
    expect(resets()).toBe(1);
    const released = await supervisorApp.request("/computers/registry/screen", {
      method: "DELETE",
      headers: { ...headers, "x-rakazo-screen-lease-id": "run-1:1" },
    });
    expect(released.status).toBe(200);
    expect((await view()).status).toBe(200);
    // The first request after a supervisor start resets; a released screen must not.
    expect(resets()).toBe(1);
  });

  it("retains a completed Team screen, rejects stale release, and isolates peer screens", async () => {
    const { supervisorApp } = await import("./index.js");
    const commands: string[] = [];
    const container = {
      inspect: vi.fn().mockResolvedValue({
        Config: {
          Labels: { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" },
        },
        HostConfig: { NetworkMode: computerNetworkNameFor("bot") },
        State: { Running: true },
        NetworkSettings: {
          Ports: Object.fromEntries(
            [0, 1].map((index) => [
              `${screenPorts(index).viewPort}/tcp`,
              [{ HostIp: "127.0.0.1", HostPort: screenPort }],
            ]),
          ),
        },
      }),
      exec: vi.fn(async ({ Cmd }: { Cmd: string[] }) => {
        commands.push(Cmd.join(" "));
        return { start: async () => Readable.from([]), inspect: async () => ({ ExitCode: 0 }) };
      }),
    };
    mocks.docker.getContainer.mockReturnValue(container);
    const headersFor = (screenId: string, leaseId: string) => ({
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
      "x-rakazo-bot-id": "bot",
      "x-rakazo-space-id": "space",
      "x-rakazo-screen-id": screenId,
      "x-rakazo-screen-lease-id": leaseId,
    });
    const view = (screenId: string, leaseId: string) =>
      supervisorApp.request("/computers/registry/screen-mode", {
        method: "POST",
        headers: headersFor(screenId, leaseId),
        body: JSON.stringify({ interactive: false, revokeControl: false }),
      });

    const first = await view("writer", "run-1:1");
    const researcher = await view("researcher", "team-run:1");
    expect(first.status).toBe(200);
    expect(researcher.status).toBe(200);
    const firstScreenUrl = ((await first.json()) as { screenUrl: string }).screenUrl;
    const researcherScreenUrl = ((await researcher.json()) as { screenUrl: string }).screenUrl;
    expect(researcherScreenUrl).not.toBe(firstScreenUrl);

    const released = await supervisorApp.request("/computers/registry/screen", {
      method: "DELETE",
      headers: {
        ...headersFor("writer", "run-1:1"),
        "x-rakazo-preserve-screen": "1",
      },
    });
    expect(released.status).toBe(200);
    const releaseCommand = commands.at(-1) ?? "";
    expect(releaseCommand).toContain("control-1");
    expect(releaseCommand).not.toContain("view-1");
    expect(releaseCommand).not.toContain("Browser.close");

    const resumed = await view("writer", "run-2:2");
    expect(resumed.status).toBe(200);
    expect(((await resumed.json()) as { screenUrl: string }).screenUrl).toBe(firstScreenUrl);

    const commandCountBeforeStaleRelease = commands.length;
    const staleRelease = await supervisorApp.request("/computers/registry/screen", {
      method: "DELETE",
      headers: {
        ...headersFor("writer", "run-1:1"),
        "x-rakazo-preserve-screen": "1",
      },
    });
    expect(staleRelease.status).toBe(200);
    expect(commands).toHaveLength(commandCountBeforeStaleRelease);

    const cancelled = await supervisorApp.request("/computers/registry/screen", {
      method: "DELETE",
      headers: {
        ...headersFor("writer", "run-2:2"),
        "x-rakazo-preserve-screen": "1",
        "x-rakazo-cancel-run-work": "1",
      },
    });
    expect(cancelled.status).toBe(200);
    expect(commands.at(-1)).toContain("Browser.close");
    expect(commands.at(-1)).toContain("view-1");
    expect(commands.at(-1)).not.toContain("view-2");

    const peerStillOpen = await view("researcher", "team-run:1");
    expect(peerStillOpen.status).toBe(200);
    expect(((await peerStillOpen.json()) as { screenUrl: string }).screenUrl).toBe(
      researcherScreenUrl,
    );
  });

  it("evicts only the oldest idle Team screen when the screen limit is full", async () => {
    vi.stubEnv("SANDBOX_TEAM_SCREEN_LIMIT", "2");
    const { supervisorApp } = await import("./index.js");
    const commands: string[] = [];
    const container = {
      inspect: vi.fn().mockResolvedValue({
        Config: {
          Labels: { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" },
        },
        HostConfig: { NetworkMode: computerNetworkNameFor("bot") },
        State: { Running: true },
        NetworkSettings: {
          Ports: Object.fromEntries(
            [0, 1].map((index) => [
              `${screenPorts(index).viewPort}/tcp`,
              [{ HostIp: "127.0.0.1", HostPort: screenPort }],
            ]),
          ),
        },
      }),
      exec: vi.fn(async ({ Cmd }: { Cmd: string[] }) => {
        commands.push(Cmd.join(" "));
        return { start: async () => Readable.from([]), inspect: async () => ({ ExitCode: 0 }) };
      }),
    };
    mocks.docker.getContainer.mockReturnValue(container);
    const headersFor = (screenId: string, leaseId: string) => ({
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
      "x-rakazo-bot-id": "bot",
      "x-rakazo-space-id": "space",
      "x-rakazo-screen-id": screenId,
      "x-rakazo-screen-lease-id": leaseId,
    });
    const view = (screenId: string, leaseId: string) =>
      supervisorApp.request("/computers/registry/screen-mode", {
        method: "POST",
        headers: headersFor(screenId, leaseId),
        body: JSON.stringify({ interactive: false, revokeControl: false }),
      });

    const writer = await view("writer", "run-1:1");
    const researcher = await view("researcher", "team-run:1");
    const writerUrl = ((await writer.json()) as { screenUrl: string }).screenUrl;
    const researcherUrl = ((await researcher.json()) as { screenUrl: string }).screenUrl;
    const release = await supervisorApp.request("/computers/registry/screen", {
      method: "DELETE",
      headers: {
        ...headersFor("writer", "run-1:1"),
        "x-rakazo-preserve-screen": "1",
      },
    });
    expect(release.status).toBe(200);

    const newcomer = await view("newcomer", "team-run:2");
    expect(newcomer.status).toBe(200);
    expect(((await newcomer.json()) as { screenUrl: string }).screenUrl).not.toBe(writerUrl);
    const eviction = commands.filter((command) => command.includes("Browser.close")).at(-1) ?? "";
    expect(eviction).toContain("view-1");
    expect(eviction).not.toContain("view-2");

    const peerStillOpen = await view("researcher", "team-run:1");
    expect(((await peerStillOpen.json()) as { screenUrl: string }).screenUrl).toBe(researcherUrl);
  });
});

describe("computer network reclaim", () => {
  const botNet = computerNetworkNameFor("bot");
  const homePath = () => path.join(process.env.DATA_DIR!, "homes", "bot");
  const headers = {
    authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
    "x-rakazo-bot-id": "bot",
    "x-rakazo-space-id": "space",
  };

  function botNetwork(attached: string[] = []) {
    return {
      inspect: vi.fn().mockResolvedValue({
        Id: "net-current",
        Containers: Object.fromEntries(attached.map((id) => [id, {}])),
      }),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };
  }

  function computer() {
    let running = true;
    const container = {
      id: "computer",
      inspect: vi.fn(async () => ({
        Id: "computer-full-id",
        Config: {
          Labels: { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" },
        },
        State: { Running: running },
        // Docker keeps a stopped container's endpoint on its network.
        NetworkSettings: { Networks: { [botNet]: { NetworkID: "net-current" } } },
      })),
      exec: vi.fn(async () => ({
        start: async () => Readable.from([]),
        inspect: async () => ({ ExitCode: 0 }),
      })),
      stop: vi.fn(async () => {
        running = false;
      }),
    };
    mocks.docker.getContainer.mockReturnValue(container);
    networkUsers(["computer-full-id"]);
    return container;
  }

  // Containers listed by network, stopped ones included; webIds answers the
  // Compose web proxy lookup.
  function networkUsers(ids: string[], webIds: string[] = []) {
    mocks.docker.listContainers.mockImplementation(
      async ({ filters }: { filters: { network?: string[] } }) =>
        (filters.network ? ids : webIds).map((Id) => ({ Id })),
    );
  }

  async function stop() {
    const { supervisorApp } = await import("./index.js");
    return supervisorApp.request("/computers/computer/stop", { method: "POST", headers });
  }

  describe("on stop", () => {
    it("disconnects the stopped computer, then gives its network back to Docker", async () => {
      const container = computer();
      const network = botNetwork();
      mocks.docker.getNetwork.mockReturnValue(network);

      expect((await stop()).status).toBe(200);
      expect(mocks.docker.getNetwork).toHaveBeenCalledWith(botNet);
      expect(network.disconnect).toHaveBeenCalledExactlyOnceWith({
        Container: "computer-full-id",
      });
      expect(network.remove).toHaveBeenCalledExactlyOnceWith();
      expect(container.stop.mock.invocationCallOrder[0]).toBeLessThan(
        network.disconnect.mock.invocationCallOrder[0]!,
      );
      expect(network.disconnect.mock.invocationCallOrder[0]).toBeLessThan(
        network.remove.mock.invocationCallOrder[0]!,
      );
    });

    it("reclaims a network created before networks carried an owner label", async () => {
      computer();
      const network = botNetwork();
      // Ownership comes from the computer's identity, not from network labels.
      network.inspect.mockResolvedValue({ Id: "net-legacy", Labels: {}, Containers: {} });
      mocks.docker.getNetwork.mockReturnValue(network);

      expect((await stop()).status).toBe(200);
      expect(network.remove).toHaveBeenCalledOnce();
    });

    it("disconnects the Compose screen peers of an isolated computer network", async () => {
      vi.stubEnv("SANDBOX_SCREEN_NETWORK", "isolated");
      vi.stubEnv("HOSTNAME", "supervisor");
      const container = computer();
      const supervisor = {
        inspect: vi.fn().mockResolvedValue({
          Id: "supervisor-id",
          Config: { Labels: { "com.docker.compose.project": "example" } },
        }),
      };
      mocks.docker.getContainer.mockImplementation((id: string) =>
        id === "supervisor" ? supervisor : container,
      );
      networkUsers(["supervisor-id", "computer-full-id", "web-id"], ["web-id"]);
      // The web proxy is stopped, so network inspect lists only the supervisor. Left
      // attached, it could not start again once the network is gone.
      const network = botNetwork(["supervisor-id"]);
      mocks.docker.getNetwork.mockReturnValue(network);

      expect((await stop()).status).toBe(200);
      expect(mocks.docker.listContainers).toHaveBeenCalledWith({
        all: true,
        filters: { network: [botNet] },
      });
      expect(mocks.docker.listContainers).toHaveBeenCalledWith({
        all: true,
        filters: {
          label: ["com.docker.compose.project=example", "com.docker.compose.service=web"],
        },
      });
      expect(network.disconnect.mock.calls).toEqual([
        [{ Container: "computer-full-id" }],
        [{ Container: "supervisor-id" }],
        [{ Container: "web-id" }],
      ]);
      expect(network.remove).toHaveBeenCalledOnce();
    });

    it("keeps the network when a screen peer cannot be disconnected from it", async () => {
      vi.stubEnv("SANDBOX_SCREEN_NETWORK", "isolated");
      vi.stubEnv("HOSTNAME", "supervisor");
      const container = computer();
      const supervisor = {
        inspect: vi.fn().mockResolvedValue({ Id: "supervisor-id", Config: { Labels: {} } }),
      };
      mocks.docker.getContainer.mockImplementation((id: string) =>
        id === "supervisor" ? supervisor : container,
      );
      networkUsers(["computer-full-id", "supervisor-id"]);
      const network = botNetwork();
      network.disconnect.mockImplementation(async ({ Container }: { Container: string }) => {
        if (Container === "supervisor-id") throw new Error("disconnect failed");
      });
      mocks.docker.getNetwork.mockReturnValue(network);

      expect((await stop()).status).toBe(200);
      expect(network.remove).not.toHaveBeenCalled();
    });

    it.each([
      ["running", ["another-container"]],
      ["stopped", []],
    ])(
      "keeps a network that a %s container other than a screen peer uses",
      async (_state, running) => {
        computer();
        networkUsers(["computer-full-id", "another-container"]);
        const network = botNetwork(running);
        mocks.docker.getNetwork.mockReturnValue(network);

        expect((await stop()).status).toBe(200);
        expect(network.disconnect).not.toHaveBeenCalled();
        expect(network.remove).not.toHaveBeenCalled();
      },
    );

    it("keeps the network when the computer cannot be disconnected from it", async () => {
      computer();
      const network = botNetwork();
      network.disconnect.mockRejectedValue(new Error("disconnect failed"));
      mocks.docker.getNetwork.mockReturnValue(network);

      expect((await stop()).status).toBe(200);
      expect(network.remove).not.toHaveBeenCalled();
    });

    it.each([
      ["logs", new Error("permission denied"), true],
      ["does not log", new Error("network example has active endpoints"), false],
    ])("%s a failed removal without failing the stop: %s", async (_case, error, logged) => {
      computer();
      const network = botNetwork();
      network.remove.mockRejectedValue(error);
      mocks.docker.getNetwork.mockReturnValue(network);
      const { getLogger } = await import("@rakazo/logging");
      const logError = vi.spyOn(getLogger(), "error").mockImplementation(() => undefined);

      expect((await stop()).status).toBe(200);
      if (logged) {
        expect(logError).toHaveBeenCalledWith("computer network reclaim failed", error);
      } else {
        expect(logError).not.toHaveBeenCalled();
      }
    });

    it("does not touch the shared internal network", async () => {
      vi.stubEnv("SANDBOX_SCREEN_NETWORK", "internal");
      computer();
      mocks.docker.getNetwork.mockReturnValue(botNetwork());

      expect((await stop()).status).toBe(200);
      expect(mocks.docker.getNetwork).not.toHaveBeenCalled();
    });

    it("does not reclaim the network of a computer that failed to stop", async () => {
      const container = computer();
      container.stop.mockRejectedValue(new Error("stop failed"));
      mocks.docker.getNetwork.mockReturnValue(botNetwork());

      expect((await stop()).status).toBe(500);
      expect(mocks.docker.getNetwork).not.toHaveBeenCalled();
    });

    it("waits for an in-flight provision of the same bot before reclaiming", async () => {
      const { supervisorApp } = await import("./index.js");
      computer();
      const network = botNetwork();
      mocks.docker.getNetwork.mockReturnValue(network);
      mocks.docker.getImage.mockReturnValue({
        inspect: vi.fn().mockResolvedValue({ Id: "image" }),
      });
      mocks.docker.listContainers.mockResolvedValue([]);
      mocks.docker.createNetwork.mockResolvedValue(network);
      let attach!: () => void;
      const attached = new Promise<void>((resolve) => {
        attach = resolve;
      });
      mocks.docker.createContainer.mockImplementation(async () => {
        await attached;
        return { id: "replacement", start: vi.fn().mockResolvedValue(undefined) };
      });
      const provision = supervisorApp.request("/computers", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ botId: "bot", spaceId: "space", homePath: homePath() }),
      });
      await vi.waitFor(() => expect(mocks.docker.createContainer).toHaveBeenCalled());

      const stopped = stop();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(network.inspect).not.toHaveBeenCalled();
      attach();
      expect((await provision).status).toBe(200);
      expect((await stopped).status).toBe(200);
      expect(network.inspect).toHaveBeenCalled();
    });
  });

  it("disconnects a stopped screen peer when the computer is deleted", async () => {
    vi.stubEnv("SANDBOX_SCREEN_NETWORK", "isolated");
    vi.stubEnv("HOSTNAME", "supervisor");
    const container = Object.assign(computer(), { remove: vi.fn().mockResolvedValue(undefined) });
    const supervisor = {
      inspect: vi.fn().mockResolvedValue({
        Id: "supervisor-id",
        Config: { Labels: { "com.docker.compose.project": "example" } },
      }),
    };
    mocks.docker.getContainer.mockImplementation((id: string) =>
      id === "supervisor" ? supervisor : container,
    );
    networkUsers(["supervisor-id", "web-id"], ["web-id"]);
    // The web proxy is stopped, so network inspect lists only the supervisor.
    const network = botNetwork(["supervisor-id"]);
    mocks.docker.getNetwork.mockImplementation((name: string) =>
      name === botNet
        ? network
        : { inspect: vi.fn().mockRejectedValue(new Error("no such network")) },
    );
    const { supervisorApp } = await import("./index.js");

    const response = await supervisorApp.request("/computers/computer", {
      method: "DELETE",
      headers,
    });
    expect(response.status).toBe(200);
    expect(container.remove).toHaveBeenCalledWith({ force: true });
    expect(network.disconnect.mock.calls).toEqual([
      [{ Container: "supervisor-id" }],
      [{ Container: "web-id" }],
    ]);
    expect(network.remove).toHaveBeenCalledOnce();
  });

  describe("on startup", () => {
    async function reclaim() {
      const { reclaimIdleComputerNetworks } = await import("./networks.js");
      return reclaimIdleComputerNetworks();
    }

    function ownerLabel() {
      return computerNetworkOwnerFor(process.env.DATA_DIR!, undefined);
    }

    it("removes only its own labeled networks that no container uses", async () => {
      const networks: Record<string, ReturnType<typeof botNetwork>> = {
        [computerNetworkNameFor("orphan")]: botNetwork(),
        [computerNetworkNameFor("stopped")]: botNetwork(),
        [computerNetworkNameFor("renamed")]: botNetwork(),
      };
      mocks.docker.listNetworks.mockResolvedValue([
        { Name: computerNetworkNameFor("orphan"), Labels: { "rakazo.botId": "orphan" } },
        { Name: computerNetworkNameFor("stopped"), Labels: { "rakazo.botId": "stopped" } },
        // The bot label must name the network, since it picks the lock.
        { Name: computerNetworkNameFor("renamed"), Labels: { "rakazo.botId": "other" } },
      ]);
      mocks.docker.getNetwork.mockImplementation((name: string) => networks[name]);
      mocks.docker.listContainers.mockImplementation(
        async ({ filters }: { filters: { network: string[] } }) =>
          // A stopped computer still uses its network, though network inspect omits it.
          filters.network[0] === computerNetworkNameFor("stopped") ? [{ Id: "stopped-id" }] : [],
      );

      await reclaim();
      expect(mocks.docker.listNetworks).toHaveBeenCalledWith({
        filters: { label: [`rakazo.computerOwner=${ownerLabel()}`] },
      });
      expect(mocks.docker.listContainers).toHaveBeenCalledWith({
        all: true,
        filters: { network: [computerNetworkNameFor("orphan")] },
      });
      expect(networks[computerNetworkNameFor("orphan")]!.remove).toHaveBeenCalledOnce();
      expect(networks[computerNetworkNameFor("stopped")]!.remove).not.toHaveBeenCalled();
      expect(networks[computerNetworkNameFor("stopped")]!.disconnect).not.toHaveBeenCalled();
      expect(mocks.docker.getNetwork).not.toHaveBeenCalledWith(computerNetworkNameFor("renamed"));
    });

    it("disconnects the Compose screen peers from an orphaned isolated network", async () => {
      vi.stubEnv("SANDBOX_SCREEN_NETWORK", "isolated");
      vi.stubEnv("HOSTNAME", "supervisor");
      mocks.docker.getContainer.mockReturnValue({
        inspect: vi.fn().mockResolvedValue({
          Id: "supervisor-id",
          Config: { Labels: { "com.docker.compose.project": "example" } },
          Mounts: [],
        }),
      });
      const network = botNetwork();
      mocks.docker.getNetwork.mockReturnValue(network);
      mocks.docker.listNetworks.mockResolvedValue([
        { Name: botNet, Labels: { "rakazo.botId": "bot" } },
      ]);
      mocks.docker.listContainers.mockImplementation(
        async ({ filters }: { filters: { network?: string[] } }) =>
          filters.network ? [{ Id: "supervisor-id" }, { Id: "web-id" }] : [{ Id: "web-id" }],
      );

      await reclaim();
      expect(network.disconnect.mock.calls).toEqual([
        [{ Container: "supervisor-id" }],
        [{ Container: "web-id" }],
      ]);
      expect(network.remove).toHaveBeenCalledOnce();
    });

    it("does nothing in the shared internal topology", async () => {
      vi.stubEnv("SANDBOX_SCREEN_NETWORK", "internal");
      await reclaim();
      expect(mocks.docker.listNetworks).not.toHaveBeenCalled();
      expect(mocks.docker.getNetwork).not.toHaveBeenCalled();
    });
  });

  describe("resuming a stopped computer", () => {
    function stoppedComputer(networks: Record<string, { NetworkID: string }>) {
      const info = {
        Image: "image",
        Config: {
          User: hostComputerUser(),
          Labels: { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" },
        },
        HostConfig: { NetworkMode: botNet, PortBindings: {} },
        State: { Running: false },
        NetworkSettings: { Networks: networks },
      };
      const existing = {
        id: "existing",
        inspect: vi.fn().mockResolvedValue(info),
        start: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      };
      const replacement = { id: "replacement", start: vi.fn().mockResolvedValue(undefined) };
      mocks.docker.getImage.mockReturnValue({
        inspect: vi.fn().mockResolvedValue({ Id: "image" }),
      });
      mocks.docker.getContainer.mockReturnValue(existing);
      mocks.docker.listContainers.mockResolvedValue([{ Id: existing.id }]);
      mocks.docker.createNetwork.mockResolvedValue({ remove: vi.fn() });
      mocks.docker.createContainer.mockResolvedValue(replacement);
      return { existing, replacement };
    }

    async function provision() {
      const { supervisorApp } = await import("./index.js");
      return supervisorApp.request("/computers", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ botId: "bot", spaceId: "space", homePath: homePath() }),
      });
    }

    function expectReconnected(
      existing: { start: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> },
      network: ReturnType<typeof botNetwork>,
    ) {
      expect(network.connect).toHaveBeenCalledExactlyOnceWith({ Container: "existing" });
      expect(existing.start).toHaveBeenCalledOnce();
      expect(network.connect.mock.invocationCallOrder[0]).toBeLessThan(
        existing.start.mock.invocationCallOrder[0]!,
      );
      expect(existing.remove).not.toHaveBeenCalled();
      expect(mocks.docker.createContainer).not.toHaveBeenCalled();
    }

    it.each(["open", "restricted"])(
      "recreates a reclaimed network and reconnects the same container (%s egress)",
      async (egress) => {
        vi.stubEnv("SANDBOX_COMPUTER_EGRESS", egress);
        const { existing } = stoppedComputer({});
        const network = botNetwork();
        network.inspect.mockRejectedValue(
          Object.assign(new Error("no such network"), { statusCode: 404 }),
        );
        mocks.docker.getNetwork.mockReturnValue(network);

        const response = await provision();
        expect(await response.json()).toMatchObject({ id: "existing", resumed: true });
        expect(mocks.docker.createNetwork).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            Name: botNet,
            Labels: {
              "rakazo.computerOwner": computerNetworkOwnerFor(process.env.DATA_DIR!, undefined),
              "rakazo.botId": "bot",
            },
            ...(egress === "restricted"
              ? { Options: { "com.docker.network.bridge.name": computerBridgeNameFor("bot") } }
              : {}),
          }),
        );
        expect(network.disconnect).not.toHaveBeenCalled();
        expectReconnected(existing, network);
      },
    );

    it("tries IPv6 again when it recreates the reclaimed network after an IPv4 fallback", async () => {
      const { existing } = stoppedComputer({});
      const network = botNetwork();
      network.inspect.mockRejectedValue(
        Object.assign(new Error("no such network"), { statusCode: 404 }),
      );
      mocks.docker.getNetwork.mockReturnValue(network);
      mocks.docker.createNetwork
        .mockRejectedValueOnce(
          new Error(
            "could not find an available, non-overlapping IPv6 address pool among the defaults to assign to the network",
          ),
        )
        .mockResolvedValueOnce({ remove: vi.fn() });

      const response = await provision();
      expect(await response.json()).toMatchObject({ id: "existing", resumed: true });
      // A stop gave this network back, so its recreation starts from the
      // dual-stack attempt again; only the create error falls back to IPv4.
      expect(mocks.docker.createNetwork).toHaveBeenCalledTimes(2);
      const [dualStack, ipv4Only] = mocks.docker.createNetwork.mock.calls;
      expect(dualStack?.[0].EnableIPv6).toBe(true);
      expect(ipv4Only?.[0]).not.toHaveProperty("EnableIPv6");
      expectReconnected(existing, network);
    });

    it("gives back an IPv4-only network a crash left behind, then retries IPv6 on resume", async () => {
      // Phase 1: a fresh provision falls back to IPv4 (the daemon has no IPv6 pool).
      const fresh = {
        id: "new-computer",
        start: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      };
      mocks.docker.getImage.mockReturnValue({
        inspect: vi.fn().mockResolvedValue({ Id: "image" }),
      });
      mocks.docker.listContainers.mockResolvedValue([]);
      mocks.docker.createNetwork
        .mockRejectedValueOnce(
          new Error(
            "could not find an available, non-overlapping IPv6 address pool among the defaults to assign to the network",
          ),
        )
        .mockResolvedValueOnce({ remove: vi.fn() });
      mocks.docker.createContainer.mockResolvedValue(fresh);
      expect((await provision()).status).toBe(200);

      // Phase 2: a crash without /stop leaves the stopped container on the
      // IPv4-only network; startup cleanup keeps it (a stopped computer still
      // references the network).
      const existing = {
        id: "existing",
        inspect: vi.fn().mockResolvedValue({
          Image: "image",
          Config: {
            User: hostComputerUser(),
            Labels: { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" },
          },
          HostConfig: { NetworkMode: botNet, PortBindings: {} },
          State: { Running: false },
          NetworkSettings: { Networks: { [botNet]: { NetworkID: "net-v4" } } },
        }),
        start: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      };
      let v4Gone = false;
      const network = {
        inspect: vi.fn(() =>
          v4Gone
            ? Promise.reject(Object.assign(new Error("no such network"), { statusCode: 404 }))
            : Promise.resolve({ Id: "net-v4", EnableIPv6: false }),
        ),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn(() => {
          v4Gone = true;
          return Promise.resolve(undefined);
        }),
      };
      mocks.docker.getContainer.mockReturnValue(existing);
      mocks.docker.getNetwork.mockReturnValue(network);
      mocks.docker.listContainers.mockReset().mockResolvedValue([{ Id: existing.id }]);
      const { reclaimIdleComputerNetworks } = await import("./networks.js");
      mocks.docker.listNetworks.mockResolvedValue([
        {
          Name: botNet,
          Labels: {
            "rakazo.computerOwner": computerNetworkOwnerFor(process.env.DATA_DIR!, undefined),
            "rakazo.botId": "bot",
          },
        },
      ]);
      await reclaimIdleComputerNetworks();
      expect(network.remove).not.toHaveBeenCalled();

      // Phase 3: the resume must hand the IPv4-only network back and retry
      // IPv6-first, rejoining the same container.
      const createsBefore = mocks.docker.createContainer.mock.calls.length;
      mocks.docker.createNetwork.mockReset().mockResolvedValue({ remove: vi.fn() });
      const response = await provision();
      expect(await response.json()).toMatchObject({ id: "existing", resumed: true, started: true });
      expect(network.remove).toHaveBeenCalledOnce();
      expect(mocks.docker.createNetwork).toHaveBeenCalledTimes(1);
      expect(mocks.docker.createNetwork.mock.calls[0]?.[0].EnableIPv6).toBe(true);
      expect(network.connect).toHaveBeenCalledWith({ Container: existing.id });
      expect(existing.start).toHaveBeenCalledOnce();
      expect(mocks.docker.createContainer.mock.calls.length).toBe(createsBefore);
    });

    it("reconnects the computer when a failed cleanup left it off its IPv4-only network", async () => {
      // The crash leaves the stopped computer on the IPv4-only fallback network.
      // The resume's cleanup disconnects the computer but cannot remove the
      // network, so the resume must rejoin it before starting.
      let detached = false;
      const existing = {
        id: "existing",
        inspect: vi.fn(() =>
          Promise.resolve({
            Image: "image",
            Config: {
              User: hostComputerUser(),
              Labels: {
                "rakazo.managed": "true",
                "rakazo.botId": "bot",
                "rakazo.spaceId": "space",
              },
            },
            HostConfig: { NetworkMode: botNet, PortBindings: {} },
            State: { Running: false },
            NetworkSettings: {
              Networks: detached ? {} : { [botNet]: { NetworkID: "net-v4" } },
            },
          }),
        ),
        start: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      };
      const network = {
        inspect: vi.fn().mockResolvedValue({ Id: "net-v4", EnableIPv6: false }),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn(async ({ Container }: { Container: string }) => {
          if (Container === existing.id) detached = true;
        }),
        remove: vi.fn().mockRejectedValue(new Error("network has active endpoints elsewhere")),
      };
      mocks.docker.getImage.mockReturnValue({
        inspect: vi.fn().mockResolvedValue({ Id: "image" }),
      });
      mocks.docker.getContainer.mockReturnValue(existing);
      mocks.docker.getNetwork.mockReturnValue(network);
      mocks.docker.listContainers.mockResolvedValue([{ Id: existing.id }]);
      mocks.docker.createNetwork.mockResolvedValue({ remove: vi.fn() });

      const response = await provision();
      expect(await response.json()).toMatchObject({ id: "existing", resumed: true, started: true });
      expect(network.remove).toHaveBeenCalledOnce();
      expect(network.connect).toHaveBeenCalledExactlyOnceWith({ Container: existing.id });
      expect(existing.start).toHaveBeenCalledOnce();
    });

    it.each([
      ["removed", Object.assign(new Error("no such network"), { statusCode: 404 })],
      ["recreated", undefined],
    ])("moves a stale endpoint onto the network when it was %s under it", async (_case, error) => {
      const { existing } = stoppedComputer({ [botNet]: { NetworkID: "net-old" } });
      const network = botNetwork();
      if (error) network.inspect.mockRejectedValue(error);
      mocks.docker.getNetwork.mockReturnValue(network);

      const response = await provision();
      expect(await response.json()).toMatchObject({ id: "existing", resumed: true });
      expect(network.disconnect).toHaveBeenCalledWith({ Container: "existing", Force: true });
      expect(network.disconnect.mock.invocationCallOrder[0]).toBeLessThan(
        network.connect.mock.invocationCallOrder[0]!,
      );
      expectReconnected(existing, network);
    });

    it("restarts it without reconnecting while its endpoint is on the current network", async () => {
      const { existing } = stoppedComputer({ [botNet]: { NetworkID: "net-current" } });
      const network = botNetwork();
      mocks.docker.getNetwork.mockReturnValue(network);

      const response = await provision();
      expect(await response.json()).toMatchObject({ id: "existing", resumed: true });
      expect(existing.start).toHaveBeenCalledOnce();
      expect(network.connect).not.toHaveBeenCalled();
      expect(mocks.docker.createNetwork).not.toHaveBeenCalled();
    });

    it.each([
      ["a leftover endpoint", new Error("endpoint with name rakazo-bot-bot already exists")],
      ["a missing container", Object.assign(new Error("no such container"), { statusCode: 404 })],
    ])(
      "replaces it, never starting it unattached, when Docker refuses to attach it: %s",
      async (_case, error) => {
        const { existing, replacement } = stoppedComputer({});
        const network = botNetwork();
        network.connect.mockRejectedValue(error);
        mocks.docker.getNetwork.mockReturnValue(network);

        const response = await provision();
        expect(await response.json()).toMatchObject({ id: "replacement", resumed: false });
        expect(existing.start).not.toHaveBeenCalled();
        expect(existing.remove).toHaveBeenCalledWith({ force: true });
        expect(replacement.start).toHaveBeenCalledOnce();
      },
    );

    it("keeps it when its network cannot be recreated", async () => {
      const { existing } = stoppedComputer({});
      mocks.docker.getNetwork.mockReturnValue(botNetwork());
      mocks.docker.createNetwork.mockRejectedValue(new Error("address pools exhausted"));

      const response = await provision();
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "address pools exhausted" });
      expect(existing.start).not.toHaveBeenCalled();
      expect(existing.remove).not.toHaveBeenCalled();
    });

    it("keeps it through a transient failure that a retry would get past", async () => {
      const { existing } = stoppedComputer({});
      mocks.docker.getNetwork.mockReturnValue(botNetwork());
      // Only the first create fails, so falling through to the replace path's
      // own create would succeed and remove this container.
      mocks.docker.createNetwork
        .mockRejectedValueOnce(new Error("daemon busy"))
        .mockResolvedValue({ remove: vi.fn() });

      const response = await provision();
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "daemon busy" });
      expect(mocks.docker.createNetwork).toHaveBeenCalledOnce();
      expect(existing.start).not.toHaveBeenCalled();
      expect(existing.remove).not.toHaveBeenCalled();
      expect(mocks.docker.createContainer).not.toHaveBeenCalled();
    });

    it.each([
      [
        "fails transiently and keeps it",
        Object.assign(new Error("daemon busy"), { statusCode: 500 }),
        false,
      ],
      [
        "is already gone and reconnects it",
        new Error("container is not connected to the network"),
        true,
      ],
    ])("when clearing a stale endpoint %s", async (_case, error, resumed) => {
      const { existing } = stoppedComputer({ [botNet]: { NetworkID: "net-old" } });
      const network = botNetwork();
      network.disconnect.mockRejectedValue(error);
      mocks.docker.getNetwork.mockReturnValue(network);

      const response = await provision();
      if (resumed) {
        expect(await response.json()).toMatchObject({ id: "existing", resumed: true });
        expect(network.connect).toHaveBeenCalledOnce();
      } else {
        expect(response.status).toBe(500);
        expect(network.connect).not.toHaveBeenCalled();
        expect(existing.start).not.toHaveBeenCalled();
      }
      expect(existing.remove).not.toHaveBeenCalled();
      expect(mocks.docker.createContainer).not.toHaveBeenCalled();
    });

    it("keeps it when attaching it fails transiently", async () => {
      const { existing } = stoppedComputer({});
      const network = botNetwork();
      network.connect.mockRejectedValue(
        Object.assign(new Error("daemon busy"), { statusCode: 500 }),
      );
      mocks.docker.getNetwork.mockReturnValue(network);

      const response = await provision();
      expect(response.status).toBe(500);
      expect(existing.start).not.toHaveBeenCalled();
      expect(existing.remove).not.toHaveBeenCalled();
      expect(mocks.docker.createContainer).not.toHaveBeenCalled();
    });

    it("surfaces a transient network inspect failure instead of replacing it", async () => {
      const { existing } = stoppedComputer({ [botNet]: { NetworkID: "net-current" } });
      const network = botNetwork();
      network.inspect.mockRejectedValue(new Error("daemon unavailable"));
      mocks.docker.getNetwork.mockReturnValue(network);

      expect((await provision()).status).toBe(500);
      expect(existing.start).not.toHaveBeenCalled();
      expect(existing.remove).not.toHaveBeenCalled();
    });
  });
});
