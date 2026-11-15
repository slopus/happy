import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { USER_DEVICE_CONNECT_PATH } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { HostComputerRequest } from "./host-computer-protocol.js";
import type { UserDeviceSocket } from "./user-device-gateway.js";
import {
  createUserDeviceToken,
  hashUserDeviceToken,
  USER_DEVICE_FORWARD_PATH,
  USER_DEVICE_OFFLINE_MESSAGE,
  UserDeviceHub,
  UserDevices,
  userDeviceBearer,
  userDeviceForwardBody,
  userDeviceForwardSecret,
  userDeviceInternalAddress,
  validUserDeviceForwardSecret,
} from "./user-device-gateway.js";

interface DeviceRow {
  id: string;
  userId: string;
  name: string;
  platform: string;
  tokenHash: string;
  createdAt?: Date;
  revokedAt: Date | null;
  lastSeenAt: Date | null;
}
interface ConnectionRow {
  deviceId: string;
  connectionId: string;
  address: string;
  connectedAt: Date;
  heartbeatAt: Date;
}

/** The handful of Prisma calls the hub and gateway make, over two in-memory tables. */
function fakePrisma() {
  const devices = new Map<string, DeviceRow>();
  const connections = new Map<string, ConnectionRow>();
  const ids = (where: { id?: { in: string[] } | string }) =>
    typeof where.id === "string" ? [where.id] : (where.id?.in ?? [...devices.keys()]);
  const prisma = {
    userDevice: {
      findUnique: async ({ where }: { where: { tokenHash: string } }) =>
        [...devices.values()].find((row) => row.tokenHash === where.tokenHash) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Partial<DeviceRow> }) =>
        Object.assign(devices.get(where.id)!, data),
      updateMany: async ({ where, data }: { where: { id: { in: string[] } }; data: object }) => {
        for (const id of ids(where)) if (devices.has(id)) Object.assign(devices.get(id)!, data);
        return { count: 0 };
      },
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        ids(where)
          .map((id) => devices.get(id))
          .filter((row) => row?.revokedAt),
      findFirst: async ({ where }: { where: { userId: string; revokedAt: null } }) =>
        [...devices.values()].find((row) => row.userId === where.userId && !row.revokedAt) ?? null,
    },
    userDeviceConnection: {
      upsert: async ({ where, create }: { where: { deviceId: string }; create: ConnectionRow }) =>
        connections.set(where.deviceId, { ...create }),
      updateMany: async ({ data }: { data: Partial<ConnectionRow> }) => {
        for (const row of connections.values()) Object.assign(row, data);
        return { count: connections.size };
      },
      deleteMany: async ({ where }: { where: { connectionId: string | { in: string[] } } }) => {
        const gone =
          typeof where.connectionId === "string" ? [where.connectionId] : where.connectionId.in;
        for (const [key, row] of connections)
          if (gone.includes(row.connectionId)) connections.delete(key);
        return { count: 0 };
      },
      findUnique: async ({ where }: { where: { deviceId: string } }) =>
        connections.get(where.deviceId) ?? null,
      findFirst: async ({
        where,
      }: {
        where: { heartbeatAt: { gt: Date }; device: { userId: string } };
      }) => {
        const row = [...connections.values()]
          .filter((connection) => {
            const device = devices.get(connection.deviceId);
            return (
              device &&
              device.userId === where.device.userId &&
              !device.revokedAt &&
              connection.heartbeatAt > where.heartbeatAt.gt
            );
          })
          .sort((a, b) => b.connectedAt.getTime() - a.connectedAt.getTime())[0];
        if (!row) return null;
        const device = devices.get(row.deviceId)!;
        return { ...row, device: { name: device.name, platform: device.platform } };
      },
    },
    // Every test user is signed in.
    session: {
      findMany: async ({ where }: { where: { userId: { in: string[] } } }) =>
        where.userId.in.map((userId) => ({ userId })),
    },
    $transaction: (run: (tx: unknown) => Promise<unknown>) => run(prisma),
  };
  return { prisma: prisma as unknown as PrismaClient, deviceRows: devices, connections };
}

