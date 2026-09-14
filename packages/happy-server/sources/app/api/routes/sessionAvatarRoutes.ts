/** Opaque, session-owned encrypted images. No project or bot identity is required. */
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { Fastify } from "../types";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { s3client, s3bucket, isLocalStorage, getLocalFilesDir } from "@/storage/files";
import { eventRouter, buildUpdateSessionUpdate } from "@/app/events/eventRouter";
import { sessionAvatar } from "@/app/session/sessionAvatar";
import { randomKeyNaked } from "@/utils/randomKeyNaked";

const MAX_BYTES = 10 * 1024 * 1024;
const params = z.object({
  sessionId: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .max(256),
});
const fileParams = params.extend({
  avatarFile: z
    .string()
    .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.enc$/i),
});
const descriptor = z
  .object({ ref: z.string().min(1).max(1024), preview: z.string().min(1).max(4096) })
  .strict();

function validRef(id: string, ref: string): boolean {
  const prefix = `sessions/${id}/avatar/`;
  return (
    ref.startsWith(prefix) &&
    fileParams.shape.avatarFile.safeParse(ref.slice(prefix.length)).success
  );
}

function baseUrl(request: { headers: Record<string, string | string[] | undefined> }): string {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
  const host = request.headers["x-forwarded-host"] ?? request.headers.host;
  const proto = request.headers["x-forwarded-proto"] ?? "http";
  const hostname = Array.isArray(host) ? host[0] : host;
  if (typeof hostname === "string" && hostname.length > 0)
    return `${Array.isArray(proto) ? proto[0] : proto}://${hostname}`;
  return `http://localhost:${process.env.PORT || "3005"}`;
}

