import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, bootstrapUserSpace, createDb, createRepos } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres("the operator's account status command (PostgreSQL)", { timeout: 120_000 }, () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  beforeAll(() => {
    db = createDb(databaseUrl!);
    system = asSystem(db.prisma);
  });
  afterAll(async () => {
    await db?.prisma.$disconnect();
    await db?.pool.end();
  });

  const scim = { SCIM_BEARER_TOKEN: "test-directory-token-0123456789abcdef" };
  const command = (...args: string[]) => commandWith({}, ...args);
  function commandWith(env: Record<string, string>, ...args: string[]) {
    const { SCIM_BEARER_TOKEN: _off, ...rest } = process.env;
    return run(
      "pnpm",
      ["--filter", "@rakazo/api", "exec", "tsx", "src/cli/account-status.ts", ...args],
      { env: { ...rest, ...env } },
    );
  }

  async function person(email: string) {
    const user = await system.user.create({
      data: { id: randomUUID(), name: "Erin", email, emailVerified: true },
    });
    const { spaceId } = await bootstrapUserSpace(system, user, {
      signupsEnabled: "true",
      signupAllowlist: "",
    });
    const bot = await createRepos(system).createBot(
      { userId: user.id, spaceId, email, isDeploymentOwner: false },
      { name: "Helper", description: "", instructions: "", notifyOnFinish: false },
    );
    const thread = await system.thread.findFirstOrThrow({ where: { botId: bot.id } });
    const ids = { userId: user.id, spaceId, botId: bot.id, threadId: thread.id };
    const task = await system.task.create({
      data: { ...ids, prompt: "fixture", status: "queued" },
    });
    const queued = await system.run.create({
      data: { ...ids, taskId: task.id, trigger: "chat", status: "queued" },
    });
    await system.session.create({
      data: {
        id: randomUUID(),
        token: randomUUID(),
        userId: user.id,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    return { user, queued };
  }

  it("deactivates and reactivates an account by email", async () => {
    const { user, queued } = await person("erin@example.test");
    const other = await person("frank@example.test");

    const off = await command("deactivate", "Erin@Example.test");
    expect(off.stdout.trim()).toBe("Deactivated");
    expect(
      (await system.user.findUniqueOrThrow({ where: { id: user.id } })).deactivatedAt,
    ).toBeInstanceOf(Date);
    expect(await system.session.count({ where: { userId: user.id } })).toBe(0);
    expect((await system.run.findUniqueOrThrow({ where: { id: queued.id } })).status).toBe(
      "cancelled",
    );
    expect(await system.session.count({ where: { userId: other.user.id } })).toBe(1);
    expect((await system.run.findUniqueOrThrow({ where: { id: other.queued.id } })).status).toBe(
      "queued",
    );
    expect((await command("deactivate", "erin@example.test")).stdout.trim()).toBe(
      "Already deactivated",
    );

    expect((await command("reactivate", "erin@example.test")).stdout.trim()).toBe("Reactivated");
    expect(
      (await system.user.findUniqueOrThrow({ where: { id: user.id } })).deactivatedAt,
    ).toBeNull();
    expect((await command("reactivate", "erin@example.test")).stdout.trim()).toBe("Already active");

    const events = await system.securityEvent.findMany({
      where: { userId: user.id, type: { startsWith: "auth.account." } },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((event) => [event.type, event.metadata])).toEqual([
      ["auth.account.deactivated", { by: "operator" }],
      ["auth.account.reactivated", { by: "operator" }],
    ]);
    expect(
      await system.auditEvent.findFirst({
        where: { action: "auth.account.deactivated", targetId: user.id },
      }),
    ).toMatchObject({ actorType: "system", actorLabel: "operator", targetLabel: user.email });
  });

  it("takes a deactivated person out of a teammate's space", async () => {
    const owner = await person("liam@example.test");
    const { user: mia } = await person("mia@example.test");
    const { organizationId } = await system.space.findUniqueOrThrow({
      where: { id: owner.queued.spaceId },
    });
    const spaceId = randomUUID();
    await system.space.create({
      data: { id: spaceId, organizationId, name: "Launch", createdByUserId: owner.user.id },
    });
    const at = new Date();
    await system.spaceMember.create({
      data: {
        id: randomUUID(),
        spaceId,
        organizationId,
        userId: owner.user.id,
        role: "owner",
        createdAt: at,
      },
    });
    await system.member.create({
      data: { id: randomUUID(), organizationId, userId: mia.id, role: "guest", createdAt: at },
    });
    await system.spaceMember.create({
      data: {
        id: randomUUID(),
        spaceId,
        organizationId,
        userId: mia.id,
        role: "member",
        createdAt: at,
      },
    });
    const bot = await createRepos(system).createBot(
      { userId: mia.id, spaceId, email: mia.email, isDeploymentOwner: false },
      { name: "Scout", description: "", instructions: "", notifyOnFinish: false },
    );

    expect((await command("deactivate", mia.email)).stdout.trim()).toBe("Deactivated");
    expect(await system.spaceMember.count({ where: { spaceId, userId: mia.id } })).toBe(0);
    expect((await system.bot.findUniqueOrThrow({ where: { id: bot.id } })).userId).toBe(
      owner.user.id,
    );
    // Their own space stays theirs.
    expect(await system.spaceMember.count({ where: { userId: mia.id } })).toBe(1);
  });

  it("refuses an unknown email or action", async () => {
    await expect(command("deactivate", "nobody@example.test")).rejects.toMatchObject({
      stderr: expect.stringContaining("No single account has that email"),
    });
    await expect(command("delete", "erin@example.test")).rejects.toMatchObject({
      stderr: expect.stringContaining("Usage: account-status.js deactivate|reactivate <email>"),
    });
  });

  it("leaves an account the identity provider turned off for the provider to turn on", async () => {
    const { user } = await person("gwen@example.test");
    const now = new Date();
    await system.scimUser.create({
      data: {
        id: randomUUID(),
        connectionId: "directory",
        provisioningDomainId: "directory",
        userId: user.id,
        connectionUserKey: randomUUID(),
        userName: user.email,
        userNameKey: randomUUID(),
        primaryEmail: user.email,
        workEmailValueIndex: "",
        emailValueIndex: "",
        displayName: "Gwen",
        formattedName: "Gwen",
        serializedEmails: "[]",
        active: false,
        orderKey: randomUUID(),
        createdAt: now,
        updatedAt: now,
      },
    });
    await system.user.update({ where: { id: user.id }, data: { deactivatedAt: now } });

    await expect(commandWith(scim, "reactivate", user.email)).rejects.toMatchObject({
      stderr: expect.stringContaining("turn it off or on there"),
    });
    expect(
      (await system.user.findUniqueOrThrow({ where: { id: user.id } })).deactivatedAt,
    ).toBeInstanceOf(Date);
  });

  it("leaves an account the identity provider deleted for the provider to restore", async () => {
    const { user } = await person("hana@example.test");
    const now = new Date();
    await system.scimIdentityTombstone.create({
      data: {
        id: randomUUID(),
        connectionId: "directory",
        provisioningDomainId: "directory",
        externalId: "directory-hana",
        externalIdKey: randomUUID(),
        userId: user.id,
        profile: "manage",
        deletedAt: now,
      },
    });
    await system.user.update({ where: { id: user.id }, data: { deactivatedAt: now } });

    await expect(commandWith(scim, "reactivate", user.email)).rejects.toMatchObject({
      stderr: expect.stringContaining("turn it off or on there"),
    });
    expect(
      (await system.user.findUniqueOrThrow({ where: { id: user.id } })).deactivatedAt,
    ).toBeInstanceOf(Date);
  });

  it("lets the operator turn back on a deleted directory account once SCIM is off", async () => {
    const { user } = await person("kim@example.test");
    const now = new Date();
    await system.scimIdentityTombstone.create({
      data: {
        id: randomUUID(),
        connectionId: "directory",
        provisioningDomainId: "directory",
        externalId: "directory-kim",
        externalIdKey: randomUUID(),
        userId: user.id,
        profile: "manage",
        deletedAt: now,
      },
    });
    await system.user.update({ where: { id: user.id }, data: { deactivatedAt: now } });

    expect((await command("reactivate", user.email)).stdout.trim()).toBe("Reactivated");
    expect(
      (await system.user.findUniqueOrThrow({ where: { id: user.id } })).deactivatedAt,
    ).toBeNull();
  });

  it("leaves an account the identity provider has on for the provider to turn off", async () => {
    const { user } = await person("ines@example.test");
    const now = new Date();
    await system.scimUser.create({
      data: {
        id: randomUUID(),
        connectionId: "directory",
        provisioningDomainId: "directory",
        userId: user.id,
        connectionUserKey: randomUUID(),
        userName: user.email,
        userNameKey: randomUUID(),
        primaryEmail: user.email,
        workEmailValueIndex: "",
        emailValueIndex: "",
        displayName: "Ines",
        formattedName: "Ines",
        serializedEmails: "[]",
        active: true,
        orderKey: randomUUID(),
        createdAt: now,
        updatedAt: now,
      },
    });

    await expect(commandWith(scim, "deactivate", user.email)).rejects.toMatchObject({
      stderr: expect.stringContaining("turn it off or on there"),
    });
    expect(
      (await system.user.findUniqueOrThrow({ where: { id: user.id } })).deactivatedAt,
    ).toBeNull();
    expect(await system.session.count({ where: { userId: user.id } })).toBe(1);
  });

  it("finds an account whose stored email has capitals", async () => {
    const user = await system.user.create({
      data: { id: randomUUID(), name: "Jo", email: "Jo.Capital@Example.test", emailVerified: true },
    });
    expect((await command("deactivate", "jo.capital@example.test")).stdout.trim()).toBe(
      "Deactivated",
    );
    expect(
      (await system.user.findUniqueOrThrow({ where: { id: user.id } })).deactivatedAt,
    ).toBeInstanceOf(Date);
  });
});
