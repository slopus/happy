import { MCP_APP_MIME_TYPE, STEP_SCREENSHOT_MIME_TYPES } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { isUniqueViolation } from "./prisma-errors.js";

/**
 * Files people and bots see. An MCP app's HTML is kept as an artifact only for its chat card, and
 * a reply's kept screenshot only for the bot's later turns.
 */
export const HIDDEN_ARTIFACT_MIME_TYPES = [MCP_APP_MIME_TYPE, ...STEP_SCREENSHOT_MIME_TYPES];
export const LISTED_ARTIFACT = {
  mimeType: { notIn: HIDDEN_ARTIFACT_MIME_TYPES },
} satisfies Prisma.ArtifactWhereInput;

export async function resolveNextArtifactVersion(
  prisma: Pick<PrismaClient, "artifact">,
  params: {
    spaceId: string;
    botId: string;
    groupId?: string | null;
    name: string;
  },
): Promise<{ rootArtifactId: string | null; version: number }> {
  const previous = await prisma.artifact.findFirst({
    where: {
      spaceId: params.spaceId,
      botId: params.botId,
      groupId: params.groupId ?? null,
      name: { equals: params.name, mode: "insensitive" },
      standalone: false,
      // An MCP app's hidden HTML never starts or joins a file's version history.
      ...LISTED_ARTIFACT,
    },
    orderBy: [{ version: "desc" }, { createdAt: "desc" }],
    select: { id: true, rootArtifactId: true, version: true },
  });
  if (!previous) return { rootArtifactId: null, version: 1 };
  return {
    rootArtifactId: previous.rootArtifactId ?? previous.id,
    version: previous.version + 1,
  };
}

const MAX_VERSION_ALLOCATION_ATTEMPTS = 5;

type ArtifactVersionWrite = {
  rootArtifactId: string | null;
  version: number;
};

// A family is the space's: any member's same-name publish is its next version.
// Advisory lock queues same-name publishes; retry a unique family-version clash.
export async function withResolvedArtifactVersion<T>(
  prisma: Pick<PrismaClient, "$transaction">,
  params: {
    spaceId: string;
    botId: string;
    groupId?: string | null;
    name: string;
  },
  attempt: (db: Prisma.TransactionClient, version: ArtifactVersionWrite) => Promise<T>,
  options?: { timeout?: number },
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < MAX_VERSION_ALLOCATION_ATTEMPTS; i++) {
    try {
      return await prisma.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${artifactVersionLockKey(params)}, 0))::text AS "lock"
        `);
        const version = await resolveNextArtifactVersion(tx, params);
        return await attempt(tx, version);
      }, options);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

// Same identity as the name lookup, so those publishes share one lock.
function artifactVersionLockKey(params: {
  spaceId: string;
  botId: string;
  groupId?: string | null;
  name: string;
}): string {
  return [params.spaceId, params.botId, params.groupId ?? "", params.name.toLowerCase()].join(
    "\u001f",
  );
}
