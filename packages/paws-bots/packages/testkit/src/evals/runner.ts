import { randomBytes, randomUUID } from "node:crypto";
import type { AgentRuntime, JobPublisher, NotificationProvider } from "@rakazo/adapter-kit";
import { historyCompactJob, runJobKey } from "@rakazo/adapter-kit";
import {
  CapturingNotificationProvider,
  MessagingTeamChatEmulator,
  messageBot,
} from "@rakazo/adapters";
import type { MessageBlock, ModelConnectInput, ReplyMode, RunStatus } from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  attachmentComputerPath,
  isTerminal,
  splitToolHistory,
} from "@rakazo/core";
import type { createDb } from "@rakazo/db";
import { createThreadEvents } from "@rakazo/db";
import type { HostedApp } from "../apps/mcp-host.js";
import { hostOverMcp } from "../apps/mcp-host.js";
import { discardBotIntroRun } from "../discard-bot-intro.js";
import { sessionCookieHeader } from "../index.js";
import { asSystem } from "../system-db.js";
import type { EvalCase, Evidence, SettingsSnapshot } from "./cases.js";
import { EMPTY_SETTINGS, wakesRoutines } from "./cases.js";
import type { ClarificationBlock } from "./clarification.js";
import { expectedClarificationText } from "./clarification.js";
import { EvalFailure, judgeOutcome, observe, settle, withinDeadline } from "./grading.js";
import type { HistoryMessage } from "./history-fixtures.js";
import type { DiagnosticToolObservation, HistoryDiagnostic } from "./history-observer.js";
import type { EvalJudge } from "./judge.js";
import type { CacheDecisionMeasurement, EvalPricing } from "./measurement.js";
import { measureCalls } from "./measurement.js";
import type { FailureCategory, TrialResult } from "./report.js";
import { emptyTrial, evidenceSnapshot, redact } from "./report.js";
import { browserScreen } from "./sandbox.js";
import { EvalServices } from "./services.js";
import type { RoutineEvidence } from "./silence.js";
import { SilenceObserver } from "./silence-observer.js";
import type { LedgerCall } from "./step-accounting.js";
import { measureWorkflowSteps } from "./step-accounting.js";
import type { ObservedToolCall, ObservedToolList } from "./tool-calls.js";

type App = { request: (input: string, init?: RequestInit) => Promise<Response> | Response };
export type EvalApp = {
  app: App;
  prisma: ReturnType<typeof createDb>["prisma"];
  jobs: JobPublisher;
  runtime: AgentRuntime;
  notifications?: NotificationProvider;
  harnessIssues?: readonly string[];
  awaitIdle?: () => Promise<void>;
  finalizeBackground?: () => Promise<void>;
  cacheDecisions?: readonly CacheDecisionMeasurement[];
  historyDiagnostics?: readonly HistoryDiagnostic[];
  toolLoopDiagnostics?: readonly DiagnosticToolObservation[];
  toolCallObservations?: readonly ObservedToolCall[];
  toolLists?: readonly ObservedToolList[];
  backgroundFailures?: () => Array<{ name: string; count: number }>;
  stop: () => Promise<void>;
};
export type EvalActor = {
  botId: string;
  cookie: string;
  userId: string;
  spaceId: string;
};
export type TrialOptions = {
  pricing?: EvalPricing;
  connection: ModelConnectInput;
  timeoutMs: number;
  judge?: EvalJudge;
  maxToolCalls: number;
  replyMode?: ReplyMode;
  createApp: (
    services: EvalServices,
    messaging: MessagingTeamChatEmulator,
    witnesses: {
      notifications: CapturingNotificationProvider;
      realtime: SilenceObserver;
      now: () => Date;
    },
  ) => Promise<EvalApp>;
};
const WAITING_STATUSES = ["waiting_input", "waiting_approval", "paused"];

