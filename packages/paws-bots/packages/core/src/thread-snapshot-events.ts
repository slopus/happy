import type { Run, RunStatus, RunTrigger, ThreadMessage } from "@rakazo/contracts";
import { RUN_TRIGGERS } from "@rakazo/contracts";
import {
  isRunTerminalEvent,
  progressMessageId,
  reduceLiveMessageBlocks,
  runFailureError,
  settleRunSubagents,
  stopsRunHelpers,
  subagentBlockFromPayload,
} from "./events.js";
import { mergeThreadHistory, upsertMessageById } from "./message-pages.js";
import { payloadAuthor, replyMetadata } from "./message-replies.js";
import { isActive, isBackgroundRunTrigger, QUEUE_HOLDING_RUN_STATUSES } from "./run-state.js";
import { takeLiveMessage, updateCloudAgentMessages } from "./thread-message-updates.js";

/** A thread event as a client receives it from the live stream. */
export type ThreadSnapshotEvent = {
  type: string;
  id?: string;
  seq?: number;
  threadId?: string;
  botId?: string;
  runId?: string;
  createdAt?: string;
  payload?: Record<string, unknown>;
};

/** A run as live events report it; a refresh brings the full record. */
export type LiveThreadRun = Pick<Run, "id"> &
  Partial<Omit<Run, "id" | "status">> & { status: string };

/**
 * A message as a thread holds it between refreshes. Rows built from live events (progress, tool
 * steps, subagents) have no message seq: the event's seq counts thread events, not messages.
 */
export type LiveThreadMessage = Omit<ThreadMessage, "threadId" | "seq" | "createdAt"> &
  Partial<Pick<ThreadMessage, "threadId" | "seq" | "createdAt">>;

/** The parts of a thread snapshot that live events patch; each app's snapshot extends it. */
export type LiveThreadSnapshot = {
  threadId: string;
  groupId?: string;
  botId?: string;
  cursor?: number;
  olderCursor: number | null;
  messages: LiveThreadMessage[];
  run: LiveThreadRun | null;
  activeRuns?: LiveThreadRun[];
  members?: { botId: string; status?: string }[];
};

const runTriggers = new Set<string>(RUN_TRIGGERS);

export function activeThreadRuns<R extends LiveThreadRun>(
  snapshot: { run: R | null; activeRuns?: R[] } | null,
): R[] {
  return snapshot?.activeRuns ?? (snapshot?.run ? [snapshot.run] : []);
}

export function isThreadSnapshotEvent(event: { type: string }): boolean {
  return (
    event.type === "thread.cleared" ||
    event.type === "thread.progress" ||
    event.type === "thread.subagent" ||
    event.type === "thread.cloud_agent" ||
    event.type === "agent.tool.called" ||
    event.type === "agent.tool.completed" ||
    event.type === "thread.message.created" ||
    event.type === "thread.message.updated" ||
    event.type === "thread.message.reaction" ||
    event.type === "run.started" ||
    event.type === "run.waiting_input" ||
    event.type === "computer.takeover.requested" ||
    event.type === "computer.takeover.released" ||
    isRunTerminalEvent(event)
  );
}

/**
 * Apply one live event to the open thread. Every app's snapshot accepts the full run and message
 * records built here, so the result keeps the caller's snapshot type. Computer status is not
 * part of this: it has its own reducer and refresh.
 */
export function reduceThreadSnapshot<S extends LiveThreadSnapshot>(
  prev: S | null,
  event: ThreadSnapshotEvent,
): S | null {
  return prev && (reduce(prev, event) as S);
}

