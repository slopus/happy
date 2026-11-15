import * as z from "zod";
import { Id, IsoDate, ReplyModeSchema } from "./ids.js";
import { PageSourceSchema, PageTitleSchema } from "./pages.js";

/**
 * A whole account as one zip, to move between Rakazo installs (Cloud to self-hosted and back).
 *
 * - `manifest.json` comes first: the format, version and the exported spaces.
 * - `spaces/<spaceId>/records.jsonl`: one `AccountExportRecord` per line. A record only refers to
 *   records earlier in the same file, except `bot.parentBotId`, which may point forward.
 * - `spaces/<spaceId>/artifacts/<artifactId>`: each artifact's bytes, after the records.
 * - `spaces/<spaceId>/homes/<botId>/<path>`: each bot's workspace files, after the records.
 * - `spaces/<spaceId>/executables.json`: after the workspace files, which of them are executable
 *   (a streamed zip cannot carry file modes back out). Left out when none are.
 *
 * Content is decrypted. Ids are the source install's; an import gives every row a new id and
 * rewrites references, including ids inside message blocks. Credentials, integrations, runs,
 * billing, computers and page links are not exported: they belong to the source install.
 */
/** A page version number, within the database's 32-bit column. */
const PageVersionNumber = z.number().int().positive().max(2_147_483_647);

export const ACCOUNT_EXPORT_FORMAT = "rakazo-account-export";
export const ACCOUNT_EXPORT_VERSION = 1;
export const ACCOUNT_EXPORT_MANIFEST_PATH = "manifest.json";
/** Larger workspace files stay behind, matching the workspace export limit elsewhere. */
export const ACCOUNT_EXPORT_MAX_HOME_FILE_BYTES = 8 * 1024 * 1024;

export const accountExportPaths = {
  records: (spaceId: string) => `spaces/${spaceId}/records.jsonl`,
  artifact: (spaceId: string, artifactId: string) => `spaces/${spaceId}/artifacts/${artifactId}`,
  homeFile: (spaceId: string, botId: string, path: string) =>
    `spaces/${spaceId}/homes/${botId}/${path}`,
  executables: (spaceId: string) => `spaces/${spaceId}/executables.json`,
};

export const AccountExportExecutablesSchema = z.array(z.object({ botId: Id, path: z.string() }));
export type AccountExportExecutables = z.infer<typeof AccountExportExecutablesSchema>;

export const AccountExportManifestSchema = z.object({
  format: z.literal(ACCOUNT_EXPORT_FORMAT),
  version: z.literal(ACCOUNT_EXPORT_VERSION),
  exportedAt: IsoDate,
  user: z.object({ name: z.string(), email: z.string(), timezone: z.string().nullable() }),
  spaces: z.array(z.object({ id: Id, name: z.string(), createdAt: IsoDate })),
});
export type AccountExportManifest = z.infer<typeof AccountExportManifestSchema>;

const json = z.json();