/** No coaching retries: scenario setup turns are intentional steps, never repair prompts. */
export async function runTrial(
  scenario: EvalCase,
  trial: number,
  options: TrialOptions,
): Promise<TrialResult> {
  const result = emptyTrial(scenario.id, trial);
  const started = Date.now();
  const deadline = started + options.timeoutMs;
  const services = new EvalServices();
  const messaging = new MessagingTeamChatEmulator({
    provider: "slack",
    capabilities: { groups: false },
  });
  scenario.configure?.(services);
  const apps = scenario.apps?.(new Date()) ?? [];
  const hostedApps: HostedApp[] = [];
  const notifications = new CapturingNotificationProvider();
  const realtime = new SilenceObserver();
  const routineRuns: RoutineEvidence[] = [];
  const peerExchanges: NonNullable<Evidence["peerExchanges"]> = [];
  let handles: EvalApp | undefined;
  // The harness observes product state outside any request or job.
  let db: EvalApp["prisma"] | undefined;
  let cookie = "";
  let botId = "";
  let peer: { id: string; name: string } | undefined;
  // A group case talks to the subject inside a group thread; every other case uses its direct chat.
  let group: { id: string; threadId: string; memberIds: Map<string, string> } | undefined;
  let seededThreadId: string | undefined;
  const seededPaths: Record<string, string> = {};
  const runIds: string[] = [];
  const runSteps = new Map<string, number>();
  const setupRunIds = new Set<string>();
  const actors: EvalActor[] = [];
  let pendingApproval: Evidence["pendingApproval"] = null;
  let approvalPending = false;
  let clarificationPending = false;
  let priorMemory = "";
  let messagingLinked = false;
  let messagingAddress = "";
  let messagingOriginThreadId: string | null = null;
  const secrets = [options.connection.apiKey ?? "", options.connection.baseUrl ?? ""];

  let phase: FailureCategory = "harness";
  const seenTools = new Map<string, { name: string }>();
  let clearedToolCount = 0;
  const seenUsage = new Map<string, LedgerCall>();
  const countCurrentTools = () =>
    db!.event.count({
      where: { spaceId: { in: actors.map((actor) => actor.spaceId) }, type: "agent.tool.called" },
    });
  // Clearing removes conversation events while the durable usage ledger remains.
  // Deduplicate observed records by id so multi-turn totals and budgets never reset.
  const captureTools = async () => {
    if (!db) return seenTools.size;
    const events = await db.event.findMany({
      where: {
        spaceId: { in: actors.map((actor) => actor.spaceId) },
        type: "agent.tool.called",
        ...(seenTools.size ? { id: { notIn: [...seenTools.keys()] } } : {}),
      },
      select: { id: true, payload: true },
    });
    for (const event of events)
      seenTools.set(event.id, {
        name: redact(String((event.payload as { name?: string }).name ?? "unknown"), secrets),
      });
    return seenTools.size;
  };
  const captureUsage = async () => {
    if (!db) return;
    const usage = await db.usageRecord.findMany({
      where: { OR: actorScopes(actors) },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    for (const row of usage)
      seenUsage.set(row.id, {
        ...row,
        modelId: row.model,
        operation:
          row.operationKind === "answer" && row.runId && setupRunIds.has(row.runId)
            ? "setup"
            : row.operationKind,
      });
  };
  try {
    for (const service of apps) {
      const hosted = await hostOverMcp(service, randomBytes(24).toString("base64url"));
      hostedApps.push(hosted);
      secrets.push(hosted.token, hosted.endpoint);
    }
    // A forced wake runs now; the agent is told it is the routine's due time instead.
    let clockShiftMs = 0;
    const now = () => new Date(Date.now() + clockShiftMs);
    handles = await options.createApp(services, messaging, { notifications, realtime, now });
    const prisma = asSystem(handles.prisma);
    db = prisma;
    realtime.attach(prisma);
    if (wakesRoutines(scenario) && handles.notifications !== notifications)
      throw new EvalFailure(
        "harness",
        "Routine wake evals require the capturing notification provider",
      );
    const trial = handles;
    const { app } = trial;
    const setupActor = async () => {
      const signup = await app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
        body: JSON.stringify({
          email: `eval-${randomUUID()}@example.test`,
          password: "synthetic-eval-password-12",
          name: "Eval User",
        }),
      });
      if (!signup.ok) throw new EvalFailure("harness", `Fixture signup failed (${signup.status})`);
      cookie = sessionCookieHeader(signup);
      await rpc(app, cookie, "models/connect", options.connection);
      // Added the way a person adds a remote MCP server: an endpoint and a bearer token.
      for (const [index, service] of apps.entries())
        await rpc(app, cookie, "mcp/servers/create", {
          transport: "streamable_http",
          slug: service.kind,
          name: service.displayName,
          endpoint: hostedApps[index]!.endpoint,
          secret: hostedApps[index]!.token,
        });
      for (const provider of scenario.connections ?? ["GMAIL", "CRM", "GITHUB"])
        await rpc(app, cookie, "connections/begin", {
          connectorId: "composio",
          provider,
          displayName: provider,
        });
      const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
        name: "Assistant",
        title: "",
        description: scenario.group?.roles?.Assistant ?? "",
        instructions: scenario.group?.instructions?.Assistant ?? "",
        notifyOnFinish: wakesRoutines(scenario),
      });
      botId = bot.id;
      const persistedBot = await prisma.bot.findUniqueOrThrow({
        where: { id: botId },
        select: { userId: true, spaceId: true },
      });
      // Register before discard so a timeout still reaches cleanupActors.
      actors.push({ botId, cookie, ...persistedBot });
      await discardBotIntroRun(trial, cookie, botId);
      await rpc(app, cookie, "bots/update", {
        botId,
        modelProvider: options.connection.provider,
        modelId: options.connection.modelId,
        replyMode: options.replyMode,
      });
      // Direct synthetic fixture state, so setup never depends on the behavior under test.
      if (scenario.botSetup)
        await prisma.bot.update({ where: { id: botId }, data: scenario.botSetup });
      if (scenario.botMemory) {
        const documents = await rpc<Array<{ id: string; path: string }>>(
          app,
          cookie,
          "memory/list",
          {
            botId,
            scope: "bot",
          },
        );
        const index = documents.find((document) => document.path === "MEMORY.md");
        if (!index) throw new EvalFailure("harness", "New bot has no MEMORY.md to seed");
        await rpc(app, cookie, "memory/update", {
          documentId: index.id,
          content: scenario.botMemory,
        });
      }
      if (scenario.peer) {
        const created = await rpc<{ id: string }>(app, cookie, "bots/create", {
          name: scenario.peer.name,
          title: "",
          description: scenario.peer.description,
          instructions: scenario.peer.instructions,
          notifyOnFinish: false,
          ...(scenario.peer.ownComputer ? { computerMode: "dedicated" } : {}),
        });
        await discardBotIntroRun(trial, cookie, created.id);
        await rpc(app, cookie, "bots/update", {
          botId: created.id,
          modelProvider: options.connection.provider,
          modelId: options.connection.modelId,
          replyMode: options.replyMode,
        });
        peer = { id: created.id, name: scenario.peer.name };
      }
      if (scenario.group) {
        // Without roles, members only author seeded history and never run a model.
        const { roles } = scenario.group;
        const memberIds = new Map<string, string>();
        for (const name of scenario.group.members) {
          const member = await rpc<{ id: string }>(app, cookie, "bots/create", {
            name,
            title: "",
            description: roles?.[name] ?? "",
            instructions: scenario.group.instructions?.[name] ?? "",
            notifyOnFinish: false,
          });
          await discardBotIntroRun(trial, cookie, member.id);
          if (roles)
            await rpc(app, cookie, "bots/update", {
              botId: member.id,
              modelProvider: options.connection.provider,
              modelId: options.connection.modelId,
            });
          memberIds.set(name, member.id);
        }
        const created = await rpc<{ id: string; threadId: string }>(app, cookie, "groups/create", {
          name: "Launch desk",
          botIds: [botId, ...memberIds.values()],
        });
        group = { ...created, memberIds };
      }
      messagingLinked = false;
      messagingAddress = `U-eval-${randomUUID()}`;
      messaging.resetWitnesses();
      // Ask mode asks before any change, so the write stops at its approval card.
      if (scenario.approvalTool) await rpc(app, cookie, "autoReview/set", { mode: "ask" });
      for (const tool of scenario.alwaysAllowTools ?? [])
        await rpc(app, cookie, "approvalRules/set", {
          effect: "always_allow",
          matchKind: "tool",
          matchValue: tool,
        });
    };
    await setupActor();
    if (scenario.computerFiles?.length) {
      // Written through the same upload path as a person's file drop, under each owner's control.
      for (const owner of [botId, peer?.id]) {
        const files = scenario.computerFiles.filter(
          (file) => (file.owner === "peer" ? peer?.id : botId) === owner,
        );
        if (!owner || !files.length) continue;
        await rpc(app, cookie, "computer/boot", { botId: owner });
        await rpc(app, cookie, "computer/takeover", { botId: owner });
        for (const file of files)
          await rpc(app, cookie, "computer/uploadFile", {
            botId: owner,
            path: file.path,
            contentBase64: Buffer.from(file.content).toString("base64"),
          });
        await rpc(app, cookie, "computer/release", { botId: owner });
      }
      if (scenario.computerFiles.some((file) => file.owner === "peer") && !peer)
        throw new EvalFailure("harness", "Peer computer files need the case's peer bot");
    }
    if (scenario.routine) {
      await rpc(app, cookie, "routines/create", {
        botId,
        name: "Release watch",
        prompt: scenario.routine.prompt,
        crons: ["0 9 * * *"],
        timezone: "UTC",
        active: true,
        notify: true,
      });
    }
    const botAuthor = (author: string | undefined) => {
      if (!author) return botId;
      const id = group?.memberIds.get(author);
      if (!id) throw new EvalFailure("harness", `History author ${author} is not a group member`);
      return id;
    };
    if (scenario.history) {
      const thread = group
        ? { id: group.threadId }
        : await prisma.thread.findUniqueOrThrow({ where: { botId }, select: { id: true } });
      seededThreadId = thread.id;
      // Attachments go through the product's upload path so their bytes are stored as uploads are.
      const files = new Map<
        number,
        { kind: "file"; artifactId: string; name: string; mimeType: string; size: number }
      >();
      for (const m of scenario.history.messages) {
        if (!m.file) continue;
        const artifact = await rpc<{ id: string; name: string; mimeType: string; size: number }>(
          app,
          cookie,
          "artifacts/create",
          {
            botId,
            name: m.file.name,
            mimeType: m.file.mimeType,
            contentBase64: Buffer.from(m.file.content).toString("base64"),
          },
        );
        seededPaths[artifact.name] = attachmentComputerPath(artifact.id, artifact.mimeType);
        files.set(m.seq, {
          kind: "file",
          artifactId: artifact.id,
          name: artifact.name,
          mimeType: artifact.mimeType,
          size: artifact.size,
        });
      }
      // A seeded step call that kept a screenshot names it `seed:screen-dark` or `seed:screen-light`;
      // the screenshot is uploaded as the product stores one, and the call refers to it.
      const screens = new Map<string, string>();
      const seededSteps = new Map<number, NonNullable<HistoryMessage["steps"]>>();
      for (const m of scenario.history.messages) {
        if (!m.steps) continue;
        const steps = [];
        for (const step of m.steps) {
          const calls = [];
          for (const call of step.calls ?? []) {
            const seed = /^seed:screen-(dark|light)$/.exec(call.image?.artifactId ?? "");
            if (!seed) {
              calls.push(call);
              continue;
            }
            if (!screens.has(seed[1]!)) {
              const artifact = await rpc<{ id: string }>(app, cookie, "artifacts/create", {
                botId,
                name: `screenshot-${seed[1]}.png`,
                mimeType: "image/png",
                contentBase64: Buffer.from(browserScreen(seed[1] === "dark")).toString("base64"),
              });
              screens.set(seed[1]!, artifact.id);
            }
            calls.push({ ...call, image: { artifactId: screens.get(seed[1]!)! } });
          }
          steps.push(step.calls ? { ...step, calls } : step);
        }
        seededSteps.set(m.seq, steps);
      }
      // Direct synthetic fixture setup, never pay a model to author filler.
      for (let offset = 0; offset < scenario.history.messages.length; offset += 500) {
        await prisma.message.createMany({
          data: scenario.history.messages.slice(offset, offset + 500).map((m) => {
            // Kept calls are stored apart from the blocks, as every product message write does.
            const { blocks, toolHistory } = splitToolHistory([
              // A reply that used tools stores its steps ahead of its text, as live replies do.
              ...(m.steps ? [{ kind: "steps", steps: seededSteps.get(m.seq) ?? m.steps }] : []),
              ...(m.text ? [{ kind: "text", text: m.text }] : []),
              ...(files.has(m.seq) ? [files.get(m.seq)!] : []),
              ...(m.subagentResult
                ? [
                    {
                      kind: "subagent",
                      agentId: "synthetic-investigation",
                      name: "Investigator",
                      task: "Investigate Aurora exports",
                      status: "completed",
                      result: m.subagentResult,
                    },
                  ]
                : []),
            ] as MessageBlock[]);
            return {
              threadId: thread.id,
              seq: m.seq,
              role: m.role,
              blocks,
              ...(toolHistory ? { toolHistory: JSON.stringify(toolHistory) } : {}),
              createdAt: m.createdAt,
              ...(m.role === "bot" ? { botId: botAuthor(m.author) } : {}),
            };
          }),
        });
      }
      if (scenario.history.messages.some((m) => m.subagentResult)) {
        const actor = actors[actors.length - 1]!;
        const source = await prisma.message.findUniqueOrThrow({
          where: { threadId_seq: { threadId: thread.id, seq: 12 } },
          select: { id: true },
        });
        const task = await prisma.task.create({
          data: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            botId,
            threadId: thread.id,
            prompt: "Synthetic prior Aurora investigation",
            status: "completed",
          },
        });
        const linkedRun = await prisma.run.create({
          data: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            botId,
            threadId: thread.id,
            taskId: task.id,
            status: "completed",
            trigger: "user",
            sourceMessageId: source.id,
            completedAt: new Date(Date.UTC(2026, 0, 1)),
          },
        });
        await prisma.message.update({
          where: { threadId_seq: { threadId: thread.id, seq: 13 } },
          data: { runId: linkedRun.id },
        });
        await prisma.artifact.create({
          data: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            botId,
            runId: linkedRun.id,
            name: "aurora-investigation.txt",
            mimeType: "text/plain",
            size: 0,
            hash: "synthetic-empty",
            storageKey: "synthetic-fixture-no-content",
          },
        });
      }
      await prisma.thread.update({
        where: { id: thread.id },
        data: {
          nextMessageSeq: scenario.history.messages.length,
          ...(scenario.history.summary
            ? {
                historyCompactedUpToSeq: scenario.history.summary.upToSeq,
                historyCompactionSummary: scenario.history.summary.text,
              }
            : {}),
        },
      });
      if (scenario.history.compact) {
        // The product's own compaction job summarizes the oldest batch, paid like any turn's.
        await trial.jobs.enqueue(historyCompactJob(thread.id, actors[actors.length - 1]!.userId));
        if (!trial.awaitIdle) throw new EvalFailure("harness", "Compaction needs an idle queue");
        await withinDeadline(trial.awaitIdle(), deadline);
        const { historyCompactedUpToSeq } = await prisma.thread.findUniqueOrThrow({
          where: { id: thread.id },
          select: { historyCompactedUpToSeq: true },
        });
        if (historyCompactedUpToSeq === null)
          throw new EvalFailure(
            "harness",
            "Seeded history was not compacted; only the current context strategy compacts",
          );
      }
    }
    if (scenario.taughtSkill) {
      // Human-authored fixture setup via the same API as the teaching UI; no model work is prefilled.
      await rpc(app, cookie, "computer/boot", { botId });
      await rpc(app, cookie, "computer/takeover", { botId });
      const skill = await rpc<{ id: string }>(app, cookie, "skills/start", {
        botId,
        goal: "Dispatch label",
      });
      await rpc(app, cookie, "computer/input", { botId, kind: "key", payload: { key: "x" } });
      await rpc(app, cookie, "skills/stop", { skillId: skill.id });
      await rpc(app, cookie, "skills/updateDraft", {
        skillId: skill.id,
        name: "Dispatch label",
        playbook: {
          whenToUse: "When asked to run Dispatch label for a city and item count.",
          inputs: ["city", "item count"],
          steps: [
            "Convert city to uppercase and item count to digits.",
            "Write results/dispatch.txt in your home, containing CITY | COUNT | PACKED with the actual values. For example PARIS | 2 | PACKED.",
          ],
          howToCheck: "Read the file and verify the city, count and PACKED marker.",
          whatToReturn: "The saved file path.",
          approvalBoundaries: "No connected-app writes are part of this workflow.",
          failureHandling: "Report a missing input; do not invent it.",
        },
      });
      await rpc(app, cookie, "skills/save", { skillId: skill.id, name: "Dispatch label" });
    }
    phase = "product";
    let lastText = "";
    const replies: string[] = [];
    let unaddressedMessageId: string | null = null;
    let memberReplies: Record<string, string> | undefined;
    const settingsSnapshot = async (): Promise<SettingsSnapshot> => {
      const bot = await prisma.bot.findUniqueOrThrow({
        where: { id: botId },
        select: {
          userId: true,
          name: true,
          description: true,
          instructions: true,
          color: true,
          notifyOnFinish: true,
          autoSpeak: true,
          voiceId: true,
          modelProvider: true,
          modelId: true,
          thinkingLevel: true,
          memoryScope: true,
        },
      });
      const { userId, ...botSettings } = bot;
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { email: true, name: true, timezone: true, marketingEmailOptOutAt: true },
      });
      const { marketingEmailOptOutAt, ...userSettings } = user;
      return {
        bot: botSettings,
        user: { ...userSettings, marketingEmailOptOut: marketingEmailOptOutAt !== null },
      };
    };
    let settingsBefore = EMPTY_SETTINGS;
    for (const [stepIndex, step] of scenario.steps.entries()) {
      // Each step waits for its run to finish, so a wake's shifted clock ends with its step.
      clockShiftMs = 0;
      if (Date.now() >= deadline) throw new EvalFailure("incomplete", "Trial time budget exceeded");
      if (stepIndex === scenario.steps.length - 1) settingsBefore = await settingsSnapshot();
      if ("newWorkspace" in step) {
        priorMemory = (await rpc<Array<{ content: string }>>(app, cookie, "memory/list", { botId }))
          .map((m) => m.content)
          .join("\n");
        await setupActor();
        continue;
      }
      if ("clear" in step) {
        await Promise.all([captureTools(), captureUsage()]);
        await rpc(app, cookie, "threads/clear", { botId });
        clearedToolCount = seenTools.size - (await countCurrentTools());
        continue;
      }
      if (scenario.routine || "wakeRoutine" in step)
        await rpc(app, cookie, "threads/markRead", { botId });
      const notificationOffset = notifications.sent.length;
      let runId: string;
      let scheduled: RoutineEvidence["scheduled"];
      if ("ask" in step) {
        const sent = await rpc<{ runId: string }>(
          app,
          cookie,
          "threads/send",
          group
            ? {
                groupId: group.id,
                text: step.ask,
                ...(step.unaddressed ? {} : { mentions: [{ kind: "bot", id: botId }] }),
              }
            : { botId, text: step.ask },
        );
        runId = sent.runId;
        if (step.unaddressed && group)
          ({ sourceMessageId: unaddressedMessageId } = await prisma.run.findUniqueOrThrow({
            where: { id: runId },
            select: { sourceMessageId: true },
          }));
      } else if ("fromPeer" in step) {
        if (!peer) throw new EvalFailure("harness", "A fromPeer step needs the case's peer bot");
        await deliverPeerMessage(
          prisma,
          handles.jobs,
          peer,
          botId,
          step.fromPeer.replaceAll("{peerHome}", `bots/${peer.id}`),
        );
        runId = await poll(
          async () =>
            (
              await prisma.run.findFirst({
                where: { botId, trigger: "bot_message", id: { notIn: runIds } },
                orderBy: { createdAt: "desc" },
                select: { id: true },
              })
            )?.id,
          deadline,
        );
      } else if ("slack" in step) {
        if (!messagingLinked) {
          const link = await rpc<{ code: string }>(app, cookie, "messaging/link/start", { botId });
          await messaging.emitInbound({
            isDirect: true,
            from: messagingAddress,
            fromLabel: "Teammate",
            content: link.code,
          });
          await poll(async () => (messaging.sent.length > 0 ? true : undefined), deadline);
          messaging.resetWitnesses();
          messagingLinked = true;
        }
        const inbound = await messaging.emitInbound({
          isDirect: true,
          from: messagingAddress,
          fromLabel: "Teammate",
          content: step.slack,
        });
        messagingOriginThreadId = inbound.threadId;
        runId = await poll(
          async () =>
            (
              await prisma.run.findFirst({
                where: {
                  botId,
                  sourceMessage: {
                    is: {
                      clientNonce: `messaging:${inbound.provider}:${inbound.handle}`,
                    },
                  },
                },
                orderBy: { createdAt: "desc" },
                select: { id: true },
              })
            )?.id,
          deadline,
        );
      } else {
        const routines = await prisma.routine.findMany({ where: { botId } });
        // A follow-up the bot cancelled once its loop closed has nothing left to wake.
        if (step.ifScheduled && !routines.some((routine) => routine.active)) continue;
        if (routines.length !== 1)
          throw new EvalFailure("agent", "Expected exactly one authored routine");
        const routine = routines[0]!;
        if (!routine.active || !routine.crons.length)
          throw new EvalFailure("agent", "Authored routine was not scheduled");
        // Force the scheduler's clock edge, not the agent's work. Attribution starts after setup.
        services.calls.length = 0;
        if (step.releases === "empty") services.seedGithubReleases([]);
        if (step.releases === undefined || step.releases === "new")
          services.seedGithubReleases([
            {
              owner: "example",
              repo: "widget",
              tag: "v2.2.0",
              name: "Widget 2.2",
              body: "Adds CSV import validation.",
              publishedAt: "2026-01-03T09:00:00Z",
              htmlUrl: "https://example.test/widget/releases/v2.2.0",
            },
            ...services.listGithubReleases(),
          ]);
        scheduled = {
          at: routine.nextRunAt?.toISOString() ?? null,
          timezone: routine.timezone,
          createdAt: routine.createdAt.toISOString(),
        };
        if (routine.nextRunAt) clockShiftMs = Math.max(0, routine.nextRunAt.getTime() - Date.now());
        const scheduledFor = new Date(Date.now() - 1_000);
        await prisma.routine.update({
          where: { id: routine.id },
          data: { nextRunAt: scheduledFor },
        });
        await handles.jobs.enqueue({
          name: "routine.wakeup",
          payload: { routineId: routine.id, scheduledFor: scheduledFor.toISOString() },
        });
        runId = await poll(
          async () =>
            (
              await prisma.run.findFirst({
                where: { botId, routineId: routine.id, id: { notIn: runIds } },
                orderBy: { createdAt: "desc" },
              })
            )?.id,
          deadline,
        );
      }
      runIds.push(runId);
      runSteps.set(runId, stepIndex + 1);
      // Every reply to a peer is graded, so it is never setup.
      if (
        !("fromPeer" in step) &&
        scenario.steps
          .slice(stepIndex + 1)
          .some(
            (next) =>
              "ask" in next || "slack" in next || "wakeRoutine" in next || "fromPeer" in next,
          )
      )
        setupRunIds.add(runId);
      const requestStarted = (
        await prisma.run.findUniqueOrThrow({ where: { id: runId }, select: { createdAt: true } })
      ).createdAt.getTime();
      let seenToolCount = result.toolCalls;
      const terminal = await poll(async () => {
        const [run, toolCount] = await Promise.all([
          prisma.run.findUnique({ where: { id: runId }, select: { status: true, error: true } }),
          countCurrentTools().then((count) => count + clearedToolCount),
        ]);
        seenToolCount = toolCount;
        if (result.firstResponseMs === null) {
          const visible = await prisma.event.findFirst({
            where: {
              runId,
              type: "thread.progress",
              payload: { path: ["streaming"], equals: true },
            },
            orderBy: { seq: "asc" },
            select: { createdAt: true },
          });
          if (visible)
            result.firstResponseMs = Math.max(0, visible.createdAt.getTime() - requestStarted);
        }
        if (toolCount > options.maxToolCalls)
          throw new EvalFailure("incomplete", "Tool call budget exceeded");
        if (
          run?.status === "waiting_input" &&
          (scenario.approvalTool || scenario.expectedClarification)
        )
          return run;
        const waiting = run && WAITING_STATUSES.includes(run.status);
        if (waiting && scenario.pauseEndsTurn) return run;
        if (waiting)
          throw new EvalFailure("agent", "Agent requested assistance; no coaching supplied");
        return run && isTerminal(run.status as RunStatus) ? run : undefined;
      }, deadline);
      if (result.firstResponseMs === null) {
        const firstMessage = await prisma.message.findFirst({
          where: { runId, role: "bot" },
          orderBy: { seq: "asc" },
          select: { createdAt: true },
        });
        if (firstMessage)
          result.firstResponseMs = Math.max(0, firstMessage.createdAt.getTime() - requestStarted);
      }
      const events = await prisma.event.findMany({
        where: { runId, type: "agent.tool.called" },
        orderBy: { seq: "asc" },
      });
      result.toolCalls = seenToolCount;
      result.trace.push({
        step: stepIndex + 1,
        status: terminal.status,
        tools: events.map((e) =>
          redact(String((e.payload as { name?: string }).name ?? "unknown"), secrets),
        ),
      });
      if (
        terminal.status !== "completed" &&
        !(scenario.pauseEndsTurn && WAITING_STATUSES.includes(terminal.status)) &&
        !(
          (scenario.approvalTool || scenario.expectedClarification) &&
          terminal.status === "waiting_input"
        )
      ) {
        // Provider attribution requires recognizable protocol/auth evidence; unknown runtime failures remain product failures.
        const error = terminal.error ?? "Run did not complete";
        const category =
          /\b(?:401|402|403|429)\b|rate.?limit|invalid api.?key|authentication.*(?:failed|error)/i.test(
            error,
          )
            ? "provider"
            : "product";
        throw new EvalFailure(category, error);
      }
      if ("slack" in step && terminal.status === "completed") {
        await waitForMessagingDelivery(prisma, runId, deadline);
      }
      // Completion is committed before notification delivery and before the reply returns to a
      // peer. Drain the executor before observing.
      if ((wakesRoutines(scenario) || "fromPeer" in step) && handles.awaitIdle)
        await withinDeadline(handles.awaitIdle(), deadline);
      const snap = await rpc<{
        messages: Array<{
          role: string;
          runId?: string | null;
          blocks: ClarificationBlock[];
        }>;
      }>(app, cookie, "threads/get", group ? { groupId: group.id } : { botId });
      approvalPending =
        terminal.status === "waiting_input" &&
        snap.messages.some((m) =>
          m.blocks.some((b) => b.kind === "ask" && typeof b.approvalEffectId === "string"),
        );
      pendingApproval = approvalPending
        ? await prisma.externalEffect.findFirst({
            where: {
              runId,
              status: "intended",
              id: {
                in: snap.messages.flatMap((m) =>
                  m.blocks.flatMap((b) => (b.approvalEffectId ? [b.approvalEffectId] : [])),
                ),
              },
            },
            select: { kind: true, request: true },
          })
        : null;
      lastText = snap.messages
        .filter((m) => m.role === "bot" && m.runId === runId)
        .flatMap((m) => m.blocks.filter((b) => b.kind === "text").map((b) => b.text ?? ""))
        .join("\n");
      if (scenario.expectedClarification && terminal.status === "waiting_input") {
        const clarification = expectedClarificationText(
          true,
          terminal.status,
          events.map((event) => String((event.payload as { name?: string }).name ?? "")),
          snap.messages
            .filter((message) => message.runId === runId && message.role === "bot")
            .flatMap((message) => message.blocks),
        );
        if (clarification === null)
          throw new EvalFailure(
            "agent",
            "Expected clarification did not contain a valid pending ask_user choice",
          );
        clarificationPending = true;
        lastText = [lastText, clarification].filter(Boolean).join("\n");
      }
      replies.push(lastText);
      if (unaddressedMessageId && group) {
        // Handoffs start more runs after the first one ends; wait until every member is done.
        const memberBotIds = [botId, ...group.memberIds.values()];
        // The trial budget spans every member's work, not only the first run's turn, and the
        // drain below runs that work, so it keeps checking while the drain is in flight.
        const assertToolBudget = async () => {
          if ((await countCurrentTools()) + clearedToolCount > options.maxToolCalls)
            throw new EvalFailure("incomplete", "Tool call budget exceeded");
        };
        const settled = await poll(async () => {
          await assertToolBudget();
          if (handles?.awaitIdle) {
            const drained = withinDeadline(handles.awaitIdle(), deadline);
            // A budget failure abandons the drain; its own timeout must not crash the trial.
            drained.catch(() => undefined);
            while (
              !(await Promise.race([
                drained.then(() => true),
                new Promise((resolve) => setTimeout(() => resolve(false), 200)),
              ]))
            )
              await assertToolBudget();
            // Work that ended between two checks still counts before grading and the judge.
            await assertToolBudget();
          }
          const runs = await prisma.run.findMany({
            where: { botId: { in: memberBotIds }, createdAt: { gte: new Date(requestStarted) } },
            select: { status: true, error: true },
          });
          return runs.every(
            (run) => isTerminal(run.status as RunStatus) || WAITING_STATUSES.includes(run.status),
          )
            ? runs
            : undefined;
        }, deadline);
        const failed = settled.find(
          (run) => run.status !== "completed" && !WAITING_STATUSES.includes(run.status),
        );
        if (failed)
          throw new EvalFailure("product", failed.error ?? "A member run did not complete");
        const { seq } = await prisma.message.findUniqueOrThrow({
          where: { id: unaddressedMessageId },
          select: { seq: true },
        });
        unaddressedMessageId = null;
        const after = await rpc<{
          messages: Array<{
            role: string;
            seq: number;
            botId?: string | null;
            blocks: ClarificationBlock[];
          }>;
        }>(app, cookie, "threads/get", { groupId: group.id });
        const names = new Map([...group.memberIds].map(([name, id]) => [id, name]));
        names.set(botId, "Assistant");
        memberReplies = Object.fromEntries([...names.values()].map((name) => [name, ""]));
        for (const message of after.messages) {
          if (message.role !== "bot" || message.seq <= seq || !message.botId) continue;
          const name = names.get(message.botId) ?? message.botId;
          // A handoff card is a post too, so a detour through another member shows in the count.
          const text = message.blocks
            .flatMap((b) =>
              b.kind === "text" || b.kind === "ask"
                ? [b.text ?? ""]
                : b.kind === "handoff"
                  ? ["(handoff)"]
                  : [],
            )
            .join("\n");
          memberReplies[name] = [memberReplies[name], text].filter(Boolean).join("\n");
        }
      }
      if ("fromPeer" in step) {
        const returned = (
          await prisma.message.findMany({
            where: { runId, role: "bot" },
            orderBy: { seq: "asc" },
            select: { blocks: true },
          })
        ).flatMap((message) =>
          (message.blocks as MessageBlock[]).flatMap((block) =>
            block.kind === "bot_message_sent" && block.toBotId === peer?.id ? [block.text] : [],
          ),
        );
        peerExchanges.push({
          message: step.fromPeer,
          reply: returned.length ? returned.join("\n") : null,
        });
      }
      if ("wakeRoutine" in step) {
        const messages = await prisma.message.findMany({
          where: { runId, role: "bot" },
          select: { blocks: true },
        });
        const observed = realtime.events.filter((event) => event.runId === runId);
        routineRuns.push({
          text: lastText,
          unread: Boolean(
            await prisma.threadRead.findFirst({
              where: { thread: { botId }, unread: true },
              select: { userId: true },
            }),
          ),
          messages: messages.map((m) => m.blocks as RoutineEvidence["messages"][number]),
          progress: observed
            .filter((event) => event.type === "thread.progress")
            .map((event) => event.payload),
          notifications: structuredClone(notifications.sent.slice(notificationOffset)),
          calls: structuredClone(services.calls),
          observedCompletion:
            !realtime.failed && observed.some((event) => event.type === "run.completed"),
          scheduled,
        });
      }
      if (/Eval spend cap|stopped scheduling inference|no configured pricing/i.test(lastText))
        throw new EvalFailure("incomplete", lastText);
      // Provider failures end the run as failed (classified above); a reply can only carry
      // the product's own fixed notices, never a bare status code from an explanation.
      if (/unknown model|invalid api.?key|authentication.*(?:failed|error)/i.test(lastText))
        throw new EvalFailure("provider", lastText);
    }
    const files: Evidence["files"] = {};
    for (const path of scenario.files ?? []) {
      try {
        files[path] = (
          await rpc<{ content: string }>(handles.app, cookie, "computer/readFile", { botId, path })
        ).content;
      } catch {
        files[path] = null;
      }
    }
    const seededAttachments: NonNullable<Evidence["seededAttachments"]> = {};
    for (const [name, path] of Object.entries(seededPaths)) {
      const content = await rpc<{ content: string }>(handles.app, cookie, "computer/readFile", {
        botId,
        path,
      }).then(
        (file) => file.content,
        () => null,
      );
      seededAttachments[name] = { path, content };
    }
    const memories = await rpc<Array<{ content: string }>>(handles.app, cookie, "memory/list", {
      botId,
    });
    const routines = await prisma.routine.findMany({
      where: { botId },
      select: { name: true, prompt: true, crons: true, active: true },
    });
    // schedule_cancel deletes the routine, but its creation event stays in the thread. The event
    // append is best-effort, so a routine that still exists counts even without one.
    const routinesCreated = Math.max(
      routines.length,
      await prisma.event.count({ where: { botId, type: "routine.created" } }),
    );
    const deliveries = await deliveredBySubject(prisma, botId, [
      ...(peer
        ? [
            (await prisma.thread.findUnique({ where: { botId: peer.id }, select: { id: true } }))
              ?.id,
          ]
        : []),
      group?.threadId,
    ]);
    await captureTools();
    const finalStep = scenario.steps.length;
    const historySummary =
      scenario.history?.compact && seededThreadId
        ? (
            await prisma.thread.findUnique({
              where: { id: seededThreadId },
              select: { historyCompactionSummary: true },
            })
          )?.historyCompactionSummary
        : undefined;
    const evidence: Evidence = {
      text: lastText,
      ...(historySummary ? { historySummary } : {}),
      replies,
      memberReplies,
      routineRuns,
      peerExchanges,
      ...(deliveries.length ? { deliveries } : {}),
      ...(peer ? { peerHome: `bots/${peer.id}` } : {}),
      files,
      ...(Object.keys(seededAttachments).length ? { seededAttachments } : {}),
      records: services.records,
      notes: services.notes,
      calls: services.calls,
      apps: Object.fromEntries(apps.map((service) => [service.kind, service])),
      routines,
      routinesCreated,
      memory: memories.map((m) => m.content).join("\n"),
      approvalPending,
      clarificationPending,
      pendingApproval,
      priorMemory,
      toolNames: [...seenTools.values()].map((event) => event.name),
      toolCalls: (handles.toolCallObservations ?? []).flatMap((call) => {
        const step = runSteps.get(call.runId);
        const { runId: _runId, ...observed } = call;
        return step === undefined ? [] : [{ step, ...observed }];
      }),
      finalStep,
      settings: await settingsSnapshot(),
      settingsBefore,
      messaging: {
        originThreadId: messagingOriginThreadId,
        outbound: structuredClone(messaging.sent),
      },
    };
    phase = "harness";
    result.criteria = scenario.grade(evidence);
    result.artifacts = Object.fromEntries(
      Object.entries({
        ...files,
        "final-response": lastText,
        ...(scenario.history && replies.length > 1
          ? Object.fromEntries(replies.map((reply, index) => [`turn-${index + 1}-response`, reply]))
          : {}),
        ...(routineRuns.length ? { "routine-observations": JSON.stringify(routineRuns) } : {}),
        ...(peerExchanges.length ? { "peer-exchanges": JSON.stringify(peerExchanges) } : {}),
        ...(memberReplies ? { "member-replies": JSON.stringify(memberReplies) } : {}),
        ...(evidence.toolCalls.length ? { "tool-calls": JSON.stringify(evidence.toolCalls) } : {}),
        ...(apps.length
          ? {
              "app-calls": JSON.stringify(
                Object.fromEntries(apps.map((service) => [service.kind, service.calls])),
              ),
              "app-writes": JSON.stringify(
                Object.fromEntries(apps.map((service) => [service.kind, service.writes])),
              ),
            }
          : {}),
        "memory-snapshot": evidence.memory,
      }).map(([key, value]) => [key, value === null ? null : redact(value, secrets)]),
    );
    // Kept so a new rubric can grade the trial again without running the bot.
    if (scenario.judge || scenario.observe) result.evidence = evidenceSnapshot(evidence, secrets);
    const grading = { judge: options.judge, deadline, secrets };
    await judgeOutcome(scenario, evidence, result, grading);
    if (handles.harnessIssues?.length) result.harnessIssues = [...handles.harnessIssues];
    settle(scenario, result, handles.harnessIssues ?? []);
    const observations = await observe(scenario, evidence, grading);
    if (observations) result.observations = observations;
  } catch (error) {
    result.status = "failed";
    result.category = error instanceof EvalFailure ? error.category : phase;
    result.reason = redact(
      error instanceof Error ? error.message : "Unknown eval failure",
      secrets,
    );
  } finally {
    if (!handles) await Promise.all(hostedApps.map((hosted) => hosted.close()));
    if (handles) {
      try {
        // Stopping each bot covers only its own chat; a member's run can still wait in the
        // group. Stop it before draining, so a failed trial does not pay for the member's
        // remaining work while the drain waits for it; when the trial ended cleanly every
        // member is already terminal and the stop changes nothing.
        if (group) await rpc(handles.app, cookie, "threads/stop", { groupId: group.id });
      } catch {
        result.cleanupFailed = true;
      }
      try {
        if (handles.awaitIdle) await withinDeadline(handles.awaitIdle(), deadline);
      } catch {
        result.cleanupFailed = true;
      }
      try {
        await cleanupActors(handles, actors);
      } catch {
        result.cleanupFailed = true;
      }
      // After the trial's work stopped, so no run is cut off mid-call.
      await Promise.all(hostedApps.map((hosted) => hosted.close()));
      try {
        await handles.finalizeBackground?.();
      } catch {
        result.cleanupFailed = true;
      }
      try {
        if (seededThreadId) {
          const state = await db!.thread.findUnique({
            where: { id: seededThreadId },
            select: {
              historyCompactedUpToSeq: true,
              historyCompactionSummary: true,
              historyCompactionGeneration: true,
            },
          });
          if (state)
            result.historyPreparationState = {
              beforeCursor: scenario.history?.summary?.upToSeq ?? null,
              afterCursor: state.historyCompactedUpToSeq,
              remainingMessages: await db!.message.count({
                where: {
                  threadId: seededThreadId,
                  ...(state.historyCompactedUpToSeq !== null
                    ? { seq: { gt: state.historyCompactedUpToSeq } }
                    : {}),
                },
              }),
              summaryPresent: !!state.historyCompactionSummary?.trim(),
              ...(scenario.history?.compact
                ? { summary: redact(state.historyCompactionSummary ?? "", secrets) || null }
                : {}),
              generation: state.historyCompactionGeneration,
            };
        }
        result.backgroundFailures = Object.fromEntries(
          (handles.backgroundFailures?.() ?? []).map(({ name, count }) => [name, count]),
        );
      } catch {
        result.cleanupFailed = true;
      }
      await captureUsage().catch(() => {
        result.cleanupFailed = true;
      });
      // Explicit pricing covers the eval model only; other models the product called
      // during the trial are priced at their own reported or catalog-estimated charge.
      const pricedModel = options.connection.modelId
        ? { provider: options.connection.provider, modelId: options.connection.modelId }
        : undefined;
      Object.assign(
        result,
        measureCalls(
          [...seenUsage.values()],
          options.pricing,
          options.connection.cacheCapabilities?.minimumTokens,
          pricedModel,
        ),
      );
      result.stepAccounting = measureWorkflowSteps(
        [...seenUsage.values()],
        runSteps,
        options.pricing,
        options.connection.cacheCapabilities?.minimumTokens,
        pricedModel,
      );
      result.cacheDecisions = handles.cacheDecisions ? [...handles.cacheDecisions] : [];
      result.historyDiagnostics = handles.historyDiagnostics ? [...handles.historyDiagnostics] : [];
      result.toolLoopDiagnostics = handles.toolLoopDiagnostics
        ? [...handles.toolLoopDiagnostics]
        : [];
      const lists = handles.toolLists ?? [];
      if (lists.length) {
        const { count, bytes } = lists.reduce((largest, list) =>
          list.bytes > largest.bytes ? list : largest,
        );
        result.offeredTools = { count, bytes };
      }
      // Include interrupted and cleared-run calls without retaining raw arguments or ids in reports.
      await captureTools().catch(() => undefined);
      const events = [...seenTools.values()];
      result.toolCalls = events.length;
      if (events.length > options.maxToolCalls) {
        result.status = "failed";
        result.category = "incomplete";
        result.reason = "Tool call budget exceeded";
      }
      if (!result.trace.length && events.length)
        result.trace.push({
          step: 0,
          status: "interrupted",
          tools: events.map((event) => event.name),
        });
    }
    try {
      await handles?.stop();
    } catch {
      result.cleanupFailed = true;
    }
    if (result.cleanupFailed) {
      result.status = "failed";
      result.category = "harness";
      result.reason = "Fixture cleanup failed; remaining trials must not start";
    }
    result.latencyMs = Date.now() - started;
  }
  return result;
}

