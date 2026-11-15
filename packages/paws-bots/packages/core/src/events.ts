import type {
  HistoryToolStep,
  MessageBlock,
  ThreadMessage,
  ToolHistory,
  ToolStepCall,
} from "@rakazo/contracts";
import { cloudAgentBlockFromPayload } from "./cloud-agent.js";
import { preserveIdentitySource } from "./identity-source.js";
import { payloadAuthor } from "./message-replies.js";
import { modelFallbackFailure, parseModelFallbackFailure } from "./run-error.js";

export function projectMessages(
  events: Array<{
    seq: number;
    type: string;
    payload: unknown;
    runId?: string | null;
    createdAt: Date | string;
    id: string;
    threadId: string;
    botId?: string | null;
  }>,
  runs?: readonly { id: string; status: string }[],
): ThreadMessage[] {
  const messages: ThreadMessage[] = [];
  type LiveProjection = {
    blocks: MessageBlock[];
    meta: {
      id: string;
      threadId: string;
      seq: number;
      botId?: string;
      runId?: string;
      createdAt: string;
    };
  };
  const liveById = new Map<string, LiveProjection>();
  const liveSubagents = new Map<string, ThreadMessage>();
  const durableSubagents = new Set<string>();
  const liveProjection = (event: (typeof events)[number], createdAt: string): LiveProjection => {
    const id = progressMessageId(event);
    const existing = liveById.get(id);
    if (existing) return existing;
    const projection: LiveProjection = {
      blocks: [],
      meta: {
        id,
        threadId: event.threadId,
        seq: event.seq,
        botId: event.botId ?? undefined,
        runId: event.runId ?? undefined,
        createdAt,
      },
    };
    liveById.set(id, projection);
    return projection;
  };
  const clearLive = (event: (typeof events)[number]) => {
    if (event.runId) liveById.delete(progressMessageId(event));
    else liveById.clear();
  };
  for (const event of events) {
    if (stopsRunHelpers(event)) {
      const settled = settleRunSubagents([...liveSubagents.values()], event.runId);
      for (const message of settled) {
        const block = message.blocks[0];
        if (block?.kind === "subagent") liveSubagents.set(block.agentId, message);
      }
    }
    const payload = asRecord(event.payload);
    const createdAt =
      typeof event.createdAt === "string" ? event.createdAt : event.createdAt.toISOString();
    if (event.type === "thread.message.created") {
      clearLive(event);
      const role = (payload.role as ThreadMessage["role"]) ?? "bot";
      const blocks = (payload.blocks as MessageBlock[]) ?? [];
      for (const block of blocks) {
        if (block.kind === "subagent") {
          durableSubagents.add(block.agentId);
          liveSubagents.delete(block.agentId);
        }
      }
      messages.push({
        id: (payload.messageId as string) ?? event.id,
        threadId: event.threadId,
        seq: event.seq,
        role,
        blocks,
        botId: event.botId ?? undefined,
        ...payloadAuthor(payload),
        runId: event.runId ?? undefined,
        createdAt,
      });
      continue;
    }
    if (event.type === "thread.cloud_agent") {
      const block = cloudAgentBlockFromPayload(payload);
      for (const message of messages) {
        if (message.id === payload.messageId)
          message.blocks = message.blocks.map((old) =>
            old.kind === "cloud_agent" && old.agentId === block.agentId ? block : old,
          );
      }
      continue;
    }
    if (event.type === "thread.progress") {
      const live = liveProjection(event, createdAt);
      live.blocks = reduceLiveMessageBlocks(live.blocks, { type: "progress", payload });
      live.meta = {
        ...live.meta,
        seq: event.seq,
        botId: event.botId ?? undefined,
        createdAt,
      };
      continue;
    }
    if (event.type === "agent.tool.called") {
      const live = liveProjection(event, createdAt);
      live.blocks = reduceLiveMessageBlocks(live.blocks, {
        type: "tool",
        name: String(payload.name ?? ""),
      });
      live.meta = {
        ...live.meta,
        seq: event.seq,
        botId: event.botId ?? undefined,
        createdAt,
      };
      continue;
    }
    if (event.type === "thread.cleared") {
      messages.length = 0;
      liveById.clear();
      liveSubagents.clear();
      durableSubagents.clear();
      continue;
    }
    if (event.type === "thread.subagent") {
      const block = subagentBlockFromPayload(payload);
      if (durableSubagents.has(block.agentId)) continue;
      liveSubagents.set(block.agentId, {
        id: `subagent:${block.agentId}`,
        threadId: event.threadId,
        seq: event.seq,
        role: "bot",
        blocks: [block],
        botId: event.botId ?? undefined,
        runId: event.runId ?? undefined,
        createdAt,
      });
      continue;
    }
    if (
      event.type === "run.completed" ||
      event.type === "run.failed" ||
      event.type === "run.cancelled"
    ) {
      clearLive(event);
    }
  }
  let helpers = [...liveSubagents.values()];
  if (runs) {
    const running = new Set(runs.filter((run) => run.status === "running").map((run) => run.id));
    for (const runId of new Set(helpers.map((message) => message.runId))) {
      if (runId && !running.has(runId)) helpers = settleRunSubagents(helpers, runId);
    }
  }
  for (const live of helpers) messages.push(live);
  for (const live of liveById.values()) {
    if (live.blocks.length > 0) {
      messages.push({
        id: live.meta.id,
        threadId: live.meta.threadId,
        seq: live.meta.seq,
        role: "bot",
        blocks: live.blocks,
        botId: live.meta.botId,
        runId: live.meta.runId,
        createdAt: live.meta.createdAt,
      });
    }
  }
  return messages;
}

