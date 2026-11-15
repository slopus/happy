import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import {
  databaseUrls,
  describeRowSecurity,
  JOB_QUEUE_POLICY,
  provisionRuntimeRole,
  RUNTIME_ROLE,
} from "./database-access.js";
import {
  drainUnscopedDatabaseAccess,
  ROW_SECURITY_MODELS,
  runAsSystem,
  runAsSystemInTransaction,
  runAsTenant,
} from "./row-security.js";

// Needs DATABASE_URL as the runtime login and DATABASE_MIGRATION_URL as the
// owner, as `pnpm test:integration` provides after `pnpm db:migrate`.
const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe
    : describe.skip;

type Tenant = {
  spaceId: string;
  userId: string;
  botId: string;
  secretId: string;
  personalSecretId: string;
};

/** One row for each protected table not covered by the main fixtures, owned by `t`. */
function rowsFor(t: Tenant, tag: string): Array<[string, Record<string, unknown>]> {
  return [
    [
      "spaceModelRoleChoice",
      {
        spaceId: t.spaceId,
        userId: t.userId,
        role: `approval-${tag}`,
        position: 0,
        provider: "openrouter",
        modelId: `model-${tag}`,
      },
    ],
    [
      "botSecret",
      {
        id: `rls-bot-secret-${tag}-${t.botId}`,
        userId: t.userId,
        spaceId: t.spaceId,
        botId: t.botId,
        name: `n-${tag}`,
        origin: "https://example.test",
        auth: {},
        ciphertext: "c",
      },
    ],
    [
      "vaultCredential",
      {
        id: `rls-vault-space-${tag}-${t.spaceId}`,
        userId: t.userId,
        spaceId: t.spaceId,
        name: `n-${tag}`,
        origin: "https://example.test",
        auth: {},
        ciphertext: "c",
      },
    ],
    [
      "vaultCredential",
      {
        id: `rls-vault-account-${tag}-${t.userId}`,
        userId: t.userId,
        spaceId: null,
        name: `n-${tag}`,
        origin: "https://example.test",
        auth: {},
        ciphertext: "c",
      },
    ],
    [
      "agentSecret",
      {
        spaceId: t.spaceId,
        createdByUserId: t.userId,
        name: `KEY_${tag.toUpperCase()}`,
        secretId: tag === "fixture" ? t.secretId : `${t.secretId}-${tag}`,
      },
    ],
    [
      "taughtSkill",
      { spaceId: t.spaceId, botId: t.botId, userId: t.userId, goal: "g", status: "s" },
    ],
    [
      "agentSkill",
      { spaceId: t.spaceId, userId: t.userId, name: `n-${tag}`, description: "d", content: "c" },
    ],
    ["userVoiceCredential", { userId: t.userId, provider: "p", secretId: t.personalSecretId }],
    ["trustedLinkSite", { userId: t.userId, site: `${tag}.example.test` }],
    ["spendingLimit", { userId: t.userId, amount: 100, currency: "usd", period: "month" }],
    [
      "payment",
      {
        operationKey: `rls-payment-${tag}-${t.userId}`,
        userId: t.userId,
        spaceId: t.spaceId,
        botId: t.botId,
        threadId: "thread",
        site: "shop.example.test",
        amount: 100,
        currency: "usd",
      },
    ],
  ];
}

