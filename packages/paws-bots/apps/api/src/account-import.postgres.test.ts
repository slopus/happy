import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AdapterContext,
  ArtifactStore,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { LocalAgentHomeStore } from "@rakazo/adapters";
import type { AccountExportRecord, Actor } from "@rakazo/contracts";
import { PAGE_SOURCE_MAX_BYTES } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, createOrganizationForUser } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountImportError, importAccount } from "./account-import.js";
import {
  buildArchive,
  chunked,
  exportFiles,
  incompressibleBytes,
  manifestFor,
} from "./account-import.test-support.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

const at = "2026-03-01T10:00:00.000Z";

function sourceRecords(): AccountExportRecord[] {
  return [
    { type: "bot_section", id: "src-section", name: "Work", position: 0, createdAt: at },
    {
      type: "bot",
      id: "src-bot-child",
      name: "Scout",
      description: "Finds things",
      instructions: "Be brief.",
      color: "#3EC5A8",
      avatarSet: "organic",
      notifyOnFinish: false,
      pinned: true,
      position: 1,
      sectionId: "src-section",
      archivedAt: null,
      // Its parent comes later in the file.
      parentBotId: "src-bot-parent",
      memoryScope: null,
      voiceId: null,
      autoSpeak: false,
      modelProvider: null,
      modelId: null,
      thinkingLevel: null,
      disabledBuiltinTools: ["browser"],
      teamChatAmbientEnabled: false,
      teamChatRules: "",
      crossSpaceCommunication: false,
      dailyCheckIns: false,
      fleetManagement: false,
      replyMode: "messages",
      createdAt: at,
    },
    {
      type: "bot",
      id: "src-bot-parent",
      name: "Chief",
      description: "",
      instructions: "",
      color: "#F5A03C",
      avatarSet: "rakazo",
      notifyOnFinish: true,
      pinned: false,
      position: 0,
      sectionId: null,
      archivedAt: null,
      parentBotId: null,
      memoryScope: null,
      voiceId: null,
      autoSpeak: false,
      modelProvider: null,
      modelId: null,
      thinkingLevel: null,
      disabledBuiltinTools: [],
      teamChatAmbientEnabled: false,
      teamChatRules: "",
      crossSpaceCommunication: false,
      dailyCheckIns: false,
      fleetManagement: true,
      replyMode: "chat",
      createdAt: at,
    },
    {
      type: "chat_group",
      id: "src-group",
      name: "Crew",
      pinned: false,
      sectionId: null,
      archivedAt: null,
      botIds: ["src-bot-child", "src-bot-parent"],
      createdAt: at,
    },
    {
      type: "thread",
      id: "src-thread-bot",
      botId: "src-bot-child",
      groupId: null,
      historyCompactedUpToSeq: 0,
      historyCompactionSummary: "summary of the secret plan",
      createdAt: at,
    },
    {
      type: "message",
      id: "src-msg-1",
      threadId: "src-thread-bot",
      seq: 0,
      role: "user",
      blocks: [{ kind: "text", text: "the secret plan" }],
      botId: null,
      replyToMessageId: null,
      replyQuote: null,
      createdAt: at,
    },
    {
      type: "message",
      id: "src-msg-2",
      threadId: "src-thread-bot",
      seq: 1,
      role: "bot",
      // Names an artifact that only appears later in the file.
      blocks: [
        { kind: "artifact", artifactId: "src-art-1" },
        { kind: "text", text: "done", mention: { botId: "src-bot-parent" } },
      ],
      botId: "src-bot-child",
      replyToMessageId: "src-msg-1",
      replyQuote: "the secret plan",
      createdAt: at,
    },
    {
      type: "thread",
      id: "src-thread-group",
      botId: null,
      groupId: "src-group",
      historyCompactedUpToSeq: null,
      historyCompactionSummary: null,
      createdAt: at,
    },
    {
      type: "message",
      id: "src-msg-3",
      threadId: "src-thread-group",
      seq: 0,
      role: "user",
      blocks: [{ kind: "text", text: "hello crew" }],
      botId: null,
      replyToMessageId: null,
      replyQuote: null,
      createdAt: at,
    },
    {
      type: "thread",
      id: "src-thread-helper",
      botId: null,
      groupId: null,
      helperBotId: "src-bot-child",
      historyCompactedUpToSeq: null,
      historyCompactionSummary: null,
      createdAt: at,
    },
    {
      type: "message",
      id: "src-msg-helper",
      threadId: "src-thread-helper",
      seq: 0,
      role: "bot",
      blocks: [
        { kind: "text", text: "helper found the venue" },
        { kind: "subagent", agentId: "a1", name: "Scout", task: "venues", status: "running" },
      ],
      botId: "src-bot-child",
      replyToMessageId: null,
      replyQuote: null,
      createdAt: at,
    },
    {
      type: "artifact",
      id: "src-art-1",
      botId: "src-bot-child",
      groupId: null,
      name: "notes.txt",
      description: null,
      mimeType: "text/plain",
      size: 2,
      hash: "ignored",
      rootArtifactId: null,
      version: 1,
      createdAt: at,
    },
    {
      type: "artifact",
      id: "src-art-2",
      botId: "src-bot-child",
      groupId: null,
      name: "notes.txt",
      description: "second",
      mimeType: "text/plain",
      size: 2,
      hash: "ignored",
      rootArtifactId: "src-art-1",
      version: 2,
      createdAt: at,
    },
    {
      type: "memory_document",
      id: "src-memory-bot",
      botId: "src-bot-child",
      scope: "bot",
      path: "MEMORY.md",
      content: "remember the secret plan",
      revision: 2,
      createdAt: at,
      updatedAt: at,
    },
    {
      type: "memory_revision",
      id: "src-memory-rev",
      documentId: "src-memory-bot",
      revision: 1,
      content: "older memory",
      sourceThreadId: "src-thread-bot",
      createdAt: at,
    },
    {
      type: "memory_document",
      id: "src-memory-space",
      botId: null,
      scope: "user",
      path: "MEMORY.md",
      content: "space memory",
      revision: 1,
      createdAt: at,
      updatedAt: at,
    },
    {
      type: "routine",
      id: "src-routine",
      botId: "src-bot-child",
      threadId: "src-thread-bot",
      name: "Morning",
      prompt: "Summarize",
      crons: ["0 9 * * *"],
      timezone: "UTC",
      active: true,
      notify: true,
      messageProvider: null,
      modelProvider: null,
      modelId: null,
      thinkingLevel: null,
      watch: null,
      createdAt: at,
    },
    {
      type: "scratchpad_item",
      id: "src-scratch",
      botId: "src-bot-child",
      title: "Follow up",
      status: "open",
      notes: "",
      createdAt: at,
      updatedAt: at,
    },
    {
      type: "agent_skill",
      id: "src-skill",
      name: "triage",
      description: "Sort the inbox",
      content: "Sort it.",
      files: null,
      createdAt: at,
    },
    { type: "board", id: "src-board", name: "Board", ticketPrefix: "ADA" },
    {
      type: "ticket",
      id: "src-ticket",
      number: 3,
      title: "Ship it",
      description: null,
      status: "todo",
      priority: null,
      assigneeBotId: "src-bot-child",
      createdByBotId: null,
      createdByExporter: true,
      createdAt: at,
      updatedAt: at,
      completedAt: null,
    },
    {
      type: "ticket_comment",
      id: "src-comment",
      ticketId: "src-ticket",
      authorBotId: null,
      authoredByExporter: true,
      body: "On it",
      createdAt: at,
    },
  ];
}