export const AccountExportRecordSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("bot_section"),
    id: Id,
    name: z.string(),
    position: z.number().int(),
    createdAt: IsoDate,
  }),
  z.object({
    type: z.literal("bot"),
    id: Id,
    name: z.string(),
    description: z.string(),
    instructions: z.string(),
    color: z.string(),
    avatarSet: z.string(),
    notifyOnFinish: z.boolean(),
    pinned: z.boolean(),
    position: z.number().int(),
    sectionId: Id.nullable(),
    archivedAt: IsoDate.nullable(),
    parentBotId: Id.nullable(),
    memoryScope: z.string().nullable(),
    voiceId: z.string().nullable(),
    autoSpeak: z.boolean(),
    modelProvider: z.string().nullable(),
    modelId: z.string().nullable(),
    thinkingLevel: z.string().nullable(),
    disabledBuiltinTools: z.array(z.string()),
    teamChatAmbientEnabled: z.boolean(),
    teamChatRules: z.string(),
    crossSpaceCommunication: z.boolean(),
    dailyCheckIns: z.boolean().default(true),
    fleetManagement: z.boolean(),
    replyMode: ReplyModeSchema.default("chat"),
    createdAt: IsoDate,
  }),
  z.object({
    type: z.literal("chat_group"),
    id: Id,
    name: z.string(),
    pinned: z.boolean(),
    sectionId: Id.nullable(),
    archivedAt: IsoDate.nullable(),
    botIds: z.array(Id),
    createdAt: IsoDate,
  }),
  /** A bot's or a group's conversation, or the thread a bot's background helper worked in. */
  z.object({
    type: z.literal("thread"),
    id: Id,
    botId: Id.nullable(),
    groupId: Id.nullable(),
    /** Absent from archives written before helpers had threads. */
    helperBotId: Id.nullable().optional(),
    historyCompactedUpToSeq: z.number().int().nullable(),
    historyCompactionSummary: z.string().nullable(),
    createdAt: IsoDate,
  }),
  z.object({
    type: z.literal("message"),
    id: Id,
    threadId: Id,
    seq: z.number().int(),
    role: z.string(),
    blocks: json,
    botId: Id.nullable(),
    replyToMessageId: Id.nullable(),
    replyQuote: z.string().nullable(),
    createdAt: IsoDate,
  }),
  /** A page arrives private: its link stays with the source install. */
  z.object({
    type: z.literal("page"),
    id: Id,
    botId: Id.nullable(),
    groupId: Id.nullable(),
    title: PageTitleSchema,
    pinnedAt: IsoDate.nullable(),
    currentVersion: PageVersionNumber,
    createdAt: IsoDate,
    updatedAt: IsoDate,
  }),
  z.object({
    type: z.literal("page_version"),
    id: Id,
    pageId: Id,
    version: PageVersionNumber,
    title: PageTitleSchema,
    source: PageSourceSchema,
    createdAt: IsoDate,
  }),
  z.object({
    type: z.literal("artifact"),
    id: Id,
    botId: Id.nullable(),
    groupId: Id.nullable(),
    name: z.string(),
    description: z.string().nullable(),
    mimeType: z.string(),
    size: z.number().int().nonnegative(),
    hash: z.string(),
    rootArtifactId: Id.nullable(),
    version: z.number().int().positive(),
    /** A file a stranger emailed; absent from older archives. */
    standalone: z.boolean().optional(),
    createdAt: IsoDate,
  }),
  z.object({
    type: z.literal("memory_document"),
    id: Id,
    botId: Id.nullable(),
    scope: z.string(),
    path: z.string(),
    content: z.string(),
    revision: z.number().int(),
    createdAt: IsoDate,
    updatedAt: IsoDate,
  }),
  z.object({
    type: z.literal("memory_revision"),
    id: Id,
    documentId: Id,
    revision: z.number().int(),
    content: z.string(),
    sourceThreadId: Id.nullable(),
    createdAt: IsoDate,
  }),
  z.object({
    type: z.literal("routine"),
    id: Id,
    botId: Id,
    threadId: Id.nullable(),
    name: z.string(),
    prompt: z.string(),
    crons: z.array(z.string()),
    timezone: z.string(),
    active: z.boolean(),
    notify: z.boolean(),
    messageProvider: z.string().nullable(),
    modelProvider: z.string().nullable(),
    modelId: z.string().nullable(),
    thinkingLevel: z.string().nullable(),
    watch: json.nullable(),
    createdAt: IsoDate,
  }),
  z.object({
    type: z.literal("scratchpad_item"),
    id: Id,
    botId: Id,
    title: z.string(),
    status: z.string(),
    notes: z.string(),
    createdAt: IsoDate,
    updatedAt: IsoDate,
  }),
  /** Skills the user wrote; built-in and plugin skills come with the install. */
  z.object({
    type: z.literal("agent_skill"),
    id: Id,
    name: z.string(),
    description: z.string(),
    content: z.string(),
    files: json.nullable(),
    createdAt: IsoDate,
  }),
  /** Only in spaces the user owns. */
  z.object({
    type: z.literal("board"),
    id: Id,
    name: z.string(),
    ticketPrefix: z.string(),
  }),
  z.object({
    type: z.literal("ticket"),
    id: Id,
    number: z.number().int().positive(),
    title: z.string(),
    description: z.string().nullable(),
    status: z.string(),
    priority: z.string().nullable(),
    /** Null when the bot is someone else's, so it is not in the export. */
    assigneeBotId: Id.nullable(),
    createdByBotId: Id.nullable(),
    createdByExporter: z.boolean(),
    createdAt: IsoDate,
    updatedAt: IsoDate,
    completedAt: IsoDate.nullable(),
  }),
  z.object({
    type: z.literal("ticket_comment"),
    id: Id,
    ticketId: Id,
    authorBotId: Id.nullable(),
    authoredByExporter: z.boolean(),
    body: z.string(),
    createdAt: IsoDate,
  }),
]);
export type AccountExportRecord = z.infer<typeof AccountExportRecordSchema>;

export const AccountImportResultSchema = z.object({
  spaces: z.array(z.object({ id: Id, name: z.string() })),
});
export type AccountImportResult = z.infer<typeof AccountImportResultSchema>;
