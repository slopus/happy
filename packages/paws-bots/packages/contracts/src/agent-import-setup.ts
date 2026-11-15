import * as z from "zod";

export const AgentImportNeedSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("api_key"), provider: z.string() }),
  /** Header names the server sends credentials in. */
  z.object({ kind: z.literal("credentials"), names: z.array(z.string()) }),
  z.object({ kind: z.literal("env"), names: z.array(z.string()) }),
  /** A program a stdio server runs on the bot's computer. */
  z.object({ kind: z.literal("program"), name: z.string() }),
  z.object({ kind: z.literal("local_paths") }),
  /** Programs, variables or tools a skill declares it needs. */
  z.object({ kind: z.literal("requires"), names: z.array(z.string()) }),
  z.object({ kind: z.literal("turn_on") }),
  z.object({ kind: z.literal("bundled_files") }),
]);
export type AgentImportNeed = z.infer<typeof AgentImportNeedSchema>;

export const AgentImportStatusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready") }),
  z.object({ kind: z.literal("needs_setup"), needs: z.array(AgentImportNeedSchema).min(1) }),
  z.object({ kind: z.literal("needs_review"), reason: z.literal("runs_code") }),
  z.object({
    kind: z.literal("unsupported"),
    reason: z.enum(["unsupported_command", "not_in_catalog", "other_platform"]),
  }),
]);
export type AgentImportStatus = z.infer<typeof AgentImportStatusSchema>;

export const AgentImportSetupStateInput = z.strictObject({
  botId: z.string().min(1).max(100),
  providers: z.array(z.string().max(100)).max(50),
  serverIds: z.array(z.string().max(100)).max(200),
  routineIds: z.array(z.string().max(100)).max(200),
});
export const AgentImportSetupStateSchema = z.object({
  providers: z.record(z.string(), z.boolean()),
  /** `unverifiable` when it also needs a program or local paths, which cannot be checked. */
  serverIds: z.record(z.string(), z.union([z.boolean(), z.literal("unverifiable")])),
  routineIds: z.record(z.string(), z.boolean()),
});
export type AgentImportSetupState = z.infer<typeof AgentImportSetupStateSchema>;

export const AgentImportSetupItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("model"),
    title: z.string(),
    provider: z.string(),
    /** The provider as model settings name it, e.g. "DeepSeek". */
    providerName: z.string().optional(),
  }),
  z.object({
    kind: z.literal("mcp"),
    serverId: z.string(),
    name: z.string(),
    needs: z.array(AgentImportNeedSchema),
  }),
  z.object({ kind: z.literal("routine"), routineId: z.string(), name: z.string() }),
  z.object({ kind: z.literal("skill"), name: z.string(), needs: z.array(AgentImportNeedSchema) }),
]);
export type AgentImportSetupItem = z.infer<typeof AgentImportSetupItemSchema>;

/** Sent as the error's `data.reason`, so clients can show their own localized copy. */
export const AGENT_IMPORT_ERROR_REASONS = [
  "selection_mismatch",
  "cannot_run_here",
  "model_needs_key",
  "instructions_too_long",
  "import_reused",
  "name_just_taken",
  "key_rejected",
  "key_unverified",
  "key_check_failed",
] as const;
export type AgentImportErrorReason = (typeof AGENT_IMPORT_ERROR_REASONS)[number];

export function agentImportErrorReason(error: unknown): AgentImportErrorReason | undefined {
  const data = error && typeof error === "object" && "data" in error ? error.data : undefined;
  const reason = data && typeof data === "object" && "reason" in data ? data.reason : undefined;
  return (AGENT_IMPORT_ERROR_REASONS as readonly unknown[]).includes(reason)
    ? (reason as AgentImportErrorReason)
    : undefined;
}