describePostgres("row-level security (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `rls-org-${suffix}`;
  const tenants = ["a", "b"].map((name) => ({
    name,
    userId: `rls-user-${name}-${suffix}`,
    spaceId: `rls-space-${name}-${suffix}`,
    botId: `rls-bot-${name}-${suffix}`,
    threadId: `rls-thread-${name}-${suffix}`,
    documentId: `rls-doc-${name}-${suffix}`,
    secretId: `rls-secret-${name}-${suffix}`,
    personalSecretId: `rls-personal-${name}-${suffix}`,
  }));
  const [a, b] = tenants as [(typeof tenants)[0], (typeof tenants)[0]];
  let owner: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createDb>;
  let db: PrismaClient;

  beforeAll(async () => {
    owner = createDb(migrationUrl!);
    app = createDb(runtimeUrl!, { poolMax: 4 });
    db = app.prisma;
    const o = owner.prisma;
    await o.organization.create({
      data: { id: organizationId, name: "RLS", slug: organizationId, createdAt: new Date() },
    });
    for (const t of tenants) {
      await o.user.create({
        data: { id: t.userId, name: t.name, email: `${t.userId}@rakazo.test`, emailVerified: true },
      });
      await o.space.create({ data: { id: t.spaceId, organizationId, name: t.name } });
      await o.bot.create({
        data: { id: t.botId, spaceId: t.spaceId, userId: t.userId, name: t.name, color: "#000" },
      });
      await o.thread.create({
        data: { id: t.threadId, spaceId: t.spaceId, userId: t.userId, botId: t.botId },
      });
      await o.message.create({
        data: { threadId: t.threadId, seq: 1, role: "user", blocks: [{ text: t.name }] },
      });
      await o.event.create({
        data: {
          spaceId: t.spaceId,
          threadId: t.threadId,
          botId: t.botId,
          seq: 1,
          type: "note",
          payload: {},
        },
      });
      await o.memoryDocument.create({
        data: {
          id: t.documentId,
          spaceId: t.spaceId,
          userId: t.userId,
          scope: "space",
          path: "notes.md",
          content: t.name,
        },
      });
      await o.memoryRevision.create({
        data: { documentId: t.documentId, revision: 1, content: t.name },
      });
      await o.artifact.create({
        data: {
          spaceId: t.spaceId,
          userId: t.userId,
          name: "a.txt",
          mimeType: "text/plain",
          size: 1,
          hash: "h",
          storageKey: `k-${t.name}-${suffix}`,
        },
      });
      await o.secret.create({
        data: {
          id: t.secretId,
          userId: t.userId,
          spaceId: t.spaceId,
          kind: "test",
          ciphertext: "c",
        },
      });
      await o.secret.create({
        data: { id: t.personalSecretId, userId: t.userId, kind: "model", ciphertext: "c" },
      });
      await o.userModelCredential.create({
        data: { userId: t.userId, provider: "p", label: "l", secretId: t.personalSecretId },
      });
      // Free secret for the agent secret the write test tries to create.
      await o.secret.create({
        data: {
          id: `${t.secretId}-write`,
          userId: t.userId,
          spaceId: t.spaceId,
          kind: "test",
          ciphertext: "c",
        },
      });
      await o.member.create({
        data: {
          id: `${t.userId}-member`,
          organizationId,
          userId: t.userId,
          role: "owner",
          createdAt: new Date(),
        },
      });
      await o.spaceMember.create({
        data: {
          id: `${t.userId}-space-member`,
          spaceId: t.spaceId,
          userId: t.userId,
          organizationId,
          role: "owner",
          createdAt: new Date(),
        },
      });
      for (const [table, data] of rowsFor(t, "fixture")) {
        await Reflect.get(o, table).create({ data });
      }
    }
  });

  afterAll(async () => {
    if (!owner) return;
    await owner.prisma.organization.deleteMany({ where: { id: organizationId } });
    await owner.prisma.user.deleteMany({ where: { id: { in: tenants.map((t) => t.userId) } } });
    for (const handle of [owner, app]) {
      await handle.prisma.$disconnect();
      await handle.pool.end();
    }
  });

  const threadIds = () => tenants.map((t) => t.threadId);
  const owners = () =>
    Promise.all(
      [
        "botSecret",
        "vaultCredential",
        "agentSecret",
        "taughtSkill",
        "agentSkill",
        "userVoiceCredential",
        "trustedLinkSite",
      ].map(async (table) => {
        const scope = ["userVoiceCredential", "vaultCredential", "trustedLinkSite"].includes(table)
          ? "userId"
          : "spaceId";
        const ids = tenants.map((t) => t[scope]);
        const rows = (await Reflect.get(db, table).findMany({
          where: { [scope]: { in: ids } },
          select: { [scope]: true },
        })) as Array<Record<string, string>>;
        return [table, rows.map((row) => row[scope]).sort()] as const;
      }),
    ).then(Object.fromEntries);
  const visible = () =>
    Promise.all([
      db.thread.findMany({ where: { id: { in: threadIds() } }, select: { id: true } }),
      db.message.findMany({ where: { threadId: { in: threadIds() } }, select: { threadId: true } }),
      db.event.findMany({ where: { threadId: { in: threadIds() } }, select: { threadId: true } }),
      db.memoryDocument.findMany({
        where: { id: { in: tenants.map((t) => t.documentId) } },
        select: { id: true },
      }),
      db.memoryRevision.findMany({
        where: { documentId: { in: tenants.map((t) => t.documentId) } },
        select: { documentId: true },
      }),
      db.artifact.findMany({
        where: { spaceId: { in: tenants.map((t) => t.spaceId) } },
        select: { spaceId: true },
      }),
      db.secret.findMany({
        where: { userId: { in: tenants.map((t) => t.userId) } },
        select: { id: true },
      }),
      db.userModelCredential.findMany({
        where: { userId: { in: tenants.map((t) => t.userId) } },
        select: { userId: true },
      }),
    ]).then(
      ([threads, messages, events, documents, revisions, artifacts, secrets, credentials]) => ({
        threads: threads.map((row) => row.id),
        messages: messages.map((row) => row.threadId),
        events: events.map((row) => row.threadId),
        documents: documents.map((row) => row.id),
        revisions: revisions.map((row) => row.documentId),
        artifacts: artifacts.map((row) => row.spaceId),
        secrets: secrets.map((row) => row.id).sort(),
        credentials: credentials.map((row) => row.userId),
      }),
    );

  it("connects as a login that cannot bypass the policies", async () => {
    await expect(describeRowSecurity(db)).resolves.toMatchObject({ enforced: true });
    expect(databaseUrls(process.env).separate).toBe(true);
    await expect(db.$executeRawUnsafe("CREATE TABLE rls_probe (id int)")).rejects.toThrow(
      /permission denied/,
    );
  });

  it("keeps security events append-only and system-only for the runtime login", async () => {
    const id = `rls-security-event-${suffix}`;
    const system = <T>(fn: () => Promise<T>) => runAsSystem("row-level security test", fn);
    await system(
      () => db.$executeRaw`INSERT INTO security_events (id, type) VALUES (${id}, 'rls.test')`,
    );
    await expect(
      system(() => db.$executeRaw`UPDATE security_events SET type = 'changed' WHERE id = ${id}`),
    ).rejects.toThrow(/permission denied/);
    // A tenant can neither read nor write the deployment's security log.
    expect(await runAsTenant(a, () => db.securityEvent.count({ where: { id } }))).toBe(0);
    await expect(
      runAsTenant(a, () =>
        db.securityEvent.create({ data: { type: "rls.test", spaceId: a.spaceId } }),
      ),
    ).rejects.toThrow(/row-level security/);
    expect(await system(() => db.$executeRaw`DELETE FROM security_events WHERE id = ${id}`)).toBe(
      1,
    );
  });

  it("applies the same rules to the remaining Space-owned tables", async () => {
    const created = new Map<string, Record<string, string[]>>();
    const seed = async (t: (typeof tenants)[0]) => {
      const o = owner.prisma;
      const tag = `${t.name}-${suffix}`;
      const ids: Record<string, string[]> = {};
      const keep = (model: string, row: { id: string }) => {
        ids[model] = [...(ids[model] ?? []), row.id];
        return row;
      };
      const task = await o.task.create({
        data: {
          spaceId: t.spaceId,
          botId: t.botId,
          threadId: t.threadId,
          userId: t.userId,
          prompt: "p",
          status: "queued",
        },
      });
      keep("task", task);
      keep(
        "run",
        await o.run.create({
          data: {
            spaceId: t.spaceId,
            botId: t.botId,
            threadId: t.threadId,
            taskId: task.id,
            userId: t.userId,
            status: "queued",
            trigger: "created",
          },
        }),
      );
      keep(
        "routine",
        await o.routine.create({
          data: {
            spaceId: t.spaceId,
            botId: t.botId,
            userId: t.userId,
            name: "r",
            prompt: "p",
            crons: [],
          },
        }),
      );
      keep(
        "connection",
        await o.connection.create({
          data: {
            spaceId: t.spaceId,
            userId: t.userId,
            provider: "p",
            displayName: "d",
            status: "connected",
          },
        }),
      );
      const server = keep(
        "mcpServer",
        await o.mcpServer.create({
          data: {
            spaceId: t.spaceId,
            userId: t.userId,
            slug: `s-${tag}`,
            name: "n",
            transport: "http",
          },
        }),
      );
      keep(
        "botMcpServer",
        await o.botMcpServer.create({
          data: { spaceId: t.spaceId, userId: t.userId, botId: t.botId, serverId: server.id },
        }),
      );
      keep(
        "mcpOAuthSession",
        await o.mcpOAuthSession.create({
          data: {
            id: `rls-oauth-${tag}`,
            spaceId: t.spaceId,
            userId: t.userId,
            serverId: server.id,
            endpoint: "https://example.test",
            redirectUri: "https://example.test/cb",
            oauthCiphertext: "c",
          },
        }),
      );
      keep(
        "computer",
        await o.computer.create({
          data: {
            spaceId: t.spaceId,
            userId: t.userId,
            scopeKey: `rls-${tag}`,
            homeKey: `rls-${tag}`,
            kind: "fake",
          },
        }),
      );
      const board = keep("board", await o.board.create({ data: { spaceId: t.spaceId } }));
      const ticket = keep(
        "ticket",
        await o.ticket.create({
          data: { spaceId: t.spaceId, boardId: board.id, number: 1, title: "t" },
        }),
      );
      keep(
        "ticketComment",
        await o.ticketComment.create({
          data: { spaceId: t.spaceId, ticketId: ticket.id, body: "b" },
        }),
      );
      const identity = keep(
        "messagingIdentity",
        await o.messagingIdentity.create({
          data: {
            provider: "test",
            address: `addr-${tag}`,
            userId: t.userId,
            spaceId: t.spaceId,
            botId: t.botId,
          },
        }),
      );
      keep(
        "messagingOutbound",
        await o.messagingOutbound.create({
          data: { idempotencyKey: `rls-${tag}`, kind: "dm", identityId: identity.id, body: "b" },
        }),
      );
      const conversation = keep(
        "externalConversation",
        await o.externalConversation.create({
          data: {
            provider: "test",
            workspaceId: "w",
            externalKey: `k-${tag}`,
            conversationId: "c",
            spaceId: t.spaceId,
            botId: t.botId,
            userId: t.userId,
          },
        }),
      );
      keep(
        "externalMessage",
        await o.externalMessage.create({
          data: {
            externalConversationId: conversation.id,
            providerEventId: `e-${tag}`,
            senderId: "s",
            senderName: "n",
            content: "c",
          },
        }),
      );
      const message = await o.message.findFirstOrThrow({ where: { threadId: t.threadId } });
      keep(
        "steeringMessage",
        await o.steeringMessage.create({
          data: { messageId: message.id, botId: t.botId, userId: t.userId },
        }),
      );
      keep(
        "usageRecord",
        await o.usageRecord.create({
          data: { spaceId: t.spaceId, userId: t.userId, provider: "p", model: "m" },
        }),
      );
      keep(
        "scratchpadItem",
        await o.scratchpadItem.create({
          data: { spaceId: t.spaceId, botId: t.botId, userId: t.userId, title: "t" },
        }),
      );
      keep(
        "actionApprovalRule",
        await o.actionApprovalRule.create({
          data: {
            spaceId: t.spaceId,
            createdByUserId: t.userId,
            effect: "allow",
            matchKind: "tool",
            matchValue: `v-${tag}`,
          },
        }),
      );
      created.set(t.name, ids);
    };
    await runAsSystem("row-level security test", async () => {
      for (const t of tenants) await seed(t);
    });
    const ownA = created.get("a")!;
    const ownB = created.get("b")!;
    const seen = async () => {
      const result: Record<string, string[]> = {};
      for (const model of Object.keys(ownA)) {
        const ids = [...ownA[model]!, ...ownB[model]!];
        const rows = (await Reflect.get(db, model).findMany({
          where: { id: { in: ids } },
          select: { id: true },
        })) as Array<{ id: string }>;
        result[model] = rows.map((row) => row.id).sort();
      }
      return result;
    };
    const only = (ids: Record<string, string[]>) =>
      Object.fromEntries(Object.entries(ids).map(([model, list]) => [model, [...list].sort()]));
    expect(await runAsTenant(a, seen)).toEqual(only(ownA));
    expect(await runAsTenant(b, seen)).toEqual(only(ownB));
    expect(Object.values(await seen()).flat()).toEqual([]);
    const all = await runAsSystem("row-level security test", seen);
    for (const model of Object.keys(ownA)) expect(all[model]).toHaveLength(2);
    // A tenant cannot write into another Space either.
    await expect(
      runAsTenant(b, () =>
        db.scratchpadItem.create({
          data: { spaceId: a.spaceId, botId: a.botId, userId: a.userId, title: "x" },
        }),
      ),
    ).rejects.toThrow(/row-level security/);
    expect(
      await runAsTenant(b, () =>
        db.bot.updateMany({ where: { id: a.botId }, data: { name: "x" } }),
      ),
    ).toEqual({ count: 0 });
    // The unscoped reads above are deliberate.
    drainUnscopedDatabaseAccess();
  });

  it("reports a bypass key that no longer matches until db:migrate runs again", async () => {
    expect((await describeRowSecurity(db)).systemBlocked).toBeUndefined();
    await owner.prisma
      .$executeRaw`UPDATE rakazo_private.rls_bypass_keys SET digest = sha256('stale')`;
    expect((await describeRowSecurity(db)).systemBlocked).toBe(true);
    await provisionRuntimeRole(migrationUrl!, runtimeUrl!);
    expect((await describeRowSecurity(db)).systemBlocked).toBeUndefined();
  });

  it("ignores a bypass a tenant session turns on without the key", async () => {
    const client = await app.pool.connect();
    try {
      // What SQL run in a tenant context could do to its own session.
      for (const key of ["", "guess"]) {
        await client.query(
          "SELECT set_config('app.space_id', $1, false), set_config('app.user_id', $2, false), set_config('app.rls_bypass', 'on', false), set_config('app.rls_bypass_key', $3, false), set_config('app.rls_version', '', false)",
          [a.spaceId, a.userId, key],
        );
        const threads = await client.query("SELECT id FROM threads WHERE id = ANY($1)", [
          threadIds(),
        ]);
        expect(threads.rows.map((row) => row.id)).toEqual([a.threadId]);
        const bots = await client.query("SELECT id FROM bots WHERE id = ANY($1)", [
          tenants.map((t) => t.botId),
        ]);
        expect(bots.rows.map((row) => row.id)).toEqual([a.botId]);
      }
      await expect(
        client.query("SELECT count(*) FROM rakazo_private.rls_bypass_keys"),
      ).rejects.toThrow(/permission denied/);
    } finally {
      client.release(true);
    }
  });

  it("limits vault guard helpers to runtime callers without exposing another tenant's restrictions", async () => {
    const publicGrants = await owner.pool.query(
      `SELECT p.proname FROM pg_proc p
       CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
       WHERE p.proname = ANY($1) AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'`,
      [["app_vault_item_unrestricted", "app_vault_run_unrestricted"]],
    );
    expect(publicGrants.rows).toEqual([]);
    const ids = [a, b].map((t) => `guard-${t.userId}`);
    try {
      for (const [index, t] of [a, b].entries()) {
        await owner.prisma.vaultCredential.create({
          data: {
            id: ids[index]!,
            userId: t.userId,
            name: ids[index]!,
            origin: "",
            auth: {},
            ciphertext: "fake",
          },
        });
        await owner.prisma.vaultCredentialLimit.create({
          data: { credentialId: ids[index]!, userId: t.userId, spaceId: t.spaceId },
        });
      }
      const probe = () =>
        runAsTenant(
          a,
          () => db.$queryRaw`
        SELECT app_vault_item_unrestricted(${ids[0]}) AS own_item,
          app_vault_item_unrestricted(${ids[1]}) AS other_item,
          app_vault_run_unrestricted(${a.userId}, ${a.spaceId}) AS own_run,
          app_vault_run_unrestricted(${b.userId}, ${b.spaceId}) AS other_run
      `,
        );
      const expected = [{ own_item: false, other_item: true, own_run: false, other_run: false }];
      expect(await probe()).toEqual(expected);
      await owner.prisma.vaultCredentialLimit.deleteMany({ where: { credentialId: ids[1] } });
      // Another tenant's restrictions changing produces the same answers.
      expect(await probe()).toEqual(expected);
      await owner.prisma.vaultCredentialLimit.deleteMany({ where: { credentialId: ids[0] } });
      expect(await probe()).toEqual([{ ...expected[0], own_item: true, own_run: true }]);
    } finally {
      await owner.prisma.vaultCredential.deleteMany({ where: { id: { in: ids } } });
    }
  });

  it.each([false, true])(
    "preserves legacy unrestricted use and fences restrictions, including system=%s",
    async (system) => {
      const tag = `rollout-${system}-${suffix}`;
      const connect = () => app.pool.connect();
      const client = await (system
        ? runAsSystem("legacy rollout test", connect)
        : runAsTenant(a, connect));
      const vaultId = (name: string) => `${tag}-${name}`;
      const kinds = [
        "run-login:rollout:login",
        "run-code:rollout",
        "run-code-spent:rollout",
        "run-secret:rollout",
      ];
      try {
        // Exactly the settings the previous release sends: no capability declaration.
        await client.query("RESET app.vault_access_version");
        await client.query(
          `INSERT INTO vault_credentials (id, "userId", name, origin, auth, ciphertext, "updatedAt")
           VALUES ($1, $2, $1, 'https://example.test', '{}', 'fake-unrestricted', now())`,
          [vaultId("open"), a.userId],
        );
        const read = (id: string) =>
          client.query("SELECT ciphertext FROM vault_credentials WHERE id = $1", [id]);
        expect((await read(vaultId("open"))).rows).toEqual([{ ciphertext: "fake-unrestricted" }]);
        expect(
          (
            await client.query(
              `UPDATE vault_credentials SET ciphertext = 'fake-updated' WHERE id = $1 RETURNING id`,
              [vaultId("open")],
            )
          ).rowCount,
        ).toBe(1);
        for (const [i, kind] of kinds.entries()) {
          await client.query(
            `INSERT INTO secrets (id, "userId", "spaceId", kind, ciphertext) VALUES ($1, $2, $3, $4, 'fake-run')`,
            [`${tag}-run-${i}`, a.userId, a.spaceId, kind],
          );
        }
        const runs = () =>
          client.query("SELECT id FROM secrets WHERE id LIKE $1", [`${tag}-run-%`]);
        expect((await runs()).rowCount).toBe(kinds.length);
        // A Space-only restriction must not fence the same owner's other Spaces.
        await owner.prisma.vaultCredential.create({
          data: {
            id: vaultId("space-only"),
            userId: a.userId,
            spaceId: a.spaceId,
            name: vaultId("space-only"),
            origin: "https://example.test",
            auth: {},
            ciphertext: "fake",
            policy: "off",
          },
        });
        await owner.prisma.secret.create({
          data: {
            id: `${tag}-other-space`,
            userId: a.userId,
            spaceId: b.spaceId,
            kind: kinds[0]!,
            ciphertext: "fake",
          },
        });
        if (system)
          expect(
            (await client.query("SELECT id FROM secrets WHERE id = $1", [`${tag}-other-space`]))
              .rowCount,
          ).toBe(1);
        expect((await runs()).rowCount).toBe(0);
        await owner.prisma.vaultCredential.delete({ where: { id: vaultId("space-only") } });
        expect((await runs()).rowCount).toBe(kinds.length);
        // A restriction made by new code applies immediately to old connections.
        for (const policy of ["off", "ask", "allow"]) {
          await owner.prisma.vaultCredential.create({
            data: {
              id: vaultId(policy),
              userId: a.userId,
              name: vaultId(policy),
              origin: "https://example.test",
              auth: {},
              ciphertext: "fake-restricted",
              policy,
            },
          });
        }
        // Even a limit hidden by tenant RLS in another Space protects the shared item
        // from an old account-vault writer. The old binary knows nothing of this table.
        await owner.prisma.vaultCredentialLimit.create({
          data: {
            credentialId: vaultId("allow"),
            userId: a.userId,
            spaceId: b.spaceId,
          },
        });
        for (const policy of ["off", "ask", "allow"]) {
          const id = vaultId(policy);
          expect((await read(id)).rows).toEqual([]);
          expect(
            (
              await client.query(
                `UPDATE vault_credentials SET ciphertext = 'fake-overwrite', policy = 'allow' WHERE id = $1 RETURNING id`,
                [id],
              )
            ).rowCount,
          ).toBe(0);
          expect(
            (await client.query("DELETE FROM vault_credentials WHERE id = $1 RETURNING id", [id]))
              .rowCount,
          ).toBe(0);
          // An old save cannot recreate the hidden name and use a replacement.
          await expect(
            client.query(
              `INSERT INTO vault_credentials (id, "userId", name, origin, auth, ciphertext, "updatedAt")
             VALUES ($1, $2, $3, 'https://example.test', '{}', 'fake-replacement', now())`,
              [`${id}-duplicate`, a.userId, id],
            ),
          ).rejects.toThrow(/unique constraint/);
        }
        // Existing unrestricted credentials still work in the same vault.
        expect((await read(vaultId("open"))).rows).toEqual([{ ciphertext: "fake-updated" }]);
        expect((await runs()).rows).toEqual([]);
        expect(
          (
            await client.query(
              `UPDATE vault_credentials SET ciphertext = 'fake-still-usable' WHERE id = $1 RETURNING id`,
              [vaultId("open")],
            )
          ).rowCount,
        ).toBe(1);
        await expect(
          client.query(
            `INSERT INTO vault_credentials (id, "userId", name, origin, auth, ciphertext, policy, "updatedAt")
           VALUES ($1, $2, $1, 'https://example.test', '{}', 'fake', 'off', now())`,
            [vaultId("blocked-insert"), a.userId],
          ),
        ).rejects.toThrow(/row-level security/);
        // Ordinary secret storage is unaffected even for the restricted owner.
        await client.query(
          `INSERT INTO secrets (id, "userId", "spaceId", kind, ciphertext) VALUES ($1, $2, $3, 'model', 'fake')`,
          [`${tag}-ordinary`, a.userId, null],
        );
        expect(
          (await client.query("SELECT id FROM secrets WHERE id = $1", [`${tag}-ordinary`]))
            .rowCount,
        ).toBe(1);
        // Restrictions never disable another owner's run-only credentials.
        await owner.prisma.secret.create({
          data: {
            id: `${tag}-other-owner`,
            userId: b.userId,
            spaceId: b.spaceId,
            kind: kinds[0]!,
            ciphertext: "fake",
          },
        });
        const other = await runAsTenant(b, connect);
        try {
          await other.query("RESET app.vault_access_version");
          expect(
            (await other.query("SELECT id FROM secrets WHERE id = $1", [`${tag}-other-owner`]))
              .rowCount,
          ).toBe(1);
        } finally {
          other.release(true);
        }
        for (const [i, kind] of kinds.entries()) {
          expect(
            (
              await client.query(
                `UPDATE secrets SET ciphertext = 'fake-overwrite' WHERE id = $1 RETURNING id`,
                [`${tag}-run-${i}`],
              )
            ).rowCount,
          ).toBe(0);
          expect(
            (
              await client.query("DELETE FROM secrets WHERE id = $1 RETURNING id", [
                `${tag}-run-${i}`,
              ])
            ).rowCount,
          ).toBe(0);
          await expect(
            client.query(
              `INSERT INTO secrets (id, "userId", "spaceId", kind, ciphertext) VALUES ($1, $2, $3, $4, 'fake')`,
              [`${tag}-blocked-${i}`, a.userId, a.spaceId, kind],
            ),
          ).rejects.toThrow(/row-level security/);
        }
        // New code can still enforce the restrictions and read the rows itself.
        await client.query("SELECT set_config('app.vault_access_version', '1', false)");
        expect((await read(vaultId("off"))).rowCount).toBe(1);
        expect((await runs()).rowCount).toBe(kinds.length);
        await client.query("RESET app.vault_access_version");
        await owner.prisma.vaultCredential.deleteMany({
          where: { id: { in: ["off", "ask", "allow"].map(vaultId) } },
        });
        expect((await runs()).rowCount).toBe(kinds.length);
        expect(
          (
            await client.query("DELETE FROM vault_credentials WHERE id = $1 RETURNING id", [
              vaultId("open"),
            ])
          ).rowCount,
        ).toBe(1);
      } finally {
        client.release(true);
        await owner.prisma.secret.deleteMany({ where: { id: { startsWith: tag } } });
        await owner.prisma.vaultCredential.deleteMany({ where: { id: { startsWith: tag } } });
      }
    },
  );

  it("routes every bypass policy through the key check", async () => {
    const policies = await owner.prisma.$queryRaw<
      Array<{ policyname: string; qual: string; with_check: string | null }>
    >`
      SELECT policyname, qual, with_check FROM pg_policies WHERE schemaname = 'public'
        AND (policyname LIKE '%\\_system' OR qual LIKE '%rls\\_%' OR with_check LIKE '%rls\\_%')`;
    expect(policies.length).toBeGreaterThan(50);
    expect(
      policies.filter(
        (p) => p.qual !== "( SELECT app_rls_bypass() AS app_rls_bypass)" || p.with_check !== null,
      ),
    ).toEqual([]);
  });

  it("lets a system step inside a tenant transaction across tenants and back", async () => {
    const counts = await runAsTenant(a, () =>
      db.$transaction(async (tx) => {
        const before = await tx.thread.count({ where: { id: { in: threadIds() } } });
        const during = await runAsSystemInTransaction(tx, "row-level security test", () =>
          tx.thread.count({ where: { id: { in: threadIds() } } }),
        );
        const after = await tx.thread.count({ where: { id: { in: threadIds() } } });
        return [before, during, after];
      }),
    );
    expect(counts).toEqual([1, 2, 1]);
  });

  it("repairs vault helper grants when provisioning a runtime role after migration", async () => {
    await owner.pool.query(`
      REVOKE EXECUTE ON FUNCTION app_vault_item_unrestricted(text) FROM ${RUNTIME_ROLE};
      REVOKE EXECUTE ON FUNCTION app_vault_run_unrestricted(text, text) FROM ${RUNTIME_ROLE};
    `);
    try {
      await expect(
        runAsTenant(
          a,
          () => db.$queryRaw`
        SELECT app_vault_item_unrestricted('missing')
      `,
        ),
      ).rejects.toThrow(/permission denied/);
      await provisionRuntimeRole(migrationUrl!, runtimeUrl!);
      expect(
        await runAsTenant(
          a,
          () => db.$queryRaw`
        SELECT app_vault_item_unrestricted('missing') AS item,
          app_vault_run_unrestricted(${a.userId}, ${a.spaceId}) AS run
      `,
        ),
      ).toEqual([{ item: true, run: true }]);
      await expect(runAsTenant(a, () => db.vaultCredential.findMany())).resolves.toBeInstanceOf(
        Array,
      );
      await expect(runAsTenant(a, () => db.secret.findMany())).resolves.toBeInstanceOf(Array);
    } finally {
      await provisionRuntimeRole(migrationUrl!, runtimeUrl!);
    }
  });

  it("gives the runtime login the job queue, replacing a hand-made policy", async () => {
    const policies = () =>
      owner.prisma.$queryRaw<Array<{ tablename: string; cmd: string; roles: string[] }>>`
        SELECT t.relname AS tablename, p.cmd, p.roles::text[] AS roles
        FROM pg_class t
        LEFT JOIN pg_policies p
          ON p.schemaname = 'graphile_worker' AND p.tablename = t.relname
          AND p.policyname = ${JOB_QUEUE_POLICY}
        WHERE t.relnamespace = 'graphile_worker'::regnamespace AND t.relrowsecurity
        ORDER BY t.relname`;
    const expected = (await policies()).map(({ tablename }) => ({
      tablename,
      cmd: "ALL",
      roles: [RUNTIME_ROLE],
    }));
    expect(expected.map(({ tablename }) => tablename)).toContain("_private_jobs");
    expect(await policies()).toEqual(expected);
    // A policy of the same name made by hand, here one that only allows reads.
    await owner.prisma.$executeRawUnsafe(
      `DROP POLICY ${JOB_QUEUE_POLICY} ON graphile_worker._private_tasks;
       CREATE POLICY ${JOB_QUEUE_POLICY} ON graphile_worker._private_tasks
         FOR SELECT TO ${RUNTIME_ROLE} USING (true)`,
    );
    await provisionRuntimeRole(migrationUrl!, runtimeUrl!);
    expect(await policies()).toEqual(expected);
  });

  it("returns no rows and rejects writes without a context", async () => {
    expect(await visible()).toEqual({
      threads: [],
      messages: [],
      events: [],
      documents: [],
      revisions: [],
      artifacts: [],
      secrets: [],
      credentials: [],
    });
    await expect(
      db.message.create({ data: { threadId: a.threadId, seq: 50, role: "user", blocks: [] } }),
    ).rejects.toThrow(/row-level security/);
    const raw = await db.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM messages`;
    expect(Number(raw[0]!.count)).toBe(0);
    // Each unscoped call site is reported, which fails the run unless drained here.
    expect(drainUnscopedDatabaseAccess()).toContainEqual(
      expect.stringMatching(/^Message\.create\n/),
    );
  });

  it("limits a tenant to its own Space and user", async () => {
    expect(await runAsTenant(a, visible)).toEqual({
      threads: [a.threadId],
      messages: [a.threadId],
      events: [a.threadId],
      documents: [a.documentId],
      revisions: [a.documentId],
      artifacts: [a.spaceId],
      secrets: [a.personalSecretId, a.secretId, `${a.secretId}-write`].sort(),
      credentials: [a.userId],
    });
    // Another tenant's ids are invisible even when asked for directly.
    expect(
      await runAsTenant(b, () => db.thread.findUnique({ where: { id: a.threadId } })),
    ).toBeNull();
    expect(
      await runAsTenant(b, () =>
        db.memoryDocument.updateMany({ where: { id: a.documentId }, data: { content: "x" } }),
      ),
    ).toEqual({ count: 0 });
    await expect(
      runAsTenant(b, () =>
        db.message.create({ data: { threadId: a.threadId, seq: 51, role: "user", blocks: [] } }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("applies the same rules to secrets, skills, voice credentials and trusted link sites", async () => {
    const none = {
      botSecret: [],
      vaultCredential: [],
      agentSecret: [],
      taughtSkill: [],
      agentSkill: [],
      userVoiceCredential: [],
      trustedLinkSite: [],
    };
    expect(await owners()).toEqual(none);
    expect(await runAsTenant(a, owners)).toEqual({
      botSecret: [a.spaceId],
      // The member's account vault and their Space's own vault.
      vaultCredential: [a.userId, a.userId],
      agentSecret: [a.spaceId],
      taughtSkill: [a.spaceId],
      agentSkill: [a.spaceId],
      userVoiceCredential: [a.userId],
      trustedLinkSite: [a.userId],
    });
    const everyone = await runAsSystem("row-level security test", owners);
    expect(everyone.agentSkill).toEqual(tenants.map((t) => t.spaceId).sort());
    // Writes into another tenant's Space or account are rejected, and so are
    // writes without a context.
    for (const [table, data] of rowsFor(a, "write")) {
      const create = () => Reflect.get(db, table).create({ data });
      await expect(runAsTenant(b, create), table).rejects.toThrow(/row-level security/);
      await expect(create(), table).rejects.toThrow(/row-level security/);
    }
    // The unscoped reads and writes above are deliberate.
    drainUnscopedDatabaseAccess();
  });

  it("shows a user's trusted link sites in every space and no one else's", async () => {
    const sites = () =>
      db.trustedLinkSite.findMany({
        where: { userId: { in: tenants.map((t) => t.userId) } },
        select: { userId: true, site: true },
      });
    // The user of one space reading from another space they belong to.
    expect(await runAsTenant({ spaceId: b.spaceId, userId: a.userId }, sites)).toEqual([
      { userId: a.userId, site: `fixture.example.test` },
    ]);
    expect(
      await runAsTenant(b, () => db.trustedLinkSite.deleteMany({ where: { userId: a.userId } })),
    ).toEqual({ count: 0 });
    // Trusting a site again, as the API does, is a no-op under the policy.
    expect(
      await runAsTenant(a, () =>
        db.trustedLinkSite.createMany({
          data: { userId: a.userId, site: "fixture.example.test" },
          skipDuplicates: true,
        }),
      ),
    ).toEqual({ count: 0 });
  });

  it("keeps normal reads, writes and transactions working for the tenant", async () => {
    const count = await runAsTenant(b, () =>
      db.$transaction(async (tx) => {
        await tx.message.create({
          data: { threadId: b.threadId, seq: 2, role: "assistant", blocks: [] },
        });
        return tx.message.count({ where: { threadId: { in: threadIds() } } });
      }),
    );
    expect(count).toBe(2);
    const thread = await runAsTenant(b, () =>
      db.thread.findUniqueOrThrow({ where: { id: b.threadId }, include: { messages: true } }),
    );
    expect(thread.messages).toHaveLength(2);
    // findUnique by a compound key, and a fluent relation read.
    const byKey = { where: { threadId_seq: { threadId: b.threadId, seq: 1 } } };
    expect(await runAsTenant(b, () => db.message.findUnique(byKey))).toMatchObject({ seq: 1 });
    expect(await runAsTenant(a, () => db.message.findUnique(byKey))).toBeNull();
    await expect(runAsTenant(a, () => db.message.findUniqueOrThrow(byKey))).rejects.toThrow();
    const fluent = await runAsTenant(b, () =>
      db.thread.findUnique({ where: { id: b.threadId } }).messages(),
    );
    expect(fluent).toHaveLength(2);
  });

  it("never lets one tenant's settings reach another's query", async () => {
    // A small pool forces queued checkouts and connection reuse across tenants,
    // and same-tick findUnique calls exercise Prisma's batching.
    for (let round = 0; round < 5; round += 1) {
      const results = await Promise.all(
        Array.from({ length: 24 }, (_, index) => {
          const tenant = tenants[index % 2]!;
          const read = [
            () =>
              db.$transaction((tx) => tx.thread.findMany({ where: { id: { in: threadIds() } } })),
            () => db.thread.findMany({ where: { id: { in: threadIds() } } }),
            () =>
              Promise.all(
                tenants.map((t) => db.thread.findUnique({ where: { id: t.threadId } })),
              ).then((rows) => rows.filter((row) => row !== null)),
          ][index % 3]!;
          return runAsTenant(tenant, read).then((rows) => ({
            expected: tenant.threadId,
            ids: rows.map((row) => row.id),
          }));
        }),
      );
      for (const { expected, ids } of results) expect(ids).toEqual([expected]);
    }
    expect(await db.thread.count({ where: { id: { in: threadIds() } } })).toBe(0);
  });

  it("rejects batch transactions inside a context", async () => {
    await expect(runAsTenant(a, () => db.$transaction([db.thread.count()]))).rejects.toThrow(
      /interactive transaction/,
    );
    // Prisma starts the batch on a later tick, outside the context: that is why it is rejected.
    drainUnscopedDatabaseAccess();
  });

  it("lets an explicit system context work across tenants", async () => {
    const all = await runAsSystem("row-level security test", visible);
    expect(all.threads.sort()).toEqual(threadIds().sort());
    expect(all.secrets).toHaveLength(6);
  });

  it("protects exactly the tables the client treats as protected", async () => {
    const rows = await owner.prisma.$queryRaw<Array<{ relname: string }>>`
      SELECT relname FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relrowsecurity`;
    const tables = rows.map((row) => row.relname).sort();
    const { models } = (
      db as unknown as { _runtimeDataModel: { models: Record<string, { dbName: string | null }> } }
    )._runtimeDataModel;
    const mapped = [...ROW_SECURITY_MODELS].map((name) => models[name]?.dbName ?? name);
    expect(tables).toEqual(mapped.sort());
  });
});
