import * as z from "zod";
import { AgentImportStatusSchema } from "./agent-import-setup.js";
import { BotAvatarSetSchema, BotAvatarValueSchema } from "./bot-avatar.js";
import { BOT_TEMPLATE_IMPORT_KEY_PREFIX } from "./bot-template.js";
import { ComputerModeSchema } from "./computer.js";
import { BOT_DESCRIPTION_MAX_LENGTH, BOT_NAME_MAX_LENGTH } from "./domain.js";

export const AGENT_IMPORT_MAX_FILES = 500;
export const AGENT_IMPORT_MAX_FILE_LENGTH = 100_000;
export const AGENT_IMPORT_MAX_TOTAL_LENGTH = 4_000_000;
export const AGENT_IMPORT_MAX_PATH_LENGTH = 300;
/** The one path a Grok Bot import sends: the chosen Bot's export, rewritten as JSON. */
export const GROK_BOT_EXPORT_PATH = "grok-bot-export.json";
/** A Bot with many full-text skills writes more than one Markdown file may hold. */
export const GROK_BOT_EXPORT_MAX_LENGTH = 1_000_000;

/** The only non-Markdown files an import may send, optionally under the chosen folder's name. */
const AGENT_IMPORT_CONFIG_PATH =
  /^(?:[^/]+\/)?(?:openclaw\.json|\.env|config\.yaml|auth\.json|cron\/jobs\.json|skills\/\.bundled_manifest)$/;

/** A relative Markdown or settings path: no absolute paths, no `..`, no empty segments. */
export function isAgentImportPath(path: string): boolean {
  if (path === GROK_BOT_EXPORT_PATH) return true;
  if (!path.toLowerCase().endsWith(".md") && !AGENT_IMPORT_CONFIG_PATH.test(path)) return false;
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export const AgentImportFileSchema = z
  .strictObject({
    path: z
      .string()
      .min(1)
      .max(AGENT_IMPORT_MAX_PATH_LENGTH)
      .refine(
        isAgentImportPath,
        "Only relative Markdown and agent settings files can be imported.",
      ),
    content: z.string().max(GROK_BOT_EXPORT_MAX_LENGTH),
  })
  .superRefine((file, ctx) => {
    if (file.path !== GROK_BOT_EXPORT_PATH && file.content.length > AGENT_IMPORT_MAX_FILE_LENGTH) {
      ctx.addIssue({
        code: "custom",
        path: ["content"],
        message: "The file is too large to import.",
      });
    }
  });
export type AgentImportFile = z.infer<typeof AgentImportFileSchema>;

export const AgentImportFilesSchema = z
  .array(AgentImportFileSchema)
  .min(1)
  .max(AGENT_IMPORT_MAX_FILES)
  .superRefine((files, ctx) => {
    const total = files.reduce((sum, file) => sum + file.content.length, 0);
    if (total > AGENT_IMPORT_MAX_TOTAL_LENGTH) {
      ctx.addIssue({ code: "custom", message: "The files are too large to import." });
    }
    if (new Set(files.map((file) => file.path)).size !== files.length) {
      ctx.addIssue({ code: "custom", message: "Each file can be sent once." });
    }
  });

export const AgentImportSourceSchema = z.enum([
  "openclaw",
  "hermes",
  "document",
  "template",
  "grok_bot",
]);
export type AgentImportSource = z.infer<typeof AgentImportSourceSchema>;

/**
 * Why an item may not work in Rakazo. Items with a warning start unticked;
 * `unsupported_command` cannot run at all and cannot be selected.
 */
export const AgentImportWarningSchema = z.enum([
  "needs_setup",
  "bundled_files",
  "runs_code",
  "unsupported_command",
  "local_path",
  "dropped_settings",
  /** A routine's timing changes: an interval loses its start time, or a time zone is unknown. */
  "changed_schedule",
]);
export type AgentImportWarning = z.infer<typeof AgentImportWarningSchema>;
const warnings = z.array(AgentImportWarningSchema).default([]);

const status = AgentImportStatusSchema.default({ kind: "ready" });

export const AgentImportInstructionRoleSchema = z.enum(["persona", "working"]);
export type AgentImportInstructionRole = z.infer<typeof AgentImportInstructionRoleSchema>;

/** Unchanged from the template the source writes for a new agent. */
const stock = z.boolean().default(false);
/** Text shaped like a credential; the match itself is never returned. */
const containsKey = z.boolean().optional();

export const AgentImportInstructionSchema = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string(),
  role: AgentImportInstructionRoleSchema.default("working"),
  stock,
  containsKey,
  /** Sections and files of the source's own runtime the text refers to, e.g. `BOOTSTRAP.md`. */
  mentions: z.array(z.string()).default([]),
});
export type AgentImportInstruction = z.infer<typeof AgentImportInstructionSchema>;

export const AgentImportMemorySchema = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string(),
  /** Path in the new bot's memory. */
  path: z.string(),
  /** Path in space memory; differs from `path` when that name is already taken. */
  spacePath: z.string(),
  stock,
  containsKey,
});
export type AgentImportMemory = z.infer<typeof AgentImportMemorySchema>;

export const AgentImportSkillSchema = z.object({
  id: z.string(),
  /** Name in the source. */
  title: z.string(),
  /** Name it is saved under; differs from `title` when that name is already taken. */
  name: z.string(),
  description: z.string(),
  /** SKILL.md as it will be saved. */
  content: z.string(),
  warnings,
  status,
  containsKey,
});
export type AgentImportSkill = z.infer<typeof AgentImportSkillSchema>;