class FakeSocket extends EventEmitter implements UserDeviceSocket {
  sent: Array<Record<string, unknown>> = [];
  closed?: { code?: number; reason?: string };
  pings = 0;
  send(data: string) {
    this.sent.push(JSON.parse(data));
    this.emit("sent");
  }
  close(code?: number, reason?: string) {
    if (this.closed) return;
    this.closed = { code, reason };
    this.emit("close");
  }
  ping() {
    this.pings += 1;
  }
  terminate() {
    this.close();
  }
  /** Device side: the next request the server sent. */
  async nextRequest() {
    while (true) {
      const request = this.sent.find((message) => message.type === "request" && !message.seen);
      if (request) {
        request.seen = true;
        return request as { id: string; request: HostComputerRequest };
      }
      await once(this, "sent");
    }
  }
  reply(id: string, frame: unknown) {
    this.emit("message", Buffer.from(JSON.stringify({ type: "frame", id, frame })));
  }
}

const device = { id: "device-1", userId: "user-1", name: "Laptop", platform: "darwin" };
const environment: HostComputerRequest = { method: "environment", botId: "bot-1" };
const secret = userDeviceForwardSecret("test-encryption-key");
const hubs: UserDeviceHub[] = [];

function setup() {
  const db = fakePrisma();
  db.deviceRows.set(device.id, {
    ...device,
    tokenHash: hashUserDeviceToken("a".repeat(64)),
    createdAt: new Date(0),
    revokedAt: null,
    lastSeenAt: null,
  });
  const hub = new UserDeviceHub({ prisma: db.prisma, address: "http://10.0.0.5:3100" });
  hubs.push(hub);
  const devices = new UserDevices({ prisma: db.prisma, forwardSecret: secret, hub });
  return { ...db, hub, devices };
}

async function collect<T>(iterable: AsyncIterable<T>) {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.close()));
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("device tokens", () => {
  it("are 32 random bytes, stored only as their sha256", () => {
    const token = createUserDeviceToken();
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(createUserDeviceToken()).not.toBe(token);
    expect(hashUserDeviceToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashUserDeviceToken(token)).not.toBe(token);
  });

  it("accepts only a well-formed bearer", () => {
    const token = "b".repeat(64);
    expect(userDeviceBearer(`Bearer ${token}`)).toBe(token);
    expect(userDeviceBearer(token)).toBeNull();
    expect(userDeviceBearer(`Bearer ${token}x`)).toBeNull();
    expect(userDeviceBearer(undefined)).toBeNull();
  });

  it("authenticates a known token and refuses a revoked or unknown one", async () => {
    const { hub, deviceRows } = setup();
    await expect(hub.authenticate(`Bearer ${"a".repeat(64)}`)).resolves.toEqual(device);
    await expect(hub.authenticate(`Bearer ${"c".repeat(64)}`)).resolves.toBeNull();
    await expect(hub.authenticate("Bearer short")).resolves.toBeNull();
    deviceRows.get(device.id)!.revokedAt = new Date();
    await expect(hub.authenticate(`Bearer ${"a".repeat(64)}`)).resolves.toBeNull();
  });

  it("derives a forward secret from the shared key without exposing it", () => {
    expect(secret).toBe(userDeviceForwardSecret("test-encryption-key"));
    expect(secret).not.toContain("test-encryption-key");
    expect(userDeviceForwardSecret("other")).not.toBe(secret);
    expect(validUserDeviceForwardSecret(secret, `Bearer ${secret}`)).toBe(true);
    expect(validUserDeviceForwardSecret(secret, `Bearer ${secret.slice(1)}`)).toBe(false);
    expect(validUserDeviceForwardSecret(secret, secret)).toBe(false);
  });

  it("advertises a bound host as is and a wildcard host by its network address", () => {
    expect(userDeviceInternalAddress("127.0.0.1", 3100)).toBe("http://127.0.0.1:3100");
    expect(userDeviceInternalAddress("::1", 3100)).toBe("http://[::1]:3100");
    expect(userDeviceInternalAddress("0.0.0.0", 3100)).toMatch(/^http:\/\/.+:3100$/);
  });
});

