import { EventEmitter } from "node:events";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, installSecurityEventStore } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { UserDeviceSocket } from "./user-device-gateway.js";
import {
  createUserDeviceToken,
  hashUserDeviceToken,
  UserDeviceHub,
  UserDevices,
  userDeviceForwardSecret,
} from "./user-device-gateway.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

class Socket extends EventEmitter implements UserDeviceSocket {
  sent: Array<{ type: string; id?: string }> = [];
  send(data: string) {
    const message = JSON.parse(data);
    this.sent.push(message);
    if (message.type === "request") {
      queueMicrotask(() => {
        for (const frame of [{ value: "ok" }, { done: true }])
          this.emit("message", JSON.stringify({ type: "frame", id: message.id, frame }));
      });
    }
  }
  close() {
    this.emit("close");
  }
  ping() {}
  terminate() {
    this.close();
  }
}

describePostgres("user devices (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `device-user-${suffix}`;
  let prisma: PrismaClient;
  let raw: PrismaClient;
  let close: () => Promise<void>;
  const hubs: UserDeviceHub[] = [];

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    raw = db.prisma;
    prisma = asSystem(db.prisma);
    await prisma.user.create({
      data: { id: userId, name: "Device owner", email: `${userId}@example.test` },
    });
    close = async () => {
      await Promise.all(hubs.map((hub) => hub.close()));
      await prisma.user.deleteMany({ where: { id: userId } });
      await db.prisma.$disconnect();
      await db.pool.end();
    };
  });
  afterAll(async () => close?.());

  it("routes a user's request through the connection row and forgets revoked devices", async () => {
    const session = await prisma.session.create({
      data: {
        id: `${suffix}-route-session`,
        token: `${suffix}-route-session-token`,
        userId,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const token = createUserDeviceToken();
    const device = await prisma.userDevice.create({
      data: {
        userId,
        name: "Laptop",
        platform: "linux",
        tokenHash: hashUserDeviceToken(token),
        sessionId: session.id,
      },
    });
    const hub = new UserDeviceHub({ prisma: raw, address: "http://127.0.0.1:1" });
    hubs.push(hub);
    const authenticated = await hub.authenticate(`Bearer ${token}`);
    expect(authenticated).toMatchObject({ id: device.id, userId });
    await hub.attach(authenticated!, new Socket());
    // A reconnect replaces the row rather than adding one.
    const socket = new Socket();
    await hub.attach(authenticated!, socket);
    expect(await prisma.userDeviceConnection.count({ where: { deviceId: device.id } })).toBe(1);

    const gateway = new UserDevices({
      prisma: raw,
      forwardSecret: userDeviceForwardSecret("k"),
      hub,
    });
    await expect(gateway.connected(userId)).resolves.toMatchObject({ deviceId: device.id });
    await expect(gateway.pairedSince(userId)).resolves.toEqual(device.createdAt);
    await expect(gateway.list(userId)).resolves.toEqual([
      { deviceId: device.id, name: "Laptop", connected: true },
    ]);
    await prisma.userDeviceConnection.update({
      where: { deviceId: device.id },
      data: { heartbeatAt: new Date(Date.now() - 10 * 60_000) },
    });
    await expect(gateway.list(userId)).resolves.toEqual([
      { deviceId: device.id, name: "Laptop", connected: false },
    ]);
    await prisma.userDeviceConnection.update({
      where: { deviceId: device.id },
      data: { heartbeatAt: new Date() },
    });
    const values: unknown[] = [];
    for await (const value of gateway.request(
      userId,
      { method: "environment", botId: "bot" },
      new AbortController().signal,
    ))
      values.push(value);
    expect(values).toEqual(["ok"]);

    await prisma.userDevice.update({ where: { id: device.id }, data: { revokedAt: new Date() } });
    await expect(gateway.connected(userId)).resolves.toBeNull();
    await expect(gateway.pairedSince(userId)).resolves.toBeNull();
    await expect(hub.authenticate(`Bearer ${token}`)).resolves.toBeNull();
  });

  it("revokes a connected device once the sign-in that paired it is gone", async () => {
    const session = await prisma.session.create({
      data: {
        id: `${suffix}-session`,
        token: `${suffix}-session-token`,
        userId,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const token = createUserDeviceToken();
    const device = await prisma.userDevice.create({
      data: {
        userId,
        name: "Desktop",
        platform: "darwin",
        tokenHash: hashUserDeviceToken(token),
        sessionId: session.id,
      },
    });
    const hub = new UserDeviceHub({
      prisma: raw,
      address: "http://127.0.0.1:1",
      pingIntervalMs: 50,
    });
    hubs.push(hub);
    const authenticated = await hub.authenticate(`Bearer ${token}`);
    expect(authenticated).toMatchObject({ id: device.id });
    const socket = new Socket();
    socket.ping = () => socket.emit("pong");
    await hub.attach(authenticated!, socket);

    installSecurityEventStore(raw);
    // Deleted without the sign-out hook, as if its cleanup had failed.
    await prisma.session.delete({ where: { id: session.id } });
    await vi.waitFor(() =>
      expect(socket.sent).toContainEqual({ type: "revoked", reason: "session-ended" }),
    );
    const revoked = await prisma.userDevice.findUniqueOrThrow({ where: { id: device.id } });
    expect(revoked.revokedAt).toBeInstanceOf(Date);
    // Heartbeats overlap: a later one can close the socket for the revoke an earlier one
    // made while that one is still writing its security event.
    await vi.waitFor(() =>
      expect(
        prisma.securityEvent.count({
          where: {
            type: "device.revoked",
            userId,
            metadata: { path: ["deviceId"], equals: device.id },
          },
        }),
      ).resolves.toBe(1),
    );
    installSecurityEventStore(undefined);
    await expect(hub.authenticate(`Bearer ${token}`)).resolves.toBeNull();
  });

  it("closes a device whose sign-out landed while it was connecting", async () => {
    const session = await prisma.session.create({
      data: {
        id: `${suffix}-racing`,
        token: `${suffix}-racing-token`,
        userId,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const token = createUserDeviceToken();
    const device = await prisma.userDevice.create({
      data: {
        userId,
        name: "Desktop",
        platform: "darwin",
        tokenHash: hashUserDeviceToken(token),
        sessionId: session.id,
      },
    });
    const hub = new UserDeviceHub({ prisma: raw, address: "http://127.0.0.1:1" });
    hubs.push(hub);
    const authenticated = await hub.authenticate(`Bearer ${token}`);
    expect(authenticated).toMatchObject({ id: device.id });

    // Sign-out revokes it after authentication but before the socket is attached.
    await prisma.session.delete({ where: { id: session.id } });
    await prisma.userDevice.update({
      where: { id: device.id },
      data: { revokedAt: new Date(), revokedBy: "session" },
    });
    const socket = new Socket();
    await hub.attach(authenticated!, socket);
    expect(socket.sent).toContainEqual({ type: "revoked", reason: "session-ended" });
    await expect(
      new UserDevices({ prisma: raw, forwardSecret: "k", hub }).connected(userId),
    ).resolves.toBeNull();
  });

  it("deletes devices and their connections with the user", async () => {
    const other = `${userId}-gone`;
    await prisma.user.create({
      data: { id: other, name: "Gone", email: `${other}@example.test` },
    });
    const device = await prisma.userDevice.create({
      data: { userId: other, name: "Desktop", platform: "win32", tokenHash: `${suffix}-gone` },
    });
    await prisma.userDeviceConnection.create({
      data: { deviceId: device.id, connectionId: `${suffix}-c`, address: "http://127.0.0.1:1" },
    });
    await prisma.user.delete({ where: { id: other } });
    expect(await prisma.userDevice.count({ where: { id: device.id } })).toBe(0);
    expect(await prisma.userDeviceConnection.count({ where: { deviceId: device.id } })).toBe(0);
  });
});
