import { createHash } from "node:crypto";
import path from "node:path";
import type {
  AdapterContext,
  ArtifactStore,
  ComputerRef,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { AttachmentImageMimeType, ComputerMode, MessageBlock } from "@rakazo/contracts";
import {
  ARTIFACT_DESCRIPTION_MAX_LENGTH,
  ARTIFACT_NAME_MAX_LENGTH,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_COUNT,
  attachmentSizeLabel,
  HISTORY_ATTACHMENTS_PER_RESPONSE,
  MCP_APP_MIME_TYPE,
  stepScreenshotMimeType,
} from "@rakazo/contracts";
import {
  attachmentComputerPath,
  inferAttachmentMimeType,
  messageBlockForArtifact,
  validateAttachmentMimeType,
} from "@rakazo/core";
import type { Artifact, Prisma, PrismaClient } from "@rakazo/db";
import {
  THREAD_LOCK_TRANSACTION_OPTIONS,
  withResolvedArtifactVersion,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { resolveBotWorkspacePath } from "./computer-support.js";

export type MaterializedThreadFile = {
  name: string;
  mimeType: string;
  size: number;
  path: string;
};

export async function attachWorkspaceFileToThread(
  deps: {
    prisma: PrismaClient;
    artifacts: ArtifactStore;
    maxUploadSizeBytes?: number;
  },
  input: {
    spaceId: string;
    userId: string;
    botId: string;
    groupId?: string;
    runId: string;
    filePath: string;
    bytes: Uint8Array;
    operationId: string;
    name?: string;
    description?: string;
    /** Checkpoint a caller's durable state atomically with attachment creation. */
    onAttached?: (tx: Prisma.TransactionClient, artifact: Artifact) => Promise<void>;
  },
): Promise<{ artifactId: string; block: Extract<MessageBlock, { kind: "image" | "file" }> }> {
  const fileName = path.basename(input.filePath) || input.filePath;
  const mimeType = inferAttachmentMimeType(fileName);
  if (!mimeType) {
    throw new Error(`Unsupported attachment type for ${fileName}`);
  }
  const name = (input.name?.trim() || fileName).slice(0, ARTIFACT_NAME_MAX_LENGTH);
  validateAttachmentMimeType(mimeType);
  if (input.bytes.byteLength > (deps.maxUploadSizeBytes ?? ATTACHMENT_MAX_BYTES)) {
    throw new Error(
      `file exceeds the ${attachmentSizeLabel(deps.maxUploadSizeBytes ?? ATTACHMENT_MAX_BYTES)} attachment limit`,
    );
  }

  const context = {
    operationId: input.operationId,
    traceId: input.operationId,
    spaceId: input.spaceId,
    userId: input.userId,
    botId: input.botId,
    signal: new AbortController().signal,
  };
  const stored = await deps.artifacts.put({ name, mimeType, bytes: input.bytes }, context);
  const hash = createHash("sha256").update(input.bytes).digest("hex");
  // Concurrent runs in one thread contend for its sequence counters when onAttached posts
  // a message; Postgres aborts a deadlock victim, which commits nothing, so retry it.
  const row = await withTransactionRetry(() =>
    withResolvedArtifactVersion(
      deps.prisma,
      {
        spaceId: input.spaceId,
        botId: input.botId,
        groupId: input.groupId,
        name,
      },
      async (tx, { rootArtifactId, version }) => {
        const artifact = await tx.artifact.create({
          data: {
            spaceId: input.spaceId,
            userId: input.userId,
            botId: input.botId,
            groupId: input.groupId,
            runId: input.runId,
            name,
            description:
              input.description?.trim().slice(0, ARTIFACT_DESCRIPTION_MAX_LENGTH) || null,
            mimeType,
            size: input.bytes.byteLength,
            hash,
            storageKey: stored.id,
            rootArtifactId,
            version,
          },
        });
        await input.onAttached?.(tx, artifact);
        return artifact;
      },
      // onAttached may post a message, which waits for the thread row; a snapshot read can
      // hold it longer than Prisma's default budget, and an expired transaction is not retried.
      THREAD_LOCK_TRANSACTION_OPTIONS,
    ),
  ).catch(async (error) => {
    await deps.artifacts.remove(stored.id, context).catch(() => undefined);
    throw error;
  });
  return { artifactId: row.id, block: messageBlockForArtifact(row) };
}

function attachmentBlocks(blocks: MessageBlock[] | undefined) {
  return (
    blocks?.filter(
      (block): block is Extract<MessageBlock, { kind: "file" | "image" }> =>
        block.kind === "file" || block.kind === "image",
    ) ?? []
  );
}

async function attachedArtifacts(
  prisma: PrismaClient,
  blocks: Array<Extract<MessageBlock, { kind: "file" | "image" }>>,
  context: AdapterContext,
) {
  const rows = await prisma.artifact.findMany({
    where: {
      id: { in: blocks.map((block) => block.artifactId) },
      spaceId: context.spaceId,
    },
  });
  return new Map(rows.map((row) => [row.id, row]));
}

function threadFileMetadata(
  row: Pick<Artifact, "id" | "name" | "mimeType" | "size">,
): MaterializedThreadFile {
  return {
    name: row.name,
    mimeType: row.mimeType,
    size: row.size,
    path: attachmentComputerPath(row.id, row.mimeType),
  };
}

/** Resolve current attachments without reading their bytes or waking a computer. */
export async function listCurrentTurnFiles(
  deps: { prisma: PrismaClient; maxUploadSizeBytes?: number },
  blocks: MessageBlock[] | undefined,
  context: AdapterContext,
): Promise<MaterializedThreadFile[]> {
  const attached = attachmentBlocks(blocks);
  if (!attached.length) return [];
  const byId = await attachedArtifacts(deps.prisma, attached, context);
  return attached.map((block) => {
    const row = byId.get(block.artifactId);
    if (!row) throw new Error(`Attached file is unavailable: ${block.name}`);
    if (row.size > (deps.maxUploadSizeBytes ?? ATTACHMENT_MAX_BYTES)) {
      throw new Error(
        `Attached file exceeds the ${attachmentSizeLabel(deps.maxUploadSizeBytes ?? ATTACHMENT_MAX_BYTES)} limit: ${row.name}`,
      );
    }
    return threadFileMetadata(row);
  });
}

export async function materializeCurrentTurnFiles(
  deps: {
    prisma: PrismaClient;
    artifacts: ArtifactStore;
    maxUploadSizeBytes?: number;
    sandbox: SandboxProvider;
  },
  blocks: MessageBlock[] | undefined,
  input: {
    context: AdapterContext & { botId: string };
    /** Starts the computer; called only when there is a file to copy onto it. */
    computer: () => Promise<ComputerRef>;
    computerMode: ComputerMode;
    markWorkspaceDirty?: () => void;
  },
): Promise<MaterializedThreadFile[]> {
  return materializeThreadFiles(deps, blocks, input, false);
}

async function materializeThreadFiles(
  deps: Parameters<typeof materializeCurrentTurnFiles>[0],
  blocks: MessageBlock[] | undefined,
  input: Parameters<typeof materializeCurrentTurnFiles>[2],
  preserveExisting: boolean,
): Promise<MaterializedThreadFile[]> {
  // Images seen inline for vision are not on disk, so they are copied too; otherwise a bot can
  // describe a photo it cannot attach, forward, or hand to a tool.
  const fileBlocks = attachmentBlocks(blocks);
  if (!fileBlocks.length) return [];
  const byId = await attachedArtifacts(deps.prisma, fileBlocks, input.context);
  const materialized: MaterializedThreadFile[] = [];

  for (const block of fileBlocks) {
    const row = byId.get(block.artifactId);
    if (!row) throw new Error(`Attached file is unavailable: ${block.name}`);
    const metadata = threadFileMetadata(row);
    const workspacePath = resolveBotWorkspacePath(
      input.computerMode,
      input.context.botId,
      metadata.path,
    );
    const exists = preserveExisting
      ? await deps.sandbox.readFile(await input.computer(), workspacePath, input.context).then(
          () => true,
          () => false,
        )
      : false;
    if (!exists) {
      const bytes = await deps.artifacts.get(row.storageKey, input.context);
      if (bytes.byteLength > (deps.maxUploadSizeBytes ?? ATTACHMENT_MAX_BYTES)) {
        throw new Error(
          `Attached file exceeds the ${attachmentSizeLabel(deps.maxUploadSizeBytes ?? ATTACHMENT_MAX_BYTES)} limit: ${row.name}`,
        );
      }
      input.markWorkspaceDirty?.();
      await deps.sandbox.writeFile(
        await input.computer(),
        { path: workspacePath, content: bytes },
        input.context,
      );
    }
    materialized.push(metadata);
  }

  return materialized;
}

export async function materializeRecentThreadFiles(
  deps: Parameters<typeof materializeCurrentTurnFiles>[0],
  history: ReadonlyArray<{ id?: string; role: string }>,
  messages: ReadonlyArray<{ id: string; blocks: MessageBlock[] }>,
  input: Parameters<typeof materializeCurrentTurnFiles>[2] & {
    skipMessageId?: string | null;
    maxTurns: number;
  },
): Promise<MaterializedThreadFile[]> {
  // Every computer start copies these again, so they need no checkpoint.
  return materializeEarlierFiles(
    deps,
    recentAttachmentBlocks(history, messages, input),
    { ...input, markWorkspaceDirty: undefined },
    ATTACHMENT_MAX_COUNT,
  );
}

/** Earlier files waiting to be copied at once: one full history response; older listings give way. */
export const EARLIER_FILES_PENDING = HISTORY_ATTACHMENTS_PER_RESPONSE;

/**
 * Files history tools listed since the last computer tool, newest kept. A file copied to the
 * current computer is not queued again; one whose copy failed is, the next time it is listed.
 */
export function createEarlierFileQueue(limit = EARLIER_FILES_PENDING) {
  type FileBlock = Extract<MessageBlock, { kind: "file" | "image" }>;
  let pending: FileBlock[] = [];
  let copied = new Set<string>();
  return {
    add(files: ReadonlyArray<FileBlock>) {
      for (const file of files) {
        if (copied.has(file.artifactId)) continue;
        pending = pending.filter((queued) => queued.artifactId !== file.artifactId);
        pending.push(file);
      }
      if (pending.length > limit) {
        getLogger().warn("earlier files not copied: newer listings replaced them");
        pending = pending.slice(-limit);
      }
    },
    take() {
      const taken = pending;
      pending = [];
      return taken;
    },
    /** Record which taken files reached the computer, by the paths the copy returned. */
    copiedTo(taken: ReadonlyArray<FileBlock>, files: ReadonlyArray<MaterializedThreadFile>) {
      const paths = new Set(files.map((file) => file.path));
      for (const file of taken)
        if (paths.has(attachmentComputerPath(file.artifactId, file.mimeType)))
          copied.add(file.artifactId);
    },
    /** A newly started computer has none of the earlier copies. */
    computerStarted() {
      copied = new Set();
    },
  };
}

/**
 * Copy files from earlier messages onto the computer, keeping copies already there. Each
 * file that cannot be copied is logged and skipped so it never blocks the tool that asked.
 * A new copy marks the workspace dirty when the caller passes markWorkspaceDirty.
 */
export async function materializeEarlierFiles(
  deps: Parameters<typeof materializeCurrentTurnFiles>[0],
  blocks: ReadonlyArray<Extract<MessageBlock, { kind: "file" | "image" }>>,
  input: Parameters<typeof materializeCurrentTurnFiles>[2],
  limit = Number.POSITIVE_INFINITY,
): Promise<MaterializedThreadFile[]> {
  const materialized: MaterializedThreadFile[] = [];
  for (const block of blocks) {
    if (materialized.length >= limit) break;
    try {
      materialized.push(...(await materializeThreadFiles(deps, [block], input, true)));
    } catch (error) {
      if (input.context.signal.aborted) throw error;
      getLogger().warn("earlier thread attachment was not copied to the computer", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return materialized;
}

/**
 * The earlier attachments a run can expect on its computer, without starting it. The run
 * copies them with materializeRecentThreadFiles once something first uses the computer.
 */
export async function listRecentThreadFiles(
  deps: Pick<Parameters<typeof materializeCurrentTurnFiles>[0], "prisma" | "maxUploadSizeBytes">,
  history: ReadonlyArray<{ id?: string; role: string }>,
  messages: ReadonlyArray<{ id: string; blocks: MessageBlock[] }>,
  input: {
    context: AdapterContext;
    skipMessageId?: string | null;
    maxTurns: number;
  },
): Promise<MaterializedThreadFile[]> {
  const blocks = recentAttachmentBlocks(history, messages, input);
  if (!blocks.length) return [];
  const byId = await attachedArtifacts(deps.prisma, blocks, input.context);
  const limit = deps.maxUploadSizeBytes ?? ATTACHMENT_MAX_BYTES;
  return blocks
    .flatMap((block) => {
      const row = byId.get(block.artifactId);
      if (!row || row.size > limit) return [];
      return [threadFileMetadata(row)];
    })
    .slice(0, ATTACHMENT_MAX_COUNT);
}

/** The newest attachments across the last `maxTurns` user turns that carry any. */
function recentAttachmentBlocks(
  history: ReadonlyArray<{ id?: string; role: string }>,
  messages: ReadonlyArray<{ id: string; blocks: MessageBlock[] }>,
  input: { skipMessageId?: string | null; maxTurns: number },
): Array<Extract<MessageBlock, { kind: "file" | "image" }>> {
  const blocksByMessageId = new Map(messages.map((message) => [message.id, message.blocks]));
  const selected = new Map<string, Extract<MessageBlock, { kind: "file" | "image" }>>();
  let turns = 0;
  for (let index = history.length - 1; index >= 0 && turns < input.maxTurns; index -= 1) {
    const entry = history[index];
    if (!entry?.id || entry.role !== "user" || entry.id === input.skipMessageId) continue;
    const attached = attachmentBlocks(blocksByMessageId.get(entry.id));
    if (!attached.length) continue;
    turns += 1;
    for (const block of attached.reverse()) {
      if (!selected.has(block.artifactId)) selected.set(block.artifactId, block);
    }
  }
  return [...selected.values()];
}

function fileLine(file: MaterializedThreadFile): string {
  return `- ${JSON.stringify(file.name)} (${file.mimeType}, ${file.size} bytes): ${JSON.stringify(file.path)}`;
}

export function currentTurnFilesInstruction(files: readonly MaterializedThreadFile[]): string {
  if (!files.length) return "";
  return [
    "Attachments will be copied to these paths when a tool needs the computer. If an image is visible directly in your input, answer from that image without starting the computer. Inspect files not visible in your input with file tools before answering questions about their contents:",
    ...files.map(fileLine),
  ].join("\n");
}

export function recentThreadFilesInstruction(files: readonly MaterializedThreadFile[]): string {
  if (!files.length) return "";
  return [
    "Files attached earlier in this conversation are also on your computer:",
    ...files.map(fileLine),
  ].join("\n");
}

type HiddenArtifactOwner = {
  spaceId: string;
  userId: string;
  botId: string;
  groupId?: string;
  runId: string;
  operationId: string;
};

/**
 * Keeps bytes as a hidden artifact of the thread's bot or group: read back through the same
 * authorized path as attachments, encrypted per space like them, but never listed, searched or
 * versioned, because its type is one of HIDDEN_ARTIFACT_MIME_TYPES. One copy per content.
 */
async function storeHiddenArtifact(
  deps: { prisma: PrismaClient; artifacts: ArtifactStore },
  input: HiddenArtifactOwner,
  file: { name: string; mimeType: string; bytes: Uint8Array },
): Promise<string> {
  const hash = createHash("sha256").update(file.bytes).digest("hex");
  const owner = {
    spaceId: input.spaceId,
    userId: input.userId,
    botId: input.botId,
    groupId: input.groupId ?? null,
  };
  const existing = await deps.prisma.artifact.findFirst({
    where: { ...owner, hash, mimeType: file.mimeType },
    select: { id: true },
  });
  if (existing) return existing.id;
  const name = file.name.slice(0, ARTIFACT_NAME_MAX_LENGTH);
  const context = {
    operationId: input.operationId,
    traceId: input.operationId,
    spaceId: input.spaceId,
    userId: input.userId,
    botId: input.botId,
    signal: new AbortController().signal,
  };
  const stored = await deps.artifacts.put(
    { name, mimeType: file.mimeType, bytes: file.bytes },
    context,
  );
  // Its own one-version family: a file of the same name never versions it, nor it the file.
  const row = await deps.prisma.artifact
    .create({
      data: {
        ...owner,
        runId: input.runId,
        name,
        mimeType: file.mimeType,
        size: file.bytes.byteLength,
        hash,
        storageKey: stored.id,
      },
    })
    .catch(async (error) => {
      await deps.artifacts.remove(stored.id, context).catch(() => undefined);
      throw error;
    });
  return row.id;
}

/** Keeps an MCP app's HTML as a hidden artifact, so its chat card can load it later. */
export function storeMcpAppHtml(
  deps: { prisma: PrismaClient; artifacts: ArtifactStore },
  input: HiddenArtifactOwner & { server: string; html: string },
): Promise<string> {
  return storeHiddenArtifact(deps, input, {
    name: `${input.server} app.html`,
    mimeType: MCP_APP_MIME_TYPE,
    bytes: new TextEncoder().encode(input.html),
  });
}

/**
 * Keeps the screenshot a reply's call returned last, so the bot's later turns see it again. It is
 * deleted with the run's messages when the chat is cleared.
 */
export function storeStepScreenshot(
  deps: { prisma: PrismaClient; artifacts: ArtifactStore },
  input: HiddenArtifactOwner & {
    image: { mimeType: AttachmentImageMimeType; data: Uint8Array };
  },
): Promise<string> {
  return storeHiddenArtifact(deps, input, {
    name: "screenshot",
    mimeType: stepScreenshotMimeType(input.image.mimeType),
    bytes: input.image.data,
  });
}
