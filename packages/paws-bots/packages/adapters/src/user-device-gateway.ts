import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { networkInterfaces } from "node:os";
import type { Duplex } from "node:stream";
import type { UserDeviceSummary } from "@rakazo/contracts";
import { USER_DEVICE_CONNECT_PATH } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { recordSecurityEvent, runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { WebSocketServer } from "ws";
import { z } from "zod";
import type { HostComputerFrame, HostComputerRequest } from "./host-computer-protocol.js";
import {
  HOST_COMPUTER_MAX_BYTES,
  hostComputerDeadlineMs,
  hostComputerRequest,
} from "./host-computer-protocol.js";
import type {
  UserDevice,
  UserDeviceGateway,
  UserDeviceRevokeReason,
} from "./user-device-protocol.js";
import {
  USER_DEVICE_REVOKED_HEADER,
  userDeviceClientMessage,
  userDeviceRevokeReason,
} from "./user-device-protocol.js";

/** Internal API endpoints other processes forward to. Not under /api, so the public proxy never routes them. */
export const USER_DEVICE_FORWARD_PATH = "/internal/user-devices/request";
export const USER_DEVICE_DISCONNECT_PATH = "/internal/user-devices/disconnect";
export const USER_DEVICE_OFFLINE_MESSAGE =
  "Your computer is not connected. Open the Rakazo desktop app.";
const DISCONNECTED_MESSAGE = "Your computer disconnected. Check the result before retrying.";
const REVOKED_MESSAGE = "This computer was disconnected from Rakazo.";
export const USER_DEVICE_LIMIT = 10;
const PING_INTERVAL_MS = 25_000;
/** A connection row older than this has lost its holding process. */
const STALE_AFTER_MS = 3 * PING_INTERVAL_MS;
const MAX_MESSAGE_BYTES = HOST_COMPUTER_MAX_BYTES + 64 * 1024;

export class UserDeviceOfflineError extends Error {
  constructor(message = USER_DEVICE_OFFLINE_MESSAGE, options?: ErrorOptions) {
    super(message, options);
    this.name = "UserDeviceOfflineError";
  }
}

export function createUserDeviceToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashUserDeviceToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function userDeviceBearer(header: string | null | undefined): string | null {
  const match = /^Bearer ([a-f0-9]{64})$/.exec(header ?? "");
  return match?.[1] ?? null;
}

/** API and worker share ENCRYPTION_KEY; forwarding uses a key derived from it for this purpose only. */
export function userDeviceForwardSecret(encryptionKey: string): string {
  return createHmac("sha256", encryptionKey).update("rakazo:user-device-forward:v1").digest("hex");
}

export function validUserDeviceForwardSecret(expected: string, header: string | null | undefined) {
  const supplied = /^Bearer (.+)$/.exec(header ?? "")?.[1];
  if (!supplied) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The base URL other processes reach this API process at; a bound wildcard host uses the first network address. */
export function userDeviceInternalAddress(host: string, port: number): string {
  let address = host;
  if (!host || host === "0.0.0.0" || host === "::") {
    const candidates = Object.values(networkInterfaces())
      .flat()
      .filter((entry) => entry && !entry.internal);
    address =
      candidates.find((entry) => entry?.family === "IPv4")?.address ??
      candidates.find((entry) => entry?.family === "IPv6" && !entry.address.startsWith("fe80"))
        ?.address ??
      "127.0.0.1";
  }
  return `http://${address.includes(":") ? `[${address}]` : address}:${port}`;
}

/** The subset of a `ws` socket the hub uses, so tests can pass a fake. */
export interface UserDeviceSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  ping(): void;
  terminate(): void;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "pong", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

interface AuthenticatedDevice {
  id: string;
  userId: string;
  name: string;
  platform: string;
}

interface LiveDevice {
  device: AuthenticatedDevice;
  connectionId: string;
  socket: UserDeviceSocket;
  pending: Map<string, FrameQueue>;
  alive: boolean;
}

export interface UserDeviceRoute {
  deviceId: string;
  userId: string;
  connectionId: string;
}

/** Why a device was revoked, as the device is told. */
function revokeReason(revokedBy: string | null): UserDeviceRevokeReason | undefined {
  return revokedBy === "session" ? "session-ended" : undefined;
}

/** Sessions among these that were deleted or have expired. */
async function endedSessions(prisma: PrismaClient, sessionIds: string[]): Promise<Set<string>> {
  if (!sessionIds.length) return new Set();
  const live = await runAsSystem("check user device sessions", () =>
    prisma.session.findMany({
      where: { id: { in: sessionIds }, expiresAt: { gt: new Date() } },
      select: { id: true },
    }),
  );
  const kept = new Set(live.map((session) => session.id));
  return new Set(sessionIds.filter((id) => !kept.has(id)));
}

/** Users among these with no sign-in left. */
async function signedOutUsers(prisma: PrismaClient, userIds: string[]): Promise<Set<string>> {
  if (!userIds.length) return new Set();
  const live = await runAsSystem("check users' remaining sign-ins", () =>
    prisma.session.findMany({
      where: { userId: { in: userIds }, expiresAt: { gt: new Date() } },
      select: { userId: true },
      distinct: ["userId"],
    }),
  );
  const kept = new Set(live.map((session) => session.userId));
  return new Set(userIds.filter((id) => !kept.has(id)));
}

/**
 * Revokes the devices whose pairing sign-in was deleted or expired without its sign-out hook
 * revoking them, and those paired before sign-ins were recorded once their user has none left.
 * Returns the ids it revoked.
 */
async function revokeSignedOut(
  prisma: PrismaClient,
  devices: { id: string; userId: string; sessionId: string | null }[],
): Promise<string[]> {
  const [ended, signedOut] = await Promise.all([
    endedSessions(
      prisma,
      devices.flatMap((device) => (device.sessionId ? [device.sessionId] : [])),
    ),
    signedOutUsers(prisma, [
      ...new Set(devices.filter((device) => !device.sessionId).map((device) => device.userId)),
    ]),
  ]);
  const revoked: string[] = [];
  for (const device of devices.filter((device) =>
    device.sessionId ? ended.has(device.sessionId) : signedOut.has(device.userId),
  )) {
    // Matching the session too leaves a device a password change or a tie just moved alone.
    const { count } = await runAsSystem("revoke a user device whose sign-in ended", () =>
      prisma.userDevice.updateMany({
        where: { id: device.id, sessionId: device.sessionId, revokedAt: null },
        data: { revokedAt: new Date(), revokedBy: "session" },
      }),
    );
    if (!count) continue;
    await recordSecurityEvent({
      type: "device.revoked",
      userId: device.userId,
      metadata: { deviceId: device.id, by: "session" },
    });
    revoked.push(device.id);
  }
  return revoked;
}

/**
 * Holds the live device sockets of one API process. Connections are recorded in the database
 * with this process's internal address so the worker and other API processes can forward.
 */
export class UserDeviceHub {
  readonly address: string;
  private readonly live = new Map<string, LiveDevice>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      address: string;
      pingIntervalMs?: number;
    },
  ) {
    this.address = deps.address;
    this.timer = setInterval(() => void this.heartbeat(), deps.pingIntervalMs ?? PING_INTERVAL_MS);
    this.timer.unref();
  }

  async authenticate(header: string | null | undefined): Promise<AuthenticatedDevice | null> {
    return (await this.lookup(header)).device ?? null;
  }

  /** The device a token belongs to, or why it was turned away. */
  private async lookup(
    header: string | null | undefined,
  ): Promise<{ device?: AuthenticatedDevice; reason?: UserDeviceRevokeReason }> {
    const token = userDeviceBearer(header);
    if (!token) return {};
    const hash = hashUserDeviceToken(token);
    const device = await runAsSystem("authenticate a user device", () =>
      this.deps.prisma.userDevice.findUnique({
        where: { tokenHash: hash },
        select: {
          id: true,
          userId: true,
          name: true,
          platform: true,
          tokenHash: true,
          revokedAt: true,
          revokedBy: true,
          sessionId: true,
        },
      }),
    );
    // The lookup is by hash; compare again in constant time so a lookup quirk never authorizes.
    if (!device || !timingSafeEqual(Buffer.from(device.tokenHash), Buffer.from(hash))) return {};
    if (device.revokedAt) return { reason: revokeReason(device.revokedBy) };
    if ((await revokeSignedOut(this.deps.prisma, [device])).length)
      return { reason: "session-ended" };
    return {
      device: {
        id: device.id,
        userId: device.userId,
        name: device.name,
        platform: device.platform,
      },
    };
  }

  /** Node `upgrade` listener for the device socket path; every other upgrade is refused. */
  handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Until ws takes over the socket, a client reset (say during the token lookup) would
    // otherwise crash the process.
    const onError = (error: Error) =>
      getLogger().warn("user device upgrade socket error", { error });
    socket.on("error", onError);
    const reject = (status: number, text: string, reason?: UserDeviceRevokeReason) => {
      const why = reason ? `${USER_DEVICE_REVOKED_HEADER}: ${reason}\r\n` : "";
      socket.end(
        `HTTP/1.1 ${status} ${text}\r\n${why}Connection: close\r\nContent-Length: 0\r\n\r\n`,
      );
    };
    const path = new URL(request.url ?? "/", "http://device").pathname;
    if (path !== USER_DEVICE_CONNECT_PATH || this.closed) return reject(404, "Not Found");
    void this.lookup(request.headers.authorization)
      .then(({ device, reason }) => {
        if (!device) return reject(401, "Unauthorized", reason);
        socket.off("error", onError);
        this.wss.handleUpgrade(request, socket, head, (ws) => {
          void this.attach(device, ws).catch((error) => {
            getLogger().error("user device attach failed", error);
            ws.close(1011, "Unavailable");
          });
        });
      })
      .catch((error) => {
        getLogger().error("user device upgrade failed", error);
        reject(500, "Internal Server Error");
      });
  };

  /** Registers a connected device socket; a newer socket for the same device replaces the older. */
  async attach(device: AuthenticatedDevice, socket: UserDeviceSocket): Promise<string> {
    const connectionId = randomUUID();
    const entry: LiveDevice = { device, connectionId, socket, pending: new Map(), alive: true };
    const previous = this.live.get(device.id);
    this.live.set(device.id, entry);
    if (previous) this.drop(previous, DISCONNECTED_MESSAGE, [4000, "Replaced"]);
    socket.on("pong", () => {
      entry.alive = true;
    });
    socket.on("message", (data) => this.receive(entry, data));
    // An oversized or malformed frame must close this device, never crash the process.
    socket.on("error", (error) => {
      getLogger().warn("user device socket error", { error });
      socket.terminate();
    });
    socket.on("close", () => {
      if (this.live.get(device.id) !== entry) return;
      this.drop(entry, DISCONNECTED_MESSAGE);
    });
    const now = new Date();
    await runAsSystem("record a user device connection", () =>
      this.deps.prisma.$transaction(async (tx) => {
        await tx.userDeviceConnection.upsert({
          where: { deviceId: device.id },
          create: {
            deviceId: device.id,
            connectionId,
            address: this.address,
            connectedAt: now,
            heartbeatAt: now,
          },
          update: { connectionId, address: this.address, connectedAt: now, heartbeatAt: now },
        });
        await tx.userDevice.update({ where: { id: device.id }, data: { lastSeenAt: now } });
      }),
    );
    // A sign-out that revoked this device while it was connecting found no socket to close.
    const current = await runAsSystem("recheck a connected user device", () =>
      this.deps.prisma.userDevice.findUnique({
        where: { id: device.id },
        select: { id: true, userId: true, revokedAt: true, revokedBy: true, sessionId: true },
      }),
    );
    if (current?.revokedAt) this.disconnect(device.id, revokeReason(current.revokedBy));
    else if (current && (await revokeSignedOut(this.deps.prisma, [current])).length)
      this.disconnect(device.id, "session-ended");
    return connectionId;
  }

  holds(route: UserDeviceRoute): boolean {
    const entry = this.live.get(route.deviceId);
    return Boolean(
      entry && entry.connectionId === route.connectionId && entry.device.userId === route.userId,
    );
  }

  /** Raw HostComputerFrame values from the device for one request. */
  async *frames(
    route: UserDeviceRoute,
    request: HostComputerRequest,
    signal: AbortSignal,
  ): AsyncIterable<unknown> {
    const entry = this.live.get(route.deviceId);
    if (!entry || !this.holds(route)) throw new UserDeviceOfflineError();
    signal.throwIfAborted();
    const id = randomUUID();
    const queue = new FrameQueue();
    entry.pending.set(id, queue);
    const abort = () => queue.fail(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    let finished = false;
    try {
      entry.socket.send(JSON.stringify({ type: "request", id, request }));
      for await (const frame of queue) {
        if (isTerminal(frame)) finished = true;
        yield frame;
        if (finished) return;
      }
    } finally {
      signal.removeEventListener("abort", abort);
      entry.pending.delete(id);
      // Aborted, timed out, or the consumer stopped early: tell the device to stop the work.
      if (!finished && !queue.lost && this.live.get(route.deviceId) === entry) {
        try {
          entry.socket.send(JSON.stringify({ type: "cancel", id }));
        } catch {
          // The socket is closing; its close handler fails the rest.
        }
      }
    }
  }

  /** NDJSON stream of frames for a forwarded request; a failure becomes an error frame. */
  stream(route: UserDeviceRoute, request: HostComputerRequest, signal: AbortSignal): Response {
    if (!this.holds(route)) return new Response(null, { status: 409 });
    const controller = new AbortController();
    const linked = AbortSignal.any([signal, controller.signal]);
    const iterator = this.frames(route, request, linked)[Symbol.asyncIterator]();
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async pull(stream) {
        try {
          const next = await iterator.next();
          if (next.done) stream.close();
          else stream.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
        } catch (error) {
          const message = error instanceof Error ? error.message : DISCONNECTED_MESSAGE;
          stream.enqueue(encoder.encode(`${JSON.stringify({ error: message })}\n`));
          stream.close();
        }
      },
      async cancel(reason) {
        controller.abort(reason);
        await iterator.return?.();
      },
    });
    return new Response(body, {
      headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
    });
  }

  /** Closes this process's socket for a device and fails its in-flight requests. */
  disconnect(deviceId: string, reason?: UserDeviceRevokeReason): void {
    const entry = this.live.get(deviceId);
    if (!entry) return;
    try {
      entry.socket.send(JSON.stringify({ type: "revoked", reason }));
    } catch {
      // Closing anyway.
    }
    this.drop(entry, REVOKED_MESSAGE, [4001, "Revoked"]);
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    const entries = [...this.live.values()];
    for (const entry of entries)
      this.drop(entry, DISCONNECTED_MESSAGE, [1001, "Server restarting"]);
    this.wss.close();
    if (entries.length)
      await runAsSystem("forget user device connections", () =>
        this.deps.prisma.userDeviceConnection.deleteMany({
          where: { connectionId: { in: entries.map((entry) => entry.connectionId) } },
        }),
      ).catch(() => undefined);
  }

  private receive(entry: LiveDevice, data: unknown) {
    const text = String(data);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const message = userDeviceClientMessage.safeParse(parsed);
    if (!message.success) return;
    entry.pending.get(message.data.id)?.push(message.data.frame, text.length);
  }

  /** Forgets a connection and fails its requests; without a close code the socket is dead and is terminated. */
  private drop(entry: LiveDevice, message: string, close?: [code: number, reason: string]) {
    if (this.live.get(entry.device.id) === entry) this.live.delete(entry.device.id);
    for (const queue of entry.pending.values()) queue.fail(new Error(message), true);
    entry.pending.clear();
    try {
      if (close) entry.socket.close(...close);
      else entry.socket.terminate();
    } catch {
      entry.socket.terminate();
    }
    void runAsSystem("forget a user device connection", () =>
      this.deps.prisma.userDeviceConnection.deleteMany({
        where: { connectionId: entry.connectionId },
      }),
    ).catch((error) => getLogger().warn("user device connection cleanup failed", { error }));
  }

  private async heartbeat() {
    const entries = [...this.live.values()];
    for (const entry of entries) {
      if (!entry.alive) {
        this.drop(entry, DISCONNECTED_MESSAGE);
        continue;
      }
      entry.alive = false;
      try {
        entry.socket.ping();
      } catch {
        this.drop(entry, DISCONNECTED_MESSAGE);
      }
    }
    const live = [...this.live.values()];
    if (!live.length) return;
    try {
      const now = new Date();
      const devices = await runAsSystem("refresh user device connections", () =>
        this.deps.prisma.$transaction(async (tx) => {
          await tx.userDeviceConnection.updateMany({
            where: { connectionId: { in: live.map((entry) => entry.connectionId) } },
            data: { heartbeatAt: now },
          });
          await tx.userDevice.updateMany({
            where: { id: { in: live.map((entry) => entry.device.id) } },
            data: { lastSeenAt: now },
          });
          return tx.userDevice.findMany({
            where: { id: { in: live.map((entry) => entry.device.id) } },
            select: { id: true, userId: true, revokedAt: true, revokedBy: true, sessionId: true },
          });
        }),
      );
      // A revoke whose direct disconnect did not reach this process still closes here.
      for (const device of devices.filter((device) => device.revokedAt))
        this.disconnect(device.id, revokeReason(device.revokedBy));
      const signedOut = await revokeSignedOut(
        this.deps.prisma,
        devices.filter((device) => !device.revokedAt),
      );
      for (const id of signedOut) this.disconnect(id, "session-ended");
    } catch (error) {
      getLogger().warn("user device heartbeat failed", { error });
    }
  }
}