/** A pause ends the current helper execution, even when the run later resumes. */
export function stopsRunHelpers(event: { type: string }): boolean {
  return (
    isRunTerminalEvent(event) ||
    event.type === "run.waiting_input" ||
    event.type === "computer.takeover.requested"
  );
}

export function settleRunSubagents<T extends { runId?: string; blocks: readonly unknown[] }>(
  messages: T[],
  runId: string | null | undefined,
): T[] {
  if (!runId) return messages;
  let changed = false;
  const next = messages.map((message) => {
    if (message.runId !== runId) return message;
    let settled = false;
    const blocks = message.blocks.map((value) => {
      const block = asRecord(value);
      if (block.kind !== "subagent" || block.status !== "running") return value;
      settled = true;
      return { ...block, status: "failed", result: "stopped" };
    });
    if (!settled) return message;
    changed = true;
    return { ...message, blocks };
  });
  return changed ? next : messages;
}

export function progressMessageId(event: { runId?: string | null; id?: string }): string {
  return `progress:${event.runId ?? event.id ?? "live"}`;
}

export function isRunTerminalEvent(event: { type: string }): boolean {
  return (
    event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled"
  );
}

export const RESPONSE_STREAMING_STORAGE_KEY = "rakazo.responseStreaming";
export type ResponseStreamingPreference = "on" | "off";

/** Missing and unknown values stay off; only an explicit "on" enables streaming. */
export function normalizeResponseStreamingPreference(
  raw: string | null | undefined,
): ResponseStreamingPreference {
  return raw?.trim().toLowerCase() === "on" ? "on" : "off";
}

export function responseStreamingEnabled(preference: ResponseStreamingPreference = "off"): boolean {
  return preference === "on";
}

/** Hide assistant token text on synthetic progress rows. Tool activity stays. */
export function stripLiveStreamingProgress<
  T extends { id: string; blocks: readonly MessageBlock[] },
>(messages: readonly T[]): T[] {
  let changed = false;
  const next: T[] = [];
  for (const message of messages) {
    if (!message.id.startsWith("progress:")) {
      next.push(message);
      continue;
    }
    const blocks = message.blocks.filter(
      (block) => block.kind !== "text" && (block.kind !== "progress" || block.activity === true),
    );
    if (blocks.length === message.blocks.length) {
      next.push(message);
      continue;
    }
    changed = true;
    if (blocks.length === 0) continue;
    next.push({ ...message, blocks });
  }
  return changed ? next : (messages as T[]);
}

export function withLiveStreamingProgress<
  T extends { messages: readonly U[] },
  U extends { id: string; blocks: readonly MessageBlock[] },
