import type { Actor, MessageBlock, SearchHit } from "@rakazo/contracts";
import { GROUP_MEMBER_MIN } from "@rakazo/contracts";
import {
  displayName,
  escapeJsonSearchWildcards,
  escapeSearchWildcards,
  extractLinksFromText,
  matchesSearchQuery,
  snippetAroundMatch,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  contentEncryptionOf,
  INDEXED_MESSAGE,
  LISTED_ARTIFACT,
  Prisma,
  UNINDEXED_MESSAGE,
} from "@rakazo/db";

const SEARCH_LIMIT = 25;
/** Cap name matches so content hits (messages/files/links/routines) keep most of the budget. */
const CONVERSATION_HIT_LIMIT = 5;
/** Recent encrypted messages scanned when no query term is long enough to be indexed. */
const UNINDEXED_SCAN_LIMIT = 200;

/**
 * Encrypted messages match on blind-index prefix tokens, then decrypt and filter
 * in `pushMessageHits`; rows not yet encrypted keep the substring match. Index
 * matches are whole words or word prefixes, so text inside a word only matches
 * on rows that are still plaintext.
 */
/**
 * A delivery is the bot's prompt, hidden in chat, so it is never a result. Filtered before
 * paging so deliveries can't fill the candidate pages; `kind` stays plaintext when encrypted.
 */
const NOT_DELIVERY = Prisma.sql`NOT (m.blocks @> ${JSON.stringify([{ kind: "delivery" }])}::jsonb)`;

async function messageMatch(prisma: PrismaClient, spaceId: string, query: string) {
  const plaintext = Prisma.sql`m.blocks::text ILIKE ${`%${escapeJsonSearchWildcards(query)}%`}`;
  const encryption = contentEncryptionOf(prisma);
  if (!encryption) return { sql: plaintext, limit: SEARCH_LIMIT, pages: 1 };
  const keyTokens = await encryption.messageSearchTokens(spaceId, query, "prefix");
  // No keys: nothing in the space was ever encrypted (encryption off from the start).
  if (!keyTokens.length) return { sql: plaintext, limit: SEARCH_LIMIT, pages: 1 };
  const tokenSets = keyTokens.filter((tokens) => tokens.length);
  if (!tokenSets.length)
    return {
      sql: Prisma.sql`(${INDEXED_MESSAGE} OR ${plaintext})`,
      limit: UNINDEXED_SCAN_LIMIT,
      pages: 1,
    };
  const encrypted = tokenSets.map((tokens) => Prisma.sql`m."searchTokens" @> ${tokens}::int[]`);
  return {
    sql: Prisma.sql`(${Prisma.join([...encrypted, Prisma.sql`(${UNINDEXED_MESSAGE} AND ${plaintext})`], " OR ")})`,
    limit: SEARCH_LIMIT * 4,
    // Candidates can share the query's words without containing the phrase, so
    // keep fetching until results fill or candidates run out, within a bound.
    pages: 5,
  };
}

async function openMessages<T extends { id: string }>(prisma: PrismaClient, rows: T[]) {
  return (await contentEncryptionOf(prisma)?.openRows("Message", rows)) ?? rows;
}

async function findArtifactMessages(
  prisma: PrismaClient,
  actor: Actor,
  artifacts: Array<{ id: string; targetId: string }>,
  target: "bot" | "group",
): Promise<Map<string, { id: string; seq: number }>> {
  if (artifacts.length === 0) return new Map();
  const targetColumn = target === "bot" ? Prisma.sql`t."botId"` : Prisma.sql`t."groupId"`;
  const candidates = Prisma.join(
    artifacts.map(({ id, targetId }) => Prisma.sql`(${id}, ${targetId})`),
  );
  const rows = await prisma.$queryRaw<Array<{ artifactId: string; id: string; seq: number }>>(
    Prisma.sql`
      SELECT candidate."artifactId", message.id, message.seq
      FROM (VALUES ${candidates}) AS candidate("artifactId", "targetId")
      CROSS JOIN LATERAL (
        SELECT m.id, m.seq
        FROM messages m
        INNER JOIN threads t ON t.id = m."threadId"
        WHERE t."spaceId" = ${actor.spaceId}
          AND ${targetColumn} = candidate."targetId"
          AND m.blocks::text ILIKE ('%' || candidate."artifactId" || '%')
        ORDER BY m."createdAt" DESC
        LIMIT 1
      ) message
    `,
  );
  return new Map(rows.map(({ artifactId, id, seq }) => [artifactId, { id, seq }]));
}