/**
 * Reaches the requesting user's connected device from any API or worker process: directly when
 * this process holds the socket, otherwise over internal HTTP to the process that does.
 */
export class UserDevices implements UserDeviceGateway {
  private readonly fetch: typeof fetch;

  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      /** userDeviceForwardSecret(ENCRYPTION_KEY). */
      forwardSecret: string;
      /** Present in API processes, which hold device sockets. */
      hub?: UserDeviceHub;
      fetch?: typeof fetch;
    },
  ) {
    this.fetch = deps.fetch ?? fetch;
  }

  async connected(userId: string): Promise<UserDevice | null> {
    const route = await this.route(userId);
    return route && { deviceId: route.deviceId, name: route.name, platform: route.platform };
  }

  /** Revokes the user's devices whose pairing sign-in ended while they were offline. */
  async releaseSignedOut(userId: string): Promise<void> {
    const devices = await runAsSystem("find a user's signed-in devices", () =>
      this.deps.prisma.userDevice.findMany({
        where: { userId, revokedAt: null },
        select: { id: true, userId: true, sessionId: true },
      }),
    );
    for (const id of await revokeSignedOut(this.deps.prisma, devices))
      await this.disconnect(id, "session-ended");
  }

  /** The user's paired devices, newest first, each with its own live connection. */
  async list(userId: string): Promise<UserDeviceSummary[]> {
    const devices = await runAsSystem("list a user's devices", () =>
      this.deps.prisma.userDevice.findMany({
        where: { userId, revokedAt: null },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          connections: {
            where: { heartbeatAt: { gt: new Date(Date.now() - STALE_AFTER_MS) } },
            select: { deviceId: true },
          },
        },
      }),
    );
    return devices.map((device) => ({
      deviceId: device.id,
      name: device.name,
      connected: device.connections.length > 0,
    }));
  }

  async pairedSince(userId: string): Promise<Date | null> {
    const device = await runAsSystem("find a user's paired device", () =>
      this.deps.prisma.userDevice.findFirst({
        where: { userId, revokedAt: null },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      }),
    );
    return device?.createdAt ?? null;
  }

  async *request<T>(
    userId: string,
    request: HostComputerRequest,
    signal: AbortSignal,
    deviceId?: string,
  ): AsyncIterable<T> {
    const body = JSON.stringify(request);
    if (Buffer.byteLength(body) > HOST_COMPUTER_MAX_BYTES)
      throw new Error("Request to your computer is too large");
    const route = await this.route(userId, deviceId);
    if (!route) throw new UserDeviceOfflineError();
    const deadline = AbortSignal.any([
      signal,
      AbortSignal.timeout(hostComputerDeadlineMs(request)),
    ]);
    const target = { deviceId: route.deviceId, userId, connectionId: route.connectionId };
    const frames = this.deps.hub?.holds(target)
      ? this.deps.hub.frames(target, request, deadline)
      : this.forward(route.address, target, request, deadline);
    yield* framesToValues<T>(frames, deadline);
  }

  /** Closes the device's socket wherever it is held. Best effort; heartbeats close it otherwise. */
  async disconnect(deviceId: string, reason?: UserDeviceRevokeReason): Promise<void> {
    this.deps.hub?.disconnect(deviceId, reason);
    const connection = await runAsSystem("find a user device connection", () =>
      this.deps.prisma.userDeviceConnection.findUnique({ where: { deviceId } }),
    );
    if (!connection || connection.address === this.deps.hub?.address) return;
    await this.fetch(new URL(USER_DEVICE_DISCONNECT_PATH, connection.address), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.deps.forwardSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId, reason }),
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    })
      .then((response) => response.body?.cancel())
      .catch((error) => getLogger().warn("user device disconnect forward failed", { error }));
  }

  private async route(userId: string, deviceId?: string) {
    const connection = await runAsSystem("find a user's connected device", () =>
      this.deps.prisma.userDeviceConnection.findFirst({
        where: {
          heartbeatAt: { gt: new Date(Date.now() - STALE_AFTER_MS) },
          device: { userId, revokedAt: null },
          ...(deviceId ? { deviceId } : {}),
        },
        orderBy: { connectedAt: "desc" },
        include: { device: { select: { name: true, platform: true } } },
      }),
    );
    if (!connection) return null;
    return {
      deviceId: connection.deviceId,
      connectionId: connection.connectionId,
      address: connection.address,
      name: connection.device.name,
      platform: connection.device.platform,
    };
  }

  private async *forward(
    address: string,
    route: UserDeviceRoute,
    request: HostComputerRequest,
    signal: AbortSignal,
  ): AsyncIterable<unknown> {
    let response: Response;
    try {
      response = await this.fetch(new URL(USER_DEVICE_FORWARD_PATH, address), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.deps.forwardSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ...route, request }),
        signal,
        redirect: "error",
      });
    } catch (error) {
      signal.throwIfAborted();
      throw new UserDeviceOfflineError(undefined, { cause: error });
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new UserDeviceOfflineError();
    }
    yield* ndjson(response.body, signal);
  }
}