>(snapshot: T | null, streamResponses: boolean): T | null {
  if (!snapshot || streamResponses) return snapshot;
  const messages = stripLiveStreamingProgress(snapshot.messages);
  if (messages === snapshot.messages) return snapshot;
  return { ...snapshot, messages };
}

const RUN_FAILURE_ERROR_MAX = 300;

/** Reason a run failed, clamped for display, or null when there is no usable error to show. */
export function runFailureError(event: {
  type: string;
  payload?: Record<string, unknown>;
}): string | null {
  if (event.type !== "run.failed") return null;
  const error = event.payload?.error;
  if (typeof error !== "string" || !error.trim()) return null;
  const message = error.trim();
  // Clamp each model's diagnostic so a fallback summary stays parseable for display.
  const fallback = parseModelFallbackFailure(message);
  if (fallback) {
    return modelFallbackFailure(
      clampRunFailure(fallback.primaryError),
      fallback.backups.map((item) => ({ ...item, reason: clampRunFailure(item.reason) })),
    );
  }
  return clampRunFailure(message);
}

// A provider can fail with a stack or a whole response body; the run record keeps the full
// text while the UI shows a bounded first line.
function clampRunFailure(message: string): string {
  return message.length > RUN_FAILURE_ERROR_MAX
    ? `${message.slice(0, RUN_FAILURE_ERROR_MAX)}…`
    : message;
}

export type LiveMessageUpdate =
  | { type: "progress"; payload: Record<string, unknown> | undefined }
  | { type: "tool"; name: string };

export function reduceLiveMessageBlocks(
  current: readonly MessageBlock[],
  update: LiveMessageUpdate,
): MessageBlock[] {
  // A reset drops the text streamed so far (it will not be in the reply) and keeps the steps,
  // including tools still waiting on that text to finish its sentence.
  let blocks = current;
  if (update.type === "progress" && update.payload?.reset === true) {
    const waiting = current.at(-1)?.kind === "progress" ? current.at(-1) : undefined;
    blocks = current.filter((block) => block.kind !== "text" && block.kind !== "progress");
    for (const name of waiting?.kind === "progress" ? (waiting.pendingToolNames ?? []) : []) {
      blocks = appendToolCallSegment(blocks, name);
    }
  }
  const tail = blocks.at(-1);
  const segments = tail?.kind === "progress" ? blocks.slice(0, -1) : blocks;
  const priorText = liveMessageText(blocks);
  const flushedLength =
    tail?.kind === "progress" ? priorText.length - tail.text.length : priorText.length;
  const tailText =
    update.type === "progress"
      ? progressMessageText(update.payload, priorText).slice(flushedLength)
      : tail?.kind === "progress"
        ? tail.text
        : "";
  const pendingToolNames = [
    ...(tail?.kind === "progress" ? (tail.pendingToolNames ?? []) : []),
    ...(update.type === "tool" ? [update.name] : []),
  ];
  const activity =
    update.type === "progress"
      ? update.payload?.activity === true
      : tail?.kind === "progress" && tail.activity === true;

  if (pendingToolNames.length > 0 && endsSentence(tailText)) {
    let next = activity ? [...segments] : appendTextSegment(segments, tailText);
    for (const name of pendingToolNames) next = appendToolCallSegment(next, name);
    return next;
  }
  if (!tailText) return [...segments];
  return [
    ...segments,
    {
      kind: "progress",
      text: tailText,
      ...(activity ? { activity: true as const } : {}),
      ...(pendingToolNames.length > 0 ? { pendingToolNames } : {}),
    },
  ];
}

function liveMessageText(blocks: readonly MessageBlock[]): string {
  return blocks
    .filter((block) => block.kind === "text" || block.kind === "progress")
    .map((block) => block.text)
    .join("");
}

/**
 * Whether a live message is writing reply text right now: its newest block is the bot's
 * own narration, with no tool waiting to run. Tool status lines don't count.
 */
export function liveMessageComposing(blocks: readonly MessageBlock[]): boolean {
  const tail = blocks.at(-1);
  return (
    tail?.kind === "progress" &&
    !tail.activity &&
    !tail.pendingToolNames?.length &&
    tail.text.trim().length > 0
  );
}