export async function querySpaceSearch(
  prisma: PrismaClient,
  actor: Actor,
  q: string,
): Promise<SearchHit[]> {
  const query = q.trim();
  if (!query) return [];
  // The database side has to match the text the user typed, the way
  // `matchesSearchQuery` does in memory: a `%` or `_` would otherwise widen
  // the match, and a `\` would swallow the character after it.
  const likeQuery = escapeSearchWildcards(query);

  const conversationHits: SearchHit[] = [];
  const contentHits: SearchHit[] = [];
  const seen = new Set<string>();

  function pushInto(bucket: SearchHit[], hit: SearchHit, limit: number) {
    const key = [
      hit.kind,
      hit.botId ?? "",
      hit.groupId ?? "",
      hit.messageId ?? "",
      hit.artifactId ?? "",
      hit.routineId ?? "",
      hit.url ?? "",
    ].join(":");
    if (seen.has(key) || bucket.length >= limit) return;
    seen.add(key);
    bucket.push(hit);
  }

  const bots = await prisma.bot.findMany({
    where: {
      spaceId: actor.spaceId,
      archivedAt: null,
      OR: [
        { name: { contains: likeQuery, mode: "insensitive" } },
        { description: { contains: likeQuery, mode: "insensitive" } },
      ],
    },
    take: CONVERSATION_HIT_LIMIT,
  });
  for (const bot of bots) {
    pushInto(
      conversationHits,
      {
        kind: "conversation",
        botId: bot.id,
        botName: bot.name,
        title: bot.name,
        snippet: bot.description || displayName(bot.name, ""),
      },
      CONVERSATION_HIT_LIMIT * 2,
    );
  }

  // Only groups that can actually be opened: not archived, and still holding
  // enough active-member bots (archiving bots can empty a group below the
  // minimum — those land on the Archived list instead of opening).
  const openableGroups = await prisma.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`
      SELECT g.id FROM chat_groups g
      WHERE g."spaceId" = ${actor.spaceId}
        AND g."archivedAt" IS NULL
        AND (
          SELECT COUNT(*) FROM chat_group_members gm
          INNER JOIN bots gb ON gb.id = gm."botId"
          WHERE gm."groupId" = g.id AND gb."archivedAt" IS NULL
        ) >= ${GROUP_MEMBER_MIN}
    `,
  );
  const openableGroupIds = openableGroups.map(({ id }) => id);
  const groups = await prisma.chatGroup.findMany({
    where: {
      spaceId: actor.spaceId,
      id: { in: openableGroupIds },
      name: { contains: likeQuery, mode: "insensitive" },
    },
    take: CONVERSATION_HIT_LIMIT,
  });
  for (const group of groups) {
    pushInto(
      conversationHits,
      {
        kind: "conversation",
        groupId: group.id,
        groupName: group.name,
        title: group.name,
        snippet: displayName(group.name, ""),
      },
      CONVERSATION_HIT_LIMIT * 2,
    );
  }

  const contentBudget = Math.max(0, SEARCH_LIMIT - conversationHits.length);
  const full = () => contentHits.length >= contentBudget;

  const artifacts = await prisma.artifact.findMany({
    where: {
      spaceId: actor.spaceId,
      groupId: null,
      botId: { not: null },
      name: { contains: likeQuery, mode: "insensitive" },
      bot: { archivedAt: null },
      ...LISTED_ARTIFACT,
    },
    include: { bot: { select: { name: true } } },
    take: SEARCH_LIMIT,
  });
  const botArtifactMessages = await findArtifactMessages(
    prisma,
    actor,
    artifacts.flatMap((artifact) =>
      artifact.botId && artifact.bot ? [{ id: artifact.id, targetId: artifact.botId }] : [],
    ),
    "bot",
  );
  for (const artifact of artifacts) {
    if (!artifact.botId || !artifact.bot) continue;
    const message = botArtifactMessages.get(artifact.id);
    if (!message) continue;
    pushInto(
      contentHits,
      {
        kind: "file",
        botId: artifact.botId,
        botName: artifact.bot.name,
        title: artifact.name,
        snippet: `${artifact.mimeType}, ${artifact.size} bytes`,
        artifactId: artifact.id,
        messageId: message.id,
        seq: message.seq,
      },
      contentBudget,
    );
  }

  if (full()) return [...conversationHits, ...contentHits];

  const groupArtifacts = await prisma.artifact.findMany({
    where: {
      spaceId: actor.spaceId,
      groupId: { in: openableGroupIds },
      name: { contains: likeQuery, mode: "insensitive" },
      ...LISTED_ARTIFACT,
    },
    include: { group: { select: { name: true } } },
    take: SEARCH_LIMIT,
  });
  const groupArtifactMessages = await findArtifactMessages(
    prisma,
    actor,
    groupArtifacts.flatMap((artifact) =>
      artifact.groupId && artifact.group ? [{ id: artifact.id, targetId: artifact.groupId }] : [],
    ),
    "group",
  );
  for (const artifact of groupArtifacts) {
    if (!artifact.groupId || !artifact.group) continue;
    const message = groupArtifactMessages.get(artifact.id);
    if (!message) continue;
    pushInto(
      contentHits,
      {
        kind: "file",
        groupId: artifact.groupId,
        groupName: artifact.group.name,
        title: artifact.name,
        snippet: `${artifact.mimeType}, ${artifact.size} bytes`,
        artifactId: artifact.id,
        messageId: message.id,
        seq: message.seq,
      },
      contentBudget,
    );
  }

  if (full()) return [...conversationHits, ...contentHits];

  const routines = await prisma.routine.findMany({
    where: {
      spaceId: actor.spaceId,
      OR: [
        { name: { contains: likeQuery, mode: "insensitive" } },
        { prompt: { contains: likeQuery, mode: "insensitive" } },
      ],
      bot: { archivedAt: null },
    },
    include: { bot: { select: { name: true } } },
    take: SEARCH_LIMIT,
  });
  for (const routine of routines) {
    pushInto(
      contentHits,
      {
        kind: "routine",
        botId: routine.botId,
        botName: routine.bot.name,
        title: routine.name,
        snippet: snippetAroundMatch(routine.prompt, query),
        routineId: routine.id,
      },
      contentBudget,
    );
  }

  if (full()) return [...conversationHits, ...contentHits];

  const match = await messageMatch(prisma, actor.spaceId, query);
  for (let page = 0; page < match.pages && !full(); page += 1) {
    const messageRows = await openMessages(
      prisma,
      await prisma.$queryRaw<
        Array<{
          id: string;
          threadId: string;
          seq: number;
          blocks: Prisma.JsonValue;
          botId: string;
          botName: string;
        }>
      >`
      SELECT m.id, m."threadId", m.seq, m.blocks, b.id AS "botId", b.name AS "botName"
      FROM messages m
      INNER JOIN threads t ON t.id = m."threadId"
      INNER JOIN bots b ON b.id = t."botId"
      WHERE t."spaceId" = ${actor.spaceId}
        AND b."archivedAt" IS NULL
        AND ${match.sql}
        AND ${NOT_DELIVERY}
      ORDER BY m."createdAt" DESC, m.id DESC
      LIMIT ${match.limit} OFFSET ${page * match.limit}
    `,
    );
    for (const row of messageRows) {
      pushMessageHits(row.blocks as MessageBlock[], {
        botId: row.botId,
        botName: row.botName,
        messageId: row.id,
        seq: row.seq,
        query,
        push: (hit) => pushInto(contentHits, hit, contentBudget),
      });
    }
    if (messageRows.length < match.limit) break;
  }

  for (let page = 0; page < match.pages && !full(); page += 1) {
    const groupMessageRows = await openMessages(
      prisma,
      await prisma.$queryRaw<
        Array<{
          id: string;
          threadId: string;
          seq: number;
          blocks: Prisma.JsonValue;
          groupId: string;
          groupName: string;
        }>
      >`
      SELECT m.id, m."threadId", m.seq, m.blocks, g.id AS "groupId", g.name AS "groupName"
      FROM messages m
      INNER JOIN threads t ON t.id = m."threadId"
      INNER JOIN chat_groups g ON g.id = t."groupId"
      WHERE t."spaceId" = ${actor.spaceId}
        AND t."groupId" IS NOT NULL
        AND g.id IN (${Prisma.join(openableGroupIds.length ? openableGroupIds : [null])})
        AND ${match.sql}
        AND ${NOT_DELIVERY}
      ORDER BY m."createdAt" DESC, m.id DESC
      LIMIT ${match.limit} OFFSET ${page * match.limit}
    `,
    );
    for (const row of groupMessageRows) {
      pushMessageHits(row.blocks as MessageBlock[], {
        groupId: row.groupId,
        groupName: row.groupName,
        messageId: row.id,
        seq: row.seq,
        query,
        push: (hit) => pushInto(contentHits, hit, contentBudget),
      });
    }
    if (groupMessageRows.length < match.limit) break;
  }

  return [...conversationHits, ...contentHits].slice(0, SEARCH_LIMIT);
}