async function rpc<T>(app: App, cookie: string, proc: string, body: unknown = {}): Promise<T> {
  const res = await app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ json: body }),
    signal: AbortSignal.timeout(15_000),
  });
  const parsed = (await res.json()) as { json?: T; error?: unknown };
  if (!res.ok || parsed.error) throw new Error(`${proc} failed (${res.status})`);
  return parsed.json as T;
}

/**
 * Speak as the peer through message_bot's own delivery, so the subject wakes exactly as it
 * would from a teammate. The peer's turn is fixture setup: no model is paid to write its words.
 */
async function deliverPeerMessage(
  prisma: EvalApp["prisma"],
  jobs: JobPublisher,
  peer: { id: string; name: string },
  targetBotId: string,
  text: string,
) {
  const { spaceId, userId, thread } = await prisma.bot.findUniqueOrThrow({
    where: { id: peer.id },
    select: { spaceId: true, userId: true, thread: { select: { id: true } } },
  });
  if (!thread) throw new EvalFailure("harness", "Peer bot has no chat");
  const task = await prisma.task.create({
    data: {
      spaceId,
      userId,
      botId: peer.id,
      threadId: thread.id,
      prompt: "Synthetic peer turn",
      status: "completed",
    },
  });
  const run = await prisma.run.create({
    data: {
      spaceId,
      userId,
      botId: peer.id,
      threadId: thread.id,
      taskId: task.id,
      status: "completed",
      trigger: "user",
      completedAt: new Date(),
    },
  });
  const sent = await messageBot(
    { prisma, events: createThreadEvents(prisma), jobs },
    { id: run.id, spaceId, threadId: thread.id, botId: peer.id, userId },
    peer,
    { bot_id: targetBotId, message: text, intent: "request" },
    { allowTerminalSource: true },
  );
  if (!sent.ok) throw new EvalFailure("harness", `Peer message was not delivered: ${sent.error}`);
}