/** Body of a forwarded request; the forward secret authorizes it. */
export const userDeviceDisconnectBody = z.object({
  deviceId: z.string().min(1).max(64),
  reason: userDeviceRevokeReason.optional(),
});

export const userDeviceForwardBody = z.object({
  deviceId: z.string().min(1).max(64),
  userId: z.string().min(1).max(128),
  connectionId: z.string().min(1).max(64),
  request: hostComputerRequest,
});

async function* framesToValues<T>(
  frames: AsyncIterable<unknown>,
  signal: AbortSignal,
): AsyncIterable<T> {
  for await (const raw of frames) {
    signal.throwIfAborted();
    const frame = hostFrame<T>(raw);
    if (!frame) throw new Error("Your computer sent an invalid response");
    if ("error" in frame) throw new Error(frame.error);
    if ("heartbeat" in frame) continue;
    if ("done" in frame) return;
    yield frame.value;
  }
  signal.throwIfAborted();
  throw new Error(DISCONNECTED_MESSAGE);
}

function hostFrame<T>(value: unknown): HostComputerFrame<T> | null {
  if (!value || typeof value !== "object") return null;
  const frame = value as Record<string, unknown>;
  if (typeof frame.error === "string") return { error: frame.error };
  if (frame.heartbeat === true) return { heartbeat: true };
  if (frame.done === true) return { done: true };
  if ("value" in frame) return { value: frame.value as T };
  return null;
}