/** The tool status line the newest live message is showing ("Searching the web: …"), if any. */
export function liveActivityLine(
  messages: readonly { id: string; blocks: readonly MessageBlock[] }[],
): string | undefined {
  const live = messages.findLast((message) => message.id.startsWith("progress:"));
  const tail = live?.blocks.at(-1);
  return (tail?.kind === "progress" && tail.activity && tail.text.trim()) || undefined;
}

export type ToolStepOutcome = "succeeded" | "failed" | "stopped";
export type ToolStep = Extract<MessageBlock, { kind: "steps" }>["steps"][number];

/**
 * Records how each call ended on the step it shows as. `calls` lists every step a call made, in
 * call order (a connector call can make several). If they stop lining up with the steps, the
 * steps are returned as they were rather than credited to the wrong step.
 */
export function withToolStepOutcomes(
  segments: readonly MessageBlock[],
  calls: readonly {
    label: string;
    outcome: ToolStepOutcome | undefined;
    /** The tool the call ran, and what it kept, when the call shows as its own step. */
    tool?: string;
    call?: ToolStepCall;
  }[],
): MessageBlock[] {
  let next = 0;
  const annotated: MessageBlock[] = [];
  for (const block of segments) {
    if (block.kind !== "steps") {
      annotated.push(block);
      continue;
    }
    const steps: HistoryToolStep[] = [];
    for (const step of block.steps as HistoryToolStep[]) {
      const outcomes: NonNullable<ToolStep["outcomes"]> = {};
      const own = calls.slice(next, next + step.count);
      next += step.count;
      if (own.length < step.count || own.some((call) => call.label !== step.label))
        return [...segments];
      for (const call of own)
        if (call.outcome) outcomes[call.outcome] = (outcomes[call.outcome] ?? 0) + 1;
      const { outcomes: _previous, tool: _tool, calls: _calls, ...rest } = step;
      // Calls are kept for a step only when every one of them was, all of the same tool.
      const tool = own[0]?.tool;
      const kept = own.flatMap((call) => (call.call ? [call.call] : []));
      const replayable =
        tool !== undefined &&
        next <= TOOL_STEP_CALLS_KEPT &&
        kept.length === step.count &&
        own.every((call) => call.tool === tool);
      steps.push({
        ...rest,
        ...(replayable ? { tool, calls: kept } : {}),
        ...(Object.keys(outcomes).length > 0 ? { outcomes } : {}),
      });
    }
    annotated.push({ ...block, steps });
  }
  return annotated;
}

/** Calls a reply keeps arguments and results for; a later turn replays no more than these. */
export const TOOL_STEP_CALLS_KEPT = 40;

/**
 * Splits a reply's kept tool calls off its blocks: the blocks keep only what the UI shows, and
 * the history (one entry per step, in order) is stored beside the message for later runs.
 * Every message write goes through this, so no tool output reaches a client in the blocks.
 */
export function splitToolHistory(blocks: readonly MessageBlock[]): {
  blocks: MessageBlock[];
  toolHistory: ToolHistory | undefined;
} {
  const steps: ToolHistory["steps"] = [];
  const shown = blocks.map((block): MessageBlock => {
    if (block.kind !== "steps") return block;
    return {
      ...block,
      steps: (block.steps as HistoryToolStep[]).map(({ tool, calls, ...step }) => {
        steps.push(tool && calls?.length ? { tool, calls } : null);
        return step;
      }),
    };
  });
  return { blocks: shown, toolHistory: steps.some(Boolean) ? { steps } : undefined };
}

/** The message's steps with the tool and calls its stored history keeps for them, for replay. */
export function withToolHistory(
  blocks: readonly MessageBlock[],
  history: ToolHistory | undefined,
): MessageBlock[] {
  if (!history) return [...blocks];
  let index = 0;
  return blocks.map((block) =>
    block.kind === "steps"
      ? {
          ...block,
          steps: block.steps.map((step): HistoryToolStep => {
            const kept = history.steps[index++];
            return kept ? { ...step, tool: kept.tool, calls: kept.calls } : step;
          }),
        }
      : block,
  );
}