function reduce(prev: LiveThreadSnapshot, event: ThreadSnapshotEvent): LiveThreadSnapshot {
  const payload = event.payload ?? {};
  // The replay cursor follows every applied event, including ones that change nothing visible.
  const cursor = event.seq ?? prev.cursor;
  const advanced = () => (cursor === prev.cursor ? prev : { ...prev, cursor });
  if (stopsRunHelpers(event)) {
    const messages = settleRunSubagents(prev.messages, event.runId);
    if (messages !== prev.messages) prev = { ...prev, messages };
  }

  if (event.type === "thread.cleared") {
    return { ...prev, cursor, messages: [], olderCursor: null, run: null, activeRuns: [] };
  }
  if (event.type === "run.started") {
    // Background runs (ticket work) stay invisible in the transcript; the server
    // already filters their events and snapshots, this guards a late arrival.
    if (isBackgroundRunTrigger(typeof payload.trigger === "string" ? payload.trigger : undefined)) {
      return advanced();
    }
    const members = updateMemberStatus(prev.members, event.botId, "running");
    if (!event.runId) {
      return members === prev.members ? advanced() : { ...prev, cursor, members };
    }
    const runId = event.runId;
    const previousRun =
      prev.activeRuns?.find((candidate) => candidate.id === runId) ??
      (prev.run?.id === runId ? prev.run : undefined);
    const run = runFromStartedEvent(event, runId, previousRun);
    if (!run.userId && prev.run?.id === run.id) run.userId = prev.run.userId;
    // Paused cards remain answerable when new work starts in any thread.
    const activeRuns = [
      ...activeThreadRuns(prev).filter(
        (candidate) => candidate.id !== run.id && isActive(candidate.status as RunStatus),
      ),
      run,
    ];
    return {
      ...prev,
      cursor,
      members,
      // A group failure lives only in run; keep it until dismiss so a late member start
      // cannot wipe the banner (activeRuns still tracks the new work).
      run: prev.groupId && prev.run?.status === "failed" && prev.run.id !== run.id ? prev.run : run,
      activeRuns,
    };
  }
  if (event.type === "run.waiting_input" || event.type === "computer.takeover.requested") {
    const status = event.type === "run.waiting_input" ? "waiting_input" : "waiting_takeover";
    const runId = event.runId;
    const userId =
      event.type === "run.waiting_input" &&
      typeof payload.userId === "string" &&
      payload.userId.length > 0
        ? payload.userId
        : undefined;
    const knownInRun = Boolean(runId && prev.run?.id === runId);
    const knownInActive = Boolean(
      runId && prev.activeRuns?.some((candidate) => candidate.id === runId),
    );
    // Peer bot_message runs are omitted from snapshots while busy; the first wait
    // event is how an open thread learns they need ask/takeover UI.
    const needsInsert = Boolean(runId) && !knownInRun && !knownInActive;
    const changes = (candidate: LiveThreadRun) =>
      candidate.status !== status || Boolean(userId && candidate.userId !== userId);
    const runChanged = Boolean(knownInRun && prev.run && changes(prev.run));
    const activeRunChanged = Boolean(
      knownInActive &&
        prev.activeRuns?.some((candidate) => candidate.id === runId && changes(candidate)),
    );
    const members = updateMemberStatus(prev.members, event.botId, status);
    // Both pauses delete the run's progress events server-side; drop the live bubble so a
    // missed message.created cannot leave "working…" stuck next to the waiting card.
    const liveId = progressMessageId(event);
    const messages = prev.messages.some((message) => message.id === liveId)
      ? prev.messages.filter((message) => message.id !== liveId)
      : prev.messages;
    if (
      !runChanged &&
      !activeRunChanged &&
      !needsInsert &&
      members === prev.members &&
      messages === prev.messages
    ) {
      return advanced();
    }
    if (needsInsert && runId) {
      const waitingRun: LiveThreadRun = {
        id: runId,
        botId: event.botId,
        threadId: event.threadId ?? prev.threadId,
        taskId: runId,
        ...(userId ? { userId } : {}),
        status,
        trigger: "bot_message",
        routineId: null,
        modelProvider: null,
        modelId: null,
        error: null,
        startedAt: event.createdAt,
        completedAt: null,
        createdAt: event.createdAt,
      };
      const activeRuns = [
        ...activeThreadRuns(prev).filter((candidate) => candidate.id !== runId),
        waitingRun,
      ];
      const promoteWaiting =
        !prev.run ||
        (prev.run.status !== "waiting_input" && prev.run.status !== "waiting_takeover");
      return {
        ...prev,
        cursor,
        members,
        messages,
        run: promoteWaiting ? waitingRun : prev.run,
        activeRuns,
      };
    }
    const settle = (candidate: LiveThreadRun) => ({
      ...candidate,
      status,
      ...(userId ? { userId } : {}),
    });
    return {
      ...prev,
      cursor,
      members,
      messages,
      run: runChanged && prev.run ? settle(prev.run) : prev.run,
      activeRuns: activeRunChanged
        ? prev.activeRuns?.map((candidate) =>
            candidate.id === runId ? settle(candidate) : candidate,
          )
        : prev.activeRuns,
    };
  }
  if (event.type === "computer.takeover.released") {
    const runId = event.runId;
    const settle = (candidate: LiveThreadRun): LiveThreadRun =>
      runId && candidate.id === runId && candidate.status === "waiting_takeover"
        ? { ...candidate, status: "queued" }
        : candidate;
    const nextRun = prev.run ? settle(prev.run) : prev.run;
    const activeChanged = Boolean(
      runId &&
        prev.activeRuns?.some(
          (candidate) => candidate.id === runId && candidate.status === "waiting_takeover",
        ),
    );
    if (nextRun === prev.run && !activeChanged) return advanced();
    const members = prev.members?.some(
      (member) => member.botId === event.botId && member.status === "waiting_takeover",
    )
      ? updateMemberStatus(prev.members, event.botId, "queued")
      : prev.members;
    return {
      ...prev,
      cursor,
      members,
      run: nextRun,
      activeRuns: activeChanged ? prev.activeRuns?.map(settle) : prev.activeRuns,
    };
  }
  if (isRunTerminalEvent(event)) {
    const activeRuns = prev.activeRuns?.filter((candidate) => candidate.id !== event.runId);
    const nextMemberRun = activeRuns?.find((candidate) => candidate.botId === event.botId);
    const failure = runFailureError(event);
    const primaryEnded = prev.run?.id === event.runId ? prev.run : null;
    // In a group the failing run may be a member run rather than the displayed one, so look
    // it up in activeRuns as well or its error would be dropped with it.
    const endedRun =
      primaryEnded ?? prev.activeRuns?.find((candidate) => candidate.id === event.runId) ?? null;
    return {
      ...prev,
      cursor,
      messages: prev.messages.filter((message) => message.id !== progressMessageId(event)),
      members: updateMemberStatus(prev.members, event.botId, nextMemberRun?.status ?? "idle"),
      // A failed run stays in run (activeRuns already excludes it) so the transcript can say
      // why it stopped, matching what threads.get returns on the next load.
      run:
        endedRun && failure
          ? { ...endedRun, status: "failed", error: failure }
          : primaryEnded
            ? (activeRuns?.[0] ?? null)
            : prev.run,
      activeRuns,
    };
  }
  if (event.type === "thread.progress" || event.type === "agent.tool.called") {
    const liveId = progressMessageId(event);
    const { previous, remaining } = takeLiveMessage(prev.messages, liveId);
    const blocks = reduceLiveMessageBlocks(
      previous?.blocks ?? [],
      event.type === "thread.progress"
        ? { type: "progress", payload }
        : { type: "tool", name: String(payload.name ?? "") },
    );
    return {
      ...prev,
      cursor,
      messages: [...remaining, liveRow(prev, event, liveId, blocks)],
    };
  }
  if (event.type === "agent.tool.completed") return advanced();
  if (event.type === "thread.subagent") {
    const block = subagentBlockFromPayload(payload);
    const next = liveRow(prev, event, `subagent:${block.agentId}`, [block]);
    // The subagent row goes before the run's streamed answer, which keeps growing below it.
    const without: LiveThreadMessage[] = [];
    const kept: LiveThreadMessage[] = [];
    for (const message of prev.messages) {
      if (message.id === next.id) continue;
      if (message.id.startsWith("progress:")) {
        if (message.runId) kept.push(message);
      } else {
        without.push(message);
      }
    }
    return { ...prev, cursor, messages: [...without, next, ...kept] };
  }
  if (event.type === "thread.cloud_agent") {
    return { ...prev, cursor, messages: updateCloudAgentMessages(prev.messages, payload) };
  }
  if (event.type === "thread.message.created" || event.type === "thread.message.updated") {
    const blocks = (payload.blocks as ThreadMessage["blocks"] | undefined) ?? [];
    const id = String(payload.messageId ?? event.id ?? `msg:${cursor ?? 0}`);
    const known = prev.messages.find((message) => message.id === id);
    // The message's own seq, which a pending send matches to recognize its echo.
    const seq = typeof payload.seq === "number" ? payload.seq : known?.seq;
    const next: LiveThreadMessage = {
      id,
      // Inline cards act on the message's thread, so live messages carry it too.
      threadId: known?.threadId ?? event.threadId ?? prev.threadId,
      ...(seq === undefined ? {} : { seq }),
      role: (payload.role as ThreadMessage["role"] | undefined) ?? "bot",
      blocks,
      botId: event.botId ?? (typeof payload.botId === "string" ? payload.botId : undefined),
      runId: event.runId,
      // An update can leave the call id out — the `end_call` marker does — so keep the one
      // the message already carries instead of dropping it out of its call.
      callId: typeof payload.callId === "string" ? payload.callId : known?.callId,
      ...payloadAuthor(payload, known),
      ...replyMetadata(payload, known),
      createdAt: known?.createdAt ?? event.createdAt,
    };
    const replacedSubagentIds = new Set(
      blocks.filter((block) => block.kind === "subagent").map((block) => block.agentId),
    );
    const { remaining } = takeLiveMessage(prev.messages, progressMessageId(event));
    // A live subagent placeholder gives way to the saved card; the saved card itself stays put.
    const without = remaining.filter(
      (message) => message.id === id || !replacedSubagent(message, replacedSubagentIds),
    );
    return { ...prev, cursor, messages: upsertMessageById(without, next) };
  }
  return prev;
}

