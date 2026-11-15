import type { Actor } from "@rakazo/contracts";
import { GROUP_MEMBER_MIN } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { Prisma } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { querySpaceSearch } from "./search.js";

const actor: Actor = {
  spaceId: "space-test",
  userId: "user-test",
  email: "user@example.test",
  isDeploymentOwner: false,
};

function fixture(count: number) {
  const artifacts = Array.from({ length: count }, (_, index) => ({
    id: `artifact-${index}`,
    botId: `bot-${index}`,
    bot: { name: "Bot" },
    name: "report.txt",
    mimeType: "text/plain",
    size: 10,
  }));
  const groupArtifacts = artifacts.map((artifact) => ({
    ...artifact,
    id: `group-${artifact.id}`,
    botId: null,
    bot: null,
    groupId: "group-test",
    group: { name: "Group", _count: { members: 2 } },
  }));
  const prisma = {
    bot: { findMany: vi.fn().mockResolvedValue([]) },
    chatGroup: { findMany: vi.fn().mockResolvedValue([]) },
    artifact: {
      findMany: vi.fn().mockResolvedValueOnce(artifacts).mockResolvedValueOnce(groupArtifacts),
    },
    routine: { findMany: vi.fn().mockResolvedValue([]) },
    $queryRaw: vi
      .fn()
      .mockResolvedValue([])
      .mockResolvedValueOnce([{ id: "group-test" }]),
  };
  return { prisma, artifacts, groupArtifacts };
}

describe("artifact search batching", () => {
  it.each([1, 25])("uses one lookup per destination for %i matching artifacts", async (count) => {
    const { prisma } = fixture(count);
    await querySpaceSearch(prisma as unknown as PrismaClient, actor, "report");
    // Two artifact batches and the eligibility query and direct/group message searches.
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(5);
    const direct = prisma.$queryRaw.mock.calls[1]?.[0];
    const group = prisma.$queryRaw.mock.calls[2]?.[0];
    expect(direct.text).toContain('t."botId" = candidate."targetId"');
    expect(group.text).toContain('t."groupId" = candidate."targetId"');
    for (const query of [direct, group]) {
      expect(query.values).toContain(actor.spaceId);
      expect(query.values).not.toContain(actor.userId);
      expect(query.text).toContain('ORDER BY m."createdAt" DESC');
    }
  });

  it("preserves artifact priority and skips missing messages regardless of batch row order", async () => {
    const { prisma } = fixture(3);
    prisma.$queryRaw
      .mockResolvedValueOnce([
        { artifactId: "artifact-2", id: "message-2", seq: 8 },
        { artifactId: "artifact-0", id: "message-0", seq: 6 },
      ])
      .mockResolvedValueOnce([{ artifactId: "group-artifact-1", id: "group-message", seq: 3 }]);
    const hits = await querySpaceSearch(prisma as unknown as PrismaClient, actor, "report");
    expect(hits.map(({ artifactId, messageId, seq }) => ({ artifactId, messageId, seq }))).toEqual([
      { artifactId: "artifact-0", messageId: "message-0", seq: 6 },
      { artifactId: "artifact-2", messageId: "message-2", seq: 8 },
      { artifactId: "group-artifact-1", messageId: "group-message", seq: 3 },
    ]);
  });

  it("does not issue artifact queries for empty batches", async () => {
    const { prisma } = fixture(0);
    expect(await querySpaceSearch(prisma as unknown as PrismaClient, actor, "report")).toEqual([]);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
  });
});