export function appendToolStep(steps: readonly ToolStep[], toolName: string): ToolStep[] {
  const label = humanizeToolName(toolName);
  const last = steps.at(-1);
  if (last && last.label === label) {
    return [...steps.slice(0, -1), { ...last, count: last.count + 1 }];
  }
  return [...steps, { label, count: 1 }];
}

/** Puts a note on the newest step, splitting it off a run of the same step so it stays in order. */
export function noteLastToolStep(segments: readonly MessageBlock[], note: string): MessageBlock[] {
  const index = segments.findLastIndex((block) => block.kind === "steps");
  const block = segments[index];
  const last = block?.kind === "steps" ? block.steps.at(-1) : undefined;
  if (block?.kind !== "steps" || !last) return [...segments];
  const steps = block.steps.slice(0, -1);
  if (last.count > 1)
    steps.push({ ...last, count: last.count - 1 }, { label: last.label, count: 1, note });
  else steps.push({ ...last, note: last.note ? `${last.note}\n\n${note}` : note });
  const next = [...segments];
  next[index] = { ...block, steps };
  return next;
}

/** Removes the newest `count` notes from the steps. */
export function withoutLastToolStepNotes(
  segments: readonly MessageBlock[],
  count: number,
): MessageBlock[] {
  let left = count;
  const next = [...segments];
  for (let index = next.length - 1; index >= 0 && left > 0; index -= 1) {
    const block = next[index];
    if (block?.kind !== "steps") continue;
    const steps = [...block.steps];
    for (let step = steps.length - 1; step >= 0 && left > 0; step -= 1) {
      const { note, ...rest } = steps[step]!;
      if (note === undefined) continue;
      steps[step] = rest;
      left -= 1;
    }
    next[index] = { ...block, steps };
  }
  return next;
}

/** `shape` is the call with the digits in its text arguments blanked, so `echo n-1`, `echo n-2` match. */
export type ToolCallStreak = {
  key: string | undefined;
  count: number;
  shape?: string;
  shapeCount?: number;
};

export function trackToolCallStreak(
  streak: ToolCallStreak,
  name: string,
  args: unknown,
): ToolCallStreak {
  const key = `${name}:${JSON.stringify(args)}`;
  const shape = `${name}:${JSON.stringify(args, (_, value) => (typeof value === "string" ? value.replace(/\d+/g, "#") : value))}`;
  return {
    key,
    count: key === streak.key ? streak.count + 1 : 1,
    shape,
    shapeCount: shape === streak.shape ? (streak.shapeCount ?? 0) + 1 : 1,
  };
}

export type ToolNameStreak = { name: string | undefined; count: number };

export function trackToolNameStreak(streak: ToolNameStreak, name: string): ToolNameStreak {
  return name === streak.name ? { name, count: streak.count + 1 } : { name, count: 1 };
}