function pushMessageHits(
  blocks: MessageBlock[],
  ctx: {
    botId?: string;
    botName?: string;
    groupId?: string;
    groupName?: string;
    messageId: string;
    seq: number;
    query: string;
    push: (hit: SearchHit) => void;
  },
) {
  // Discriminate on groupId (not name): empty group names must still target the group.
  const destination = ctx.groupId
    ? { groupId: ctx.groupId, groupName: ctx.groupName ?? "" }
    : { botId: ctx.botId!, botName: ctx.botName! };
  const title = ctx.groupId ? (ctx.groupName ?? "") : (ctx.botName ?? "");
  let messageHit = false;
  for (const block of blocks) {
    if (block.kind !== "text") continue;
    const text = block.text;
    if (matchesSearchQuery(ctx.query, text)) {
      ctx.push({
        kind: "message",
        ...destination,
        title,
        snippet: snippetAroundMatch(text, ctx.query),
        messageId: ctx.messageId,
        seq: ctx.seq,
      });
      messageHit = true;
    }
    for (const url of extractLinksFromText(text)) {
      if (matchesSearchQuery(ctx.query, url)) {
        ctx.push({
          kind: "link",
          ...destination,
          title: url,
          snippet: snippetAroundMatch(text, ctx.query),
          messageId: ctx.messageId,
          seq: ctx.seq,
          url,
        });
      }
    }
  }
  if (!messageHit && matchesSearchQuery(ctx.query, JSON.stringify(blocks))) {
    ctx.push({
      kind: "message",
      ...destination,
      title,
      snippet: ctx.query,
      messageId: ctx.messageId,
      seq: ctx.seq,
    });
  }
}