describe("user device gateway in the holding process", () => {
  it("streams values, skipping heartbeats, until done", async () => {
    const { hub, devices, connections } = setup();
    const socket = new FakeSocket();
    await hub.attach(device, socket);
    expect(connections.get(device.id)).toMatchObject({ address: hub.address });
    await expect(devices.connected("user-1")).resolves.toEqual({
      deviceId: device.id,
      name: "Laptop",
      platform: "darwin",
    });
    await expect(devices.connected("user-2")).resolves.toBeNull();

    const result = collect(devices.request("user-1", environment, new AbortController().signal));
    const { id, request } = await socket.nextRequest();
    expect(request).toEqual(environment);
    socket.reply(id, { heartbeat: true });
    socket.reply(id, { value: { platform: "darwin" } });
    socket.reply(id, { done: true });
    await expect(result).resolves.toEqual([{ platform: "darwin" }]);
    expect(socket.sent.some((message) => message.type === "cancel")).toBe(false);
  });

  it("raises the device's error", async () => {
    const { hub, devices } = setup();
    const socket = new FakeSocket();
    await hub.attach(device, socket);
    const result = collect(devices.request("user-1", environment, new AbortController().signal));
    const { id } = await socket.nextRequest();
    socket.reply(id, { error: "Local computer is busy. Try again shortly." });
    await expect(result).rejects.toThrow("Local computer is busy");
  });

  it("is offline when no device is connected or the connection went stale", async () => {
    const { hub, devices, connections } = setup();
    const signal = new AbortController().signal;
    await expect(collect(devices.request("user-1", environment, signal))).rejects.toThrow(
      USER_DEVICE_OFFLINE_MESSAGE,
    );
    await hub.attach(device, new FakeSocket());
    connections.get(device.id)!.heartbeatAt = new Date(Date.now() - 10 * 60_000);
    await expect(devices.connected("user-1")).resolves.toBeNull();
    await expect(devices.pairedSince("user-1")).resolves.toEqual(new Date(0));
    await expect(devices.pairedSince("user-2")).resolves.toBeNull();
  });

  it("fails an in-flight request when the device disconnects and never resends it", async () => {
    const { hub, devices, connections } = setup();
    const socket = new FakeSocket();
    await hub.attach(device, socket);
    const result = collect(devices.request("user-1", environment, new AbortController().signal));
    await socket.nextRequest();
    socket.close();
    await expect(result).rejects.toThrow("Your computer disconnected");
    expect(socket.sent.filter((message) => message.type === "request")).toHaveLength(1);
    await vi.waitFor(() => expect(connections.size).toBe(0));
  });

  it("sends cancel to the device when the run aborts", async () => {
    const { hub, devices } = setup();
    const socket = new FakeSocket();
    await hub.attach(device, socket);
    const controller = new AbortController();
    const result = collect(devices.request("user-1", environment, controller.signal));
    const { id } = await socket.nextRequest();
    controller.abort(new Error("stopped"));
    await expect(result).rejects.toThrow("stopped");
    expect(socket.sent).toContainEqual({ type: "cancel", id });
  });

  it("replaces an older socket for the same device", async () => {
    const { hub, devices } = setup();
    const first = new FakeSocket();
    await hub.attach(device, first);
    const pending = collect(devices.request("user-1", environment, new AbortController().signal));
    await first.nextRequest();
    const second = new FakeSocket();
    await hub.attach(device, second);
    expect(first.closed?.code).toBe(4000);
    await expect(pending).rejects.toThrow("Your computer disconnected");

    const result = collect(devices.request("user-1", environment, new AbortController().signal));
    const { id } = await second.nextRequest();
    second.reply(id, { value: 1 });
    second.reply(id, { done: true });
    await expect(result).resolves.toEqual([1]);
  });

  it("closes the socket and fails requests on revoke", async () => {
    const { hub, devices } = setup();
    const socket = new FakeSocket();
    await hub.attach(device, socket);
    const result = collect(devices.request("user-1", environment, new AbortController().signal));
    await socket.nextRequest();
    await devices.disconnect(device.id);
    await expect(result).rejects.toThrow("disconnected from Rakazo");
    expect(socket.sent).toContainEqual({ type: "revoked" });
    expect(socket.closed?.code).toBe(4001);
  });

  it("closes a socket whose device was revoked elsewhere on the next heartbeat", async () => {
    vi.useFakeTimers();
    const db = fakePrisma();
    db.deviceRows.set(device.id, { ...device, tokenHash: "x", revokedAt: null, lastSeenAt: null });
    const hub = new UserDeviceHub({ prisma: db.prisma, address: "http://a", pingIntervalMs: 50 });
    hubs.push(hub);
    const socket = new FakeSocket();
    await hub.attach(device, socket);
    await vi.advanceTimersByTimeAsync(60);
    expect(socket.pings).toBe(1);
    db.deviceRows.get(device.id)!.revokedAt = new Date();
    socket.emit("pong");
    await vi.advanceTimersByTimeAsync(50);
    expect(socket.sent).toContainEqual({ type: "revoked" });
    expect(socket.closed?.code).toBe(4001);
  });

  it("terminates a socket that stopped answering pings", async () => {
    vi.useFakeTimers();
    const db = fakePrisma();
    db.deviceRows.set(device.id, { ...device, tokenHash: "x", revokedAt: null, lastSeenAt: null });
    const hub = new UserDeviceHub({ prisma: db.prisma, address: "http://a", pingIntervalMs: 50 });
    hubs.push(hub);
    const socket = new FakeSocket();
    await hub.attach(device, socket);
    await vi.advanceTimersByTimeAsync(110);
    expect(socket.closed).toEqual({ code: undefined, reason: undefined });
  });

  it("closes a socket that errors instead of crashing the process", async () => {
    const db = fakePrisma();
    db.deviceRows.set(device.id, { ...device, tokenHash: "x", revokedAt: null, lastSeenAt: null });
    const hub = new UserDeviceHub({ prisma: db.prisma, address: "http://a" });
    hubs.push(hub);
    const socket = new FakeSocket();
    await hub.attach(device, socket);
    socket.emit("error", new RangeError("Max payload size exceeded"));
    expect(socket.closed).toBeDefined();
  });
});