const SENTENCE_END_RE = /[.!?]["'”’)\]]*\s*$/;

/** True once `text` ends at a sentence boundary (or is empty) — safe to flush without cutting a clause. */
export function endsSentence(text: string): boolean {
  return text.trim() === "" || SENTENCE_END_RE.test(text);
}

export function appendTextSegment(segments: readonly MessageBlock[], text: string): MessageBlock[] {
  if (!text) return [...segments];
  const last = segments.at(-1);
  if (last?.kind === "text") {
    return [...segments.slice(0, -1), { kind: "text", text: last.text + text }];
  }
  return [...segments, { kind: "text", text }];
}

export function appendToolCallSegment(
  segments: readonly MessageBlock[],
  toolName: string,
): MessageBlock[] {
  const last = segments.at(-1);
  const priorSteps = last?.kind === "steps" ? last.steps : [];
  const steps = appendToolStep(priorSteps, toolName);
  if (last?.kind === "steps") {
    return [...segments.slice(0, -1), { kind: "steps", steps }];
  }
  return [...segments, { kind: "steps", steps }];
}

export function humanizeToolName(name: string): string {
  const spaced = name.replace(/_/g, " ").trim();
  if (!spaced) return name;
  const lower = spaced.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** "GMAIL_SEND_EMAIL" on Gmail's page reads as "Send email": the app is already the page title. */
export function appToolLabel(name: string, appSlug: string): string {
  const prefix = `${appSlug}_`.toLowerCase();
  return humanizeToolName(name.toLowerCase().startsWith(prefix) ? name.slice(prefix.length) : name);
}

/** Reverses humanizeToolName for a typed name; rules match tool names ignoring case. */
export function toolNameFromLabel(label: string): string {
  return label.trim().replace(/\s+/g, "_");
}

export function progressMessageText(
  payload: Record<string, unknown> | undefined,
  previousText = "",
): string {
  return typeof payload?.delta === "string"
    ? previousText + payload.delta
    : String(payload?.text ?? "");
}

export function subagentBlockFromPayload(
  payload: Record<string, unknown>,
): Extract<MessageBlock, { kind: "subagent" }> {
  const status = payload.status;
  return preserveIdentitySource(
    payload,
    {
      kind: "subagent",
      agentId: String(payload.agentId ?? ""),
      name: String(payload.name ?? ""),
      task: String(payload.task ?? ""),
      status: status === "completed" || status === "failed" ? status : "running",
      progress: payload.progress ? String(payload.progress) : undefined,
      result: payload.result ? String(payload.result) : undefined,
    },
    ["name"],
  );
}

/** Shorter lines, or lines with spaces such as a key's BEGIN header, also appear in ordinary text. */
const MIN_SECRET_LINE_LENGTH = 16;

/**
 * The values to hide for `secrets`: each value, and each long unspaced line of a multi-line value
 * such as a private key's body, since output that prints only some lines or joins them with
 * spaces (an unquoted `echo $KEY`) never contains the whole value.
 */
function protectedValues(secrets: Iterable<string>): string[] {
  const values = new Set<string>();
  for (const secret of secrets) {
    if (!secret) continue;
    values.add(secret);
    if (!/[\r\n]/.test(secret)) continue;
    for (const line of secret.split(/\r\n?|\n/)) {
      const trimmed = line.trim();
      if (trimmed.length >= MIN_SECRET_LINE_LENGTH && !/\s/.test(trimmed)) values.add(trimmed);
    }
  }
  return [...values];
}

/**
 * The stretches protected values cover in `value`, in order, as [start, end). Matches that
 * overlap make one stretch, so a shorter value inside or across a longer one can't cut it and
 * leave the rest readable; matches that only touch stay separate.
 */
function redactedRanges(value: string, secrets: Iterable<string>): Array<[number, number]> {
  // Count matches starting and ending at each offset rather than listing every match, so a value
  // that repeats or overlaps itself across a long text costs no more than two counters per offset.
  let starts: Int32Array | undefined;
  let ends: Int32Array | undefined;
  for (const secret of protectedValues(secrets)) {
    for (let at = value.indexOf(secret); at !== -1; at = value.indexOf(secret, at + 1)) {
      starts ??= new Int32Array(value.length + 1);
      ends ??= new Int32Array(value.length + 1);
      starts[at] = starts[at]! + 1;
      ends[at + secret.length] = ends[at + secret.length]! + 1;
    }
  }
  if (!starts || !ends) return [];
  const ranges: Array<[number, number]> = [];
  let open = 0;
  let start = 0;
  for (let offset = 0; offset <= value.length; offset += 1) {
    const ending = ends[offset]!;
    const starting = starts[offset]!;
    if (ending === 0 && starting === 0) continue;
    open -= ending;
    if (ending > 0 && open === 0) ranges.push([start, offset]);
    if (starting > 0 && open === 0) start = offset;
    open += starting;
  }
  return ranges;
}

export function redactSecrets(value: string, secrets: readonly string[]): string {
  let output = "";
  let offset = 0;
  for (const [start, end] of redactedRanges(value, secrets)) {
    output += `${value.slice(offset, start)}[redacted]`;
    offset = end;
  }
  return output + value.slice(offset);
}

/** Redacts `text` as the continuation of `before`, so a value split across the two is hidden too. */
export function redactSecretsAfter(before: string, text: string, secrets: string[]): string {
  const value = before + text;
  let output = "";
  let offset = before.length;
  for (const [start, end] of redactedRanges(value, secrets)) {
    if (end <= offset) continue;
    output += `${value.slice(offset, Math.max(start, offset))}[redacted]`;
    offset = end;
  }
  return output + value.slice(offset);
}

export function containsSecret(value: unknown, secrets: string[]): boolean {
  const active = protectedValues(secrets);
  if (active.length === 0) return false;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return false;
  const pending: unknown[] = [JSON.parse(serialized)];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (active.some((secret) => current.includes(secret))) return true;
      continue;
    }
    if (current === null || typeof current === "number" || typeof current === "boolean") {
      const primitive = String(current);
      if (active.some((secret) => primitive.includes(secret))) return true;
      continue;
    }
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (current && typeof current === "object") {
      for (const [key, nested] of Object.entries(current)) {
        if (active.some((secret) => key.includes(secret))) return true;
        pending.push(nested);
      }
    }
  }
  return false;
}

