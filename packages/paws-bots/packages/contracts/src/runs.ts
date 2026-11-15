import * as z from "zod";
import { Id, IsoDate, RunStatus } from "./ids.js";

/** The computer provider refused a request at its own rate limit; the run tells the user to wait. */
export const COMPUTER_RATE_LIMIT_ERROR = "Too many computer requests. Try again later.";

/** The organization spent this period's computer allowance; computers start again at renewal. */
export const COMPUTER_ALLOWANCE_USED_ERROR = "No computer hours left.";

/** The deployment's computer provider account cannot start computers, such as when it is unpaid. */
export const COMPUTER_PROVIDER_UNAVAILABLE_ERROR =
  "Computers are unavailable right now. Try again later.";

/** A running computer did not answer a request; its work may or may not have happened. */
export const COMPUTER_UNRESPONSIVE_ERROR = "The computer stopped responding. Try again.";

/** Whether an error says the computer hours are spent, which only a plan change can fix. */
export function isComputerAllowanceUsed(message: string | null | undefined): boolean {
  return message?.startsWith(COMPUTER_ALLOWANCE_USED_ERROR) ?? false;
}

export const RUN_TRIGGERS = [
  "user",
  "routine",
  "resume",
  "follow_up",
  "reaction",
  "call_end",
  "spawn",
  "skill",
  "bot_message",
  "webhook",
  "messaging",
  "cloud_agent",
  "purchase",
  "media",
  "created",
  "tickets",
  "helper",
  "helper_result",
] as const;
export const RunTriggerSchema = z.enum(RUN_TRIGGERS);
export type RunTrigger = z.infer<typeof RunTriggerSchema>;

/**
 * Whose problem a failed run is. Every kind except "output" is the user's provider account,
 * key, plan or model choice; "output" is a model that returned nothing usable.
 */
export const RUN_ERROR_KINDS = [
  "key",
  "credit",
  "spending",
  "rate",
  "auth",
  "access",
  "model",
  "context",
  "output",
] as const;
export type RunErrorKind = (typeof RUN_ERROR_KINDS)[number];

/** A limit that resets later than this is a quota to wait out, not a rate limit to retry. */
const PROVIDER_QUOTA_MIN_RESET_MS = 60 * 60_000;

/**
 * When a provider error says its exhausted limit resets, if that is over an hour away. Gateways
 * copy the response's `X-RateLimit-Reset` (an epoch in seconds or milliseconds) or `Retry-After`
 * (seconds) headers into the error body, which is all a model runtime passes on.
 */
export function providerQuotaResetAt(text: string, now = Date.now()): number | undefined {
  const epoch = text.match(/\bx-ratelimit-reset\\?"?\s*[:=]\s*\\?"?(\d{10,13})(?!\d)/i)?.[1];
  const delay = text.match(/\bretry-after\\?"?\s*[:=]\s*\\?"?(\d+)(?![\d.])/i)?.[1];
  const resetAt = epoch
    ? Number(epoch) * (epoch.length > 10 ? 1 : 1000)
    : delay
      ? now + Number(delay) * 1000
      : undefined;
  return resetAt !== undefined && resetAt - now > PROVIDER_QUOTA_MIN_RESET_MS ? resetAt : undefined;
}

export const RoutineRunSchema = z.object({
  id: Id,
  botId: Id,
  groupId: Id.nullable(),
  status: RunStatus,
  error: z.string().nullable(),
  createdAt: IsoDate,
  startedAt: IsoDate.nullable(),
  /** When a scheduled run that started well after its time was due; null otherwise. */
  lateSince: IsoDate.nullable(),
  completedAt: IsoDate.nullable(),
  messageId: Id.nullable(),
});
export type RoutineRun = z.infer<typeof RoutineRunSchema>;

export const RoutineRunCursorSchema = z.object({ id: Id, createdAt: IsoDate });
export type RoutineRunCursor = z.infer<typeof RoutineRunCursorSchema>;
/** Runs per history page; the first page a screen shows is shorter. */
export const ROUTINE_HISTORY_PAGE_SIZE = 20;
export const ROUTINE_HISTORY_FIRST_PAGE_SIZE = 5;
export const RoutineHistorySchema = z.object({
  runs: z.array(RoutineRunSchema),
  nextCursor: RoutineRunCursorSchema.nullable(),
});
export type RoutineHistory = z.infer<typeof RoutineHistorySchema>;

export const RunActivityRowSchema = z.object({
  runId: Id,
  botId: Id,
  botName: z.string(),
  groupId: Id.nullable(),
  groupName: z.string().nullable(),
  threadId: Id,
  status: RunStatus,
  trigger: RunTriggerSchema,
  notificationsEnabled: z.boolean(),
  promptSnippet: z.string(),
  agentMessage: z
    .discriminatedUnion("kind", [
      z.strictObject({
        fromBotName: z.string(),
        kind: z.enum(["update", "request"]),
        text: z.string().max(120),
      }),
      z.strictObject({ kind: z.literal("unknown") }),
    ])
    .nullable(),
  updatedAt: z.string(),
});
export type RunActivityRow = z.infer<typeof RunActivityRowSchema>;

export const RunsListOutputSchema = z.object({
  runs: z.array(RunActivityRowSchema),
});
export type RunsListOutput = z.infer<typeof RunsListOutputSchema>;
