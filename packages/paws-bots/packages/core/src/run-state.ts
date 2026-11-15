import type { RunStatus } from "@rakazo/contracts";

/** Runs the bot is working on, which the chat shows as working. */
export const WORKING_RUN_STATUSES = [
  "queued",
  "leased",
  "running",
] as const satisfies readonly RunStatus[];
/** Runs paused on the user: an answer, an approval, or a computer takeover. Their card is the state. */
export const WAITING_ON_USER_RUN_STATUSES = [
  "waiting_input",
  "waiting_takeover",
] as const satisfies readonly RunStatus[];
export const ACTIVE_RUN_STATUSES = [
  ...WORKING_RUN_STATUSES,
  ...WAITING_ON_USER_RUN_STATUSES,
] as const satisfies readonly RunStatus[];
/** Runs that hold new work in the queue. A pending card holds no compute. */
export const QUEUE_HOLDING_RUN_STATUSES = ACTIVE_RUN_STATUSES.filter(
  (status) => status !== "waiting_input",
);
const TERMINAL: RunStatus[] = ["completed", "failed", "cancelled"];
/**
 * These turns carry their own prompt and must not take a user message as steering.
 * Routine and webhook runs are not the conversation, and neither is a wake from another bot:
 * its reply goes back to that bot. The creation intro can only ask what it is for; a message
 * that lands during any of them waits, and the continuation after the turn finishes answers it.
 */
const NON_CONVERSATIONAL_RUN_TRIGGERS = new Set([
  "routine",
  "webhook",
  "created",
  "tickets",
  "bot_message",
]);

/**
 * Background triggers do internal work that must not leak into the chat: the
 * sidebar must not show them as activity and the bot transcript must not render
 * their steps/text. Ticket work reports through board comments and its status.
 * Existing ask and approval cards can still request user input.
 */
export const BACKGROUND_RUN_TRIGGERS = ["tickets"] as const;
const BACKGROUND_RUN_TRIGGER_SET = new Set<string>(BACKGROUND_RUN_TRIGGERS);

export function isBackgroundRunTrigger(trigger: string | null | undefined): boolean {
  return BACKGROUND_RUN_TRIGGER_SET.has(trigger ?? "");
}

const allowed: Record<RunStatus, RunStatus[]> = {
  queued: ["leased", "cancelled"],
  leased: ["running", "queued", "cancelled"],
  running: ["waiting_input", "waiting_takeover", "completed", "failed", "cancelled", "leased"],
  waiting_input: ["queued", "leased", "cancelled"],
  waiting_takeover: ["queued", "leased", "cancelled"],
  completed: [],
  failed: ["queued"],
  cancelled: [],
};

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return allowed[from]?.includes(to) ?? false;
}

export function assertTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal run transition ${from} -> ${to}`);
  }
}

export function isActive(status: RunStatus): boolean {
  return (ACTIVE_RUN_STATUSES as readonly RunStatus[]).includes(status);
}

export function isRunWorking(status: string | null | undefined): boolean {
  return WORKING_RUN_STATUSES.some((working) => working === status);
}

export function workingRoutineName(
  runs: readonly {
    status: string;
    botId?: string;
    trigger?: string;
    routineName?: string | null;
  }[],
): string | undefined {
  const running = runs.filter((candidate) => candidate.status === "running");
  const [run] = running;
  if (running.length !== 1 || run?.trigger !== "routine") return undefined;
  const otherBotWorking = runs.some(
    (candidate) => isRunWorking(candidate.status) && candidate.botId !== run.botId,
  );
  return (!otherBotWorking && run.routineName?.trim()) || undefined;
}

export function isRunWaitingOnUser(status: string | null | undefined): boolean {
  return WAITING_ON_USER_RUN_STATUSES.some((waiting) => waiting === status);
}

export function isTerminal(status: string): boolean {
  return TERMINAL.includes(status as RunStatus);
}

/**
 * A helper the bot started in the background. It works in a thread of its own, so the chat
 * that started it stays free, and its result comes back there as a HELPER_RESULT_TRIGGER run.
 */
export const BACKGROUND_HELPER_TRIGGER = "helper";
export const HELPER_RESULT_TRIGGER = "helper_result";
/** The result a stopped background helper's card settles with, beside status "failed". */
export const STOPPED_HELPER_RESULT = "stopped";

/**
 * How a helper card reads: a stopped helper settles as failed but did not fail, and shows no
 * body; otherwise the body is its result, or its progress while it works.
 */
export function helperCardState(block: { status: string; result?: string; progress?: string }): {
  stopped: boolean;
  failed: boolean;
  body: string;
} {
  const stopped = block.status === "failed" && block.result === STOPPED_HELPER_RESULT;
  return {
    stopped,
    failed: block.status === "failed" && !stopped,
    body: stopped ? "" : block.result || block.progress || "",
  };
}

/** Runs that may use their bot's computer: a background helper never does. */
export const COMPUTER_USING_RUNS = { trigger: { not: BACKGROUND_HELPER_TRIGGER } } as const;

/** Prompt of a run created to answer messages that waited behind another turn. */
export const STEERING_CONTINUATION_PROMPT = "Respond to the user's steering context.";

/** Routine runs and the creation intro stay isolated from thread history. */
export function runReadsThreadHistory(trigger: string | null | undefined): boolean {
  return trigger !== "created" && trigger !== "routine";
}

/** Whether a run's turn is part of the thread's conversation and may take user steering. */
export function isConversationalRun(trigger: string | null | undefined): boolean {
  return !NON_CONVERSATIONAL_RUN_TRIGGERS.has(trigger ?? "");
}

/**
 * Whether a message joins a busy run as steering. A webhook delivery never does, nothing steers a
 * non-conversational run, and a connected chat's message steers only a run started from a connected
 * chat in the same channel (or both in the bot's direct chat); otherwise it waits for its own run.
 */
export function messageSteersRun(
  messageTrigger: string,
  runTrigger: string | null | undefined,
  messageChannelId?: string,
  runChannelId?: string,
): boolean {
  if (messageTrigger === "webhook" || !isConversationalRun(runTrigger)) return false;
  return (
    messageTrigger !== "messaging" ||
    (runTrigger === "messaging" && messageChannelId === runChannelId)
  );
}

/**
 * A takeover wait holds only a conversational message it can take as steering. Any other
 * message passes it and gets its own run; the dispatcher then ends a wait the user has not
 * acted on so that run can start. `steerable` is false for messages that would not steer this run
 * (see `messageSteersRun`).
 */
export function messageBypassesTakeoverWait(
  run: { status?: string; trigger?: string | null },
  steerable = true,
): boolean {
  return run.status === "waiting_takeover" && !(steerable && isConversationalRun(run.trigger));
}

export function nextFence(current: number): number {
  return current + 1;
}
