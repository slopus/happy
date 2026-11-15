import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  AdapterContext,
  AgentRunModel,
  AgentRuntime,
  AgentUsage,
  ComputerObservation,
  ComputerRef,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { WORKING_RUN_STATUSES } from "@rakazo/core";
import type { createDb } from "@rakazo/db";
import type { EvalJudge, JudgeInput, Judgment } from "../evals/judge.js";
import { createEvalJudge } from "../evals/judge.js";
import { sessionCookieHeader } from "../index.js";
import { asSystem } from "../system-db.js";
import type { Criterion, Flow, FlowComputer, FlowEvidence, TranscriptEntry } from "./flow.js";
import { check } from "./flow.js";
import type { PendingAsk, Situation, UserMove } from "./simulated-user.js";
import { createSimulatedUser, screenStepLog } from "./simulated-user.js";

export type FlowApp = {
  app: { request: (input: string, init?: RequestInit) => Promise<Response> | Response };
  prisma: ReturnType<typeof createDb>["prisma"];
  jobs: JobPublisher;
  runtime: AgentRuntime;
  sandbox: SandboxProvider;
};

export type FlowOptions = {
  sandboxKind: ComputerRef["kind"];
  userModel: AgentRunModel;
  judgeModel: AgentRunModel;
  deadlineMs: number;
  maxUserTurns: number;
  spendCapUsd: number;
  log: (line: string) => void;
  /** Where screen frames are written; the report links them from the timeline. */
  framesDir: string;
};

export type FlowResult = {
  flow: string;
  status: "passed" | "failed" | "error";
  error?: string;
  endedBy: FlowEvidence<unknown>["endedBy"];
  criteria: Criterion[];
  judgment: Judgment | null;
  transcript: TranscriptEntry[];
  observations: Record<string, unknown>;
  /** Every run the bot made, so a quiet or failed routine wake is visible. */
  runs: Array<{
    trigger: string;
    routine: boolean;
    status: string;
    error: string | null;
    botMessages: number;
  }>;
  routines: FlowEvidence<unknown>["routines"];
  /** Distinct screen frames in time order, relative to the report directory. */
  frames: Array<{ at: string; file: string }>;
  toolCalls: number;
  toolCounts: Record<string, number>;
  durationMs: number;
  botCostUsd: number;
  /** Null when the provider reported no price for some simulated-user or judge call. */
  harnessCostUsd: number | null;
  harnessTokens: { input: number; output: number };
};

type Settled =
  | { kind: "idle" }
  | { kind: "ask"; runId: string; messageId: string; toolApproval: boolean; ask: PendingAsk }
  | { kind: "mcp"; threadId: string; serverId: string; needsOAuth: boolean; ask: PendingAsk }
  | { kind: "takeover" };

class FlowStop extends Error {
  constructor(readonly endedBy: FlowEvidence<unknown>["endedBy"]) {
    super(endedBy);
  }
}

