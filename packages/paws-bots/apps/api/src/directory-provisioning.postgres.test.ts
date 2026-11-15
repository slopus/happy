import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TransactionalEmailProvider } from "@rakazo/adapter-kit";
import { FakeSandboxProvider } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, bootstrapUserSpace, createRepos, reserveBotEmailSend } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppHandles } from "./app.js";
import { createApp } from "./app.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const describePostgres = databaseUrl ? describe : describe.skip;
const webOrigin = "http://127.0.0.1:5173";
const token = "scim-test-token-0123456789abcdef0123456789";
const authSecret = "directory-test-secret-with-32-characters";
const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

describePostgres("directory provisioning over SCIM (PostgreSQL)", () => {
  let handles: AppHandles;
  let system: PrismaClient;
  let dataDir: string;
  const sent: string[] = [];
  const email: TransactionalEmailProvider = {
    describe: () => ({
      id: "offline-email",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { transactional: true },
    }),
    send: async (message) => {
      sent.push(message.text);
    },
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "rakazo-directory-"));
    handles = await createApp({
      databaseUrl: databaseUrl!,
      dataDir,
      sandboxProvider: "docker",
      sandbox: new FakeSandboxProvider(),
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      signupAllowlist: "",
      webOrigin,
      authUrl: webOrigin,
      authSecret,
      scimBearerToken: token,
      email,
    });
    system = asSystem(handles.prisma);
  });
  afterAll(async () => {
    await handles?.stop();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  function scim(method: string, path: string, body?: unknown, bearer: string | null = token) {
    return handles.app.request(`/api/auth/scim/v2${path}`, {
      method,
      headers: {
        "content-type": "application/scim+json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  function auth(path: string, body?: object, cookie?: string) {
    return handles.app.request(`/api/auth${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        origin: webOrigin,
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  const cookieOf = (response: Response) =>
    response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; ");
  /** Signs in with an emailed code, as a directory account without a password would. */
  async function signInWithCode(address: string) {
    sent.length = 0;
    const requested = await auth("/email-otp/send-verification-otp", {
      email: address,
      type: "sign-in",
    });
    expect(requested.status).toBe(200);
    await expect.poll(() => sent.length).toBeGreaterThan(0);
    const otp = sent.at(-1)!.match(/\b\d{6}\b/)![0];
    return auth("/sign-in/email-otp", { email: address, otp });
  }
  const userResource = (userName: string, externalId: string, active = true) => ({
    schemas: [USER_SCHEMA],
    userName,
    externalId,
    name: { givenName: "Ada", familyName: "Lovelace" },
    emails: [{ value: userName, type: "work", primary: true }],
    active,
  });
  /** A session row written straight to the database, as one racing a deactivation would be. */
  async function rawSession(userId: string) {
    const raw = `raw-${userId}-${Date.now()}`;
    await system.session.create({
      data: { id: raw, token: raw, userId, expiresAt: new Date(Date.now() + 3_600_000) },
    });
    const signed = `${raw}.${createHmac("sha256", authSecret).update(raw).digest("base64")}`;
    return () =>
      handles.app.request("/api/auth/get-session", {
        headers: { origin: webOrigin, authorization: `Bearer ${signed}` },
      });
  }
  const accountOf = (address: string) =>
    system.user.findUniqueOrThrow({ where: { email: address } });
  const securityEvents = (userId: string) =>
    system.securityEvent.findMany({
      where: { userId, type: { in: ["auth.account.deactivated", "auth.account.reactivated"] } },
      orderBy: { createdAt: "asc" },
    });

  it("answers only the operator's token, and only for users", async () => {
    expect((await scim("GET", "/Users", undefined, null)).status).toBe(401);
    expect(
      (await scim("GET", "/Users", undefined, "wrong-token-0123456789abcdef01234")).status,
    ).toBe(401);
    expect((await scim("GET", "/Users")).status).toBe(200);
    expect((await scim("GET", "/Groups")).status).toBe(403);
    const created = await scim("POST", "/Groups", {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
      displayName: "Everyone",
    });
    expect(created.status).toBe(403);
  });

  it.each(["PUT", "PATCH"])(
    "blocks bot sending after a directory email change through %s until the new mailbox is verified",
    async (method) => {
      const externalId = randomUUID();
      const address = `${externalId}@example.test`;
      const replacement = `new-${address}`;
      const created = await scim("POST", "/Users", userResource(address, externalId));
      expect(created.status).toBe(201);
      const resource = (await created.json()) as { id: string };
      const user = await accountOf(address);
      await system.user.update({ where: { id: user.id }, data: { emailVerified: true } });
      const update = (email: string) =>
        scim(
          method,
          `/Users/${resource.id}`,
          method === "PUT"
            ? userResource(email, externalId)
            : {
                schemas: [PATCH_SCHEMA],
                Operations: [
                  {
                    op: "replace",
                    value: {
                      userName: email,
                      emails: [{ value: email, type: "work", primary: true }],
                    },
                  },
                ],
              },
        );
      expect((await update(address)).status).toBe(200);
      expect((await accountOf(address)).emailVerified).toBe(true);
      const reserve = (email: string) =>
        reserveBotEmailSend(handles.prisma, {
          userId: user.id,
          botId: "directory-fixture",
          recipients: [email],
        });
      expect(await reserve(address)).toHaveProperty("id");

      expect((await update(replacement)).status).toBe(200);
      expect(await accountOf(replacement)).toMatchObject({ id: user.id, emailVerified: false });
      expect(await reserve(replacement)).toBe("unverified");
      expect(await system.botEmailSend.count({ where: { userId: user.id } })).toBe(1);

      await system.user.update({ where: { id: user.id }, data: { emailVerified: true } });
      expect(await reserve(replacement)).toHaveProperty("id");
    },
  );

  it("provisions a person, turns them off with a full replace, and back on with a patch", async () => {
    const address = "ada@example.test";
    const created = await scim("POST", "/Users", userResource(address, "directory-ada"));
    expect(created.status).toBe(201);
    const resource = (await created.json()) as { id: string; active: boolean };
    expect(resource.active).toBe(true);
    const found = await scim(
      "GET",
      `/Users?filter=${encodeURIComponent(`userName eq "${address}"`)}`,
    );
    expect(await found.json()).toMatchObject({ totalResults: 1, Resources: [{ id: resource.id }] });
    const ada = await accountOf(address);
    expect(ada).toMatchObject({ deactivatedAt: null, emailVerified: false });
    // The directory made this account, so its first SSO sign-in may claim it.
    expect(
      (await system.scimSubject.findUniqueOrThrow({ where: { userId: ada.id } })).profileSourceId,
    ).toEqual(expect.any(String));

    // The directory admits Ada even though nobody invited her; she signs in with an emailed code.
    const signedIn = await signInWithCode(address);
    expect(signedIn.status).toBe(200);
    const cookie = cookieOf(signedIn);
    expect(await (await auth("/get-session", undefined, cookie)).json()).toMatchObject({
      user: { id: ada.id },
    });
    expect(await (await (await rawSession(ada.id))()).json()).toMatchObject({
      user: { id: ada.id },
    });
    const membership = await system.spaceMember.findFirstOrThrow({ where: { userId: ada.id } });
    const bot = await createRepos(system).createBot(
      { userId: ada.id, spaceId: membership.spaceId, email: address, isDeploymentOwner: false },
      { name: "Helper", description: "", instructions: "", notifyOnFinish: false },
    );
    const thread = await system.thread.findFirstOrThrow({ where: { botId: bot.id } });
    const { screenGeneration } = await system.bot.findUniqueOrThrow({ where: { id: bot.id } });
    const queuedRun = {
      userId: ada.id,
      spaceId: membership.spaceId,
      botId: bot.id,
      threadId: thread.id,
    };
    const task = await system.task.create({
      data: { ...queuedRun, prompt: "fixture", status: "queued" },
    });
    const queued = await system.run.create({
      data: { ...queuedRun, taskId: task.id, trigger: "chat", status: "queued" },
    });

    // Some providers replace the whole user with active: false.
    const off = await scim(
      "PUT",
      `/Users/${resource.id}`,
      userResource(address, "directory-ada", false),
    );
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ active: false });
    expect((await accountOf(address)).deactivatedAt).toBeInstanceOf(Date);
    expect(await system.session.count({ where: { userId: ada.id } })).toBe(0);
    expect(await (await auth("/get-session", undefined, cookie)).json()).toBeNull();
    // A sign-in that slipped in around the deactivation is refused when it is used.
    const racing = await rawSession(ada.id);
    expect(await (await racing()).json()).toBeNull();
    expect((await system.run.findUniqueOrThrow({ where: { id: queued.id } })).status).toBe(
      "cancelled",
    );
    const refused = await signInWithCode(address);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "ACCOUNT_DEACTIVATED" });
    // Ada's content stays, and screen links issued to her stop working.
    expect(await system.bot.findUniqueOrThrow({ where: { id: bot.id } })).toMatchObject({
      screenGeneration: screenGeneration + 1,
    });
    const space = await system.space.findUniqueOrThrow({ where: { id: membership.spaceId } });
    expect(
      await system.auditEvent.findFirst({
        where: { organizationId: space.organizationId, action: "auth.account.deactivated" },
      }),
    ).toMatchObject({
      actorType: "system",
      actorLabel: "directory",
      targetType: "user",
      targetId: ada.id,
      targetLabel: address,
    });

    // Repeating the change finishes anything that slipped past the first one (the session
    // above, a run started meanwhile) and records nothing new.
    const lateTask = await system.task.create({
      data: { ...queuedRun, prompt: "fixture", status: "queued" },
    });
    const late = await system.run.create({
      data: { ...queuedRun, taskId: lateTask.id, trigger: "chat", status: "queued" },
    });
    expect(await system.session.count({ where: { userId: ada.id } })).toBe(1);
    const again = await scim(
      "PUT",
      `/Users/${resource.id}`,
      userResource(address, "directory-ada", false),
    );
    expect(again.status).toBe(200);
    expect(await system.session.count({ where: { userId: ada.id } })).toBe(0);
    expect((await system.run.findUniqueOrThrow({ where: { id: late.id } })).status).toBe(
      "cancelled",
    );

    // A sign-in that slipped in around the deactivation does not come back to life with her.
    await rawSession(ada.id);
    expect(await system.session.count({ where: { userId: ada.id } })).toBe(1);

    // Others patch with a capitalized op and a string boolean.
    const on = await scim("PATCH", `/Users/${resource.id}`, {
      schemas: [PATCH_SCHEMA],
      Operations: [{ op: "Replace", path: "active", value: "True" }],
    });
    expect([200, 204]).toContain(on.status);
    expect((await accountOf(address)).deactivatedAt).toBeNull();
    expect(await system.session.count({ where: { userId: ada.id } })).toBe(0);
    expect((await signInWithCode(address)).status).toBe(200);
    expect((await securityEvents(ada.id)).map((event) => event.type)).toEqual([
      "auth.account.deactivated",
      "auth.account.reactivated",
    ]);
  });

  it("leaves an account whose email nobody proved to the operator", async () => {
    const address = "squatted@example.test";
    expect(
      (await auth("/sign-up/email", { email: address, password: "test-password-123", name: "X" }))
        .status,
    ).toBe(200);
    const refused = await scim("POST", "/Users", userResource(address, "directory-squatted"));
    expect(refused.status).toBe(409);
    expect(await system.scimUser.count({ where: { primaryEmail: address } })).toBe(0);
    expect((await accountOf(address)).deactivatedAt).toBeNull();
  });

  it("takes over an account whose stored email differs only in case", async () => {
    const stored = "Mixed.Case@Example.test";
    const user = await system.user.create({
      data: { id: "mixed-case-user", name: "Mixed", email: stored, emailVerified: true },
    });
    const linked = await scim(
      "POST",
      "/Users",
      userResource("mixed.case@example.test", "directory-mixed"),
    );
    expect(linked.status).toBe(201);
    expect(
      await system.user.count({ where: { email: { equals: stored, mode: "insensitive" } } }),
    ).toBe(1);
    expect(await system.scimUser.findFirstOrThrow({ where: { userId: user.id } })).toBeTruthy();
  });

  it("leaves two accounts that differ only by case to the operator", async () => {
    await system.user.createMany({
      data: [
        { id: "twin-1", name: "Twin", email: "Twin@Example.test", emailVerified: true },
        { id: "twin-2", name: "Twin", email: "twin@EXAMPLE.test", emailVerified: true },
      ],
    });
    const refused = await scim(
      "POST",
      "/Users",
      userResource("twin@example.test", "directory-twin"),
    );
    expect(refused.status).toBe(409);
    expect(
      await system.user.count({
        where: { email: { equals: "twin@example.test", mode: "insensitive" } },
      }),
    ).toBe(2);
  });

  it("refuses to provision a chat-app address", async () => {
    const address = "someone@messaging.invalid";
    const refused = await scim("POST", "/Users", userResource(address, "directory-chat"));
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    expect(await system.user.count({ where: { email: address } })).toBe(0);
  });

  it("keeps a deleted person's account and finds it again when they come back", async () => {
    const address = "grace@example.test";
    const first = (await (
      await scim("POST", "/Users", userResource(address, "directory-grace"))
    ).json()) as { id: string };
    const grace = await accountOf(address);

    const off = await scim("PATCH", `/Users/${first.id}`, {
      schemas: [PATCH_SCHEMA],
      Operations: [{ op: "Replace", path: "active", value: "False" }],
    });
    expect([200, 204]).toContain(off.status);
    expect((await scim("DELETE", `/Users/${first.id}`)).status).toBe(204);
    expect(await accountOf(address)).toMatchObject({ id: grace.id });
    expect((await accountOf(address)).deactivatedAt).toBeInstanceOf(Date);
    expect((await scim("GET", `/Users/${first.id}`)).status).toBe(404);

    const again = await scim("POST", "/Users", userResource(address, "directory-grace"));
    expect(again.status).toBe(201);
    expect(await accountOf(address)).toMatchObject({ id: grace.id, deactivatedAt: null });
  });

  it("takes a turned-off person out of spaces they were invited into, keeping ones they own", async () => {
    const owner = await system.user.create({
      data: { id: randomUUID(), name: "Olive", email: "olive@example.test", emailVerified: true },
    });
    const personal = await bootstrapUserSpace(system, owner, {
      signupsEnabled: "true",
      signupAllowlist: "",
    });
    const { organizationId } = await system.space.findUniqueOrThrow({
      where: { id: personal.spaceId },
    });
    const spaceId = randomUUID();
    await system.space.create({
      data: { id: spaceId, organizationId, name: "Launch", createdByUserId: owner.id },
    });
    await system.spaceMember.create({
      data: {
        id: randomUUID(),
        spaceId,
        organizationId,
        userId: owner.id,
        role: "owner",
        createdAt: new Date(),
      },
    });
    const address = "nora@example.test";
    const resource = (await (
      await scim("POST", "/Users", userResource(address, "directory-nora"))
    ).json()) as { id: string };
    const nora = await accountOf(address);
    // A full member of the owner's organization: invited into Launch, and owner of a space of
    // her own there that the owner joined.
    const joined = { organizationId, userId: nora.id, createdAt: new Date() };
    await system.member.create({ data: { id: randomUUID(), ...joined, role: "member" } });
    await system.spaceMember.create({
      data: { id: randomUUID(), ...joined, spaceId, role: "member" },
    });
    const notes = randomUUID();
    await system.space.create({
      data: { id: notes, organizationId, name: "Field notes", createdByUserId: nora.id },
    });
    await system.spaceMember.create({
      data: { id: randomUUID(), ...joined, spaceId: notes, role: "owner" },
    });
    await system.spaceMember.create({
      data: {
        id: randomUUID(),
        organizationId,
        userId: owner.id,
        spaceId: notes,
        role: "member",
        createdAt: new Date(),
      },
    });
    const bot = await createRepos(system).createBot(
      { userId: nora.id, spaceId, email: address, isDeploymentOwner: false },
      { name: "Scout", description: "", instructions: "", notifyOnFinish: false },
    );
    const thread = await system.thread.findFirstOrThrow({ where: { botId: bot.id } });
    // Nora's run is working in the shared chat, and the owner's next message waits behind it.
    const shared = { spaceId, botId: bot.id, threadId: thread.id, userId: nora.id };
    const task = await system.task.create({
      data: { ...shared, prompt: "fixture", status: "running" },
    });
    const running = await system.run.create({
      data: { ...shared, taskId: task.id, trigger: "user", status: "running" },
    });
    const waiting = await system.message.create({
      data: {
        threadId: thread.id,
        seq: 1_000,
        role: "user",
        authorUserId: owner.id,
        blocks: [{ kind: "text", text: "Also this" }],
      },
    });
    await system.steeringMessage.create({
      data: { messageId: waiting.id, botId: bot.id, userId: owner.id },
    });

    const off = await scim("PATCH", `/Users/${resource.id}`, {
      schemas: [PATCH_SCHEMA],
      Operations: [{ op: "Replace", path: "active", value: "False" }],
    });
    expect([200, 204]).toContain(off.status);
    expect(await system.spaceMember.count({ where: { spaceId, userId: nora.id } })).toBe(0);
    // The space she owns stays hers, and with it her place in the organization.
    expect(
      await system.spaceMember.findUniqueOrThrow({
        where: { spaceId_userId: { spaceId: notes, userId: nora.id } },
      }),
    ).toMatchObject({ role: "owner" });
    expect(await system.member.count({ where: { organizationId, userId: nora.id } })).toBe(1);
    expect(await system.bot.findUniqueOrThrow({ where: { id: bot.id } })).toMatchObject({
      userId: owner.id,
      spaceId,
    });
    expect(await system.thread.findFirstOrThrow({ where: { botId: bot.id } })).toMatchObject({
      userId: owner.id,
    });
    expect((await system.run.findUniqueOrThrow({ where: { id: running.id } })).status).toBe(
      "cancelled",
    );
    // Started for the owner; the worker may already have picked it up.
    expect(
      await system.run.findFirstOrThrow({
        where: { threadId: thread.id, sourceMessageId: waiting.id },
      }),
    ).toMatchObject({ userId: owner.id });

    // Turning them back on restores sign-in, not the membership: the owner invites them again.
    const on = await scim("PATCH", `/Users/${resource.id}`, {
      schemas: [PATCH_SCHEMA],
      Operations: [{ op: "Replace", path: "active", value: "True" }],
    });
    expect([200, 204]).toContain(on.status);
    expect((await accountOf(address)).deactivatedAt).toBeNull();
    expect(await system.spaceMember.count({ where: { spaceId, userId: nora.id } })).toBe(0);
  });

  it("takes over an existing account without changing it, and leaves others alone", async () => {
    const credentials = { email: "carol@example.test", password: "test-password-123" };
    const signedUp = await auth("/sign-up/email", { ...credentials, name: "Carol" });
    expect(signedUp.status).toBe(200);
    const bystander = { email: "dave@example.test", password: "test-password-123" };
    const daveSignedUp = await auth("/sign-up/email", { ...bystander, name: "Dave" });
    const daveCookie = cookieOf(daveSignedUp);
    const carol = await accountOf(credentials.email);
    // Carol opened the link in her verification email.
    await system.user.update({ where: { id: carol.id }, data: { emailVerified: true } });

    const linked = await scim("POST", "/Users", {
      ...userResource(credentials.email, "directory-carol"),
      name: { givenName: "Someone", familyName: "Else" },
    });
    expect(linked.status).toBe(201);
    const resource = (await linked.json()) as { id: string };
    expect(await accountOf(credentials.email)).toMatchObject({ id: carol.id, name: "Carol" });
    // Taken over, not made: SSO sign-in never claims it by email.
    expect(
      (await system.scimSubject.findUniqueOrThrow({ where: { userId: carol.id } })).profileSourceId,
    ).toBeNull();

    await scim("PATCH", `/Users/${resource.id}`, {
      schemas: [PATCH_SCHEMA],
      Operations: [{ op: "replace", value: { active: false } }],
    });
    const refused = await auth("/sign-in/email", credentials);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "ACCOUNT_DEACTIVATED" });
    expect(await (await auth("/get-session", undefined, daveCookie)).json()).toMatchObject({
      user: { email: bystander.email },
    });
    expect((await auth("/sign-in/email", bystander)).status).toBe(200);
  });
});