function isTerminal(frame: unknown) {
  const parsed = hostFrame(frame);
  return !parsed || "error" in parsed || "done" in parsed;
}

async function* ndjson(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const reader = body.getReader();
  const abort = () => void reader.cancel(signal.reason).catch(() => undefined);
  signal.addEventListener("abort", abort, { once: true });
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) return;
      pending += decoder.decode(chunk.value, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        if (newline > MAX_MESSAGE_BYTES)
          throw new Error("Response from your computer is too large");
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        yield JSON.parse(line) as unknown;
        newline = pending.indexOf("\n");
      }
      if (pending.length > MAX_MESSAGE_BYTES)
        throw new Error("Response from your computer is too large");
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Buffers device frames for one request until its consumer reads them. */
class FrameQueue implements AsyncIterable<unknown> {
  private readonly items: Array<{ frame: unknown; size: number }> = [];
  private bytes = 0;
  private error: unknown;
  private failed = false;
  /** The connection went away, so there is no device to cancel on. */
  lost = false;
  private wake?: () => void;

  push(frame: unknown, size: number) {
    if (this.failed) return;
    this.bytes += size;
    if (this.bytes > 2 * MAX_MESSAGE_BYTES) {
      this.fail(new Error("Response from your computer is too large"));
      return;
    }
    this.items.push({ frame, size });
    this.wake?.();
  }

  fail(error: unknown, lost = false) {
    if (this.failed) return;
    this.failed = true;
    this.lost = lost;
    this.error = error;
    this.wake?.();
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.failed) throw this.error;
      const next = this.items.shift();
      if (next) {
        this.bytes -= next.size;
        yield next.frame;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }
}