function runFromStartedEvent(
  event: ThreadSnapshotEvent,
  runId: string,
  previous: LiveThreadRun | undefined,
): LiveThreadRun {
  const trigger = event.payload?.trigger;
  const routineId = event.payload?.routineId;
  const routineName = event.payload?.routineName;
  return {
    ...previous,
    id: runId,
    botId: event.botId ?? previous?.botId,
    threadId: event.threadId ?? previous?.threadId,
    taskId: previous?.taskId ?? runId,
    status: "running",
    trigger:
      typeof trigger === "string" && runTriggers.has(trigger)
        ? (trigger as RunTrigger)
        : (previous?.trigger ?? "user"),
    routineId: typeof routineId === "string" ? routineId : (previous?.routineId ?? null),
    ...(typeof routineName === "string" ? { routineName } : {}),
    modelProvider: previous?.modelProvider ?? null,
    modelId: previous?.modelId ?? null,
    error: null,
    startedAt: previous?.startedAt ?? event.createdAt,
    completedAt: null,
    createdAt: previous?.createdAt ?? event.createdAt,
  };
}

function liveRow(
  prev: LiveThreadSnapshot,
  event: ThreadSnapshotEvent,
  id: string,
  blocks: ThreadMessage["blocks"],
): LiveThreadMessage {
  return {
    id,
    threadId: event.threadId ?? prev.threadId,
    role: "bot",
    blocks,
    botId: event.botId,
    runId: event.runId,
    createdAt: event.createdAt,
  };
}