/** UTF-16 high surrogates (0xD800–0xDBFF) must be paired with a low surrogate for valid JSON. */
const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;

function isHighSurrogate(code: number): boolean {
  return code >= HIGH_SURROGATE_START && code <= HIGH_SURROGATE_END;
}

function endsWithHighSurrogate(value: string): boolean {
  return value.length > 0 && isHighSurrogate(value.charCodeAt(value.length - 1));
}

/**
 * Replace unpaired UTF-16 surrogates and NUL characters, which Postgres rejects
 * in json and text columns (command output and binary-ish tool results carry both).
 */
export function sanitizeUtf16ForJson(value: string): string {
  return value.replace(UNSAFE_UTF16, "\uFFFD");
}

/** NUL, a high surrogate with no low after it, or a low surrogate with no high before it. */
const UNSAFE_UTF16 = /\0|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Deep-sanitize string leaves and keys so event payloads always persist in Postgres. */
export function sanitizeJsonValue<T>(value: T): T {
  if (typeof value === "string") return sanitizeUtf16ForJson(value) as T;
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonValue(item)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    const used = new Map<string, number>();
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      let safeKey = sanitizeUtf16ForJson(key);
      const seen = used.get(safeKey) ?? 0;
      used.set(safeKey, seen + 1);
      // Deterministic collision handling when sanitizing collapses distinct keys.
      if (seen > 0) safeKey = `${safeKey}#${seen + 1}`;
      // An own property, so a parsed "__proto__" key stays data instead of setting the prototype.
      Object.defineProperty(out, safeKey, {
        value: sanitizeJsonValue(nested),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out as T;
  }
  return value;
}

export function createStreamingRedactor(secrets: string[]) {
  const values = protectedValues(secrets);
  const maxLength = Math.max(0, ...values.map((value) => value.length));
  let buffer = "";
  let covered = 0;

  const drain = (final: boolean) => {
    let output: string;
    if (values.length === 0) {
      output = buffer;
      buffer = "";
    } else {
      // A match a later chunk completes starts in the last maxLength - 1 units, so text before
      // that is final. A stretch reaching past it is shown now and its rest kept as `covered`: a
      // later match starting inside it extends the same placeholder, so nothing is held for long.
      const cut = final ? buffer.length : Math.max(0, buffer.length - maxLength + 1);
      let offset = covered;
      output = "";
      for (const [start, end] of redactedRanges(buffer, values)) {
        if (start >= cut) break;
        if (start >= offset) output += `${buffer.slice(offset, start)}[redacted]`;
        offset = Math.max(offset, end);
      }
      output += buffer.slice(Math.min(offset, cut), cut);
      covered = Math.max(0, offset - cut);
      buffer = buffer.slice(cut);
    }
    // No-secret path emits the whole buffer; hold a trailing high until the next chunk.
    if (!final && endsWithHighSurrogate(output)) {
      buffer = output.slice(-1) + buffer;
      output = output.slice(0, -1);
    }
    return sanitizeUtf16ForJson(output);
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      return drain(false);
    },
    finish() {
      return drain(true);
    },
    /**
     * Drops what is held back without showing it, but keeps matching against it, so a value
     * split between the dropped text and the next chunk is still hidden.
     */
    skip() {
      covered = buffer.length;
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
