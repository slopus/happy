import { EventEmitter } from "node:events";
import type { UserDeviceSocket } from "@rakazo/adapters";
import {
  hashUserDeviceToken,
  USER_DEVICE_DISCONNECT_PATH,
  USER_DEVICE_FORWARD_PATH,
  UserDeviceHub,
  UserDevices,
  userDeviceForwardSecret,
} from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { installSecurityEventStore } from "@rakazo/db";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { endUserDeviceSession, mountUserDeviceRoutes } from "./user-devices.js";

interface Row {
  id: string;
  userId: string;
  name: string;
  platform: string;
  tokenHash: string;
  sessionId: string | null;
  createdAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
}

function fakePrisma() {
  const rows: Row[] = [];
  const connections = new Map<string, Date>();
  const events: Array<{ type: string; userId: string | null; metadata: object }> = [];
  /** Live sessions by id, with their expiry. Every test user starts signed in. */
  const sessions = new Map<string, Date>();
  /** Users with no sign-in left at all. */
  const signedOutUsers = new Set<string>();
  const signedIn = (id: string) =>
    sessions.get(id) ?? (id.endsWith("-ended") ? null : new Date(Date.now() + 60_000));
  type Where = Partial<Row> & { OR?: Partial<Row>[] };
  const matches = (row: Row, { OR, ...where }: Where): boolean =>
    Object.entries(where).every(([key, value]) => row[key as keyof Row] === value) &&
    (!OR || OR.some((option) => matches(row, option)));
  const prisma = {
    userDevice: {
      count: async ({ where }: { where: Partial<Row> }) =>
        rows.filter((row) => matches(row, where)).length,
      create: async ({
        data,
      }: {
        data: Omit<Row, "id" | "createdAt" | "lastSeenAt" | "revokedAt" | "sessionId"> &
          Partial<Pick<Row, "lastSeenAt" | "revokedAt" | "sessionId">>;
      }) => {
        const row = {
          id: `device-${rows.length + 1}`,
          createdAt: new Date(),
          lastSeenAt: null,
          revokedAt: null,
          sessionId: null,
          ...data,
        };
        rows.push(row);
        return { id: row.id };
      },
      findMany: async ({
        where,
        select,
      }: {
        where: Where;
        select?: { connections?: { where: { heartbeatAt: { gt: Date } } } };
      }) =>
        rows
          .filter((row) => matches(row, where))
          .map((row) => {
            const after = select?.connections?.where.heartbeatAt.gt;
            const heartbeatAt = connections.get(row.id);
            return {
              ...row,
              connections:
                after && heartbeatAt && heartbeatAt > after ? [{ deviceId: row.id }] : [],
            };
          }),
      findUnique: async ({ where }: { where: { tokenHash: string } }) =>
        rows.find((row) => row.tokenHash === where.tokenHash) ?? null,
      update: async () => ({}),
      updateMany: async ({ where, data }: { where: Partial<Row>; data: Partial<Row> }) => {
        const hit = rows.filter((row) => matches(row, where));
        for (const row of hit) Object.assign(row, data);
        return { count: hit.length };
      },
    },
    userDeviceConnection: {
      upsert: async ({ create }: { create: { deviceId: string; heartbeatAt: Date } }) =>
        connections.set(create.deviceId, create.heartbeatAt),
      deleteMany: async () => ({ count: 0 }),
      findFirst: async () => null,
      findUnique: async () => null,
    },
    session: {
      findFirst: async ({ where }: { where: { id?: string; userId?: string } }) => {
        if (where.id) return signedIn(where.id) ? { id: where.id } : null;
        return signedOutUsers.has(where.userId!) ? null : { id: `${where.userId}-session` };
      },
      findMany: async ({
        where,
      }: {
        where: { id?: { in: string[] }; userId?: { in: string[] }; expiresAt: { gt: Date } };
      }) =>
        where.userId
          ? where.userId.in
              .filter((userId) => !signedOutUsers.has(userId))
              .map((userId) => ({ userId }))
          : where
              .id!.in.filter((id) => {
                const expiresAt = signedIn(id);
                return expiresAt !== null && expiresAt > where.expiresAt.gt;
              })
              .map((id) => ({ id })),
    },
    securityEvent: {
      create: async ({ data }: { data: (typeof events)[number] }) => events.push(data),
    },
    $executeRaw: async () => 1,
    $transaction: (run: (tx: unknown) => Promise<unknown>) => run(prisma),
  };
  return {
    prisma: prisma as unknown as PrismaClient,
    rows,
    events,
    connections,
    sessions,
    signedOutUsers,
  };
}