export function sessionAvatarRoutes(app: Fastify) {
  const limits = new Map<string, { at: number; count: number }>();
  app.addHook("onClose", async () => {
    limits.clear();
  });
  const owned = (id: string, accountId: string) =>
    db.session.findFirst({ where: { id, accountId } });

  async function mutate(
    id: string,
    accountId: string,
    next: { ref: string; preview: string } | null,
  ) {
    const result = await inTx(async (tx) => {
      const current = await tx.session.findFirst({ where: { id, accountId } });
      if (!current) return null;
      if (
        current.avatarRef === (next?.ref ?? null) &&
        current.avatarPreview === (next?.preview ?? null)
      ) {
        return { avatar: sessionAvatar(current) };
      }
      const updated = await tx.session.update({
        where: { id },
        data: {
          avatarRef: next?.ref ?? null,
          avatarPreview: next?.preview ?? null,
          avatarVersion: { increment: 1 },
        },
      });
      // Commit the descriptor, removal revision and event sequence together. Serializable
      // contention uses inTx's bounded retry; a failed transaction publishes no update.
      const account = await tx.account.update({
        where: { id: accountId },
        data: { seq: { increment: 1 } },
        select: { seq: true },
      });
      return {
        avatar: sessionAvatar(updated),
        seq: account.seq,
        avatarVersion: updated.avatarVersion,
      };
    });
    if (result && "seq" in result) {
      eventRouter.emitUpdate({
        userId: accountId,
        payload: buildUpdateSessionUpdate(
          id,
          result.seq!,
          randomKeyNaked(12),
          undefined,
          undefined,
          undefined,
          result.avatar,
          result.avatarVersion,
        ),
        recipientFilter: { type: "all-interested-in-session", sessionId: id },
      });
    }
    return result === null ? null : { avatar: result.avatar };
  }

  app.post(
    "/v1/sessions/:sessionId/avatar/request-upload",
    {
      preHandler: app.authenticate,
      schema: { params, body: z.object({ size: z.number().int().min(1).max(MAX_BYTES) }) },
    },
    async (request, reply) => {
      const session = await owned(request.params.sessionId, request.userId);
      if (!session) return reply.code(404).send({ error: "Session not found" });
      const now = Date.now();
      for (const [key, value] of limits) if (now - value.at >= 60_000) limits.delete(key);
      const limit = limits.get(request.userId) ?? { at: now, count: 0 };
      if (limit.count >= 60 || (!limits.has(request.userId) && limits.size >= 10_000))
        return reply.code(429).send({ error: "Too many avatar uploads. Try again later." });
      limit.count++;
      limits.set(request.userId, limit);
      const file = `${randomUUID()}.enc`;
      const ref = `sessions/${session.id}/avatar/${file}`;
      if (isLocalStorage())
        return reply.send({
          ref,
          method: "PUT",
          uploadUrl: `${baseUrl(request)}/v1/sessions/${session.id}/avatar/${file}`,
        });
      const policy = s3client.newPostPolicy();
      policy.setBucket(s3bucket);
      policy.setKey(ref);
      policy.setExpires(new Date(now + 15 * 60_000));
      policy.setContentLengthRange(1, MAX_BYTES);
      const { postURL, formData } = await s3client.presignedPostPolicy(policy);
      return reply.send({
        ref,
        method: "POST",
        uploadUrl: postURL,
        formFields: formData as Record<string, string>,
      });
    },
  );

  app.put(
    "/v1/sessions/:sessionId/avatar/:avatarFile",
    {
      preHandler: app.authenticate,
      bodyLimit: MAX_BYTES,
      schema: { params: fileParams },
    },
    async (request, reply) => {
      if (!isLocalStorage()) return reply.code(404).send({ error: "Direct upload is unavailable" });
      const { sessionId, avatarFile } = request.params;
      if (!(await owned(sessionId, request.userId)))
        return reply.code(404).send({ error: "Session not found" });
      const bytes = request.body;
      if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_BYTES)
        return reply
          .code(413)
          .send({ error: "Avatar must contain at most 10 MB of encrypted image data" });
      const target = path.join(getLocalFilesDir(), "sessions", sessionId, "avatar", avatarFile);
      await fs.mkdir(path.dirname(target), { recursive: true });
      // Activated references are immutable; replacing a picture always uses a fresh upload.
      try {
        await fs.writeFile(target, bytes, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (!(await fs.readFile(target)).equals(bytes))
          return reply.code(409).send({ error: "Avatar upload already exists" });
      }
      return reply.send({ ok: true });
    },
  );

  app.patch(
    "/v1/sessions/:sessionId/avatar",
    {
      preHandler: app.authenticate,
      schema: { params, body: descriptor },
    },
    async (request, reply) => {
      const { sessionId } = request.params;
      if (!(await owned(sessionId, request.userId)))
        return reply.code(404).send({ error: "Session not found" });
      const { ref } = request.body;
      if (!validRef(sessionId, ref))
        return reply.code(400).send({ error: "Invalid session avatar reference" });
      try {
        const stat = isLocalStorage()
          ? await fs.stat(path.join(getLocalFilesDir(), ref))
          : await s3client.statObject(s3bucket, ref);
        if (stat.size < 1 || stat.size > MAX_BYTES)
          return reply.code(413).send({ error: "Avatar image is too large or empty" });
      } catch {
        return reply.code(404).send({ error: "Avatar upload not found" });
      }
      const result = await mutate(sessionId, request.userId, request.body);
      return result ? reply.send(result) : reply.code(404).send({ error: "Session not found" });
    },
  );

  app.delete(
    "/v1/sessions/:sessionId/avatar",
    {
      preHandler: app.authenticate,
      schema: { params },
    },
    async (request, reply) => {
      const result = await mutate(request.params.sessionId, request.userId, null);
      // Retired blobs are cleaned with the session, not by a racy prefix delete on replacement.
      return result ? reply.send(result) : reply.code(404).send({ error: "Session not found" });
    },
  );

  app.post(
    "/v1/sessions/:sessionId/avatar/request-download",
    {
      preHandler: app.authenticate,
      schema: { params },
    },
    async (request, reply) => {
      const session = await owned(request.params.sessionId, request.userId);
      if (!session?.avatarRef || !validRef(session.id, session.avatarRef))
        return reply.code(404).send({ error: "Session avatar not found" });
      const ref = session.avatarRef;
      const downloadUrl = isLocalStorage()
        ? `${baseUrl(request)}/v1/sessions/${session.id}/avatar/${path.basename(ref)}`
        : await s3client.presignedGetObject(s3bucket, ref, 15 * 60);
      return reply.send({ ref, downloadUrl });
    },
  );

  app.get(
    "/v1/sessions/:sessionId/avatar/:avatarFile",
    {
      preHandler: app.authenticate,
      schema: { params: fileParams },
    },
    async (request, reply) => {
      if (!isLocalStorage())
        return reply.code(404).send({ error: "Direct download is unavailable" });
      const session = await owned(request.params.sessionId, request.userId);
      const ref = `sessions/${request.params.sessionId}/avatar/${request.params.avatarFile}`;
      if (!session || session.avatarRef !== ref)
        return reply.code(404).send({ error: "Session avatar not found" });
      try {
        return reply
          .header("Cache-Control", "private, no-store")
          .type("application/octet-stream")
          .send(await fs.readFile(path.join(getLocalFilesDir(), ref)));
      } catch {
        return reply.code(404).send({ error: "Session avatar not found" });
      }
    },
  );
}