/** Messages and handoffs the subject delivered into these threads, read from what was stored. */
async function deliveredBySubject(
  prisma: EvalApp["prisma"],
  botId: string,
  threadIds: Array<string | undefined>,
): Promise<NonNullable<Evidence["deliveries"]>> {
  const ids = threadIds.filter((id): id is string => Boolean(id));
  if (!ids.length) return [];
  const messages = await prisma.message.findMany({
    where: { threadId: { in: ids } },
    select: { blocks: true },
    orderBy: { seq: "asc" },
  });
  return messages.flatMap((message) => {
    const blocks = message.blocks as MessageBlock[];
    const sent = blocks.find(
      (block) =>
        (block.kind === "bot_message_received" || block.kind === "handoff") &&
        block.fromBotId === botId,
    );
    if (!sent || (sent.kind !== "bot_message_received" && sent.kind !== "handoff")) return [];
    return [
      {
        kind: sent.kind === "handoff" ? ("handoff" as const) : ("message" as const),
        text: sent.text,
        files: blocks.flatMap((block) =>
          (block.kind === "file" || block.kind === "image") && block.name ? [block.name] : [],
        ),
      },
    ];
  });
}

async function poll<T>(read: () => Promise<T | undefined>, deadline: number): Promise<T> {
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new EvalFailure("incomplete", "Trial time budget exceeded");
}