export async function runFlow<World>(
  handles: FlowApp,
  flow: Flow<World>,
  options: FlowOptions,
): Promise<FlowResult> {
  const started = Date.now();
  const deadline = started + options.deadlineMs;
  const prisma = asSystem(handles.prisma);
  const abort = new AbortController();
  const transcript: TranscriptEntry[] = [];
  const observations: Record<string, unknown> = {};
  const seenMessages = new Set<string>();
  let harnessCostUsd = 0;
  let harnessCostKnown = true;
  const harnessTokens = { input: 0, output: 0 };
  const onUsage = (usage: AgentUsage) => {
    if (usage.costUsd == null) harnessCostKnown = false;
    harnessCostUsd += usage.costUsd ?? 0;
    harnessTokens.input += (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0);
    harnessTokens.output += usage.outputTokens ?? 0;
  };
  let botId = "";
  let cookie = "";
  let world: World | undefined;
  let endedBy: FlowEvidence<unknown>["endedBy"] = "user-done";
  let wakesRan = 0;
  let wakesNotDue = 0;
  let computer: FlowComputer | undefined;
  let recorder: NodeJS.Timeout | undefined;
  let recording: Promise<void> | undefined;
  let record = async (_frame: ComputerObservation) => {};
  const result: FlowResult = {
    flow: flow.id,
    status: "error",
    endedBy,
    criteria: [],
    judgment: null,
    transcript,
    observations,
    runs: [],
    frames: [],
    routines: [],
    toolCalls: 0,
    toolCounts: {},
    durationMs: 0,
    botCostUsd: 0,
    harnessCostUsd: 0,
    harnessTokens,
  };

  const rpc = async <T>(procedure: string, body: unknown): Promise<T> => {
    const response = await handles.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({ json: body }),
    });
    const parsed = (await response.json()) as { json?: T; error?: { message?: string } };
    if (!response.ok || parsed.error)
      throw new Error(`${procedure} ${response.status}: ${parsed.error?.message ?? "failed"}`);
    return parsed.json as T;
  };

  const botCost = async () =>
    (await prisma.usageRecord.aggregate({ where: { botId }, _sum: { costUsd: true } }))._sum
      .costUsd ?? 0;

  /** Reads new bot messages into the transcript and returns the pending card, if any. */
  const readThread = async (wake?: number) => {
    const snapshot = await rpc<{
      threadId: string;
      messages: Array<{
        id: string;
        role: string;
        runId?: string | null;
        createdAt: string;
        blocks: MessageBlock[];
      }>;
    }>("threads/get", { botId });
    let pending: Extract<Settled, { kind: "ask" | "mcp" }> | undefined;
    for (const message of snapshot.messages) {
      if (message.role !== "bot") continue;
      for (const block of message.blocks) {
        const mcp = mcpPendingCard(snapshot.threadId, block);
        if (mcp) {
          pending = mcp;
          continue;
        }
        const ask = askPendingCard(message, block);
        if (ask) pending = ask;
      }
      if (seenMessages.has(message.id)) continue;
      const text = message.blocks
        .flatMap((block) =>
          block.kind === "text"
            ? [block.text ?? ""]
            : block.kind === "ask"
              ? [cardText({ text: block.text, detail: block.detail, actions: block.actions })]
              : block.kind === "mcp_approval"
                ? [cardText(mcpApprovalAsk(block))]
                : block.kind === "computer"
                  ? [`[screen] ${block.text}`]
                  : [],
        )
        .join("\n")
        .trim();
      // Messages still streaming are re-read next time.
      const working = await prisma.run.findFirst({
        where: { id: message.runId ?? "", status: { in: [...WORKING_RUN_STATUSES] } },
        select: { id: true },
      });
      if (working) continue;
      seenMessages.add(message.id);
      if (text)
        transcript.push({ from: "bot", text, at: message.createdAt, ...(wake ? { wake } : {}) });
    }
    return pending;
  };

  /** Checked before every paid step, the bot's or the harness's. */
  const withinSpend = async () => {
    if ((await botCost()) + harnessCostUsd > options.spendCapUsd) {
      await rpc("threads/stop", { botId }).catch(() => undefined);
      throw new FlowStop("spend-cap");
    }
  };
  const withinLimits = async () => {
    if (Date.now() > deadline) throw new FlowStop("deadline");
    await withinSpend();
  };

  /** Waits until the bot stops working: idle, waiting on a card, or asking for the screen. */
  const settle = async (wake?: number): Promise<Settled> => {
    for (;;) {
      await withinLimits();
      const runs = await prisma.run.findMany({
        where: {
          botId,
          status: { in: [...WORKING_RUN_STATUSES, "waiting_input", "waiting_takeover"] },
        },
        select: { id: true, status: true },
      });
      if (!runs.some((run) => (WORKING_RUN_STATUSES as readonly string[]).includes(run.status))) {
        if (runs.some((run) => run.status === "waiting_takeover")) {
          await readThread(wake);
          return { kind: "takeover" };
        }
        const pending = await readThread(wake);
        if (pending) return pending;
        // An answered card flips its run back to queued; wait for that instead of reading it as idle.
        if (!runs.length) return { kind: "idle" };
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  };

  try {
    const signup = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({
        email: `flow-${randomUUID()}@example.test`,
        password: "synthetic-flow-password-12",
        name: "Sam Rivera",
      }),
    });
    if (!signup.ok) throw new Error(`Signup failed (${signup.status})`);
    cookie = sessionCookieHeader(signup);
    await rpc("preferences/adoptTimezone", { timezone: flow.timezone });
    // A fresh bot exactly as a new user would create it: no test instructions.
    const bot = await rpc<{ id: string }>("bots/create", { name: "Errands" });
    botId = bot.id;
    // The intro run can hold the computer while it starts; wait it out like a person would.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rpc("computer/boot", { botId });
        break;
      } catch (error) {
        if (attempt >= 30 || !String(error).includes(" 409:")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    }
    const stored = await prisma.bot.findUniqueOrThrow({
      where: { id: botId },
      include: { computer: true },
    });
    const ref: ComputerRef = {
      id: stored.computer!.providerRef!,
      providerRef: stored.computer!.providerRef!,
      botId: stored.computer!.homeKey,
      kind: options.sandboxKind,
    };
    const context: AdapterContext = {
      operationId: `flow-${flow.id}`,
      traceId: `flow-${flow.id}`,
      spaceId: stored.spaceId,
      userId: stored.userId,
      botId,
      signal: abort.signal,
    };
    computer = { sandbox: handles.sandbox, computer: ref, context };
    mkdirSync(options.framesDir, { recursive: true });
    let lastFrame = "";
    record = async (frame: ComputerObservation) => {
      const hash = createHash("sha1").update(frame.image).digest("hex");
      if (hash === lastFrame) return;
      lastFrame = hash;
      const file = `${String(result.frames.length + 1).padStart(4, "0")}.${frame.mimeType === "image/png" ? "png" : "jpg"}`;
      writeFileSync(path.join(options.framesDir, file), frame.image);
      result.frames.push({ at: new Date().toISOString(), file: `frames/${file}` });
    };
    // Watch the bot's screen the way a person glancing at it would; failures only cost a frame.
    recorder = setInterval(() => {
      if (recording) return;
      recording = handles.sandbox
        .observe(ref, context)
        .then((frame) => record(frame))
        .catch(() => undefined)
        .finally(() => {
          recording = undefined;
        });
    }, FRAME_INTERVAL_MS);
    options.log(`computer ready (${options.sandboxKind}), setting up ${flow.id}`);
    world = await flow.setup(computer);

    const user = createSimulatedUser(
      handles.runtime,
      options.userModel,
      async () => {
        const live = await flow.liveFacts?.(computer!, world!);
        return live ? `${flow.persona(world!)}\n\n## Right now\n${live}` : flow.persona(world!);
      },
      onUsage,
    );
    /** The person takes the screen through the product's takeover path, acts, and hands it back. */
    const takeOver = async (wake?: number) => {
      await rpc("computer/takeover", { botId });
      const log = screenStepLog();
      for (let step = 0; step < MAX_SCREEN_STEPS; step += 1) {
        await withinLimits();
        const frame = await handles.sandbox.observe(ref, context);
        await record(frame);
        log.saw(frame.image);
        const situation: Situation = {
          kind: "screen",
          image: { name: "screen.png", mimeType: frame.mimeType, data: frame.image },
          width: frame.width,
          height: frame.height,
          steps: log.steps,
        };
        const move = await user(transcript, situation, abort.signal);
        options.log(`user at screen: ${describeMove(move)}`);
        if (move.kind === "release") {
          await rpc("computer/release", { botId, reason: "done" });
          transcript.push({
            from: "user",
            at: new Date().toISOString(),
            text: `[took the screen: ${log.steps.join("; ")}]`,
            ...(wake ? { wake } : {}),
          });
          return;
        }
        if (move.kind === "click")
          await rpc("computer/input", {
            botId,
            kind: "pointer",
            payload: { x: move.x, y: move.y, type: "click" },
          });
        else if (move.kind === "type")
          // Marked sensitive like a real password field, so it is never recorded as teaching.
          await rpc("computer/input", {
            botId,
            kind: "clipboard",
            payload: { text: move.text, sensitive: true },
          });
        else if (move.kind === "key")
          await rpc("computer/input", { botId, kind: "key", payload: { key: move.key } });
        log.did(describeMove(move), move.kind === "click" ? move : undefined);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      await rpc("computer/release", { botId, reason: "skipped" }).catch(() => undefined);
      throw new FlowStop("takeover");
    };

    const converse = async (wake?: number) => {
      let state = await settle(wake);
      for (let turn = 0; ; turn += 1) {
        if (turn >= options.maxUserTurns) throw new FlowStop("turn-limit");
        if (state.kind === "takeover") {
          await takeOver(wake);
          state = await settle(wake);
          continue;
        }
        const card = state.kind === "idle" ? undefined : state.ask;
        const move: UserMove = await user(
          transcript,
          card ? { kind: "card", ask: card } : { kind: "chat" },
          abort.signal,
        );
        options.log(`user: ${describeMove(move)}`);
        if (move.kind === "done") return;
        if (state.kind === "ask") {
          await rpc("threads/answer", {
            botId,
            runId: state.runId,
            messageId: state.messageId,
            answer:
              move.kind === "say"
                ? move.text
                : move.kind === "choose"
                  ? move.actionId
                  : move.kind === "secret"
                    ? move.value
                    : "",
            ...(move.kind === "secret" && move.username ? { username: move.username } : {}),
          });
        } else if (state.kind === "mcp" && move.kind === "choose") {
          const request = mcpCardRequest(state, move.actionId, botId);
          // Stopping still grades the run.
          if (!request) {
            options.log("cannot complete an MCP OAuth popup");
            throw new FlowStop("error");
          }
          await rpc(request.procedure, request.body);
        } else if (move.kind === "say") {
          await rpc("threads/send", { botId, text: move.text });
        } else {
          // Buttons and secrets only make sense on a card; treat a stray one as the person moving on.
          return;
        }
        transcript.push({
          from: "user",
          at: new Date().toISOString(),
          text:
            move.kind === "say"
              ? move.text
              : move.kind === "choose"
                ? `[pressed ${card?.actions?.find((action) => action.id === move.actionId)?.label ?? move.actionId}]`
                : "[filled secret]",
          ...(answeredToolApproval(state, move) ? { toolApproval: true } : {}),
          ...(wake ? { wake } : {}),
        });
        state = await settle(wake);
        const last = transcript.at(-1);
        if (last?.from === "bot")
          options.log(`bot: ${last.text.slice(0, 160).replace(/\n/g, " ")}`);
      }
    };

    try {
      await converse();
      observations.conversation = await flow.observe(computer, world);
      for (let wake = 1; wake <= (flow.routineWakes ?? 0); wake += 1) {
        const routine = await prisma.routine.findFirst({
          where: { botId, active: true },
          orderBy: { createdAt: "asc" },
        });
        if (!routine) break;
        observations[`before-wake-${wake}`] = {
          nextRunAt: routine.nextRunAt?.toISOString() ?? null,
          crons: routine.crons,
          timezone: routine.timezone,
        };
        if (!wakeIsDue(routine.nextRunAt, Date.now(), flow.wakeHorizonMs)) {
          options.log(`routine "${routine.name}" is not due soon; not waking it early`);
          wakesNotDue += 1;
          break;
        }
        options.log(`waking routine "${routine.name}" (${wake})`);
        // Stand in for the calendar passing, not for the bot's work.
        const scheduledFor = new Date(Date.now() - 1_000);
        await prisma.routine.update({
          where: { id: routine.id },
          data: { nextRunAt: scheduledFor },
        });
        await handles.jobs.enqueue({
          name: "routine.wakeup",
          payload: { routineId: routine.id, scheduledFor: scheduledFor.toISOString() },
        });
        const waitStart = Date.now();
        while ((await prisma.run.count({ where: { botId, routineId: routine.id } })) < wake) {
          if (Date.now() - waitStart > 60_000) throw new Error("Routine wake did not start a run");
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
        await converse(wake);
        observations[`wake-${wake}`] = await flow.observe(computer, world);
        wakesRan += 1;
      }
    } catch (error) {
      if (!(error instanceof FlowStop)) throw error;
      endedBy = error.endedBy;
      options.log(`stopped: ${endedBy}`);
      observations.final = await flow.observe(computer, world).catch(() => null);
    }

    const tools = await prisma.event.findMany({
      where: { botId, type: "agent.tool.called" },
      select: { payload: true },
    });
    for (const event of tools) {
      const name = String((event.payload as { name?: string }).name ?? "unknown");
      result.toolCounts[name] = (result.toolCounts[name] ?? 0) + 1;
    }
    result.toolCalls = tools.length;
    const runs = await prisma.run.findMany({
      where: { botId },
      orderBy: { createdAt: "asc" },
      select: { id: true, trigger: true, routineId: true, status: true, error: true },
    });
    result.runs = await Promise.all(
      runs.map(async (run) => ({
        trigger: run.trigger,
        routine: Boolean(run.routineId),
        status: run.status,
        error: run.error,
        botMessages: await prisma.message.count({ where: { runId: run.id, role: "bot" } }),
      })),
    );
    result.routines = (await prisma.routine.findMany({ where: { botId } })).map((routine) => ({
      name: routine.name,
      prompt: routine.prompt,
      crons: routine.crons,
      active: routine.active,
      timezone: routine.timezone,
      nextRunAt: routine.nextRunAt?.toISOString() ?? null,
    }));
    const evidence: FlowEvidence<World> = {
      world,
      transcript,
      routines: result.routines,
      toolNames: Object.keys(result.toolCounts),
      observations,
      endedBy,
    };
    const failedRuns = result.runs.filter((run) => run.status === "failed");
    result.criteria = [
      ...flow.grade(evidence),
      ...(flow.routineWakes
        ? [
            check(
              "requested-wakes-ran",
              wakesRan + wakesNotDue === flow.routineWakes,
              `${wakesRan} ran, ${wakesNotDue} not due, of ${flow.routineWakes}`,
            ),
          ]
        : []),
      check(
        "runs-succeeded",
        failedRuns.length === 0,
        failedRuns.map((run) => run.error ?? run.trigger).join("; "),
      ),
    ];
    const deterministicPass = result.criteria.every((criterion) => criterion.pass);
    if (flow.judge) {
      const judge = createEvalJudge(handles.runtime, options.judgeModel, onUsage);
      // Grading runs past the deadline, so it gets its own bound, but not past the spend cap.
      result.judgment = await judgeFlow(
        spendCappedJudge(judge, withinSpend),
        flow.judge(evidence),
        flow.judgeCalibration ?? [],
      );
    }
    result.status = deterministicPass && (result.judgment?.pass ?? true) ? "passed" : "failed";
  } catch (error) {
    result.status = "error";
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (botId && cookie) await rpc("threads/stop", { botId }).catch(() => undefined);
    clearInterval(recorder);
    await recording;
    abort.abort();
    result.endedBy = endedBy;
    result.durationMs = Date.now() - started;
    result.botCostUsd = botId ? await botCost().catch(() => 0) : 0;
    result.harnessCostUsd = harnessCostKnown ? harnessCostUsd : null;
    if (computer)
      await handles.sandbox
        .destroy(computer.computer, { ...computer.context, signal: new AbortController().signal })
        .catch((error: unknown) => options.log(`computer cleanup failed: ${String(error)}`));
  }
  return result;
}

/**
 * Whether to force a routine's next run now. The bot's clock does not move, so only a run due
 * within the flow's horizon stands in for time passing; a later start the bot chose is kept.
 */
export function wakeIsDue(nextRunAt: Date | null, now: number, horizonMs?: number) {
  return (
    Boolean(nextRunAt) && nextRunAt!.getTime() <= now + (horizonMs ?? Number.POSITIVE_INFINITY)
  );
}

const MAX_SCREEN_STEPS = 30;
const FRAME_INTERVAL_MS = 2_500;
const JUDGE_TIMEOUT_MS = 180_000;

/** Checks the spend cap before each judge call and again after it: an over-cap verdict doesn't count. */
export function spendCappedJudge(judge: EvalJudge, withinSpend: () => Promise<void>): EvalJudge {
  return async (input, signal) => {
    await withinSpend();
    const verdict = await judge(input, signal);
    await withinSpend();
    return verdict;
  };
}

/**
 * The flow's judgment. The judge must first agree with every reviewed label; a disagreement or
 * any judge failure is an unqualified result, never a pass.
 */
export async function judgeFlow(
  judge: EvalJudge,
  input: JudgeInput,
  labels: NonNullable<Flow["judgeCalibration"]>,
): Promise<Judgment> {
  try {
    for (const [index, label] of labels.entries()) {
      const verdict = await judge(label.input, AbortSignal.timeout(JUDGE_TIMEOUT_MS));
      if (verdict.pass !== label.pass)
        throw new Error(`judge disagreed with calibration label ${index + 1}: ${verdict.reason}`);
    }
    return await judge(input, AbortSignal.timeout(JUDGE_TIMEOUT_MS));
  } catch (error) {
    return {
      pass: false,
      reason: `Judge unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** The open question card in this block, as the person can answer it. */
export function askPendingCard(
  message: { id: string; runId?: string | null },
  block: MessageBlock,
) {
  if (block.kind !== "ask" || block.status === "answered" || block.dismissed) return undefined;
  if (!message.runId) return undefined;
  return {
    kind: "ask" as const,
    runId: message.runId,
    messageId: message.id,
    toolApproval: Boolean(block.approvalEffectId),
    ask: {
      text: block.text,
      ...(block.detail ? { detail: block.detail } : {}),
      ...(block.actions?.length
        ? { actions: block.actions.map(({ id, label }) => ({ id, label })) }
        : {}),
      ...(block.input ? { input: block.input } : {}),
      ...(block.purpose ? { purpose: String(block.purpose) } : {}),
    } satisfies PendingAsk,
  };
}

/** Whether the person's move was a button press on a card approving one of the bot's tool calls. */
export function answeredToolApproval(
  state: { kind: string; toolApproval?: boolean },
  move: UserMove,
): boolean {
  return state.kind === "ask" && state.toolApproval === true && move.kind === "choose";
}

/** The pending MCP approval card in this block, as the person can answer it. */
export function mcpPendingCard(threadId: string, block: MessageBlock) {
  if (block.kind !== "mcp_approval" || block.status !== "pending") return undefined;
  return {
    kind: "mcp" as const,
    threadId,
    serverId: block.serverId,
    needsOAuth: block.needsOAuth,
    ask: mcpApprovalAsk(block),
  };
}

/**
 * The call the web card makes for a button. None for Authorize on an OAuth card, which first
 * needs a browser popup.
 */
export function mcpCardRequest(
  card: { serverId: string; threadId: string; needsOAuth: boolean },
  actionId: string,
  botId: string,
) {
  if (actionId === "approve" && card.needsOAuth) return undefined;
  return {
    procedure: `mcp/assignments/${actionId}`,
    body: { botId, serverId: card.serverId, threadId: card.threadId },
  };
}

/** An MCP approval card as the web shows it: the server, its address and two buttons. */
export function mcpApprovalAsk(block: Extract<MessageBlock, { kind: "mcp_approval" }>): PendingAsk {
  return {
    text: `Connect MCP server “${block.name}”`,
    detail: block.endpoint ?? `stdio (${block.transport})`,
    actions: [
      { id: "approve", label: block.needsOAuth ? "Authorize" : "Approve" },
      { id: "dismiss", label: "Not now" },
    ],
  };
}

/** A card as the person reads it in the transcript. */
export function cardText(ask: PendingAsk) {
  return [
    `[card] ${ask.text}`,
    ask.detail,
    ask.actions?.length
      ? `(buttons: ${ask.actions.map((action) => action.label).join(", ")})`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function describeMove(move: UserMove) {
  if (move.kind === "say") return move.text.replace(/\n/g, " ");
  if (move.kind === "choose") return `[pressed ${move.actionId}]`;
  if (move.kind === "secret") return "[filled secret]";
  if (move.kind === "click") return `click ${move.x},${move.y}`;
  if (move.kind === "type") return `typed ${move.text.length} characters`;
  if (move.kind === "key") return `pressed ${move.key}`;
  if (move.kind === "release") return "gave the screen back";
  return `[done] ${move.reason}`;
}
