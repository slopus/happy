import type { PrismaClient } from "@rakazo/db";
import { runAsSystem, withTransactionRetry } from "@rakazo/db";
import { advisoryLock } from "./advisory-lock.js";
import { credentialDigest } from "./credential-digest.js";
import { EncryptedSecretStore } from "./secrets.js";

export interface PushRecord {
  token: string;
  sessionId?: string;
  presentation?: "android_sender";
}

export type CallPushRegistration = {
  deviceId: string;
  platform: "ios" | "android";
  expoToken?: string;
  voipToken?: string;
};
export type CallPushDevice = CallPushRegistration & {
  userId: string;
  sessionId: string;
  revision: string;
};

/** Account-wide registrations, shared by API replicas and notification workers. */
export interface PushTokenStore {
  saveDevice?(userId: string, registration: CallPushRegistration, sessionId: string): Promise<void>;
  devices?(userId: string): Promise<CallPushDevice[]>;
  removeDevice?(
    userId: string,
    deviceId: string,
    revision: string,
    transport?: "voip" | "expo",
  ): Promise<void>;
  load(userId: string): Promise<PushRecord | undefined>;
  save(
    userId: string,
    token: string,
    sessionId: string,
    presentation?: "android_sender",
  ): Promise<void>;
  /** Import only when neither the account nor the device is registered already. */
  importLegacy(userId: string, token: string, sessionId: string): Promise<boolean>;
  remove(userId: string, tokenDigest?: string): Promise<void>;
  endSession(userId: string, sessionId: string, nextSessionId?: string): Promise<void>;
}

export class PushSessionEndedError extends Error {
  constructor() {
    super("Push session ended");
  }
}

export class PrismaPushTokenStore implements PushTokenStore {
  private readonly encryption: EncryptedSecretStore;

  constructor(
    private readonly prisma: PrismaClient,
    encryptionKey: string,
  ) {
    this.encryption = new EncryptedSecretStore(encryptionKey);
  }

  async saveDevice(
    userId: string,
    registration: CallPushRegistration,
    sessionId: string,
  ): Promise<void> {
    const id = credentialDigest(registration.deviceId);
    await runAsSystem("register a call notification device", () =>
      withTransactionRetry(() =>
        this.prisma.$transaction(async (tx) => {
          // Locks are taken in sorted key order so concurrent registrations never deadlock.
          await advisoryLock(tx, "push-device", id, "joined");
          if (registration.expoToken)
            await advisoryLock(tx, "push-expo", credentialDigest(registration.expoToken), "joined");
          await advisoryLock(tx, "push-user", userId, "joined");
          if (registration.voipToken)
            await advisoryLock(tx, "push-voip", credentialDigest(registration.voipToken), "joined");
          const sessions = await tx.$queryRaw<
            Array<{ id: string }>
          >`SELECT id FROM "session" WHERE id = ${sessionId} AND "userId" = ${userId} AND "expiresAt" > CURRENT_TIMESTAMP FOR UPDATE`;
          if (!sessions.length) throw new PushSessionEndedError();
          const existing = await tx.callPushDevice.findUnique({ where: { id } });
          const previous =
            existing?.userId === userId
              ? (JSON.parse(
                  await this.encryption.load(existing.ciphertext, `call-push:${id}`),
                ) as CallPushRegistration)
              : undefined;
          const merged = { ...previous, ...registration };
          const sealed = await this.encryption.put(
            JSON.stringify(merged),
            {
              operationId: "push.register",
              traceId: "push.register",
              spaceId: "",
              userId,
              signal: new AbortController().signal,
            },
            { recordId: `call-push:${id}` },
          );
          const expoTokenDigest = merged.expoToken ? credentialDigest(merged.expoToken) : null;
          const voipTokenDigest = merged.voipToken ? credentialDigest(merged.voipToken) : null;
          // One physical push token has one owner, even after reinstall or account handover.
          const duplicates = [
            ...(expoTokenDigest ? [{ expoTokenDigest }] : []),
            ...(voipTokenDigest ? [{ voipTokenDigest }] : []),
          ];
          if (duplicates.length)
            await tx.callPushDevice.deleteMany({ where: { id: { not: id }, OR: duplicates } });
          const data = {
            userId,
            sessionId,
            ciphertext: sealed.ciphertext,
            expoTokenDigest,
            voipTokenDigest,
          };
          await tx.callPushDevice.upsert({ where: { id }, create: { id, ...data }, update: data });
        }),
      ),
    );
  }

  async devices(userId: string): Promise<CallPushDevice[]> {
    return runAsSystem("load the call owner's devices", async () => {
      const rows = await this.prisma.callPushDevice.findMany({ where: { userId } });
      return Promise.all(
        rows.map(async (row) => ({
          ...(JSON.parse(
            await this.encryption.load(row.ciphertext, `call-push:${row.id}`),
          ) as CallPushRegistration),
          userId,
          sessionId: row.sessionId,
          revision: row.ciphertext,
        })),
      );
    });
  }

