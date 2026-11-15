import type * as NodeHttp from "node:http";
import { Readable } from "node:stream";
import { resolveSupervisorToken } from "@rakazo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  version: vi.fn(),
  getContainer: vi.fn(),
  listContainers: vi.fn(),
  getNetwork: vi.fn(),
}));
vi.mock("dockerode", () => ({
  default: class {
    version = mocks.version;
    getContainer = mocks.getContainer;
    listContainers = mocks.listContainers;
    getNetwork = mocks.getNetwork;
  },
}));
vi.mock("node:http", async (original) => {
  const http = await original<typeof NodeHttp>();
  return {
    ...http,
    default: {
      ...http,
      get: vi.fn((_options, callback) => {
        callback({ statusCode: 200, resume() {} });
        return {
          once() {
            return this;
          },
          destroy() {},
        };
      }),
    },
  };
});

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.version.mockReset();
  vi.stubEnv("HOSTNAME", "supervisor-host");
  vi.stubEnv("SANDBOX_SCREEN_NETWORK", "isolated");
});
afterEach(() => vi.unstubAllEnvs());

function fixture() {
  // The bot network remembers its members, like Docker, so an idempotent rejoin
  // only connects peers that are actually missing.
  const members = new Set<string>();
  const connect = vi.fn(async (options: { Container: string }) => {
    members.add(options.Container);
  });
  const container = {
    inspect: vi.fn().mockResolvedValue({
      Id: "computer",
      Config: {
        Labels: { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" },
      },
      HostConfig: { NetworkMode: "bot-network" },
      State: { Running: true },
      NetworkSettings: { Networks: { "bot-network": { IPAddress: "172.28.0.2" } } },
    }),
    exec: vi.fn(async (options: { Cmd: string[] }) => ({
      start: async () => Readable.from(options.Cmd[1] === "-lc" ? ["GEOM 1 1\nIMAGE AQID\n"] : []),
      inspect: async () => ({ ExitCode: 0 }),
    })),
  };
  const supervisor = {
    inspect: vi.fn().mockResolvedValue({
      Id: "supervisor-peer",
      Config: { Labels: { "com.docker.compose.project": "example" } },
    }),
  };
  mocks.getContainer.mockImplementation((id: string) =>
    id === "supervisor-host" ? supervisor : container,
  );
  mocks.listContainers.mockResolvedValue([{ Id: "web-peer" }]);
  mocks.getNetwork.mockReturnValue({
    inspect: vi.fn(async () => ({
      Containers: Object.fromEntries([...members].map((id) => [id, {}])),
    })),
    connect,
  });
  return { connect, members };
}

async function observe() {
  const { supervisorApp } = await import("./index.js");
  return supervisorApp.request("/computers/computer/observe", {
    method: "POST",
    headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "x-rakazo-bot-id": "bot",
      "x-rakazo-space-id": "space",
      "x-rakazo-screen-id": "writer",
    },
  });
}

async function openScreen() {
  const { supervisorApp } = await import("./index.js");
  return supervisorApp.request("/computers/computer/screen-mode", {
    method: "POST",
    headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
      "x-rakazo-bot-id": "bot",
      "x-rakazo-space-id": "space",
      "x-rakazo-screen-id": "writer",
    },
    body: JSON.stringify({ interactive: false }),
  });
}

describe("isolated screen peer gateway priority through the supervisor route", () => {
  it.each([
    ["1.45", false],
    ["1.47", false],
    ["invalid", false],
    ["1.48", true],
    ["1.55", true],
    ["2.0", true],
  ] as const)(
    "network.connect for Docker API %s includes GwPriority -1 only when supported (%s)",
    async (version, supportsPriority) => {
      const { connect } = fixture();
      mocks.version.mockResolvedValue({ ApiVersion: version });
      const response = await openScreen();
      expect(response.status).toBe(200);
      const payload = (containerId: string) =>
        supportsPriority
          ? { Container: containerId, EndpointConfig: { GwPriority: -1 } }
          : { Container: containerId };
      expect(connect).toHaveBeenCalledTimes(2);
      expect(connect).toHaveBeenCalledWith(payload("supervisor-peer"));
      expect(connect).toHaveBeenCalledWith(payload("web-peer"));
    },
  );

  it("rejoins the computer network on use after the supervisor container is recreated", async () => {
    const { connect, members } = fixture();
    mocks.version.mockResolvedValue({ ApiVersion: "1.45" });
    expect((await openScreen()).status).toBe(200);
    // A recreated supervisor container is a new container: Docker drops it from
    // every network except the Compose one, and the screen registry is gone.
    members.clear();
    vi.resetModules();
    connect.mockClear();
    expect((await observe()).status).toBe(200);
    expect(connect).toHaveBeenCalledWith({ Container: "supervisor-peer" });
    expect(connect).toHaveBeenCalledWith({ Container: "web-peer" });
  });

  it("keeps observing when rejoining the computer network fails", async () => {
    const { connect, members } = fixture();
    members.add("supervisor-peer");
    connect.mockRejectedValueOnce(new Error("peer disappeared before connect"));

    const response = await observe();

    expect(connect).toHaveBeenCalledWith({ Container: "web-peer" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ image: "AQID", width: 1, height: 1 });
  });

  it("keeps opening screens after a failed version lookup and retries discovery later", async () => {
    const { connect, members } = fixture();
    mocks.version
      .mockRejectedValueOnce(new Error("version temporarily unavailable"))
      .mockResolvedValue({ ApiVersion: "1.48" });
    expect((await openScreen()).status).toBe(200);
    expect(connect).toHaveBeenCalledWith({ Container: "web-peer" });
    expect(connect).toHaveBeenCalledWith({ Container: "supervisor-peer" });
    connect.mockClear();
    // Peers left the network, so the next screen has to join them again.
    members.clear();
    expect((await openScreen()).status).toBe(200);
    expect(mocks.version).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledWith({
      Container: "web-peer",
      EndpointConfig: { GwPriority: -1 },
    });
    expect(connect).toHaveBeenCalledWith({
      Container: "supervisor-peer",
      EndpointConfig: { GwPriority: -1 },
    });
  });
});