export const AgentImportModelSchema = z.object({
  id: z.string(),
  /** The model as the source names it, e.g. `openrouter/anthropic/claude-sonnet-4.6`. */
  title: z.string(),
  provider: z.string(),
  /** The provider as model settings name it, e.g. "DeepSeek". */
  providerName: z.string().optional(),
  modelId: z.string(),
  /** `ready`: a connection exists; `needs_key`: only with this provider's key; `unknown`: not offered. */
  status: z.enum(["ready", "needs_key", "unknown"]),
});
export type AgentImportModel = z.infer<typeof AgentImportModelSchema>;

export const AgentImportMcpServerSchema = z.object({
  id: z.string(),
  /** Name in the source. */
  title: z.string(),
  /** Slug it is saved under; differs from the source name when that one is taken. */
  name: z.string(),
  /** What the server runs or connects to, without credential values. */
  content: z.string(),
  warnings,
  status,
});
export type AgentImportMcpServer = z.infer<typeof AgentImportMcpServerSchema>;

export const AgentImportRoutineSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** Schedule and prompt, as shown in the preview. */
  content: z.string(),
  warnings,
  status,
});
export type AgentImportRoutine = z.infer<typeof AgentImportRoutineSchema>;

export const AgentImportApiKeySchema = z.object({
  id: z.string(),
  /** Provider display name. Key values are never returned. */
  title: z.string(),
  provider: z.string(),
});
export type AgentImportApiKey = z.infer<typeof AgentImportApiKeySchema>;

export const AgentImportSkipReasonSchema = z.enum([
  "runtime",
  "invalid_skill",
  "builtin",
  "unsupported",
  "connected",
  "invalid_file",
  /** An unchanged default the source wrote when the agent was created. */
  "default",
  /** A connected app with no server address to carry over: connect it again here. */
  "reconnect",
]);
export type AgentImportSkipReason = z.infer<typeof AgentImportSkipReasonSchema>;

export const AgentImportPlanSchema = z.object({
  source: AgentImportSourceSchema,
  suggestedName: z.string(),
  suggestedDescription: z.string().default(""),
  instructions: z.array(AgentImportInstructionSchema),
  memory: z.array(AgentImportMemorySchema),
  skills: z.array(AgentImportSkillSchema),
  model: AgentImportModelSchema.nullable(),
  mcpServers: z.array(AgentImportMcpServerSchema),
  routines: z.array(AgentImportRoutineSchema),
  apiKeys: z.array(AgentImportApiKeySchema),
  skipped: z.array(z.object({ path: z.string(), reason: AgentImportSkipReasonSchema })),
});
export type AgentImportPlan = z.infer<typeof AgentImportPlanSchema>;

export const AgentImportMemoryDestinationSchema = z.enum(["bot", "space"]);
export type AgentImportMemoryDestination = z.infer<typeof AgentImportMemoryDestinationSchema>;

const selectedId = z
  .string()
  .min(1)
  .max(AGENT_IMPORT_MAX_PATH_LENGTH + 20);
const selectedIds = z.array(selectedId);

export const AgentImportSelectionSchema = z.strictObject({
  instructions: selectedIds.max(AGENT_IMPORT_MAX_FILES),
  memory: z
    .array(z.strictObject({ id: selectedId, destination: AgentImportMemoryDestinationSchema }))
    .max(AGENT_IMPORT_MAX_FILES),
  skills: selectedIds.max(AGENT_IMPORT_MAX_FILES),
  model: z.boolean().default(false),
  mcpServers: selectedIds.max(AGENT_IMPORT_MAX_FILES).default([]),
  routines: selectedIds.max(AGENT_IMPORT_MAX_FILES).default([]),
  apiKeys: selectedIds.max(AGENT_IMPORT_MAX_FILES).default([]),
});
export type AgentImportSelection = z.infer<typeof AgentImportSelectionSchema>;

/** API keys and credential values are read only when the user opted in. */
const includeSecrets = z.boolean().default(false);

/** Names, never contents, of the files beside each SKILL.md, to show what a skill is missing. */
const skillFiles = z
  .record(
    z.string().max(AGENT_IMPORT_MAX_PATH_LENGTH),
    z.array(z.string().max(AGENT_IMPORT_MAX_PATH_LENGTH)).max(200),
  )
  .refine((value) => Object.keys(value).length <= AGENT_IMPORT_MAX_FILES)
  .default({});

export const AgentImportPreviewInput = z.strictObject({
  files: AgentImportFilesSchema,
  includeSecrets,
  skillFiles,
});

export const AgentImportCreateInput = z.strictObject({
  /** Chosen by the client once per import, so a retried create returns the same bot. */
  importKey: z
    .string()
    .trim()
    .min(8)
    .max(100)
    .refine(
      (key) => !key.startsWith(BOT_TEMPLATE_IMPORT_KEY_PREFIX),
      "That import key is reserved.",
    )
    .optional(),
  files: AgentImportFilesSchema,
  includeSecrets,
  skillFiles,
  name: z.string().trim().min(1).max(BOT_NAME_MAX_LENGTH),
  description: z.string().trim().max(BOT_DESCRIPTION_MAX_LENGTH).default(""),
  computerMode: ComputerModeSchema.default("team"),
  /** Portable appearance when supplied by an exported profile; without it, the owner's set applies. */
  color: BotAvatarValueSchema.optional(),
  avatarSet: BotAvatarSetSchema.optional(),
  selection: AgentImportSelectionSchema,
});
export type AgentImportCreateInput = z.infer<typeof AgentImportCreateInput>;
