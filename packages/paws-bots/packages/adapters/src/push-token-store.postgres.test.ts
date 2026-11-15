import { randomUUID } from "node:crypto";
import { createDb, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { credentialDigest } from "./credential-digest.js";
import { PrismaPushTokenStore, PushSessionEndedError } from "./push-token-store.js";

const suite = process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;
suite("database push registrations", () => {
  let a: ReturnType<typeof createDb>;
  let b: ReturnType<typeof createDb>;
  let api: PrismaPushTokenStore;
  let worker: PrismaPushTokenStore;
  const prefix = `push-fixture-${randomUUID()}`;
  const user = (id: string) => `${prefix}-${id}`;
  const session = (id: string) => `${prefix}-session-${id}`;
  const token = (id: string) => `ExponentPushToken[${prefix}-${id}]`;
  beforeAll(async () => {
    a = createDb(process.env.DATABASE_URL!);
    b = createDb(process.env.DATABASE_URL!);
    api = new PrismaPushTokenStore(a.prisma, "offline-push-encryption-key");
    worker = new PrismaPushTokenStore(b.prisma, "offline-push-encryption-key");
    await runAsSystem("seed push registration fixtures", async () => {
      for (const id of ["a", "b", "c"]) {
        await a.prisma.user.create({
          data: { id: user(id), name: "Fixture", email: `${user(id)}@example.invalid` },
        });
        await a.prisma.session.create({
          data: {
            id: session(id),
            token: session(id),
            userId: user(id),
            expiresAt: new Date(Date.now() + 3600_000),
          },
        });
      }
      await a.prisma.session.create({
        data: {
          id: session("a2"),
          token: session("a2"),
          userId: user("a"),
          expiresAt: new Date(Date.now() + 3600_000),
        },
      });
    });
  });
  beforeEach(async () => {
    await runAsSystem("clear fixture push registrations", () =>
      a.prisma.pushToken.deleteMany({ where: { userId: { startsWith: prefix } } }),
    );
  });
  afterAll(async () => {
    if (!a) return;
    await runAsSystem("remove push registration fixtures", () =>
      a.prisma.user.deleteMany({ where: { id: { startsWith: prefix } } }),
    );
    await Promise.all([a.pool.end(), b.pool.end()]);
  });

  it("shares encrypted registrations across independent connections and restricts row access", async () => {
    await api.save(user("a"), token("a"), session("a"));
    expect(await worker.load(user("a"))).toEqual({ token: token("a"), sessionId: session("a") });
    const row = await runAsSystem("inspect fixture ciphertext", () =>
      a.prisma.pushToken.findUniqueOrThrow({ where: { userId: user("a") } }),
    );
    expect(row.ciphertext).not.toContain(token("a"));
    expect(row.tokenDigest).toBe(credentialDigest(token("a")));
    await runAsTenant({ userId: user("b"), spaceId: "unused" }, async () => {
      expect(await a.prisma.pushToken.findMany()).toEqual([]);
    });
  });

  it("keeps the native presentation capability across replicas and clears it on legacy registration", async () => {
    await api.save(user("a"), token("a"), session("a"), "android_sender");
    expect((await worker.load(user("a")))?.presentation).toBe("android_sender");
    await api.save(user("a"), token("a"), session("a"));
    expect((await worker.load(user("a")))?.presentation).toBeUndefined();
  });

  it("serializes concurrent device handovers so only one account owns a token", async () => {
    await Promise.all([
      api.save(user("a"), token("shared"), session("a")),
      worker.save(user("b"), token("shared"), session("b")),
      api.save(user("c"), token("shared"), session("c")),
    ]);
    const registrations = await Promise.all([
      api.load(user("a")),
      worker.load(user("b")),
      api.load(user("c")),
    ]);
    expect(registrations.filter(Boolean)).toHaveLength(1);
  });

  it("keeps newer registrations when an old receipt or logout arrives", async () => {
    await api.save(user("a"), token("a"), session("a"));
    await worker.save(user("a"), token("new"), session("a2"));
    await api.remove(user("a"), credentialDigest(token("a")));
    await api.endSession(user("a"), session("a"));
    expect((await worker.load(user("a")))?.token).toBe(token("new"));
    await api.remove(user("a"), credentialDigest(token("new")));
    expect(await worker.load(user("a"))).toBeUndefined();
  });

  it("retargets only the replaced session and cannot reclaim a handed-over device", async () => {
    await api.save(user("a"), token("shared"), session("a"));
    await worker.endSession(user("a"), session("a"), session("a2"));
    await api.endSession(user("a"), session("a"));
    expect((await worker.load(user("a")))?.sessionId).toBe(session("a2"));
    await worker.save(user("b"), token("shared"), session("b"));
    await api.endSession(user("a"), session("a2"), session("a"));
    expect(await api.load(user("a"))).toBeUndefined();
    expect((await worker.load(user("b")))?.token).toBe(token("shared"));
  });

  it("imports only unclaimed devices and accounts, including concurrent imports", async () => {
    await api.save(user("b"), token("owned"), session("b"));
    expect(await worker.importLegacy(user("a"), token("owned"), session("a"))).toBe(false);
    expect(await worker.load(user("a"))).toBeUndefined();
    expect((await api.load(user("b")))?.token).toBe(token("owned"));
    expect(await worker.importLegacy(user("b"), token("stale"), session("b"))).toBe(false);
    expect((await api.load(user("b")))?.token).toBe(token("owned"));
    const imported = await Promise.all([
      api.importLegacy(user("a"), token("unclaimed"), session("a")),
      worker.importLegacy(user("c"), token("unclaimed"), session("c")),
    ]);
    expect(imported.filter(Boolean)).toHaveLength(1);
  });

  it("lets authenticated registration win a race with legacy import", async () => {
    await Promise.all([
      api.importLegacy(user("a"), token("racing"), session("a")),
      worker.save(user("b"), token("racing"), session("b")),
    ]);
    expect(await api.load(user("a"))).toBeUndefined();
    expect((await worker.load(user("b")))?.token).toBe(token("racing"));
  });

  it("rejects expired, missing and another account's sessions without stealing tokens", async () => {
    await api.save(user("a"), token("shared"), session("a"));
    for (const invalid of [session("missing"), session("a")])
      await expect(worker.save(user("b"), token("shared"), invalid)).rejects.toBeInstanceOf(
        PushSessionEndedError,
      );
    await runAsSystem("expire fixture session", () =>
      a.prisma.session.update({ where: { id: session("c") }, data: { expiresAt: new Date(0) } }),
    );
    await expect(worker.save(user("c"), token("shared"), session("c"))).rejects.toBeInstanceOf(
      PushSessionEndedError,
    );
    expect((await api.load(user("a")))?.token).toBe(token("shared"));
  });

  it("does not publish a registration after a concurrent session deletion commits", async () => {
    let release!: () => void;
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deletion = runAsSystem("delete fixture session concurrently", () =>
      a.prisma.$transaction(async (tx) => {
        await tx.session.delete({ where: { id: session("a2") } });
        locked();
        await hold;
      }),
    );
    await ready;
    const registering = worker.save(user("a"), token("late"), session("a2"));
    // Attach rejection handling before releasing the blocked registration.
    const rejected = expect(registering).rejects.toBeInstanceOf(PushSessionEndedError);
    release();
    await deletion;
    await rejected;
    expect(await api.load(user("a"))).toBeUndefined();
  });
});