describe("user device gateway from another process", () => {
  function forwarding(hub: UserDeviceHub) {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const fetcher = (async (input: URL | string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), authorization: headers.get("authorization") });
      const body = userDeviceForwardBody.parse(JSON.parse(String(init?.body)));
      const { request, ...route } = body;
      return hub.stream(route, request, init?.signal ?? new AbortController().signal);
    }) as typeof fetch;
    return { calls, fetcher };
  }

  it("forwards to the holding process and streams NDJSON frames back", async () => {
    const { hub, prisma } = setup();
    const socket = new FakeSocket();
    await hub.attach(device, socket);
    const { calls, fetcher } = forwarding(hub);
    const worker = new UserDevices({ prisma, forwardSecret: secret, fetch: fetcher });
    const result = collect(worker.request("user-1", environment, new AbortController().signal));
    const { id } = await socket.nextRequest();
    socket.reply(id, { heartbeat: true });
    socket.reply(id, { value: "a" });
    socket.reply(id, { value: "b" });
    socket.reply(id, { done: true });
    await expect(result).resolves.toEqual(["a", "b"]);
    expect(calls).toEqual([
      { url: `http://10.0.0.5:3100${USER_DEVICE_FORWARD_PATH}`, authorization: `Bearer ${secret}` },
    ]);
  });

  it("carries a device disconnect back as an error", async () => {
    const { hub, prisma } = setup();
    const socket = new FakeSocket();
    await hub.attach(device, socket);
    const worker = new UserDevices({
      prisma,
      forwardSecret: secret,
      fetch: forwarding(hub).fetcher,
    });
    const result = collect(worker.request("user-1", environment, new AbortController().signal));
    await socket.nextRequest();
    socket.close();
    await expect(result).rejects.toThrow("Your computer disconnected");
  });

  it("cancels on the device when the forwarding run aborts", async () => {
    const { hub, prisma } = setup();
    const socket = new FakeSocket();
    await hub.attach(device, socket);
    const worker = new UserDevices({
      prisma,
      forwardSecret: secret,
      fetch: forwarding(hub).fetcher,
    });
    const controller = new AbortController();
    const result = collect(worker.request("user-1", environment, controller.signal));
    const { id } = await socket.nextRequest();
    socket.reply(id, { value: "partial" });
    controller.abort(new Error("stopped"));
    await expect(result).rejects.toThrow("stopped");
    await vi.waitFor(() => expect(socket.sent).toContainEqual({ type: "cancel", id }));
  });

  it("is offline when the holding process is unreachable or no longer holds the socket", async () => {
    const { hub, prisma } = setup();
    await hub.attach(device, new FakeSocket());
    const unreachable = new UserDevices({
      prisma,
      forwardSecret: secret,
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    const signal = new AbortController().signal;
    await expect(collect(unreachable.request("user-1", environment, signal))).rejects.toThrow(
      USER_DEVICE_OFFLINE_MESSAGE,
    );
    const moved = new UserDevices({
      prisma,
      forwardSecret: secret,
      fetch: (async () => new Response(null, { status: 409 })) as typeof fetch,
    });
    await expect(collect(moved.request("user-1", environment, signal))).rejects.toThrow(
      USER_DEVICE_OFFLINE_MESSAGE,
    );
  });

  it("refuses a forwarded request for a connection this process does not hold", async () => {
    const { hub } = setup();
    await hub.attach(device, new FakeSocket());
    const response = hub.stream(
      { deviceId: device.id, userId: "user-2", connectionId: "x" },
      environment,
      new AbortController().signal,
    );
    expect(response.status).toBe(409);
  });
});