function updateMemberStatus(
  members: LiveThreadSnapshot["members"],
  botId: string | undefined,
  status: string,
): LiveThreadSnapshot["members"] {
  const member = botId ? members?.find((candidate) => candidate.botId === botId) : undefined;
  if (!member || member.status === status) return members;
  return members?.map((candidate) =>
    candidate.botId === botId ? { ...candidate, status } : candidate,
  );
}

function replacedSubagent(message: LiveThreadMessage, agentIds: ReadonlySet<string>) {
  if (agentIds.size === 0) return false;
  return message.blocks.some((block) => block.kind === "subagent" && agentIds.has(block.agentId));
}

/**
 * Reflect a committed direct-message send before its follow-up snapshot arrives.
 *
 * threads.send returns only after the message and run are durable. Keeping that
 * receipt prevents a transient snapshot/SSE interruption from showing a stored
 * user bubble with no working state. A matching live run always wins, and the
 * next durable event or refresh still supplies the authoritative status.
 */
export function applyThreadSendReceipt<S extends LiveThreadSnapshot>(
  snapshot: S | null,
  receipt: { botId: string; runId: string; taskId: string; createdAt?: string },
  terminalRunIds: ReadonlySet<string> = new Set(),
): S | null {
  if (
    !snapshot ||
    snapshot.groupId ||
    snapshot.botId !== receipt.botId ||
    snapshot.run?.id === receipt.runId ||
    terminalRunIds.has(receipt.runId)
  ) {
    return snapshot;
  }
  const currentRuns = activeThreadRuns(snapshot);
  if (currentRuns.some((run) => QUEUE_HOLDING_RUN_STATUSES.some((s) => s === run.status)))
    return snapshot;
  const createdAt = receipt.createdAt ?? new Date().toISOString();
  const run: Run = {
    id: receipt.runId,
    botId: receipt.botId,
    threadId: snapshot.threadId,
    taskId: receipt.taskId,
    status: "queued",
    trigger: "user",
    routineId: null,
    modelProvider: null,
    modelId: null,
    error: null,
    startedAt: null,
    completedAt: null,
    createdAt,
  };
  return {
    ...snapshot,
    run,
    activeRuns: [...currentRuns.filter((r) => isActive(r.status as RunStatus)), run],
  };
}

