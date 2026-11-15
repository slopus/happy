import { randomUUID } from "node:crypto";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { VoiceAccountError } from "@rakazo/adapter-kit";
import { asSystem, createDb, runAsTenant } from "@rakazo/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { serializeModelSecret } from "./model-secret.js";
import { EncryptedSecretStore } from "./secrets.js";
import { MODEL_CONNECTION_VOICE_SECRET, resolveVoiceKey } from "./voice-model-connection.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

const TOKEN_URL = "https://auth.x.ai/oauth2/token";

describePostgres("voice through a Grok sign-in (PostgreSQL contract)", () => {
  const db = databaseUrl ? createDb(databaseUrl) : undefined;
  const users: string[] = [];
  const secrets = new EncryptedSecretStore("test-only-encryption-key");

  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    if (!db) return;
    const prisma = asSystem(db.prisma);
    await prisma.organization.deleteMany({ where: { id: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  // A user whose only xAI model connection is a sign-in due for a refresh.
  async function seed() {
    const prisma = db!.prisma;
    const id = randomUUID();
    users.push(id);
    const scope = { userId: id, spaceId: id };
    const fixture = asSystem(prisma);
    await fixture.user.create({
      data: { id, name: "Voice test", email: `${id}@example.test`, emailVerified: true },
    });
    await fixture.organization.create({
      data: { id, name: "Voice test", slug: id, createdAt: new Date() },
    });
    await fixture.space.create({
      data: { id, organizationId: id, name: "Voice test", isDefault: true },
    });
    const credential: OAuthCredential = {
      type: "oauth",
      access: "acc-0",
      refresh: "rt-0",
      expires: Date.now() - 1,
    };
    const stored = await secrets.put(serializeModelSecret({ kind: "oauth", credential }), {
      operationId: "test",
      traceId: "test",
      spaceId: id,
      userId: id,
      signal: new AbortController().signal,
    });
    await fixture.secret.create({
      data: { id: stored.id, userId: id, kind: "model", ciphertext: stored.ciphertext },
    });
    await fixture.userModelCredential.create({
      data: { userId: id, provider: "xai", label: "xAI", secretId: stored.id },
    });
    const storedModelSecret = async () => {
      const row = await fixture.secret.findUniqueOrThrow({ where: { id: stored.id } });
      return JSON.parse(await secrets.load(row.ciphertext, row.id));
    };
    const resolve = () =>
      runAsTenant(scope, () =>
        resolveVoiceKey(
          { prisma, secretStore: secrets },
          scope,
          "xai",
          MODEL_CONNECTION_VOICE_SECRET,
        ),
      );
    return { resolve, storedModelSecret };
  }

  /** xAI's token endpoint, answering refreshes with `reply`; other requests fail the test. */
  function tokenEndpoint(reply: () => Response) {
    const refreshes: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url !== TOKEN_URL) throw new Error(`Unexpected request to ${url}`);
        const form = new URLSearchParams(String(init?.body ?? ""));
        refreshes.push(form.get("refresh_token") ?? "");
        return reply();
      }),
    );
    return refreshes;
  }

  it("refreshes an expired sign-in once, keeps the rotated token, and speaks with it", async () => {
    const { resolve, storedModelSecret } = await seed();
    const refreshes = tokenEndpoint(() =>
      Response.json({ access_token: "acc-1", refresh_token: "rt-1", expires_in: 3600 }),
    );

    expect(await resolve()).toBe("acc-1");
    expect(await storedModelSecret()).toMatchObject({ access: "acc-1", refresh: "rt-1" });
    // The next request reads the saved token instead of spending the refresh token again.
    expect(await resolve()).toBe("acc-1");
    expect(refreshes).toEqual(["rt-0"]);
  });

  it("asks to connect xAI again once the sign-in is revoked", async () => {
    const { resolve, storedModelSecret } = await seed();
    tokenEndpoint(() =>
      Response.json(
        { error: "invalid_grant", error_description: "refresh token revoked" },
        { status: 400 },
      ),
    );

    const failure = await resolve().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(VoiceAccountError);
    expect(failure).toMatchObject({ code: undefined, message: "Connect xAI in Models settings." });
    // The revoked tokens are gone; Models shows the connection as needing a new sign-in.
    expect(await storedModelSecret()).toMatchObject({ reconnectRequired: true });
  });
});