describe("device socket upgrade", () => {
  it("accepts a valid token on the connect path and rejects everything else", async () => {
    const { hub, devices } = setup();
    const server = createServer();
    server.on("upgrade", hub.handleUpgrade);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const status = (path: string, token: string) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(`${base}${path}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        ws.on("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
        ws.on("open", () => {
          ws.close();
          resolve(101);
        });
        ws.on("error", () => undefined);
      });
    try {
      expect(await status(USER_DEVICE_CONNECT_PATH, "c".repeat(64))).toBe(401);
      expect(await status("/other", "a".repeat(64))).toBe(404);

      const ws = new WebSocket(`${base}${USER_DEVICE_CONNECT_PATH}`, {
        headers: { authorization: `Bearer ${"a".repeat(64)}` },
      });
      ws.on("message", (data) => {
        const message = JSON.parse(String(data));
        if (message.type !== "request") return;
        ws.send(JSON.stringify({ type: "frame", id: message.id, frame: { value: "hi" } }));
        ws.send(JSON.stringify({ type: "frame", id: message.id, frame: { done: true } }));
      });
      await once(ws, "open");
      await vi.waitFor(async () => expect(await devices.connected("user-1")).not.toBeNull());
      await expect(
        collect(devices.request("user-1", environment, new AbortController().signal)),
      ).resolves.toEqual(["hi"]);
      ws.close();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  /** Serves the hub and sends a raw upgrade, keeping the server's end of the socket. */
  it("says when a refused device's sign-in ended, and only then", async () => {
    const { hub, deviceRows } = setup();
    const server = createServer();
    server.on("upgrade", hub.handleUpgrade);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const refusal = () =>
      new Promise<string | undefined>((resolve) => {
        const ws = new WebSocket(`${base}${USER_DEVICE_CONNECT_PATH}`, {
          headers: { authorization: `Bearer ${"a".repeat(64)}` },
        });
        ws.on("unexpected-response", (_request, response) =>
          resolve(String(response.headers["x-rakazo-device-revoked"] ?? "none")),
        );
        ws.on("open", () => {
          ws.close();
          resolve(undefined);
        });
        ws.on("error", () => undefined);
      });
    try {
      const row = deviceRows.get(device.id)! as { revokedAt?: Date | null; revokedBy?: string };
      row.revokedAt = new Date();
      row.revokedBy = "session";
      expect(await refusal()).toBe("session-ended");
      row.revokedBy = "owner";
      expect(await refusal()).toBe("none");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  async function rawUpgrade(hub: UserDeviceHub, path: string, token: string) {
    const server = createServer((_request, response) => response.end("ok"));
    let serverSide!: { socket: Duplex; closed: Promise<void> };
    const accepted = new Promise<typeof serverSide>((resolve) => {
      server.on("upgrade", (_request, socket: Duplex) => {
        // A close listener, not events.once, which would add an error listener and hide a crash.
        const closed = new Promise<void>((done) => socket.on("close", () => done()));
        serverSide = { socket, closed };
        resolve(serverSide);
      });
    });
    server.on("upgrade", hub.handleUpgrade);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const client = connect(port, "127.0.0.1");
    client.on("error", () => undefined);
    client.write(
      `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nAuthorization: Bearer ${token}\r\n\r\n`,
    );
    const stop = async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };
    return { port, client, accepted, stop };
  }

  const upgradeSocketError = ["user device upgrade socket error", expect.anything()] as const;

  it.each([
    ["404", "/other", "a".repeat(64)],
    ["401", USER_DEVICE_CONNECT_PATH, "c".repeat(64)],
  ])("survives a client that resets after its %s", async (status, path, token) => {
    const { hub } = setup();
    const warn = vi.spyOn(getLogger(), "warn");
    const { port, client, accepted, stop } = await rawUpgrade(hub, path, token);
    try {
      const [response] = (await once(client, "data")) as [Buffer];
      expect(String(response)).toMatch(new RegExp(`^HTTP/1.1 ${status} `));
      const { closed } = await accepted;
      client.resetAndDestroy();
      await closed;
      expect(warn).toHaveBeenCalledWith(...upgradeSocketError);
      expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
    } finally {
      await stop();
    }
  });

  it("abandons the upgrade when the client resets while its token is checked", async () => {
    const { hub, prisma, deviceRows, devices } = setup();
    const warn = vi.spyOn(getLogger(), "warn");
    // The upgrade authenticates through the lookup that also says why a token was refused.
    const authenticate = vi.spyOn(hub as unknown as { lookup: () => Promise<unknown> }, "lookup");
    let release = () => {};
    const lookup = vi.spyOn(prisma.userDevice, "findUnique").mockImplementationOnce(
      (() =>
        new Promise((resolve) => {
          release = () => resolve(deviceRows.get(device.id));
        })) as never,
    );
    const { port, client, accepted, stop } = await rawUpgrade(
      hub,
      USER_DEVICE_CONNECT_PATH,
      "a".repeat(64),
    );
    try {
      const { closed } = await accepted;
      await vi.waitFor(() => expect(lookup).toHaveBeenCalled());
      client.resetAndDestroy();
      await closed;
      expect(warn).toHaveBeenCalledWith(...upgradeSocketError);
      release();
      await expect(authenticate.mock.results[0]!.value).resolves.toMatchObject({
        device: { id: device.id },
      });
      expect(await devices.connected("user-1")).toBeNull();
      expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
    } finally {
      await stop();
    }
  });

  it("leaves socket errors to ws once it holds the socket", async () => {
    const { hub, devices } = setup();
    const warn = vi.spyOn(getLogger(), "warn");
    const server = createServer();
    const sockets: Duplex[] = [];
    server.on("upgrade", (_request, socket: Duplex) => sockets.push(socket));
    server.on("upgrade", hub.handleUpgrade);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${USER_DEVICE_CONNECT_PATH}`, {
        headers: { authorization: `Bearer ${"a".repeat(64)}` },
      });
      ws.on("error", () => undefined);
      await once(ws, "open");
      await vi.waitFor(async () => expect(await devices.connected("user-1")).not.toBeNull());
      const socket = sockets[0]!;
      const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
      socket.destroy(new Error("socket failed"));
      await closed;
      expect(warn).not.toHaveBeenCalledWith(...upgradeSocketError);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