class FakeSocket extends EventEmitter implements UserDeviceSocket {
  sent: unknown[] = [];
  closedWith?: number;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number) {
    this.closedWith = code;
    this.emit("close");
  }
  ping() {}
  terminate() {
    this.close();
  }
}

const secret = userDeviceForwardSecret("test-key");
const hubs: UserDeviceHub[] = [];

function setup() {
  const db = fakePrisma();
  installSecurityEventStore(db.prisma);
  const hub = new UserDeviceHub({ prisma: db.prisma, address: "http://127.0.0.1:3100" });
  hubs.push(hub);
  const app = new Hono();
  mountUserDeviceRoutes(app, {
    prisma: db.prisma,
    hub,
    devices: new UserDevices({ prisma: db.prisma, forwardSecret: secret, hub }),
    forwardSecret: secret,
    session: async (request) => {
      const userId = request.headers.get("x-test-user");
      return userId
        ? { userId, sessionId: request.headers.get("x-test-session") ?? `${userId}-session` }
        : null;
    },
    trustedOrigin: (origin) => origin === "http://app.test",
  });
  const pair = (
    user: string | null,
    init: { origin?: string; body?: unknown; session?: string } = {},
  ) =>
    app.request("/api/devices/pair", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(user ? { "x-test-user": user } : {}),
        ...(init.session ? { "x-test-session": init.session } : {}),
        ...(init.origin ? { origin: init.origin } : {}),
      },
      body: JSON.stringify(init.body ?? { name: "Laptop", platform: "darwin" }),
    });
  const devices = new UserDevices({ prisma: db.prisma, forwardSecret: secret, hub });
  const attach = async (deviceId: string, userId = "user-1") => {
    const socket = new FakeSocket();
    await hub.attach({ id: deviceId, userId, name: "Laptop", platform: "darwin" }, socket);
    return socket;
  };
  return { ...db, hub, app, pair, attach, store: { prisma: db.prisma, devices } };
}

afterEach(async () => {
  installSecurityEventStore(undefined);
  await Promise.all(hubs.splice(0).map((hub) => hub.close()));
});