async function waitForMessagingDelivery(
  prisma: EvalApp["prisma"],
  runId: string,
  deadline: number,
): Promise<void> {
  await poll(
    async () =>
      (
        await prisma.run.findUnique({
          where: { id: runId },
          select: { messagingMirroredAt: true },
        })
      )?.messagingMirroredAt ?? undefined,
    deadline,
  );
  const messages = await prisma.message.findMany({
    where: { runId, role: "bot" },
    select: { id: true },
  });
  await poll(async () => {
    const outbound = await prisma.messagingOutbound.findMany({
      where: { sourceMessageId: { in: messages.map((message) => message.id) } },
      select: { status: true, providerHandle: true },
    });
    return outbound.length > 0 &&
      outbound.every((row) => row.providerHandle !== null || row.status === "failed")
      ? true
      : undefined;
  }, deadline);
}

function actorScopes(actors: readonly EvalActor[]) {
  return actors.map(({ userId, spaceId }) => ({ userId, spaceId }));
}

async function findScopeBots(
  prisma: EvalApp["prisma"],
  actors: readonly EvalActor[],
): Promise<Array<{ id: string; userId: string; spaceId: string }>> {
  if (!actors.length) return [];
  return prisma.bot.findMany({
    where: { OR: actorScopes(actors) },
    select: { id: true, userId: true, spaceId: true },
  });
}