/** Remember a finished run so a late send receipt cannot show it as queued again. */
export function rememberTerminalRun(terminalRunIds: Set<string>, event: ThreadSnapshotEvent) {
  if (!event.runId || !isRunTerminalEvent(event)) return;
  terminalRunIds.add(event.runId);
  if (terminalRunIds.size > 100) {
    const oldest = terminalRunIds.values().next().value;
    if (oldest !== undefined) terminalRunIds.delete(oldest);
  }
}

export function mergeThreadSnapshot<S extends LiveThreadSnapshot>(
  prev: S | null,
  next: S,
  preserveLoadedHistory = false,
): S {
  // A threads.get started before SSE caught up must not wipe newer live state
  // (e.g. ask cards applied after send's post-refresh request was already in flight).
  if (prev && prev.threadId === next.threadId && (prev.cursor ?? -1) > (next.cursor ?? -1)) {
    return prev;
  }
  return mergeThreadHistory(prev, next, preserveLoadedHistory);
}

/**
 * Apply a threads.get refresh without clobbering newer event-sourced takeover state.
 *
 * A refresh that started earlier can still return running+busyBotName after the client
 * already applied waiting_takeover. That stale snapshot shares the cursor already applied.
 * A newer cursor is the release (or a later run) and replaces the waiting status.
 * Cursor comparisons only apply within the same thread.
 * Stop clears run/busy optimistically so an in-flight refresh cannot revive the run before
 * its run.cancelled event lands; an older-cursor refresh must keep that cleared local state.
 */
export function reconcileRefreshedThread<
  C extends { busyBotName?: string | null },
  S extends LiveThreadSnapshot & { computer?: C },
>(
  prev: S | null,
  snap: S,
  prevComputer: C | null,
  preserveLoadedHistory = false,
): { snapshot: S; computer: C | null } {
  const sameThread = Boolean(prev && prev.threadId === snap.threadId);

  if (sameThread && prev && (snap.cursor ?? -1) < (prev.cursor ?? -1)) {
    // A subscription can advance the cursor with progress before the send-triggered refresh
    // returns the new run record. Hydrate that matching run without rolling the transcript back.
    // Optimistic stop removes the matching progress message, so an older refresh cannot revive it.
    const refreshedRun = snap.run;
    const hasMatchingLiveProgress = Boolean(
      refreshedRun &&
        prev.messages.some(
          (message) =>
            message.runId === refreshedRun.id && message.id === `progress:${refreshedRun.id}`,
        ),
    );
    if (!prev.run && refreshedRun && hasMatchingLiveProgress) {
      return {
        snapshot: {
          ...prev,
          run: refreshedRun,
          activeRuns: snap.activeRuns,
          computer: snap.computer,
        },
        computer: snap.computer ?? null,
      };
    }
    // Progress can advance the thread cursor while embedded computer status from threads.get
    // is still useful — but only while a live run remains. Preserve event-sourced
    // waiting_takeover clears and optimistic stop clears.
    const preserveLocalComputer =
      prev.run?.status === "waiting_takeover" ||
      !prev.run ||
      !isActive(prev.run.status as RunStatus);
    return {
      snapshot: prev,
      computer: preserveLocalComputer ? prevComputer : (snap.computer ?? null),
    };
  }

  let snapshot = mergeThreadSnapshot(prev, snap, preserveLoadedHistory);
  let computer = snap.computer ?? null;

  const localWaiting =
    sameThread &&
    prev?.cursor === snapshot.cursor &&
    prev?.run?.status === "waiting_takeover" &&
    snapshot.run?.id === prev.run.id &&
    snapshot.run.status !== "waiting_takeover" &&
    isActive(snapshot.run.status as RunStatus);

  if (localWaiting && snapshot.run) {
    const runId = snapshot.run.id;
    snapshot = {
      ...snapshot,
      run: { ...snapshot.run, status: "waiting_takeover" },
      activeRuns: snapshot.activeRuns?.map((run) =>
        run.id === runId ? { ...run, status: "waiting_takeover" } : run,
      ),
    };
    if (computer?.busyBotName) computer = { ...computer, busyBotName: null };
  } else if (snapshot.run?.status === "waiting_takeover" && computer?.busyBotName) {
    computer = { ...computer, busyBotName: null };
  }

  return { snapshot, computer };
}