describePostgres("account import (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const userId = `import-user-${suffix}`;
  const organizationId = `import-org-${suffix}`;
  const baseSpaceId = `import-space-${suffix}`;
  const actor: Actor = {
    userId,
    spaceId: baseSpaceId,
    email: `${userId}@rakazo.test`,
    isDeploymentOwner: false,
  };
  const stored = new Map<string, Uint8Array>();
  const artifacts = {
    async put({ bytes }: { bytes: Uint8Array }) {
      const id = `blob-${stored.size}-${randomBytes(4).toString("hex")}`;
      stored.set(id, bytes);
      return { id, hash: "" };
    },
    async remove(id: string) {
      stored.delete(id);
    },
  } as unknown as ArtifactStore;
  const noop = new Proxy({}, { get: () => async () => undefined });
  const context: AdapterContext = {
    operationId: "test",
    traceId: "test",
    spaceId: "test",
    userId,
    signal: new AbortController().signal,
  };
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let root: string;
  let home: LocalAgentHomeStore;

  const archive = (records = sourceRecords()) =>
    buildArchive(
      exportFiles(manifestFor([{ id: "src-space", name: "Imported Home" }]), [
        {
          id: "src-space",
          records,
          artifacts: [
            ["src-art-1", "v1"],
            ["src-art-2", "v2"],
          ],
          homes: [
            ["src-bot-child", "notes/today.md", "hello"],
            ["src-bot-child", "bin/blob", new Uint8Array([0, 255, 1])],
          ],
          executables: [{ botId: "src-bot-child", path: "bin/blob" }],
        },
      ]),
    );
  const runImport = (bytes: Uint8Array, importer = actor) =>
    importAccount(
      {
        prisma,
        artifacts,
        home,
        sandbox: noop as SandboxProvider,
        jobs: noop as JobPublisher,
        memoryProviders: { resolve: async () => null },
        dataDir: root,
        maxArtifactBytes: 1024 * 1024,
      },
      importer,
      chunked(bytes),
    );
  const ownedSpaceIds = async () =>
    (await system.spaceMember.findMany({ where: { userId }, select: { spaceId: true } }))
      .map((membership) => membership.spaceId)
      .sort();

  beforeAll(async () => {
    db = createDb(databaseUrl!, { encryptContent: true });
    prisma = db.prisma;
    system = asSystem(prisma);
    root = await mkdtemp(path.join(tmpdir(), "rakazo-account-import-"));
    home = new LocalAgentHomeStore(root);
    const now = new Date();
    await system.user.create({
      data: { id: userId, name: "Ada", email: actor.email, emailVerified: false },
    });
    await system.organization.create({
      data: { id: organizationId, name: "Ada", slug: organizationId, createdAt: now },
    });
    await system.member.create({
      data: {
        id: `${organizationId}-member`,
        organizationId,
        userId,
        role: "owner",
        createdAt: now,
      },
    });
    await system.space.create({
      data: { id: baseSpaceId, organizationId, name: "General", isDefault: true },
    });
    await system.spaceMember.create({
      data: {
        id: `${baseSpaceId}-member`,
        spaceId: baseSpaceId,
        organizationId,
        userId,
        role: "owner",
        createdAt: now,
      },
    });
  });

  afterAll(async () => {
    if (!db) return;
    await system.organization.deleteMany({
      where: { OR: [{ id: organizationId }, { members: { some: { userId } } }] },
    });
    await system.user.deleteMany({ where: { id: userId } });
    await rm(root, { recursive: true, force: true });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("recreates the export under new ids in a new space the importer owns", async () => {
    const result = await runImport(archive());
    expect(result.spaces).toHaveLength(1);
    const [imported] = result.spaces;
    expect(imported!.name).toBe("Imported Home");
    const spaceId = imported!.id;
    expect(spaceId).not.toBe("src-space");
    const space = await system.space.findUniqueOrThrow({
      where: { id: spaceId },
      include: { memberships: true },
    });
    expect(space.organizationId).toBe(organizationId);
    expect(space.memberships.map((m) => [m.userId, m.role])).toEqual([[userId, "owner"]]);

    const bots = await system.bot.findMany({
      where: { spaceId },
      include: { thread: true, computer: true },
    });
    const child = bots.find((bot) => bot.name === "Scout")!;
    const parent = bots.find((bot) => bot.name === "Chief")!;
    expect(bots).toHaveLength(2);
    expect(bots.every((bot) => bot.userId === userId && !bot.id.startsWith("src-"))).toBe(true);
    expect(child.parentBotId).toBe(parent.id);
    expect(child.pinned).toBe(true);
    expect(child.fleetManagement).toBe(false);
    expect(child.replyMode).toBe("messages");
    expect(child.dailyCheckIns).toBe(false);
    expect(parent.dailyCheckIns).toBe(false);
    expect(child.disabledBuiltinTools).toEqual(["browser"]);
    const section = await system.botSection.findFirstOrThrow({ where: { spaceId } });
    expect(child.sectionId).toBe(section.id);
    expect(child.computer).not.toBeNull();

    const thread = child.thread!;
    expect(thread).toMatchObject({
      nextMessageSeq: 2,
      historyCompactionSummary: "summary of the secret plan",
    });
    // Imported history reads as caught up: nobody has an unread mark on it.
    await expect(system.threadRead.count({ where: { threadId: thread.id } })).resolves.toBe(0);
    const messages = await system.message.findMany({
      where: { threadId: thread.id },
      orderBy: { seq: "asc" },
    });
    const art1 = await system.artifact.findFirstOrThrow({ where: { spaceId, version: 1 } });
    const art2 = await system.artifact.findFirstOrThrow({ where: { spaceId, version: 2 } });
    expect(messages.map((message) => message.blocks)).toEqual([
      [{ kind: "text", text: "the secret plan" }],
      [
        { kind: "artifact", artifactId: art1.id },
        { kind: "text", text: "done", mention: { botId: parent.id } },
      ],
    ]);
    expect(messages[1]).toMatchObject({ botId: child.id, replyToMessageId: messages[0]!.id });

    const [rawMessage] = await system.$queryRaw<Array<{ blocks: string }>>`
      SELECT blocks::text AS blocks FROM messages WHERE id = ${messages[0]!.id}
    `;
    expect(rawMessage!.blocks).not.toContain("secret plan");
    const memory = await system.memoryDocument.findFirstOrThrow({
      where: { spaceId, botId: child.id, path: "MEMORY.md" },
      include: { revisions: true },
    });
    expect(memory.content).toBe("remember the secret plan");
    expect(memory.revisions.map((revision) => [revision.content, revision.sourceThreadId])).toEqual(
      [["older memory", thread.id]],
    );
    const [rawMemory] = await system.$queryRaw<Array<{ content: string }>>`
      SELECT content FROM memory_documents WHERE id = ${memory.id}
    `;
    expect(rawMemory!.content).not.toContain("secret plan");
    expect(
      (await system.memoryDocument.findMany({ where: { spaceId, botId: null } })).map(
        (document) => document.content,
      ),
    ).toEqual(["space memory"]);

    expect(art2.rootArtifactId).toBe(art1.id);
    expect(art2.hash).toBe(createHash("sha256").update("v2").digest("hex"));
    expect(Buffer.from(stored.get(art2.storageKey)!).toString()).toBe("v2");

    const files = new Map<string, string>();
    for await (const file of home.exportHome(child.computer!.homeKey, context, {
      directory: `bots/${child.id}`,
    }))
      files.set(
        file.path,
        `${Buffer.from(file.content).toString("hex")}${file.executable ? " +x" : ""}`,
      );
    expect(Object.fromEntries(files)).toEqual({
      "notes/today.md": Buffer.from("hello").toString("hex"),
      "bin/blob": "00ff01 +x",
    });

    const group = await system.chatGroup.findFirstOrThrow({
      where: { spaceId },
      include: { members: true, thread: { include: { messages: true } } },
    });
    expect(group.members.map((member) => member.botId).sort()).toEqual(
      [child.id, parent.id].sort(),
    );
    expect(group.thread?.messages.map((message) => message.blocks)).toEqual([
      [{ kind: "text", text: "hello crew" }],
    ]);
    const helperThread = await system.thread.findFirstOrThrow({
      where: { spaceId, helperBotId: child.id },
      include: { messages: true },
    });
    expect(helperThread).toMatchObject({ botId: null, groupId: null, nextMessageSeq: 1 });
    expect(helperThread.messages.map((message) => [message.botId, message.blocks])).toEqual([
      [
        child.id,
        [
          { kind: "text", text: "helper found the venue" },
          {
            kind: "subagent",
            agentId: "a1",
            name: "Scout",
            task: "venues",
            status: "failed",
            result: "stopped",
          },
        ],
      ],
    ]);
    expect(
      await system.routine.findFirstOrThrow({
        where: { spaceId },
        select: { active: true, nextRunAt: true, threadId: true, botId: true },
      }),
    ).toEqual({ active: false, nextRunAt: null, threadId: thread.id, botId: child.id });
    expect(await system.agentSkill.findFirstOrThrow({ where: { spaceId } })).toMatchObject({
      name: "triage",
      source: "user",
      allSpaces: false,
    });
    const board = await system.board.findUniqueOrThrow({
      where: { spaceId },
      include: { tickets: { include: { comments: true } } },
    });
    expect(board.nextNumber).toBe(4);
    expect(board.tickets[0]).toMatchObject({
      assigneeBotId: child.id,
      createdByUserId: userId,
    });
    expect(board.tickets[0]!.comments[0]).toMatchObject({ authorUserId: userId, body: "On it" });
  });

  it("imports the same archive twice as two independent copies", async () => {
    const bytes = archive();
    const first = await runImport(bytes);
    const second = await runImport(bytes);
    expect(first.spaces[0]!.id).not.toBe(second.spaces[0]!.id);
    const botIds = async (spaceId: string) =>
      (await system.bot.findMany({ where: { spaceId }, select: { id: true } })).map((b) => b.id);
    const [firstBots, secondBots] = await Promise.all([
      botIds(first.spaces[0]!.id),
      botIds(second.spaces[0]!.id),
    ]);
    expect(firstBots).toHaveLength(2);
    expect(secondBots).toHaveLength(2);
    expect(firstBots.filter((id) => secondBots.includes(id))).toEqual([]);
  });

  it("imports a nested zip home file byte-for-byte", async () => {
    const inner = buildArchive([
      ["f0.bin", incompressibleBytes(64 * 1024)],
      ["f1.bin", incompressibleBytes(64 * 1024)],
      ["f2.bin", incompressibleBytes(64 * 1024)],
      ["f3.bin", incompressibleBytes(64 * 1024)],
    ]);
    const result = await runImport(
      buildArchive(
        exportFiles(manifestFor([{ id: "src-space", name: "Nested" }]), [
          {
            id: "src-space",
            records: sourceRecords(),
            homes: [["src-bot-child", "archive.zip", inner]],
          },
        ]),
      ),
    );
    const spaceId = result.spaces[0]!.id;
    const child = await system.bot.findFirstOrThrow({
      where: { spaceId, name: "Scout" },
      include: { computer: true },
    });
    const files = new Map<string, Uint8Array>();
    for await (const file of home.exportHome(child.computer!.homeKey, context, {
      directory: `bots/${child.id}`,
    }))
      files.set(file.path, file.content);
    expect(Buffer.from(files.get("archive.zip")!)).toEqual(Buffer.from(inner));
  });

  it("imports into the importer's current organization", async () => {
    const work = await createOrganizationForUser(system, { userId, name: "Work" });
    const result = await runImport(archive(), { ...actor, spaceId: work.defaultSpaceId });
    await expect(
      system.space.findUniqueOrThrow({ where: { id: result.spaces[0]!.id } }),
    ).resolves.toMatchObject({ organizationId: work.id });
  });

  it("leaves out an artifact the export could not read, with its versions", async () => {
    const blobs = stored.size;
    const result = await runImport(
      buildArchive(
        exportFiles(manifestFor([{ id: "src-space", name: "Partial" }]), [
          { id: "src-space", records: sourceRecords(), artifacts: [["src-art-2", "v2"]] },
        ]),
      ),
    );
    expect(await system.artifact.count({ where: { spaceId: result.spaces[0]!.id } })).toBe(0);
    expect(stored.size).toBe(blobs);
  });

  it("imports page source up to the save limit and refuses more, leaving nothing behind", async () => {
    const withPage = (source: string): AccountExportRecord[] => [
      ...sourceRecords(),
      {
        type: "page",
        id: "src-page",
        botId: "src-bot-child",
        groupId: null,
        title: "Plan",
        pinnedAt: null,
        currentVersion: 1,
        createdAt: at,
        updatedAt: at,
      },
      {
        type: "page_version",
        id: "src-page-v1",
        pageId: "src-page",
        version: 1,
        title: "Plan",
        source,
        createdAt: at,
      },
    ];
    const head = `export default () => <Page title="Plan" />;\n`;
    const comment = (fill: string, count: number) => `${head}/*${fill.repeat(count)}*/`;
    const atLimit = comment("x", PAGE_SOURCE_MAX_BYTES - 4 - head.length);
    const result = await runImport(archive(withPage(atLimit)));
    const saved = await system.pageVersion.findFirstOrThrow({
      where: { page: { spaceId: result.spaces[0]!.id } },
      select: { source: true, code: true },
    });
    expect(saved.source).toBe(atLimit);
    expect(saved.code).not.toBe("");

    // Over by bytes though not by characters, and far over: neither reaches the compiler.
    const before = await ownedSpaceIds();
    for (const over of [
      comment("é", PAGE_SOURCE_MAX_BYTES / 2 - 1),
      comment("x", PAGE_SOURCE_MAX_BYTES * 4),
    ]) {
      await expect(runImport(archive(withPage(over)))).rejects.toBeInstanceOf(AccountImportError);
      expect(await ownedSpaceIds()).toEqual(before);
    }
  });

  const pageRecords = (
    versions: number[],
    {
      currentVersion = 1,
      title = "Plan",
      source = (version: number) => `export default () => <Page title="Draft ${version}" />;`,
    }: { currentVersion?: number; title?: string; source?: (version: number) => string } = {},
  ): AccountExportRecord[] => [
    ...sourceRecords(),
    {
      type: "page",
      id: "src-page",
      botId: null,
      groupId: null,
      title,
      pinnedAt: null,
      currentVersion,
      createdAt: at,
      updatedAt: at,
    },
    ...versions.map((version) => ({
      type: "page_version" as const,
      id: `src-page-v${version}`,
      pageId: "src-page",
      version,
      title,
      source: source(version),
      createdAt: at,
    })),
  ];
  const importedPage = async (records: AccountExportRecord[]) => {
    const result = await runImport(archive(records));
    return system.page.findFirstOrThrow({
      where: { spaceId: result.spaces[0]!.id },
      select: {
        title: true,
        currentVersion: true,
        versions: { orderBy: { version: "asc" }, select: { version: true, title: true } },
      },
    });
  };

  it("keeps every version of a page and opens it on the newest, whatever its header says", async () => {
    // A version past the header keeps its place, and the next save takes the number after it.
    expect(await importedPage(pageRecords([1, 2], { currentVersion: 1 }))).toMatchObject({
      currentVersion: 2,
      versions: [{ version: 1 }, { version: 2 }],
    });
    // A header naming a version the archive lacks opens on the newest one it has.
    expect(await importedPage(pageRecords([1], { currentVersion: 2 }))).toMatchObject({
      currentVersion: 1,
      versions: [{ version: 1 }],
    });
  });

  it("imports a version today's check refuses, so it opens on its own error", async () => {
    const result = await runImport(
      archive(
        pageRecords([1, 2], {
          source: (version) =>
            version === 1 ? "<Page" : "const App = () => <Card />;\nexport default App;\n",
        }),
      ),
    );
    const versions = await system.pageVersion.findMany({
      where: { page: { spaceId: result.spaces[0]!.id } },
      orderBy: { version: "asc" },
      select: { version: true, code: true },
    });
    expect(versions.map((version) => version.version)).toEqual([1, 2]);
    expect(versions[0]!.code).toMatch(/^throw new Error\(/);
    expect(versions[1]!.code).toContain("Card");
  });

  it("refuses a page with no version, a version of something that is not a page or a repeated version, leaving nothing behind", async () => {
    const before = await ownedSpaceIds();
    for (const records of [
      pageRecords([]),
      // A version naming a bot, not a page.
      pageRecords([1]).map((record) =>
        record.type === "page_version" ? { ...record, pageId: "src-bot-child" } : record,
      ),
      // The same version twice, under different ids.
      pageRecords([1, 1]).map((record, index) =>
        record.type === "page_version" ? { ...record, id: `src-page-copy-${index}` } : record,
      ),
    ]) {
      await expect(runImport(archive(records))).rejects.toBeInstanceOf(AccountImportError);
      expect(await ownedSpaceIds()).toEqual(before);
    }
  });

  it("folds an imported page title to one line as a save does, and refuses a blank one", async () => {
    expect(await importedPage(pageRecords([1], { title: "  Q3\n\tplan\u2028 " }))).toMatchObject({
      title: "Q3 plan",
      versions: [{ version: 1, title: "Q3 plan" }],
    });
    const before = await ownedSpaceIds();
    await expect(runImport(archive(pageRecords([1], { title: " \n " })))).rejects.toBeInstanceOf(
      AccountImportError,
    );
    expect(await ownedSpaceIds()).toEqual(before);
  });

  it("removes every space it created when a later space fails", async () => {
    const before = await ownedSpaceIds();
    const blobs = stored.size;
    const broken = sourceRecords().map((record) =>
      record.type === "message" && record.id === "src-msg-3"
        ? { ...record, threadId: "src-thread-missing" }
        : record,
    );
    const bytes = buildArchive(
      exportFiles(
        manifestFor([
          { id: "src-space", name: "Good" },
          { id: "src-space-2", name: "Bad" },
        ]),
        [
          {
            id: "src-space",
            records: sourceRecords(),
            artifacts: [
              ["src-art-1", "v1"],
              ["src-art-2", "v2"],
            ],
          },
          {
            id: "src-space-2",
            records: broken,
            artifacts: [
              ["src-art-1", "v1"],
              ["src-art-2", "v2"],
            ],
          },
        ],
      ),
    );
    await expect(runImport(bytes)).rejects.toBeInstanceOf(AccountImportError);
    expect(await ownedSpaceIds()).toEqual(before);
    expect(stored.size).toBe(blobs);
  });
});