function cookieForBot(bot: { userId: string; spaceId: string }, actors: readonly EvalActor[]) {
  return actors.find((actor) => actor.userId === bot.userId && actor.spaceId === bot.spaceId)
    ?.cookie;
}

/** Disable scheduled work and stop every run in each isolated actor scope. */
export async function cleanupActors(
  handles: Pick<EvalApp, "app" | "prisma" | "jobs" | "runtime">,
  actors: readonly EvalActor[],
): Promise<void> {
  if (!actors.length) return;
  const prisma = asSystem(handles.prisma);
  const failures: unknown[] = [];
  const scopes = actorScopes(actors);
  let stable = false;

  // A parent can finish spawning a child while its abort is settling. Repeat until
  // every bot and run visible after abort was included in the pass.
  for (let pass = 0; pass < 8; pass++) {
    let bots: Array<{ id: string; userId: string; spaceId: string }> = actors.map((actor) => ({
      id: actor.botId,
      userId: actor.userId,
      spaceId: actor.spaceId,
    }));
    let runsBeforeStop: Array<{ id: string }> = [];
    try {
      await prisma.routine.updateMany({
        where: { OR: scopes },
        data: { active: false, nextRunAt: null },
      });
    } catch (error) {
      failures.push(error);
    }

    try {
      bots = await findScopeBots(prisma, actors);
    } catch (error) {
      failures.push(error);
    }
    try {
      runsBeforeStop = await prisma.run.findMany({
        where: { OR: scopes },
        select: { id: true },
      });
    } catch (error) {
      failures.push(error);
    }

    for (const bot of bots) {
      const actorCookie = cookieForBot(bot, actors);
      if (!actorCookie) {
        failures.push(new Error("No actor session for scoped bot"));
        continue;
      }
      try {
        await rpc(handles.app, actorCookie, "threads/stop", { botId: bot.id });
      } catch (error) {
        failures.push(error);
      }
    }

    let runsAfterStop: Array<{ id: string }> = [];
    try {
      runsAfterStop = await prisma.run.findMany({
        where: { OR: scopes },
        select: { id: true },
      });
    } catch (error) {
      failures.push(error);
    }
    const handledRunIds = new Set([...runsBeforeStop, ...runsAfterStop].map((run) => run.id));
    for (const runId of handledRunIds) {
      try {
        await handles.jobs.cancel(runJobKey(runId));
      } catch (error) {
        failures.push(error);
      }
    }
    for (const runId of handledRunIds) {
      try {
        await handles.runtime.abort(runId);
      } catch (error) {
        failures.push(error);
      }
    }

    let botsAfter: Array<{ id: string; userId: string; spaceId: string }> | undefined;
    let runsAfter: Array<{ id: string; status: string }> | undefined;
    let activeRoutineCount: number | undefined;
    try {
      await prisma.routine.updateMany({
        where: { OR: scopes },
        data: { active: false, nextRunAt: null },
      });
      [botsAfter, runsAfter, activeRoutineCount] = await Promise.all([
        findScopeBots(prisma, actors),
        prisma.run.findMany({
          where: { OR: scopes },
          select: { id: true, status: true },
        }),
        prisma.routine.count({ where: { OR: scopes, active: true } }),
      ]);
    } catch (error) {
      failures.push(error);
    }

    if (
      botsAfter &&
      runsAfter &&
      activeRoutineCount === 0 &&
      botsAfter.every((bot) => bots.some((stopped) => stopped.id === bot.id)) &&
      runsAfter.every(
        (run) =>
          handledRunIds.has(run.id) &&
          !(ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status),
      )
    ) {
      stable = true;
      break;
    }
  }
  if (!stable) failures.push(new Error("Trial scope did not become idle"));
  if (failures.length) throw new Error("Trial work could not be stopped", { cause: failures });
}
