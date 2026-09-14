import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Fastify } from "../types";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = vi.hoisted(() => {
  const session = {
    id: "s1",
    accountId: "u1",
    avatarRef: null as string | null,
    avatarPreview: null as string | null,
    avatarVersion: 0,
  };
  const objects = new Set<string>();
  const emitUpdate = vi.fn();
  const db = {
    session: {
      findFirst: vi.fn(async ({ where }: any) =>
        where.id === session.id && where.accountId === session.accountId ? { ...session } : null,
      ),
      update: vi.fn(async ({ data }: any) => {
        session.avatarRef = data.avatarRef;
        session.avatarPreview = data.avatarPreview;
        session.avatarVersion++;
        return { ...session };
      }),
    },
    account: { update: vi.fn(async () => ({ seq: session.avatarVersion })) },
  };
  return { session, objects, emitUpdate, db, local: false, directory: "" };
});
vi.mock("@/storage/db", () => ({ db: fixture.db }));
vi.mock("@/storage/inTx", () => ({ inTx: async (fn: any) => fn(fixture.db) }));
vi.mock("@/app/events/eventRouter", () => ({
  eventRouter: { emitUpdate: fixture.emitUpdate },
  buildUpdateSessionUpdate: (
    id: string,
    seq: number,
    updateId: string,
    _m: unknown,
    _s: unknown,
    _p: unknown,
    avatar: unknown,
    avatarVersion: number,
  ) => ({ id: updateId, seq, body: { t: "update-session", id, avatar, avatarVersion } }),
}));
vi.mock("@/storage/files", () => ({
  isLocalStorage: () => fixture.local,
  getLocalFilesDir: () => fixture.directory,
  putLocalFile: vi.fn(),
  s3bucket: "test",
  s3client: {
    newPostPolicy: () => ({
      setBucket() {},
      setKey() {},
      setExpires() {},
      setContentLengthRange() {},
    }),
    presignedPostPolicy: async () => ({
      postURL: "https://files.test/upload",
      formData: { policy: "opaque" },
    }),
    statObject: async (_bucket: string, ref: string) => {
      if (!fixture.objects.has(ref)) throw new Error("missing");
      return { size: 42 };
    },
    presignedGetObject: async () => "https://files.test/download",
  },
}));
import { sessionAvatarRoutes } from "./sessionAvatarRoutes";

