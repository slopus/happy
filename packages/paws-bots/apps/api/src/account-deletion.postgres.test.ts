import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AdapterContext,
  ArtifactStore,
  ComputerRef,
  JobPublisher,
  PortableFile,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import {
  checkpointAndRecordComputerWorkspace,
  ObjectAgentHomeStore,
  PrismaAgentHomeRecords,
  teamBrowserProfileName,
} from "@rakazo/adapters";
import type { PrismaClient, SpaceKeyRecord, SpaceKeyStore } from "@rakazo/db";
import {
  asSystem,
  ContentKeyRing,
  computerHomeKey,
  computerScopeKey,
  createDb,
  createThreadEvents,
  LocalKeyProvider,
  legacyTeamHomeKey,
  lockSpaceForContentCreation,
  runAsSystem,
  SpaceDeletionInProgressError,
} from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryObjectStorage } from "../../../packages/adapters/src/object-storage.test-support.js";
import { deleteAccountContent } from "./account-deletion.js";
import type { SpaceDeletionDeps } from "./space-deletion.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("account deletion on bot computers (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let suffix: string;
  let root: string;
  let storage: MemoryObjectStorage;
  let records: PrismaAgentHomeRecords;
  let home: ObjectAgentHomeStore;
  let sandbox: ReturnType<typeof fakeSandbox>;
  let ids: ReturnType<typeof fixtureIds>;

  const context: AdapterContext = {
    operationId: "test",
    traceId: "test",
    spaceId: "test",
    userId: "test",
    signal: new AbortController().signal,
  };
  const deleteAccount = (userId: string, secrets?: SpaceDeletionDeps["secrets"]) =>
    runAsSystem("account deletion test", () =>
      deleteAccountContent(
        {
          ...(secrets ? { secrets } : {}),
          prisma,
          memoryProviders: { resolve: async () => null },
          sandbox: sandbox as unknown as SandboxProvider,
          home,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
          artifacts: { remove: vi.fn() } as unknown as ArtifactStore,
          events: createThreadEvents(prisma),
          dataDir: root,
        },
        userId,
      ),
    );
  /** Another API or worker host: same bucket and database, its own empty cache. */
  const freshHost = async () =>
    new ObjectAgentHomeStore(
      await mkdtemp(path.join(tmpdir(), "rakazo-account-delete-host-")),
      storage,
      records,
    );
  const storedFiles = async (homeKey: string) => {
    const files: string[] = [];
    for await (const file of (await freshHost()).exportHome(homeKey, context))
      files.push(file.path);
    return files.sort();
  };

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
  });

  afterAll(async () => {
    await close?.();
  });

  beforeEach(async () => {
    suffix = `${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
    ids = fixtureIds(suffix);
    root = await mkdtemp(path.join(tmpdir(), "rakazo-account-delete-"));
    storage = new MemoryObjectStorage();
    records = new PrismaAgentHomeRecords(system, memoryRing());
    home = new ObjectAgentHomeStore(root, storage, records);
    sandbox = fakeSandbox();
    await seed();
    return async () => {
      await system.organization.deleteMany({
        where: { id: { in: [ids.personalOrg, ids.sharedOrg] } },
      });
      await system.user.deleteMany({ where: { id: { in: [ids.leaver, ids.stayer] } } });
      await rm(root, { recursive: true, force: true });
    };
  });

  /**
   * The leaver has a personal organization (space with a Team Computer and a bot with its own
   * computer) and shares an organization with the stayer: a space both use, and a space only
   * the leaver uses. In the shared space the stayer owns the Team Computer from before each
   * person got their own, which still holds the leaver's bot folder and browser profile.
   */
  async function seed() {
    const now = new Date();
    await system.user.createMany({
      data: [ids.leaver, ids.stayer].map((id) => ({
        id,
        name: id,
        email: `${id}@rakazo.test`,
        emailVerified: false,
      })),
    });
    await system.organization.createMany({
      data: [ids.personalOrg, ids.sharedOrg].map((id) => ({
        id,
        name: id,
        slug: id,
        createdAt: now,
      })),
    });
    await system.space.createMany({
      data: [
        { id: ids.personalSpace, organizationId: ids.personalOrg, name: "Mine", isDefault: true },
        { id: ids.sharedSpace, organizationId: ids.sharedOrg, name: "Ours", isDefault: true },
        { id: ids.soloSpace, organizationId: ids.sharedOrg, name: "Only mine" },
      ],
    });
    // Members join each organization's default space by trigger.
    await system.member.createMany({
      data: [
        { org: ids.personalOrg, user: ids.leaver },
        { org: ids.sharedOrg, user: ids.leaver },
        { org: ids.sharedOrg, user: ids.stayer },
      ].map(({ org, user }) => ({
        id: `${org}-${user}`,
        organizationId: org,
        userId: user,
        role: "owner",
        createdAt: now,
      })),
    });
    await system.spaceMember.create({
      data: {
        id: `${ids.soloSpace}-member`,
        spaceId: ids.soloSpace,
        organizationId: ids.sharedOrg,
        userId: ids.leaver,
        role: "owner",
        createdAt: now,
      },
    });

    const team = (spaceId: string, userId: string, providerRef: string, state = "stopped") => ({
      id: `${providerRef}-row`,
      spaceId,
      userId,
      scope: "team",
      scopeKey: computerScopeKey({ mode: "team", spaceId, userId }),
      homeKey: computerHomeKey({ mode: "team", spaceId, userId }),
      kind: "e2b",
      providerRef,
      state,
    });
    await system.computer.createMany({
      data: [
        team(ids.personalSpace, ids.leaver, `sb-personal-${suffix}`),
        team(ids.soloSpace, ids.leaver, `sb-solo-${suffix}`),
        team(ids.sharedSpace, ids.leaver, `sb-own-${suffix}`, "running"),
        {
          ...team(ids.sharedSpace, ids.stayer, `sb-legacy-${suffix}`),
          homeKey: legacyTeamHomeKey(ids.sharedSpace),
        },
        {
          id: `sb-dedicated-${suffix}-row`,
          spaceId: ids.personalSpace,
          userId: ids.leaver,
          scope: "dedicated",
          scopeKey: `bot:${ids.dedicatedBot}`,
          homeKey: ids.dedicatedBot,
          kind: "e2b",
          providerRef: `sb-dedicated-${suffix}`,
        },
      ],
    });
    const bot = (id: string, spaceId: string, userId: string, computerId: string) => ({
      id,
      spaceId,
      userId,
      name: id,
      color: "blue",
      computerId,
    });
    await system.bot.createMany({
      data: [
        bot(ids.personalBot, ids.personalSpace, ids.leaver, `sb-personal-${suffix}-row`),
        bot(ids.dedicatedBot, ids.personalSpace, ids.leaver, `sb-dedicated-${suffix}-row`),
        bot(ids.soloBot, ids.soloSpace, ids.leaver, `sb-solo-${suffix}-row`),
        bot(ids.leaverBot, ids.sharedSpace, ids.leaver, `sb-own-${suffix}-row`),
        bot(ids.stayerBot, ids.sharedSpace, ids.stayer, `sb-legacy-${suffix}-row`),
      ],
    });

    for (const [homeKey, files] of [
      [computerHomeKey({ mode: "team", spaceId: ids.personalSpace, userId: ids.leaver }), ["a"]],
      [computerHomeKey({ mode: "team", spaceId: ids.soloSpace, userId: ids.leaver }), ["a"]],
      [ids.dedicatedBot, ["a"]],
      [
        computerHomeKey({ mode: "team", spaceId: ids.sharedSpace, userId: ids.leaver }),
        [`bots/${ids.leaverBot}/notes.txt`, "shared/mine.txt"],
      ],
      [
        legacyTeamHomeKey(ids.sharedSpace),
        [
          `bots/${ids.leaverBot}/old.txt`,
          `.browser-profiles/${teamBrowserProfileName(ids.leaverBot)}/Cookies`,
          `bots/${ids.stayerBot}/work.txt`,
          `.browser-profiles/${teamBrowserProfileName(ids.stayerBot)}/Cookies`,
          "shared/plan.txt",
        ],
      ],
    ] as const) {
      await home.commit(homeKey, await staged(files), context);
    }
  }

  it("deletes every computer of the account and its own spaces, and only its folders elsewhere", async () => {
    const legacyKey = legacyTeamHomeKey(ids.sharedSpace);
    const legacyStorage = (
      await system.computer.findUniqueOrThrow({ where: { homeKey: legacyKey } })
    ).homeStorageId;

    await deleteAccount(ids.leaver);

    expect(sandbox.destroyed.sort()).toEqual(
      [
        `sb-dedicated-${suffix}`,
        `sb-own-${suffix}`,
        `sb-personal-${suffix}`,
        `sb-solo-${suffix}`,
      ].sort(),
    );
    expect(
      await system.computer.findMany({
        where: { OR: [{ userId: ids.leaver }, { spaceId: { in: [ids.personalSpace] } }] },
      }),
    ).toEqual([]);
    expect(
      (await system.space.findMany({ where: { id: { in: ids.spaces } } })).map(({ id }) => id),
    ).toEqual([ids.sharedSpace]);
    expect(
      (await system.bot.findMany({ where: { id: { in: ids.bots } } })).map(({ id }) => id),
    ).toEqual([ids.stayerBot]);

    // The stayer's computer keeps its own work, on any host, and loses the leaver's.
    expect(await storedFiles(legacyKey)).toEqual(
      [
        `.browser-profiles/${teamBrowserProfileName(ids.stayerBot)}/Cookies`,
        `bots/${ids.stayerBot}/work.txt`,
        "shared/plan.txt",
      ].sort(),
    );
    expect(sandbox.destroyed).not.toContain(`sb-legacy-${suffix}`);

    // Nothing of the leaver's homes is left on this host, and the sweep empties the bucket of
    // them: only the stayer's home is still stored.
    expect(await readdir(path.join(root, "homes"))).toEqual([legacyKey]);
    await home.sweep();
    expect(new Set([...storage.objects.keys()].map((key) => key.split("/")[1]))).toEqual(
      new Set([legacyStorage]),
    );
  });

  it("deletes the sealed link tokens of the account's pages with its spaces, and only those", async () => {
    const sharedPage = async (spaceId: string, userId: string, name: string) => {
      const secret = await system.secret.create({
        data: { userId, spaceId, kind: "page_share", ciphertext: `ref-${name}-${suffix}` },
      });
      await system.page.create({
        data: { spaceId, userId, title: name, visibility: "link", shareSecretId: secret.id },
      });
      return secret.id;
    };
    const leaving = [
      await sharedPage(ids.personalSpace, ids.leaver, "personal"),
      await sharedPage(ids.soloSpace, ids.leaver, "solo"),
      await sharedPage(ids.sharedSpace, ids.leaver, "member"),
    ];
    const staying = await sharedPage(ids.sharedSpace, ids.stayer, "stayer");
    const secrets = { delete: vi.fn(async (_ref: string) => {}) };

    // The account's rows are still there: only the deletion of its content took the tokens.
    await deleteAccount(ids.leaver, secrets);
    expect(await system.user.count({ where: { id: ids.leaver } })).toBe(1);
    expect(
      (await system.secret.findMany({ where: { id: { in: [...leaving, staying] } } })).map(
        (secret) => secret.id,
      ),
    ).toEqual([staying]);
    expect(secrets.delete.mock.calls.map(([ref]) => ref).sort()).toEqual(
      ["member", "personal", "solo"].map((name) => `ref-${name}-${suffix}`),
    );
  });

  it("finishes on a retry after a provider fails, and a third run changes nothing", async () => {
    sandbox.failDestroy.add(`sb-dedicated-${suffix}`);
    await expect(deleteAccount(ids.leaver)).rejects.toThrow("provider unavailable");
    // A computer the provider could not confirm gone keeps its handle (and a dedicated one its
    // bot), so the retry can destroy it.
    expect(
      await system.computer.findUnique({ where: { id: `sb-dedicated-${suffix}-row` } }),
    ).toMatchObject({ providerRef: `sb-dedicated-${suffix}` });
    expect(await system.bot.findUnique({ where: { id: ids.dedicatedBot } })).not.toBeNull();

    sandbox.failDestroy.clear();
    await deleteAccount(ids.leaver);
    await deleteAccount(ids.leaver);

    expect(await system.computer.findMany({ where: { userId: ids.leaver } })).toEqual([]);
    expect(await system.bot.findMany({ where: { userId: ids.leaver } })).toEqual([]);
    expect(await system.bot.findUnique({ where: { id: ids.stayerBot } })).not.toBeNull();
    expect(await storedFiles(legacyTeamHomeKey(ids.sharedSpace))).toContain(
      `bots/${ids.stayerBot}/work.txt`,
    );
  });

  it("does not let a running computer's later save bring the deleted bot's folder back", async () => {
    await deleteAccount(ids.leaver);
    const legacy = await system.computer.findUniqueOrThrow({
      where: { homeKey: legacyTeamHomeKey(ids.sharedSpace) },
    });
    const stale = fakeSandbox([
      `bots/${ids.leaverBot}/old.txt`,
      `.browser-profiles/${teamBrowserProfileName(ids.leaverBot)}/Cookies`,
      `bots/${ids.stayerBot}/work.txt`,
      "shared/plan.txt",
    ]);

    await runAsSystem("account deletion test", () =>
      checkpointAndRecordComputerWorkspace(
        { prisma, sandbox: stale as unknown as SandboxProvider, home },
        legacy,
        { id: "sb", botId: legacy.homeKey, kind: "e2b", providerRef: "sb" },
        context,
      ),
    );

    expect(await storedFiles(legacy.homeKey)).toEqual(
      [`bots/${ids.stayerBot}/work.txt`, "shared/plan.txt"].sort(),
    );
  });

  it("keeps a space someone else joined while the account was being deleted", async () => {
    // The stayer joins after deletion has decided the space was the leaver's alone.
    sandbox.beforeDestroy = async (providerRef) => {
      if (providerRef !== `sb-solo-${suffix}`) return;
      await system.spaceMember.create({
        data: {
          id: `${ids.soloSpace}-joined`,
          spaceId: ids.soloSpace,
          organizationId: ids.sharedOrg,
          userId: ids.stayer,
          role: "member",
          createdAt: new Date(),
        },
      });
      // Until the deletion settles, the new member cannot add content it would tear down.
      await expect(
        prisma.$transaction((tx) =>
          lockSpaceForContentCreation(tx, { spaceId: ids.soloSpace, userId: ids.stayer }),
        ),
      ).rejects.toThrow(SpaceDeletionInProgressError);
    };

    await deleteAccount(ids.leaver);

    expect(await system.space.findUnique({ where: { id: ids.soloSpace } })).toMatchObject({
      deletingAt: null,
      deletionClaimId: null,
    });
    expect(
      await system.spaceMember.findUnique({ where: { id: `${ids.soloSpace}-joined` } }),
    ).not.toBeNull();
    // The leaver's bot and computer there still go.
    expect(await system.bot.findUnique({ where: { id: ids.soloBot } })).toBeNull();
    expect(sandbox.destroyed).toContain(`sb-solo-${suffix}`);
  });

  it("releases its claim on a space someone joined before a failed attempt", async () => {
    sandbox.failDestroy.add(`sb-dedicated-${suffix}`);
    sandbox.beforeDestroy = async (providerRef) => {
      if (providerRef !== `sb-dedicated-${suffix}`) return;
      await system.spaceMember.upsert({
        where: { id: `${ids.soloSpace}-joined` },
        update: {},
        create: {
          id: `${ids.soloSpace}-joined`,
          spaceId: ids.soloSpace,
          organizationId: ids.sharedOrg,
          userId: ids.stayer,
          role: "member",
          createdAt: new Date(),
        },
      });
    };
    await expect(deleteAccount(ids.leaver)).rejects.toThrow("provider unavailable");
    sandbox.failDestroy.clear();
    // The retry may run on the previous release, which finds its claims by this exact token.
    expect(await system.space.findUnique({ where: { id: ids.soloSpace } })).toMatchObject({
      deletionClaimId: `account-deletion:${ids.leaver}`,
    });

    await deleteAccount(ids.leaver);

    expect(await system.space.findUnique({ where: { id: ids.soloSpace } })).toMatchObject({
      deletingAt: null,
      deletionClaimId: null,
    });
  });

  it("waits for another deletion of a leaving space, and takes over once it is stale", async () => {
    await system.space.update({
      where: { id: ids.soloSpace },
      data: { deletingAt: new Date(), deletionClaimId: "another-deletion" },
    });
    await expect(deleteAccount(ids.leaver)).rejects.toThrow(SpaceDeletionInProgressError);

    await system.space.update({
      where: { id: ids.soloSpace },
      data: { deletingAt: new Date(Date.now() - 60 * 60_000) },
    });
    await deleteAccount(ids.leaver);

    expect(await system.space.findUnique({ where: { id: ids.soloSpace } })).toBeNull();
  });

  it("fails and retries when the other member's stored home cannot be saved", async () => {
    const legacyKey = legacyTeamHomeKey(ids.sharedSpace);
    const put = storage.put.bind(storage);
    storage.put = async () => {
      throw new Error("bucket unavailable");
    };
    await expect(deleteAccount(ids.leaver)).rejects.toThrow("bucket unavailable");
    storage.put = put;
    expect(await storedFiles(legacyKey)).toContain(`bots/${ids.leaverBot}/old.txt`);

    await deleteAccount(ids.leaver);

    expect(await storedFiles(legacyKey)).toEqual(
      [
        `.browser-profiles/${teamBrowserProfileName(ids.stayerBot)}/Cookies`,
        `bots/${ids.stayerBot}/work.txt`,
        "shared/plan.txt",
      ].sort(),
    );
  });
});

function fixtureIds(suffix: string) {
  const ids = {
    leaver: `acct-del-leaver-${suffix}`,
    stayer: `acct-del-stayer-${suffix}`,
    personalOrg: `acct-del-personal-${suffix}`,
    sharedOrg: `acct-del-shared-${suffix}`,
    personalSpace: `acct-del-personal-space-${suffix}`,
    sharedSpace: `acct-del-shared-space-${suffix}`,
    soloSpace: `acct-del-solo-space-${suffix}`,
    personalBot: `acctdelpersonal${suffix.replace(/[^a-z0-9]/g, "")}`,
    dedicatedBot: `acctdeldedicated${suffix.replace(/[^a-z0-9]/g, "")}`,
    soloBot: `acctdelsolo${suffix.replace(/[^a-z0-9]/g, "")}`,
    leaverBot: `acctdelleaver${suffix.replace(/[^a-z0-9]/g, "")}`,
    stayerBot: `acctdelstayer${suffix.replace(/[^a-z0-9]/g, "")}`,
  };
  return {
    ...ids,
    spaces: [ids.personalSpace, ids.sharedSpace, ids.soloSpace],
    bots: [ids.personalBot, ids.dedicatedBot, ids.soloBot, ids.leaverBot, ids.stayerBot],
  };
}

/** A provider that records destroys and runs folder commands as a no-op. */
function fakeSandbox(exportedPaths: string[] = []) {
  const destroyed: string[] = [];
  const failDestroy = new Set<string>();
  return {
    destroyed,
    failDestroy,
    beforeDestroy: undefined as ((providerRef: string) => Promise<void>) | undefined,
    async destroy(computer: ComputerRef) {
      await this.beforeDestroy?.(computer.providerRef);
      if (failDestroy.has(computer.providerRef)) throw new Error("provider unavailable");
      destroyed.push(computer.providerRef);
    },
    async releaseScreen() {},
    async *execute() {
      yield { type: "exit" as const, code: 0 };
    },
    async *exportWorkspace(): AsyncGenerator<PortableFile> {
      for (const filePath of exportedPaths)
        yield { path: filePath, content: Buffer.from(filePath), executable: false };
    },
  };
}

function memoryRing() {
  const keys: SpaceKeyRecord[] = [];
  const store: SpaceKeyStore = {
    forSpace: async (spaceId) => keys.filter((row) => row.spaceId === spaceId),
    byId: async (id) => keys.find((row) => row.id === id),
    insert: async (record) => {
      keys.push(record);
      return record;
    },
    rowContext: async () => undefined,
    sampleByMasterKey: async () => [],
  };
  return new ContentKeyRing(new LocalKeyProvider([{ id: "k1", key: randomBytes(32) }]), store);
}

async function staged(files: readonly string[]) {
  const dir = await mkdtemp(path.join(tmpdir(), "rakazo-account-delete-staging-"));
  for (const name of files) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), name);
  }
  return dir;
}