describe("search saturation", () => {
  it.each([
    { direct: 25, grouped: 25, conversations: 0, artifactReads: 1, routineReads: 0 },
    { direct: 25, grouped: 25, conversations: 5, artifactReads: 1, routineReads: 0 },
    { direct: 10, grouped: 25, conversations: 0, artifactReads: 2, routineReads: 0 },
    { direct: 0, grouped: 0, conversations: 0, artifactReads: 2, routineReads: 1 },
  ])("stops lower-priority reads when the content budget fills: %j", async (scenario) => {
    const { prisma, artifacts, groupArtifacts } = fixture(25);
    const messageSearchTokens = vi.fn().mockResolvedValue([]);
    Object.assign(prisma, { $contentEncryption: () => ({ messageSearchTokens }) });
    prisma.bot.findMany.mockResolvedValue(
      Array.from({ length: scenario.conversations }, (_, i) => ({ id: `bot-${i}`, name: "Bot" })),
    );
    prisma.artifact.findMany
      .mockReset()
      .mockResolvedValueOnce(artifacts.slice(0, scenario.direct))
      .mockResolvedValueOnce(groupArtifacts.slice(0, scenario.grouped));
    const reference = (id: string) => ({ artifactId: id, id: `message-${id}`, seq: 7 });
    if (scenario.direct)
      prisma.$queryRaw.mockResolvedValueOnce(artifacts.map((a) => reference(a.id)));
    if (scenario.grouped)
      prisma.$queryRaw.mockResolvedValueOnce(groupArtifacts.map((a) => reference(a.id)));
    prisma.routine.findMany.mockResolvedValue(
      Array.from({ length: 25 }, (_, i) => ({
        id: `routine-${i}`,
        botId: "bot",
        bot: { name: "Bot" },
        name: "report",
        prompt: "report",
      })),
    );

    const hits = await querySpaceSearch(prisma as never, actor, "report");

    expect(hits).toHaveLength(25);
    expect(hits.slice(0, scenario.conversations).every((hit) => hit.kind === "conversation")).toBe(
      true,
    );
    const expectedFiles = [
      ...artifacts.slice(0, scenario.direct),
      ...groupArtifacts.slice(0, scenario.grouped),
    ];
    expect(hits.filter((hit) => hit.kind === "file").map((hit) => hit.artifactId)).toEqual(
      expectedFiles.slice(0, 25 - scenario.conversations).map((file) => file.id),
    );
    expect(prisma.artifact.findMany).toHaveBeenCalledTimes(scenario.artifactReads);
    expect(prisma.routine.findMany).toHaveBeenCalledTimes(scenario.routineReads);
    expect(messageSearchTokens).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(
      1 +
        Number(scenario.direct > 0) +
        Number(scenario.grouped > 0 && scenario.artifactReads === 2),
    );
  });

  it("keeps searching after unreferenced file candidates fail to fill the budget", async () => {
    const { prisma } = fixture(25);
    prisma.routine.findMany.mockResolvedValue([
      { id: "routine", botId: "bot", bot: { name: "Bot" }, name: "report", prompt: "report" },
    ]);
    expect(await querySpaceSearch(prisma as never, actor, "report")).toMatchObject([
      { kind: "routine", routineId: "routine" },
    ]);
    expect(prisma.artifact.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(5);
  });
});

it("resolves active group eligibility once for names, artifacts, and messages", async () => {
  const { prisma } = fixture(0);
  await querySpaceSearch(prisma as never, actor, "Launch");

  const eligibility = prisma.$queryRaw.mock.calls[0]?.[0];
  expect(eligibility.text).toContain('g."spaceId" = $1');
  expect(eligibility.text).toContain('g."archivedAt" IS NULL');
  expect(eligibility.text).toContain("SELECT COUNT(*) FROM chat_group_members gm");
  expect(eligibility.text).toContain('INNER JOIN bots gb ON gb.id = gm."botId"');
  expect(eligibility.text).toContain('gm."groupId" = g.id AND gb."archivedAt" IS NULL');
  expect(eligibility.text).not.toContain('"userId"');
  expect(eligibility.text).toContain(") >= $2");
  expect(eligibility.values).toEqual([actor.spaceId, GROUP_MEMBER_MIN]);

  expect(prisma.chatGroup.findMany.mock.calls[0]?.[0]).toMatchObject({
    where: { spaceId: actor.spaceId, id: { in: ["group-test"] } },
    take: 5,
  });
  expect(prisma.artifact.findMany.mock.calls[1]?.[0]).toMatchObject({
    where: { spaceId: actor.spaceId, groupId: { in: ["group-test"] } },
    take: 25,
  });
  const [strings, ...values] = prisma.$queryRaw.mock.calls[2]!;
  const groupMessageQuery = Prisma.sql(strings, ...values);
  expect(groupMessageQuery.text).toContain("AND g.id IN ($2)");
  expect(groupMessageQuery.values[1]).toBe("group-test");
});

it("applies group eligibility before name and artifact limits", async () => {
  const { prisma } = fixture(0);
  const groups = Array.from({ length: 25 }, (_, index) => ({
    id: `under-minimum-${index}`,
    name: "report",
  })).concat({ id: "group-test", name: "report" });
  const files = groups.map((group) => ({
    id: `file-${group.id}`,
    groupId: group.id,
    group: { name: group.name },
    name: "report.txt",
    mimeType: "text/plain",
    size: 10,
  }));
  prisma.chatGroup.findMany.mockImplementation(async ({ where, take }) =>
    groups.filter((group) => !where.id || where.id.in.includes(group.id)).slice(0, take),
  );
  prisma.artifact.findMany
    .mockReset()
    .mockResolvedValueOnce([])
    .mockImplementation(async ({ where, take }) =>
      files
        .filter((file) => !where.groupId?.in || where.groupId.in.includes(file.groupId))
        .slice(0, take),
    );
  prisma.$queryRaw.mockResolvedValueOnce([
    { artifactId: "file-group-test", id: "message-test", seq: 1 },
  ]);

  const hits = await querySpaceSearch(prisma as never, actor, "report");
  expect(hits.map(({ kind, groupId }) => ({ kind, groupId }))).toEqual([
    { kind: "conversation", groupId: "group-test" },
    { kind: "file", groupId: "group-test" },
  ]);
});

it("searches for the characters the user typed, not SQL wildcards", async () => {
  const { prisma } = fixture(0);
  await querySpaceSearch(prisma as unknown as PrismaClient, actor, "50%_off");

  const botFilter = prisma.bot.findMany.mock.calls[0]?.[0]?.where?.OR?.[0]?.name;
  expect(botFilter?.contains).toBe("50\\%\\_off");

  const groupFilter = prisma.chatGroup.findMany.mock.calls[0]?.[0]?.where?.name;
  expect(groupFilter?.contains).toBe("50\\%\\_off");

  // The message scan builds its own pattern, and a backslash in the query must
  // not swallow the character after it.
  const boundValues = prisma.$queryRaw.mock.calls.flatMap((call) =>
    call.map((argument) => (argument as { values?: unknown[] } | undefined)?.values ?? []),
  );
  expect(boundValues.flat()).toContain("%50\\%\\_off%");
});

it("JSON-escapes backslashes only for the message scan", async () => {
  const { prisma } = fixture(0);
  await querySpaceSearch(prisma as unknown as PrismaClient, actor, String.raw`back\slash`);

  const botFilter = prisma.bot.findMany.mock.calls[0]?.[0]?.where?.OR?.[0]?.name;
  expect(botFilter?.contains).toBe(String.raw`back\\slash`);
  const groupFilter = prisma.chatGroup.findMany.mock.calls[0]?.[0]?.where?.name;
  expect(groupFilter?.contains).toBe(String.raw`back\\slash`);
  for (const call of prisma.$queryRaw.mock.calls.slice(1)) {
    const values = call.flatMap(
      (argument) => (argument as { values?: unknown[] } | undefined)?.values ?? [],
    );
    expect(values).toContain(String.raw`%back\\\\slash%`);
  }
});

it("guards name-derived snippets while preserving descriptions", async () => {
  const { prisma } = fixture(0);
  prisma.bot.findMany.mockResolvedValue([
    { id: "bot-1", name: "__TestTok1__", title: "", description: "" },
    { id: "bot-2", name: "__TestTok2__", title: "", description: "Keep __TestTok2__ literal" },
  ] as never);
  prisma.chatGroup.findMany.mockResolvedValue([
    { id: "group-1", name: "__TestTok1__", _count: { members: 2 } },
  ] as never);
  const hits = await querySpaceSearch(prisma as never, actor, "TestTok");
  expect(
    hits
      .filter((hit) => hit.botId === "bot-1" || hit.groupId === "group-1")
      .map((hit) => hit.snippet),
  ).toEqual(["", ""]);
  expect(hits.find((hit) => hit.botId === "bot-2")?.snippet).toBe("Keep __TestTok2__ literal");
});
