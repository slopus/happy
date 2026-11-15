import type { UserDeviceHub, UserDeviceRevokeReason, UserDevices } from "@rakazo/adapters";
import {
  createUserDeviceToken,
  hashUserDeviceToken,
  USER_DEVICE_DISCONNECT_PATH,
  USER_DEVICE_FORWARD_PATH,
  USER_DEVICE_LIMIT,
  userDeviceDisconnectBody,
  userDeviceForwardBody,
  validUserDeviceForwardSecret,
} from "@rakazo/adapters";
import type { UserDeviceList, UserDevicePairResponse } from "@rakazo/contracts";
import {
  USER_DEVICE_CONNECT_PATH,
  USER_DEVICE_PAIR_PATH,
  USER_DEVICE_PATH,
  USER_DEVICE_SESSION_PATH,
  userDevicePairRequest,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { recordSecurityEvent, runAsSystem } from "@rakazo/db";
import type { Hono } from "hono";
import { lockOwner } from "./availability.js";
import { readBoundedBody } from "./http-body.js";

const FORWARD_BODY_MAX_BYTES = 13 * 1024 * 1024;

export interface UserDeviceRouteDeps {
  prisma: PrismaClient;
  hub: UserDeviceHub;
  devices: UserDevices;
  forwardSecret: string;
  session: (request: Request) => Promise<{ userId: string; sessionId: string } | null>;
  trustedOrigin: (origin: string) => boolean;
}

export type DeviceStore = { prisma: PrismaClient; devices: UserDevices };

async function revokeDevice(
  { prisma, devices }: DeviceStore,
  deviceId: string,
  userId: string,
  by: "owner" | "device" | "session",
  /** For a session revoke, the sign-in it was selected under; a device tied since is left alone. */
  sessionId?: string | null,
) {
  const { count } = await runAsSystem("revoke a user device", () =>
    prisma.userDevice.updateMany({
      where: { id: deviceId, userId, revokedAt: null, ...(by === "session" ? { sessionId } : {}) },
      data: { revokedAt: new Date(), revokedBy: by },
    }),
  );
  if (!count) return false;
  await recordSecurityEvent({ type: "device.revoked", userId, metadata: { deviceId, by } });
  const reason: UserDeviceRevokeReason | undefined = by === "session" ? "session-ended" : undefined;
  await devices.disconnect(deviceId, reason);
  return true;
}

/**
 * A computer stays paired only while the sign-in that paired it lasts, so signing out, a password
 * reset or signing out everywhere disconnects it. A password change that keeps the caller signed
 * in moves the caller's computers to the replacing session. A computer paired before sessions were
 * recorded is tied to none, so it ends only once the user has no sign-in left; its desktop app ties
 * it to its own sign-in when it next connects.
 */
export async function endUserDeviceSession(
  store: DeviceStore,
  ended: { id: string; userId: string },
  next?: { id: string },
) {
  const { prisma } = store;
  const { userId } = ended;
  if (next) {
    await runAsSystem("move user devices to a new session", () =>
      prisma.userDevice.updateMany({
        where: { userId, sessionId: ended.id, revokedAt: null },
        data: { sessionId: next.id },
      }),
    );
    return;
  }
  const signedIn = await runAsSystem("check for a user's remaining sign-ins", () =>
    prisma.session.findFirst({
      where: { userId, expiresAt: { gt: new Date() } },
      select: { id: true },
    }),
  );
  const devices = await runAsSystem("find a session's user devices", () =>
    prisma.userDevice.findMany({
      where: {
        userId,
        revokedAt: null,
        OR: [{ sessionId: ended.id }, ...(signedIn ? [] : [{ sessionId: null }])],
      },
      select: { id: true, sessionId: true },
    }),
  );
  for (const device of devices)
    await revokeDevice(store, device.id, userId, "session", device.sessionId);
}

/**
 * Disconnects every computer the user paired, as when their last sign-in ends. One that fails
 * does not keep the others paired; the failures are reported together at the end.
 */
export async function revokeUserDevices(store: DeviceStore, userId: string) {
  const devices = await runAsSystem("find a user's devices", () =>
    store.prisma.userDevice.findMany({
      where: { userId, revokedAt: null },
      select: { id: true },
    }),
  );
  const failures: unknown[] = [];
  // Without a session to match: a computer moved to a new sign-in meanwhile goes too.
  for (const device of devices)
    await revokeDevice(store, device.id, userId, "session").catch((error: unknown) =>
      failures.push(error),
    );
  if (failures.length) throw new AggregateError(failures, "Could not disconnect every computer");
}

/** The device socket itself is upgraded by the hub before Hono sees it. */
export function mountUserDeviceRoutes(app: Hono, deps: UserDeviceRouteDeps) {
  const { prisma } = deps;
  app.use(`${USER_DEVICE_PATH}/*`, async (c, next) => {
    await next();
    c.header("cache-control", "no-store");
  });

  app.post(USER_DEVICE_PAIR_PATH, async (c) => {
    // The desktop main process sends no Origin. A JSON content type forces a CORS preflight,
    // so a cross-site page cannot pair with the user's cookie either way.
    const origin = c.req.header("origin");
    if (origin && !deps.trustedOrigin(origin)) return c.json({ error: "Forbidden" }, 403);
    if (!c.req.header("content-type")?.startsWith("application/json"))
      return c.json({ error: "Expected JSON" }, 415);
    const session = await deps.session(c.req.raw);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const { userId, sessionId } = session;
    await deps.devices.releaseSignedOut(userId);
    const body = await readBoundedBody(c.req.raw, 4096);
    if (body === null) return c.json({ error: "Request too large" }, 413);
    const input = userDevicePairRequest.safeParse(parseJson(body));
    if (!input.success) return c.json({ error: "Invalid device" }, 400);
    const token = createUserDeviceToken();
    const device = await runAsSystem("pair a user device", () =>
      prisma.$transaction(async (tx) => {
        // Hold the account's pairing lock across the count and the insert, so pairings
        // that race cannot each see the limit as still open.
        await lockOwner(tx, userId, "user-devices");
        const active = await tx.userDevice.count({ where: { userId, revokedAt: null } });
        if (active >= USER_DEVICE_LIMIT) return null;
        return tx.userDevice.create({
          data: {
            userId,
            name: input.data.name,
            platform: input.data.platform,
            tokenHash: hashUserDeviceToken(token),
            sessionId,
          },
          select: { id: true },
        });
      }),
    );
    if (!device) return c.json({ error: "Remove a computer before adding another" }, 409);
    await recordSecurityEvent({
      type: "device.paired",
      userId,
      metadata: { deviceId: device.id, platform: input.data.platform },
    });
    return c.json({ deviceId: device.id, userId, token } satisfies UserDevicePairResponse, 201);
  });

  app.get(USER_DEVICE_PATH, async (c) => {
    const session = await deps.session(c.req.raw);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    await deps.devices.releaseSignedOut(session.userId);
    return c.json({
      devices: await deps.devices.list(session.userId),
    } satisfies UserDeviceList);
  });

  app.get(USER_DEVICE_CONNECT_PATH, (c) => c.json({ error: "Upgrade required" }, 426));

  app.post(USER_DEVICE_SESSION_PATH, async (c) => {
    const device = await deps.hub.authenticate(c.req.header("authorization"));
    const session = await deps.session(c.req.raw);
    if (!device || !session) return c.json({ error: "Unauthorized" }, 401);
    if (device.userId !== session.userId) return c.json({ error: "Forbidden" }, 403);
    const { count } = await runAsSystem("tie a user device to its sign-in", () =>
      prisma.userDevice.updateMany({
        where: { id: device.id, userId: device.userId, revokedAt: null, sessionId: null },
        data: { sessionId: session.sessionId },
      }),
    );
    if (!count) return c.body(null, 204);
    // A sign-out that ran while this was tying would have missed it.
    const live = await runAsSystem("check a tied sign-in", () =>
      prisma.session.findFirst({
        where: { id: session.sessionId, expiresAt: { gt: new Date() } },
        select: { id: true },
      }),
    );
    if (!live) {
      await revokeDevice(deps, device.id, device.userId, "session", session.sessionId);
      return c.json({ error: "Unauthorized" }, 401);
    }
    await recordSecurityEvent({
      type: "device.tied",
      userId: device.userId,
      metadata: { deviceId: device.id },
    });
    return c.body(null, 204);
  });

  // Registered before `:deviceId` so "self" is never read as an id.
  app.delete(`${USER_DEVICE_PATH}/self`, async (c) => {
    const device = await deps.hub.authenticate(c.req.header("authorization"));
    if (!device) return c.json({ error: "Unauthorized" }, 401);
    await revokeDevice(deps, device.id, device.userId, "device");
    return c.body(null, 204);
  });

  app.delete(`${USER_DEVICE_PATH}/:deviceId`, async (c) => {
    const session = await deps.session(c.req.raw);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const revoked = await revokeDevice(deps, c.req.param("deviceId"), session.userId, "owner");
    return revoked ? c.body(null, 204) : c.json({ error: "Not found" }, 404);
  });

  app.post(USER_DEVICE_FORWARD_PATH, async (c) => {
    if (!validUserDeviceForwardSecret(deps.forwardSecret, c.req.header("authorization")))
      return c.json({ error: "Unauthorized" }, 401);
    const body = await readBoundedBody(c.req.raw, FORWARD_BODY_MAX_BYTES);
    if (body === null) return c.json({ error: "Request too large" }, 413);
    const input = userDeviceForwardBody.safeParse(parseJson(body));
    if (!input.success) return c.json({ error: "Invalid request" }, 400);
    const { request, ...route } = input.data;
    return deps.hub.stream(route, request, c.req.raw.signal);
  });

  app.post(USER_DEVICE_DISCONNECT_PATH, async (c) => {
    if (!validUserDeviceForwardSecret(deps.forwardSecret, c.req.header("authorization")))
      return c.json({ error: "Unauthorized" }, 401);
    const body = await readBoundedBody(c.req.raw, 1024);
    const input = userDeviceDisconnectBody.safeParse(parseJson(body ?? ""));
    if (!input.success) return c.json({ error: "Invalid request" }, 400);
    deps.hub.disconnect(input.data.deviceId, input.data.reason);
    return c.body(null, 204);
  });
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}