  async removeDevice(
    userId: string,
    deviceId: string,
    revision: string,
    transport?: "voip" | "expo",
  ): Promise<void> {
    const id = credentialDigest(deviceId);
    const failed = JSON.parse(
      await this.encryption.load(revision, `call-push:${id}`),
    ) as CallPushRegistration;
    await runAsSystem("remove an invalid call notification token", () =>
      withTransactionRetry(() =>
        this.prisma.$transaction(async (tx) => {
          // Serialized with registration: concurrent invalidations each apply to the latest row.
          await advisoryLock(tx, "push-device", id, "joined");
          const row = await tx.callPushDevice.findUnique({ where: { id } });
          if (row?.userId !== userId) return;
          const registration =
            row.ciphertext === revision
              ? { ...failed }
              : (JSON.parse(
                  await this.encryption.load(row.ciphertext, `call-push:${id}`),
                ) as CallPushRegistration);
          // Only the token that actually failed goes; a newer one registered meanwhile stays.
          if (transport !== "expo" && registration.voipToken === failed.voipToken)
            delete registration.voipToken;
          if (transport !== "voip" && registration.expoToken === failed.expoToken)
            delete registration.expoToken;
          if (!registration.voipToken && !registration.expoToken) {
            await tx.callPushDevice.deleteMany({ where: { id, userId } });
            return;
          }
          const sealed = await this.encryption.put(
            JSON.stringify(registration),
            {
              operationId: "push.invalidate",
              traceId: "push.invalidate",
              spaceId: "",
              userId,
              signal: new AbortController().signal,
            },
            { recordId: `call-push:${id}` },
          );
          await tx.callPushDevice.updateMany({
            where: { id, userId },
            data: {
              ciphertext: sealed.ciphertext,
              voipTokenDigest: registration.voipToken
                ? credentialDigest(registration.voipToken)
                : null,
              expoTokenDigest: registration.expoToken
                ? credentialDigest(registration.expoToken)
                : null,
            },
          });
        }),
      ),
    );
  }

  async load(userId: string): Promise<PushRecord | undefined> {
    return runAsSystem("load an account's notification registration", async () => {
      const row = await this.prisma.pushToken.findUnique({ where: { userId } });
      if (!row) return undefined;
      return {
        token: await this.encryption.load(row.ciphertext, `push-token:${userId}`),
        sessionId: row.sessionId,
        ...(row.presentation === "android_sender"
          ? { presentation: "android_sender" as const }
          : {}),
      };
    });
  }

  async save(
    userId: string,
    token: string,
    sessionId: string,
    presentation?: "android_sender",
  ): Promise<void> {
    await this.register(userId, token, sessionId, "register", presentation);
  }

  importLegacy(userId: string, token: string, sessionId: string): Promise<boolean> {
    return this.register(userId, token, sessionId, "import");
  }

  private async register(
    userId: string,
    token: string,
    sessionId: string,
    mode: "register" | "import",
    presentation?: "android_sender",
  ): Promise<boolean> {
    const value = token.trim();
    if (!value) throw new Error("Push token is empty");
    const tokenDigest = credentialDigest(value);
    const sealed = await this.encryption.put(
      value,
      {
        operationId: "push.register",
        traceId: "push.register",
        spaceId: "",
        userId,
        signal: new AbortController().signal,
      },
      { recordId: `push-token:${userId}` },
    );
    return runAsSystem("register or import a notification device", () =>
      withTransactionRetry(() =>
        this.prisma.$transaction(async (tx) => {
          // Account locks serialize sign-out/replacement; token locks serialize device handover.
          // Keep advisory acquisition ordered; row-lock conflicts during handover are retried.
          await advisoryLock(tx, "push-token", tokenDigest, "joined");
          await advisoryLock(tx, "push-user", userId, "joined");
          // Legacy files are weaker evidence than any existing database registration.
          // Use the same locks as live registration so the check and insert are atomic.
          if (
            mode === "import" &&
            (await tx.pushToken.findFirst({
              where: { OR: [{ userId }, { tokenDigest }] },
              select: { userId: true },
            }))
          )
            return false;
          // Lock the session against deletion until registration commits. A late registration
          // after sign-out cannot publish a token, even when its request authenticated earlier.
          const sessions = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "session" WHERE id = ${sessionId} AND "userId" = ${userId}
          AND "expiresAt" > CURRENT_TIMESTAMP FOR UPDATE`;
          if (!sessions.length) throw new PushSessionEndedError();
          const data = {
            ciphertext: sealed.ciphertext,
            tokenDigest,
            sessionId,
            presentation: presentation ?? null,
          };
          if (mode === "import") await tx.pushToken.create({ data: { userId, ...data } });
          else {
            await tx.pushToken.deleteMany({ where: { tokenDigest, userId: { not: userId } } });
            await tx.pushToken.upsert({
              where: { userId },
              create: { userId, ...data },
              update: data,
            });
          }
          return true;
        }),
      ),
    );
  }

  async remove(userId: string, tokenDigest?: string): Promise<void> {
    await runAsSystem("remove an account's notification registration", () =>
      withTransactionRetry(() =>
        this.prisma.$transaction(async (tx) => {
          await advisoryLock(tx, "push-user", userId, "joined");
          await tx.pushToken.deleteMany({
            where: { userId, ...(tokenDigest ? { tokenDigest } : {}) },
          });
        }),
      ),
    );
  }

  async endSession(userId: string, sessionId: string, nextSessionId?: string): Promise<void> {
    await runAsSystem("revoke or retarget a session's notification registration", () =>
      withTransactionRetry(() =>
        this.prisma.$transaction(async (tx) => {
          await advisoryLock(tx, "push-user", userId, "joined");
          const where = { userId, sessionId };
          // Password changes may retarget a live installation; sign-out revokes both transports.
          if (!nextSessionId) await tx.callPushDevice.deleteMany({ where });
          if (nextSessionId) {
            const session = await tx.session.findFirst({
              where: { id: nextSessionId, userId, expiresAt: { gt: new Date() } },
              select: { id: true },
            });
            if (!session) {
              await tx.callPushDevice.deleteMany({ where });
              await tx.pushToken.deleteMany({ where });
              return;
            }
            await tx.callPushDevice.updateMany({ where, data: { sessionId: nextSessionId } });
            await tx.pushToken.updateMany({ where, data: { sessionId: nextSessionId } });
          } else await tx.pushToken.deleteMany({ where });
        }),
      ),
    );
  }
}