describe("session avatar transport", () => {
  let app: Fastify;
  beforeEach(async () => {
    Object.assign(fixture.session, { avatarRef: null, avatarPreview: null, avatarVersion: 0 });
    fixture.objects.clear();
    fixture.local = false;
    fixture.directory = await mkdtemp(join(tmpdir(), "happy-session-avatar-"));
    vi.clearAllMocks();
    const instance = fastify();
    instance.setValidatorCompiler(validatorCompiler);
    instance.setSerializerCompiler(serializerCompiler);
    instance.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body),
    );
    app = instance.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    app.addHook("onRequest", async (request) => {
      if (request.headers["x-hostless"]) delete request.headers.host;
    });
    app.decorate("authenticate", async (request: any, reply: any) => {
      if (!request.headers["x-user"]) return reply.code(401).send({ error: "Unauthorized" });
      request.userId = request.headers["x-user"];
    });
    sessionAvatarRoutes(app);
    await app.ready();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  });
  const headers = { "x-user": "u1" };
  const base = "/v1/sessions/s1/avatar";

  it("uses the configured local port when the request has no usable host", async () => {
    fixture.local = true;
    vi.stubEnv("PUBLIC_URL", "");
    vi.stubEnv("PORT", "4321");
    const upload = await app.inject({
      method: "POST",
      url: `${base}/request-upload`,
      headers: { ...headers, "x-hostless": "true" },
      payload: { size: 42 },
    });
    expect(upload.statusCode).toBe(200);
    expect(upload.json().uploadUrl).toMatch(/^http:\/\/localhost:4321\//);
  });

  it("activates an encrypted upload, publishes it once, and explicitly clears it", async () => {
    const upload = await app.inject({
      method: "POST",
      url: `${base}/request-upload`,
      headers,
      payload: { size: 42 },
    });
    expect(upload.statusCode).toBe(200);
    const { ref } = upload.json();
    expect(ref).toMatch(/^sessions\/s1\/avatar\/[a-f0-9-]+\.enc$/);
    const payload = { ref, preview: "encrypted-preview" };
    expect((await app.inject({ method: "PATCH", url: base, headers, payload })).statusCode).toBe(
      404,
    );
    fixture.objects.add(ref);
    const active = await app.inject({ method: "PATCH", url: base, headers, payload });
    expect(active.json()).toEqual({ avatar: { ...payload, version: 1 } });
    expect(fixture.emitUpdate).toHaveBeenCalledTimes(1);
    await app.inject({ method: "PATCH", url: base, headers, payload });
    expect(fixture.emitUpdate).toHaveBeenCalledTimes(1);
    expect(
      (await app.inject({ method: "POST", url: `${base}/request-download`, headers })).json(),
    ).toEqual({ ref, downloadUrl: "https://files.test/download" });
    expect((await app.inject({ method: "DELETE", url: base, headers })).json()).toEqual({
      avatar: null,
    });
    expect(fixture.emitUpdate.mock.calls.at(-1)?.[0].payload.body.avatar).toBeNull();
    expect(fixture.emitUpdate.mock.calls.at(-1)?.[0].payload.body.avatarVersion).toBe(2);
    await app.inject({ method: "DELETE", url: base, headers });
    expect(fixture.emitUpdate).toHaveBeenCalledTimes(2);
    expect(
      (await app.inject({ method: "POST", url: `${base}/request-download`, headers })).statusCode,
    ).toBe(404);
  });

  it("rejects unauthenticated and cross-account reads and writes", async () => {
    for (const method of ["PATCH", "DELETE", "POST"] as const) {
      const url = method === "POST" ? `${base}/request-download` : base;
      const payload = method === "PATCH" ? { ref: "x", preview: "opaque" } : undefined;
      expect((await app.inject({ method, url, payload })).statusCode).toBe(401);
      expect(
        (await app.inject({ method, url, payload, headers: { "x-user": "u2" } })).statusCode,
      ).toBe(404);
    }
    expect(fixture.db.session.update).not.toHaveBeenCalled();
  });

  it("rejects foreign refs, path traversal, and oversized uploads", async () => {
    for (const ref of [
      "sessions/s2/avatar/00000000-0000-4000-8000-000000000000.enc",
      "sessions/s1/avatar/../../secret",
      "projects/p1/avatar/x.enc",
    ]) {
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: base,
            headers,
            payload: { ref, preview: "opaque" },
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${base}/request-upload`,
          headers,
          payload: { size: 11 * 1024 * 1024 },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("serves only activated local bytes, supports upload retries, and rejects overwrites", async () => {
    fixture.local = true;
    const upload = await app.inject({
      method: "POST",
      url: `${base}/request-upload`,
      headers,
      payload: { size: 3 },
    });
    const { ref, uploadUrl, method } = upload.json();
    expect(method).toBe("PUT");
    const url = new URL(uploadUrl).pathname;
    const request = {
      method: "PUT" as const,
      url,
      headers: { ...headers, "content-type": "application/octet-stream" },
      payload: Buffer.from("abc"),
    };
    expect((await app.inject(request)).statusCode).toBe(200);
    expect((await app.inject(request)).statusCode).toBe(200);
    expect((await app.inject({ ...request, payload: Buffer.from("xyz") })).statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(404);
    await app.inject({
      method: "PATCH",
      url: base,
      headers,
      payload: { ref, preview: "ciphertext" },
    });
    const bytes = await app.inject({ method: "GET", url, headers });
    expect(bytes.rawPayload).toEqual(Buffer.from("abc"));
    expect((await app.inject({ method: "GET", url, headers: { "x-user": "u2" } })).statusCode).toBe(
      404,
    );
    await app.inject({ method: "DELETE", url: base, headers });
    expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(404);
  });
});