describe("device pairing", () => {
  it("requires a session and a JSON body, and refuses a foreign origin", async () => {
    const { pair, app } = setup();
    expect((await pair(null)).status).toBe(401);
    expect((await pair("user-1", { origin: "https://evil.test" })).status).toBe(403);
    expect((await pair("user-1", { body: { name: "", platform: "darwin" } })).status).toBe(400);
    const form = await app.request("/api/devices/pair", {
      method: "POST",
      headers: { "content-type": "text/plain", "x-test-user": "user-1" },
      body: JSON.stringify({ name: "Laptop", platform: "darwin" }),
    });
    expect(form.status).toBe(415);
  });

  it("returns the token once and stores only its hash", async () => {
    const { pair, rows, events } = setup();
    const response = await pair("user-1", { origin: "http://app.test" });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { deviceId, token, userId } = await response.json();
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(userId).toBe("user-1");
    expect(rows).toEqual([
      expect.objectContaining({ id: deviceId, userId: "user-1", sessionId: "user-1-session" }),
    ]);
    expect(rows[0]!.tokenHash).toBe(hashUserDeviceToken(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(events).toEqual([
      expect.objectContaining({
        type: "device.paired",
        userId: "user-1",
        metadata: { deviceId, platform: "darwin" },
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain(token);
  });

  it("caps active devices per user", async () => {
    const { pair } = setup();
    for (let index = 0; index < 10; index += 1) expect((await pair("user-1")).status).toBe(201);
    expect((await pair("user-1")).status).toBe(409);
    expect((await pair("user-2")).status).toBe(201);
  });

  it("lists the user's own active devices", async () => {
    const { pair, app } = setup();
    await pair("user-1");
    await pair("user-2");
    const response = await app.request("/api/devices", { headers: { "x-test-user": "user-1" } });
    const { devices } = await response.json();
    expect(devices).toEqual([
      expect.objectContaining({ deviceId: "device-1", name: "Laptop", connected: false }),
    ]);
    expect(JSON.stringify(devices)).not.toContain("tokenHash");
  });

  it("shows each device's own live connection", async () => {
    const { pair, app, hub, connections } = setup();
    await pair("user-1");
    await pair("user-1");
    await pair("user-1");
    for (const id of ["device-1", "device-2"])
      await hub.attach(
        { id, userId: "user-1", name: "Laptop", platform: "darwin" },
        new FakeSocket(),
      );
    connections.set("device-2", new Date(Date.now() - 10 * 60_000));
    const response = await app.request("/api/devices", { headers: { "x-test-user": "user-1" } });
    const { devices } = await response.json();
    expect(
      Object.fromEntries(
        devices.map((device: { deviceId: string; connected: boolean }) => [
          device.deviceId,
          device.connected,
        ]),
      ),
    ).toEqual({ "device-1": true, "device-2": false, "device-3": false });
  });
});

describe("device revoke", () => {
  it("lets only the owner revoke, then closes the socket and records it", async () => {
    const { pair, app, hub, rows, events } = setup();
    const { deviceId } = await (await pair("user-1")).json();
    const socket = new FakeSocket();
    await hub.attach(
      { id: deviceId, userId: "user-1", name: "Laptop", platform: "darwin" },
      socket,
    );
    const remove = (user: string) =>
      app.request(`/api/devices/${deviceId}`, {
        method: "DELETE",
        headers: { "x-test-user": user },
      });
    expect((await remove("user-2")).status).toBe(404);
    expect(rows[0]!.revokedAt).toBeNull();
    expect((await remove("user-1")).status).toBe(204);
    expect(rows[0]!.revokedAt).toBeInstanceOf(Date);
    expect(socket.sent).toContainEqual({ type: "revoked" });
    expect(socket.closedWith).toBe(4001);
    expect(events.at(-1)).toMatchObject({ type: "device.revoked", metadata: { deviceId } });
    expect((await remove("user-1")).status).toBe(404);
  });

  it("lets a device revoke itself with its token, which then stops working", async () => {
    const { pair, app, hub } = setup();
    const { token } = await (await pair("user-1")).json();
    const self = () =>
      app.request("/api/devices/self", {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      });
    expect((await self()).status).toBe(204);
    await expect(hub.authenticate(`Bearer ${token}`)).resolves.toBeNull();
    expect((await self()).status).toBe(401);
  });
});

describe("device sessions", () => {
  it("revokes a device when the session that paired it ends, and says why", async () => {
    const { pair, attach, store, hub, rows, events } = setup();
    const { deviceId, token } = await (await pair("user-1", { session: "desktop" })).json();
    const other = await (await pair("user-1", { session: "laptop" })).json();
    const socket = await attach(deviceId);

    await endUserDeviceSession(store, { id: "phone", userId: "user-1" });
    expect(rows.every((row) => row.revokedAt === null)).toBe(true);

    await endUserDeviceSession(store, { id: "desktop", userId: "user-2" });
    expect(rows.every((row) => row.revokedAt === null)).toBe(true);

    await endUserDeviceSession(store, { id: "desktop", userId: "user-1" });
    expect(rows.find((row) => row.id === deviceId)?.revokedAt).toBeInstanceOf(Date);
    expect(rows.find((row) => row.id === other.deviceId)?.revokedAt).toBeNull();
    await expect(hub.authenticate(`Bearer ${token}`)).resolves.toBeNull();
    expect(socket.sent).toContainEqual({ type: "revoked", reason: "session-ended" });
    expect(socket.closedWith).toBe(4001);
    expect(events.at(-1)).toMatchObject({
      type: "device.revoked",
      userId: "user-1",
      metadata: { deviceId, by: "session" },
    });
  });

  it("keeps a device on the session that replaces its own", async () => {
    const { pair, store, hub, rows } = setup();
    const { token } = await (await pair("user-1", { session: "desktop" })).json();

    await endUserDeviceSession(store, { id: "desktop", userId: "user-1" }, { id: "desktop-2" });
    expect(rows[0]).toMatchObject({ sessionId: "desktop-2", revokedAt: null });
    await expect(hub.authenticate(`Bearer ${token}`)).resolves.toMatchObject({ userId: "user-1" });

    await endUserDeviceSession(store, { id: "desktop-2", userId: "user-1" });
    await expect(hub.authenticate(`Bearer ${token}`)).resolves.toBeNull();
  });

  it("keeps a device paired before sessions were recorded until the user has no sign-in left", async () => {
    const { pair, store, rows, signedOutUsers } = setup();
    await pair("user-1", { session: "desktop" });
    rows[0]!.sessionId = null;
    await pair("user-2");
    rows[1]!.sessionId = null;

    await endUserDeviceSession(store, { id: "phone", userId: "user-1" });
    expect(rows.map((row) => row.revokedAt === null)).toEqual([true, true]);

    signedOutUsers.add("user-1");
    await endUserDeviceSession(store, { id: "desktop", userId: "user-1" });
    expect(rows.map((row) => row.revokedAt === null)).toEqual([false, true]);
  });

  it("refuses a device paired before sessions were recorded once no sign-in is left", async () => {
    const { pair, hub, rows, signedOutUsers } = setup();
    const { token } = await (await pair("user-1")).json();
    rows[0]!.sessionId = null;
    await expect(hub.authenticate(`Bearer ${token}`)).resolves.toMatchObject({ userId: "user-1" });

    signedOutUsers.add("user-1");
    await expect(hub.authenticate(`Bearer ${token}`)).resolves.toBeNull();
    expect(rows[0]).toMatchObject({ revokedBy: "session" });
  });

  it("leaves a device a new sign-in tied while the old sign-out was ending it", async () => {
    const { pair, store, rows, signedOutUsers, prisma } = setup();
    await pair("user-1");
    rows[0]!.sessionId = null;
    signedOutUsers.add("user-1");
    const findMany = prisma.userDevice.findMany.bind(prisma.userDevice);
    prisma.userDevice.findMany = (async (args: Parameters<typeof findMany>[0]) => {
      const found = await findMany(args);
      rows[0]!.sessionId = "desktop-2";
      return found;
    }) as typeof findMany;

    await endUserDeviceSession(store, { id: "phone", userId: "user-1" });
    expect(rows[0]).toMatchObject({ sessionId: "desktop-2", revokedAt: null });
  });

  it("ties a device paired before sessions were recorded to its desktop's sign-in", async () => {
    const { pair, app, store, rows, events } = setup();
    const { deviceId, token } = await (await pair("user-1", { session: "desktop" })).json();
    rows[0]!.sessionId = null;
    const tie = (user: string | null, authorization = `Bearer ${token}`, session = "desktop") =>
      app.request("/api/devices/self/session", {
        method: "POST",
        headers: {
          authorization,
          ...(user ? { "x-test-user": user, "x-test-session": session } : {}),
        },
      });

    expect((await tie(null)).status).toBe(401);
    expect((await tie("user-1", "Bearer wrong")).status).toBe(401);
    expect((await tie("user-2")).status).toBe(403);
    expect(rows[0]!.sessionId).toBeNull();

    expect((await tie("user-1")).status).toBe(204);
    expect((await tie("user-1", `Bearer ${token}`, "phone")).status).toBe(204);
    expect(rows[0]!.sessionId).toBe("desktop");
    expect(events.filter((event) => event.type === "device.tied")).toMatchObject([
      { type: "device.tied", userId: "user-1", metadata: { deviceId } },
    ]);

    await endUserDeviceSession(store, { id: "desktop", userId: "user-1" });
    expect(rows[0]!.revokedAt).toBeInstanceOf(Date);
  });

  it("ends a computer tied to a sign-in that signed out while it was tying", async () => {
    const { pair, app, rows } = setup();
    const { token } = await (await pair("user-1")).json();
    rows[0]!.sessionId = null;
    const response = await app.request("/api/devices/self/session", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-test-user": "user-1",
        "x-test-session": "desktop-ended",
      },
    });
    expect(response.status).toBe(401);
    expect(rows[0]).toMatchObject({ sessionId: "desktop-ended", revokedBy: "session" });
  });

  it("never accepts a device paired by a sign-in that already ended", async () => {
    const { pair, hub, rows } = setup();
    const { token } = await (await pair("user-1", { session: "desktop-ended" })).json();
    expect(rows[0]!.revokedAt).toBeNull();
    await expect(hub.authenticate(`Bearer ${token}`)).resolves.toBeNull();
  });

  it("stops accepting a device once the sign-in that paired it expires", async () => {
    const { pair, hub, sessions } = setup();
    const { token } = await (await pair("user-1", { session: "desktop" })).json();
    await expect(hub.authenticate(`Bearer ${token}`)).resolves.toMatchObject({ userId: "user-1" });
    sessions.set("desktop", new Date(Date.now() - 1));
    await expect(hub.authenticate(`Bearer ${token}`)).resolves.toBeNull();
  });

  it("tells a device held by another process why it was revoked", async () => {
    const { app, attach } = setup();
    const socket = await attach("device-9");
    const response = await app.request(USER_DEVICE_DISCONNECT_PATH, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ deviceId: "device-9", reason: "session-ended" }),
    });
    expect(response.status).toBe(204);
    expect(socket.sent).toContainEqual({ type: "revoked", reason: "session-ended" });
  });
});

describe("internal forwarding endpoint", () => {
  it("requires the derived forward secret", async () => {
    const { app } = setup();
    const forward = (authorization: string) =>
      app.request(USER_DEVICE_FORWARD_PATH, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({
          deviceId: "device-1",
          userId: "user-1",
          connectionId: "c",
          request: { method: "environment", botId: "bot-1" },
        }),
      });
    expect((await forward("Bearer wrong")).status).toBe(401);
    // Authorized, but this process holds no such connection.
    expect((await forward(`Bearer ${secret}`)).status).toBe(409);
  });
});
