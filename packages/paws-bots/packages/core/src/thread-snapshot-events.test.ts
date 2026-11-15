import type {
  ComputerStatus,
  ProductEvent,
  ThreadMessage,
  ThreadSnapshot,
} from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { answerableAskMessageIds, dismissableAskMessageIds } from "./answerable-ask.js";
import { withLiveStreamingProgress } from "./events.js";
import { prependThreadHistoryPage } from "./message-pages.js";
import type { LiveThreadMessage, LiveThreadSnapshot } from "./thread-snapshot-events.js";
import {
  activeThreadRuns,
  applyThreadSendReceipt,
  isThreadSnapshotEvent,
  mergeThreadSnapshot,
  reconcileRefreshedThread,
  reduceThreadSnapshot,
} from "./thread-snapshot-events.js";

describe("thread event reduction", () => {
  it("shows a committed direct send as queued before its snapshot refresh returns", () => {
    const initial = snapshot([message("user-1", [{ kind: "text", text: "Continue" }], 4)]);

    const next = applyThreadSendReceipt(initial, {
      botId: "bot-1",
      runId: "run-receipt",
      taskId: "task-receipt",
      createdAt: "2026-09-03T21:29:52.000Z",
    });

    expect(next?.run).toMatchObject({
      id: "run-receipt",
      taskId: "task-receipt",
      status: "queued",
    });
    expect(next?.activeRuns).toEqual([next?.run]);
    expect(next?.messages).toBe(initial.messages);
  });

  it("keeps a private card answerable through a new send receipt and run start", () => {
    const paused = { ...threadRun("paused"), status: "waiting_input" as const };
    const ask = {
      ...message("ask", [{ kind: "ask", text: "Which city?", status: "pending" }], 1),
      runId: paused.id,
    };
    const initial = { ...snapshot([ask]), run: paused, activeRuns: [paused] };
    const receipt = applyThreadSendReceipt(initial, {
      botId: "bot-1",
      runId: "new",
      taskId: "task-new",
    });
    expect(receipt?.activeRuns?.map((run) => run.id)).toEqual(["paused", "new"]);
    const started = reduceThreadSnapshot(receipt, event({ type: "run.started", runId: "new" }));
    expect(answerableAskMessageIds(started)).toEqual(new Set(["ask"]));
    expect(started?.activeRuns?.map((run) => run.id)).toEqual(["paused", "new"]);
  });

  it("does not replace authoritative active or group run state with a send receipt", () => {
    const active = threadRun("run-active");
    const direct: ThreadSnapshot = { ...snapshot([]), run: active, activeRuns: [active] };
    const group: ThreadSnapshot = { ...snapshot([]), groupId: "group-1" };
    const receipt = { botId: "bot-1", runId: "run-new", taskId: "task-new" };
    const completed = { ...threadRun(receipt.runId), status: "completed" as const };

    expect(applyThreadSendReceipt(direct, receipt)).toBe(direct);
    expect(applyThreadSendReceipt(group, receipt)).toBe(group);
    expect(applyThreadSendReceipt({ ...snapshot([]), run: completed }, receipt)?.run).toBe(
      completed,
    );
    expect(applyThreadSendReceipt(snapshot([]), receipt, new Set([receipt.runId]))).toEqual(
      snapshot([]),
    );
  });

  it("appends an emoji reply with its exact target", () => {
    const initial = snapshot([message("message-1", [{ kind: "text", text: "Done" }], 1)]);

    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.message.created",
        seq: 4,
        payload: {
          messageId: "reaction-1",
          role: "user",
          blocks: [{ kind: "text", text: "❤️" }],
          replyToMessageId: "message-1",
        },
      }),
    );

    expect(next?.messages.find((message) => message.id === "reaction-1")).toMatchObject({
      role: "user",
      blocks: [{ kind: "text", text: "❤️" }],
      replyToMessageId: "message-1",
    });
    expect(next?.cursor).toBe(4);
  });

  it("appends a quoted reply carrying its excerpt", () => {
    const initial = snapshot([message("message-1", [{ kind: "text", text: "Done" }], 1)]);

    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.message.created",
        seq: 4,
        createdAt: "2026-10-08T12:00:00.000Z",
        payload: {
          messageId: "reply-1",
          role: "user",
          blocks: [{ kind: "text", text: "why this?" }],
          replyToMessageId: "message-1",
          replyQuote: "Done",
          replyPreview: { role: "user", text: "Done" },
        },
      }),
    );

    expect(next?.messages.find((message) => message.id === "reply-1")).toMatchObject({
      role: "user",
      replyToMessageId: "message-1",
      replyQuote: "Done",
      replyPreview: { role: "user", text: "Done" },
      createdAt: "2026-10-08T12:00:00.000Z",
    });

    const updated = reduceThreadSnapshot(
      next,
      event({
        type: "thread.message.updated",
        seq: 5,
        payload: {
          messageId: "reply-1",
          role: "user",
          blocks: [{ kind: "text", text: "Updated" }],
        },
      }),
    );
    expect(updated?.messages.find((message) => message.id === "reply-1")).toMatchObject({
      replyToMessageId: "message-1",
      replyQuote: "Done",
      replyPreview: { role: "user", text: "Done" },
      createdAt: "2026-10-08T12:00:00.000Z",
    });
  });

  it("prepends older pages in order, removes overlaps, and advances the history cursor", () => {
    const initial = snapshot([message("m-2", [], 2), message("m-3", [], 3)], 2);

    const next = prependThreadHistoryPage(initial, {
      threadId: "thread-1",
      messages: [message("m-0", [], 0), message("m-1", [], 1), message("m-2", [], 2)],
      olderCursor: null,
    });

    expect(next?.messages.map((item) => item.id)).toEqual(["m-0", "m-1", "m-2", "m-3"]);
    expect(next?.olderCursor).toBeNull();
  });

  it("ignores a stale older page after the conversation was cleared", () => {
    const cleared = snapshot([], null);
    const next = prependThreadHistoryPage(cleared, {
      threadId: "thread-1",
      messages: [message("old-1", [], 0), message("old-2", [], 1)],
      olderCursor: null,
    });
    expect(next).toBe(cleared);
  });

  it("merges a refreshed recent page with loaded history and drops stale live messages", () => {
    const previous = snapshot(
      [
        message("m-0", [], 0),
        message("m-1", [], 1),
        message("progress:run-1", [{ kind: "progress", text: "draft" }], 9),
      ],
      null,
    );
    const recent = snapshot([message("m-1", [], 1), message("m-2", [], 2)], 1);

    const next = mergeThreadSnapshot(previous, recent, true);

    expect(next.messages.map((item) => item.id)).toEqual(["m-0", "m-1", "m-2"]);
    expect(next.olderCursor).toBeNull();
  });

  it("ignores a stale thread refresh that is behind the live cursor", () => {
    const live: ThreadSnapshot = {
      ...snapshot([
        message("ask-1", [{ kind: "ask", text: "Which city?", status: "pending" }], 11),
      ]),
      cursor: 12,
    };
    const stale: ThreadSnapshot = {
      ...snapshot([message("m-1", [{ kind: "text", text: "older" }], 1)]),
      cursor: 8,
    };

    expect(mergeThreadSnapshot(live, stale)).toBe(live);
    expect(mergeThreadSnapshot(live, stale, true)).toBe(live);
  });

  it("accumulates progress deltas and keeps only the active progress message", () => {
    const stale = message("progress:older", [{ kind: "progress", text: "old run" }]);
    const initial = snapshot([stale]);

    const first = reduceThreadSnapshot(
      initial,
      event({ type: "thread.progress", seq: 4, runId: "run-1", payload: { delta: "Hel" } }),
    );
    const second = reduceThreadSnapshot(
      first,
      event({ type: "thread.progress", seq: 5, runId: "run-1", payload: { delta: "lo" } }),
    );

    expect(second?.cursor).toBe(5);
    expect(second?.messages).toEqual([
      expect.objectContaining({
        id: "progress:run-1",
        blocks: [{ kind: "progress", text: "Hello" }],
      }),
    ]);
  });

  it("keeps hidden token progress so re-enabling streaming stays continuous", () => {
    const initial = snapshot([]);
    const afterTokens = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.progress",
        seq: 4,
        runId: "run-1",
        payload: { text: "Lis", streaming: true },
      }),
    );
    const afterDelta = reduceThreadSnapshot(
      afterTokens,
      event({
        type: "thread.progress",
        seq: 5,
        runId: "run-1",
        payload: { delta: "bon", streaming: true },
      }),
    );

    expect(afterDelta?.cursor).toBe(5);
    expect(afterDelta?.messages).toEqual([
      expect.objectContaining({
        id: "progress:run-1",
        blocks: [{ kind: "progress", text: "Lisbon" }],
      }),
    ]);
    expect(withLiveStreamingProgress(afterDelta, false)?.messages).toEqual([]);

    const afterActivity = reduceThreadSnapshot(
      afterDelta,
      event({
        type: "thread.progress",
        seq: 6,
        runId: "run-1",
        payload: { text: "Using browser", activity: true },
      }),
    );
    expect(withLiveStreamingProgress(afterActivity, false)?.messages).toEqual([
      expect.objectContaining({
        id: "progress:run-1",
        blocks: [{ kind: "progress", text: "Using browser", activity: true }],
      }),
    ]);

    const afterComplete = reduceThreadSnapshot(
      afterActivity,
      event({
        type: "thread.message.created",
        seq: 7,
        runId: "run-1",
        payload: {
          messageId: "m-final",
          role: "bot",
          blocks: [{ kind: "text", text: "Lisbon" }],
        },
      }),
    );
    expect(afterComplete?.messages).toEqual([
      expect.objectContaining({
        id: "m-final",
        blocks: [{ kind: "text", text: "Lisbon" }],
      }),
    ]);
  });

  it("resumes from retained tokens after streaming is turned back on mid-reply", () => {
    const afterPrefix = reduceThreadSnapshot(
      snapshot([]),
      event({
        type: "thread.progress",
        seq: 4,
        runId: "run-1",
        payload: { text: "Lis", streaming: true },
      }),
    );
    const hidden = withLiveStreamingProgress(afterPrefix, false);
    expect(hidden?.messages).toEqual([]);

    const afterResume = reduceThreadSnapshot(
      afterPrefix,
      event({
        type: "thread.progress",
        seq: 5,
        runId: "run-1",
        payload: { delta: "bon", streaming: true },
      }),
    );
    expect(withLiveStreamingProgress(afterResume, true)?.messages).toEqual([
      expect.objectContaining({
        id: "progress:run-1",
        blocks: [{ kind: "progress", text: "Lisbon" }],
      }),
    ]);
  });

  it("updates a live subagent in place while preserving streamed answer progress", () => {
    const activeRun = threadRun("run-1");
    const initial: ThreadSnapshot = {
      ...snapshot([
        message("subagent:research", [
          {
            kind: "subagent",
            agentId: "research",
            name: "Research",
            task: "Find sources",
            status: "running",
            progress: "Starting",
          },
        ]),
        {
          ...message("progress:run-1", [{ kind: "progress", text: "Draft" }]),
          runId: activeRun.id,
        },
      ]),
      run: activeRun,
      activeRuns: undefined,
    };

    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.subagent",
        seq: 8,
        payload: {
          agentId: "research",
          name: "Research",
          task: "Find sources",
          status: "completed",
          result: "Three sources found",
        },
      }),
    );

    expect(next?.messages.map((item) => item.id)).toEqual(["subagent:research", "progress:run-1"]);
    expect(next?.messages[0]?.blocks[0]).toMatchObject({
      kind: "subagent",
      status: "completed",
      result: "Three sources found",
    });
  });

  it("replaces transient progress and a matching live subagent with the durable message", () => {
    const initial = snapshot([
      message("durable", [{ kind: "text", text: "old value" }]),
      message("subagent:research", [
        {
          kind: "subagent",
          agentId: "research",
          name: "Research",
          task: "Find sources",
          status: "running",
        },
      ]),
      message("subagent:other", [
        {
          kind: "subagent",
          agentId: "other",
          name: "Other",
          task: "Keep working",
          status: "running",
        },
      ]),
      message("progress:run-1", [{ kind: "progress", text: "Draft" }]),
    ]);
    const completedBlock = {
      kind: "subagent" as const,
      agentId: "research",
      name: "Research",
      task: "Find sources",
      status: "completed" as const,
      result: "Done",
    };

    const next = reduceThreadSnapshot(
      initial,
      event({
        id: "event-message",
        type: "thread.message.created",
        seq: 9,
        payload: { messageId: "durable", role: "bot", blocks: [completedBlock] },
      }),
    );

    expect(next?.messages.map((item) => item.id)).toEqual(["durable", "subagent:other"]);
    expect(next?.messages[0]?.blocks).toEqual([completedBlock]);
  });

  it("settles a saved helper card where it is, ahead of the reply that came after it", () => {
    const helper = {
      kind: "subagent" as const,
      agentId: "helper-1",
      name: "helper",
      task: "Keep working",
      status: "running" as const,
    };
    const initial = snapshot([
      message("card", [helper]),
      message("reply", [{ kind: "text", text: "On it" }]),
    ]);

    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.message.updated",
        seq: 9,
        payload: { messageId: "card", role: "bot", blocks: [{ ...helper, status: "stopped" }] },
      }),
    );

    expect(next?.messages.map((item) => item.id)).toEqual(["card", "reply"]);
    expect(next?.messages[0]?.blocks).toEqual([{ ...helper, status: "stopped" }]);
  });

  it("keeps a replayed bot-to-bot marker in its durable transcript position", () => {
    const peerBlock = {
      kind: "bot_message_received" as const,
      fromBotId: "bot-peer",
      fromBotName: "Peer",
      text: "Please check this.",
    };
    const initial = snapshot([
      message("peer-message", [peerBlock], 1),
      message("newer-message", [{ kind: "text", text: "Working on it." }], 2),
    ]);

    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.message.created",
        seq: 9,
        payload: { messageId: "peer-message", role: "user", blocks: [peerBlock] },
      }),
    );

    expect(next?.messages.map((item) => item.id)).toEqual(["peer-message", "newer-message"]);
  });

  it("clears durable and transient history when another client clears the thread", () => {
    const initial = snapshot(
      [
        message("message-1", [{ kind: "text", text: "old" }]),
        message("progress:run-1", [{ kind: "progress", text: "draft" }]),
      ],
      1,
    );
    initial.run = {
      id: "run-1",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-1",
      status: "running",
      trigger: "user",
      routineId: null,
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: null,
      completedAt: null,
      createdAt: "2026-08-16T00:00:00.000Z",
    };

    const next = reduceThreadSnapshot(
      initial,
      event({ type: "thread.cleared", seq: 12, runId: undefined }),
    );

    expect(next).toMatchObject({ cursor: 12, messages: [], olderCursor: null, run: null });
  });

  it("routes clear and terminal events through the snapshot reducer", () => {
    expect(
      isThreadSnapshotEvent(event({ type: "thread.cleared", seq: 12, runId: undefined })),
    ).toBe(true);
    expect(isThreadSnapshotEvent(event({ type: "run.started" }))).toBe(true);
    expect(isThreadSnapshotEvent(event({ type: "run.completed" }))).toBe(true);
    expect(isThreadSnapshotEvent(event({ type: "computer.takeover.requested" }))).toBe(true);
    expect(isThreadSnapshotEvent(event({ type: "computer.takeover.released" }))).toBe(true);
    expect(isThreadSnapshotEvent(event({ type: "agent.tool.completed" }))).toBe(true);
  });

  it("keeps the routine name from run.started so the working line can name it", () => {
    const started = reduceThreadSnapshot(
      snapshot([]),
      event({
        type: "run.started",
        seq: 3,
        runId: "run-1",
        payload: { trigger: "routine", routineId: "routine-1", routineName: "Daily check" },
      }),
    );
    expect(started?.run).toMatchObject({
      trigger: "routine",
      routineId: "routine-1",
      routineName: "Daily check",
    });

    const resumed = reduceThreadSnapshot(
      started,
      event({ type: "run.started", seq: 4, runId: "run-1", payload: { trigger: "routine" } }),
    );
    expect(resumed?.run?.routineName).toBe("Daily check");
  });

  it("event-sources the active run on run.started so Stop does not wait on threads.get", () => {
    const initial = snapshot([]);
    const started = reduceThreadSnapshot(
      initial,
      event({
        type: "run.started",
        seq: 3,
        runId: "run-1",
        payload: { trigger: "user" },
      }),
    );

    expect(started?.run).toMatchObject({
      id: "run-1",
      botId: "bot-1",
      status: "running",
      trigger: "user",
    });
    expect(started?.activeRuns).toEqual([started?.run]);

    const progressed = reduceThreadSnapshot(
      started,
      event({
        type: "thread.progress",
        seq: 4,
        runId: "run-1",
        payload: { delta: "still working" },
      }),
    );
    expect(progressed?.run?.id).toBe("run-1");
    expect(progressed?.cursor).toBe(4);
  });

  it.each([undefined, "group-1"])(
    "preserves and hydrates the owner for waiting secret requests in %s",
    (groupId) => {
      const run = { ...threadRun("run-1"), userId: "owner" };
      const ask = {
        ...message("ask", [{ kind: "ask", text: "Secret", input: "secret", status: "pending" }]),
        runId: run.id,
      };
      const initial = { ...snapshot([ask]), groupId, run, activeRuns: [run] };
      const started = reduceThreadSnapshot(
        initial,
        event({ type: "run.started", seq: 4, runId: run.id }),
      );
      expect(started?.run?.userId).toBe("owner");
      expect(started?.activeRuns?.[0]?.userId).toBe("owner");

      const waiting = reduceThreadSnapshot(
        started,
        event({
          type: "run.waiting_input",
          seq: 5,
          runId: run.id,
          payload: { userId: "owner" },
        }),
      );
      expect(waiting?.run?.userId).toBe("owner");
      expect(waiting?.activeRuns?.[0]?.userId).toBe("owner");
      expect(dismissableAskMessageIds(waiting, "owner")).toEqual(new Set(["ask"]));
      expect(dismissableAskMessageIds(waiting, "other")).toEqual(new Set());
    },
  );

  it("hydrates the matching already-waiting run without changing another run", () => {
    const run = { ...threadRun("run-1"), status: "waiting_input" as const };
    const other = { ...threadRun("run-2"), userId: "other" };
    const initial = { ...snapshot([]), run, activeRuns: [run, other] };
    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "run.waiting_input",
        seq: 5,
        runId: run.id,
        payload: { userId: "owner" },
      }),
    );
    expect(next?.run?.userId).toBe("owner");
    expect(next?.activeRuns?.[0]?.userId).toBe("owner");
    expect(next?.activeRuns?.[1]).toEqual(other);
  });

  it("keeps legacy waits closed and inserts an authoritative peer owner", () => {
    const ask = {
      ...message("ask", [{ kind: "ask", text: "Secret", input: "secret", status: "pending" }]),
      runId: "peer",
    };
    const initial = { ...snapshot([ask]), groupId: "group-1" };
    const legacy = reduceThreadSnapshot(
      initial,
      event({ type: "run.waiting_input", seq: 4, runId: "peer", payload: {} }),
    );
    expect(dismissableAskMessageIds(legacy, "owner")).toEqual(new Set());
    const hydrated = reduceThreadSnapshot(
      legacy,
      event({
        type: "run.waiting_input",
        seq: 5,
        runId: "peer",
        payload: { userId: "owner" },
      }),
    );
    expect(dismissableAskMessageIds(hydrated, "owner")).toEqual(new Set(["ask"]));
    expect(dismissableAskMessageIds(hydrated, "other")).toEqual(new Set());
    const laterLegacy = reduceThreadSnapshot(
      hydrated,
      event({ type: "run.waiting_input", seq: 6, runId: "peer", payload: {} }),
    );
    expect(laterLegacy?.activeRuns?.[0]?.userId).toBe("owner");
  });

  it("accepts a queued refresh after an answer update at the same cursor", () => {
    const run = {
      ...threadRun("run-1"),
      status: "waiting_input" as const,
      userId: "owner",
    };
    const ask = {
      ...message("ask", [{ kind: "ask", text: "Secret", input: "secret", status: "pending" }]),
      runId: run.id,
    };
    const local: ThreadSnapshot = { ...snapshot([ask]), run, activeRuns: [run] };
    const answered = reduceThreadSnapshot(
      local,
      event({
        type: "thread.message.updated",
        seq: 10,
        runId: run.id,
        payload: {
          messageId: "ask",
          blocks: [
            {
              kind: "ask",
              text: "Secret",
              input: "secret",
              status: "answered",
            },
          ],
        },
      }),
    );
    const queued = {
      ...local,
      cursor: 10,
      run: { ...run, status: "queued" as const },
      activeRuns: [{ ...run, status: "queued" as const }],
    };
    const result = reconcileRefreshedThread(answered, queued, null).snapshot;
    expect(result.run?.status).toBe("queued");
    expect(result.activeRuns?.[0]?.status).toBe("queued");
  });

  it("keeps background ticket runs out of the transcript while advancing the cursor", () => {
    const started = reduceThreadSnapshot(
      snapshot([]),
      event({
        type: "run.started",
        seq: 7,
        runId: "ticket-run-1",
        payload: { trigger: "tickets" },
      }),
    );

    expect(started?.run).toBeNull();
    expect(started?.activeRuns ?? []).toEqual([]);
    expect(started?.cursor).toBe(7);
  });

  it("preserves bot_message when event-sourcing a peer run", () => {
    const started = reduceThreadSnapshot(
      snapshot([]),
      event({
        type: "run.started",
        runId: "peer-run-1",
        payload: { trigger: "bot_message" },
      }),
    );

    expect(started?.run?.trigger).toBe("bot_message");
  });

  it("preserves webhook when event-sourcing an inbound wake", () => {
    const started = reduceThreadSnapshot(
      snapshot([]),
      event({
        type: "run.started",
        runId: "webhook-run-1",
        payload: { trigger: "webhook" },
      }),
    );

    expect(started?.run?.trigger).toBe("webhook");
  });

  it("preserves call_end when event-sourcing the wrap-up run", () => {
    const started = reduceThreadSnapshot(
      snapshot([]),
      event({
        type: "run.started",
        runId: "call-end-run-1",
        payload: { trigger: "call_end" },
      }),
    );

    expect(started?.run?.trigger).toBe("call_end");
  });

  it("marks the run as waiting when computer takeover is requested", () => {
    const run = threadRun("run-1");
    const initial: ThreadSnapshot = {
      ...snapshot([]),
      run,
      activeRuns: [run],
    };

    const waiting = reduceThreadSnapshot(
      initial,
      event({ type: "computer.takeover.requested", seq: 5, runId: run.id }),
    );

    expect(waiting?.run?.status).toBe("waiting_takeover");
    expect(waiting?.activeRuns?.[0]?.status).toBe("waiting_takeover");

    const other = threadRun("run-2", "bot-2");
    const released = reduceThreadSnapshot(
      {
        ...initial,
        run: { ...run, status: "waiting_takeover" },
        activeRuns: [
          { ...run, status: "waiting_takeover" },
          { ...other, status: "waiting_takeover" },
        ],
      },
      event({
        type: "computer.takeover.released",
        seq: 6,
        runId: run.id,
        payload: { holder: "bot", reason: "released" },
      }),
    );
    expect(released?.run?.status).toBe("queued");
    expect(released?.activeRuns?.map((item) => [item.id, item.status])).toEqual([
      [run.id, "queued"],
      [other.id, "waiting_takeover"],
    ]);

    const running = reduceThreadSnapshot(
      {
        ...snapshot([]),
        run: { ...run, status: "running" },
        activeRuns: [{ ...run, status: "running" }],
      },
      event({ type: "computer.takeover.released", seq: 7, runId: run.id }),
    );
    expect(running?.run?.status).toBe("running");
  });

  it("inserts a peer takeover run that was absent from the open snapshot", () => {
    const userRun = threadRun("run-user");
    const initial: ThreadSnapshot = {
      ...snapshot([]),
      run: userRun,
      activeRuns: [userRun],
    };

    const waiting = reduceThreadSnapshot(
      initial,
      event({
        type: "computer.takeover.requested",
        seq: 12,
        runId: "run-peer",
        botId: "bot-peer",
      }),
    );

    expect(waiting?.run).toMatchObject({
      id: "run-peer",
      botId: "bot-peer",
      status: "waiting_takeover",
      trigger: "bot_message",
    });
    expect(waiting?.activeRuns?.map((run) => ({ id: run.id, status: run.status }))).toEqual([
      { id: "run-user", status: "running" },
      { id: "run-peer", status: "waiting_takeover" },
    ]);
  });

  it("accepts a newer refresh that queued the run after takeover release", () => {
    const run = threadRun("run-1");
    const waitingLocal: ThreadSnapshot = {
      ...snapshot([]),
      cursor: 10,
      run: { ...run, status: "waiting_takeover" },
      activeRuns: [{ ...run, status: "waiting_takeover" }],
    };
    const released: ThreadSnapshot = {
      ...snapshot([]),
      cursor: 12,
      run: { ...run, status: "queued" },
      activeRuns: [{ ...run, status: "queued" }],
      computer: computer({ state: "running", busyBotName: "Chief", takeoverRequested: false }),
    };

    const reconciled = reconcileRefreshedThread(
      waitingLocal,
      released,
      computer({ state: "running", takeoverRequested: true }),
    );

    expect(reconciled.snapshot.run?.status).toBe("queued");
    expect(reconciled.snapshot.activeRuns?.[0]?.status).toBe("queued");
    expect(reconciled.computer?.takeoverRequested).toBe(false);
  });

  it("ignores a refresh whose cursor is behind the event-sourced snapshot", () => {
    const run = threadRun("run-1");
    const newer: ThreadSnapshot = {
      ...snapshot([]),
      cursor: 12,
      run: { ...run, status: "waiting_takeover" },
    };
    const older: ThreadSnapshot = {
      ...snapshot([]),
      cursor: 9,
      run,
      computer: computer({ busyBotName: "Chief" }),
    };
    const prevComputer = computer({ busyBotName: null });

    const reconciled = reconcileRefreshedThread(newer, older, prevComputer);

    expect(reconciled.snapshot).toBe(newer);
    expect(reconciled.computer).toBe(prevComputer);
  });

  it("refreshes busy status when only transient thread events are ahead", () => {
    const run = threadRun("run-1");
    const newer: ThreadSnapshot = { ...snapshot([]), cursor: 12, run };
    const older: ThreadSnapshot = {
      ...snapshot([]),
      cursor: 9,
      run,
      computer: computer({ state: "running", controlHolder: "bot", busyBotName: "Chief" }),
    };

    const reconciled = reconcileRefreshedThread(
      newer,
      older,
      computer({ state: "running", controlHolder: "bot", busyBotName: null }),
    );

    expect(reconciled.snapshot).toBe(newer);
    expect(reconciled.computer?.busyBotName).toBe("Chief");
  });

  it("hydrates a live run from a refresh without rolling back newer progress", () => {
    const run = threadRun("run-1");
    const liveProgress = {
      ...message("progress:run-1", [{ kind: "progress" as const, text: "Still working" }]),
      runId: run.id,
    };
    const newer: ThreadSnapshot = { ...snapshot([liveProgress]), cursor: 12, run: null };
    const older: ThreadSnapshot = {
      ...snapshot([]),
      cursor: 11,
      run,
      computer: computer({ state: "running", controlHolder: "bot", busyBotName: "Chief" }),
    };

    const reconciled = reconcileRefreshedThread(newer, older, computer());

    expect(reconciled.snapshot.cursor).toBe(12);
    expect(reconciled.snapshot.messages).toEqual([liveProgress]);
    expect(reconciled.snapshot.run).toBe(run);
    expect(reconciled.computer?.busyBotName).toBe("Chief");
  });

  it("always replaces the snapshot when switching to a different thread", () => {
    const previous: ThreadSnapshot = {
      ...snapshot([]),
      threadId: "thread-writer",
      cursor: 40,
      computer: computer({ mode: "team", busyBotName: null }),
    };
    const next: ThreadSnapshot = {
      ...snapshot([]),
      botId: "bot-private",
      threadId: "thread-private",
      cursor: 0,
      computer: computer({ mode: "dedicated", state: "running" }),
    };

    const reconciled = reconcileRefreshedThread(previous, next, previous.computer ?? null);

    expect(reconciled.snapshot.threadId).toBe("thread-private");
    expect(reconciled.computer?.mode).toBe("dedicated");
  });

  it("keeps group member status in sync with run lifecycle events", () => {
    const run = threadRun("run-1", "bot-member");
    const initial: ThreadSnapshot = {
      ...snapshot([]),
      botId: undefined,
      groupId: "group-1",
      members: [{ botId: "bot-member", name: "Member", color: "#8B5CF6", status: "idle" }],
    };

    const started = reduceThreadSnapshot(
      initial,
      event({ type: "run.started", botId: "bot-member", runId: run.id }),
    );
    expect(started?.members?.[0]?.status).toBe("running");
    expect(started?.run?.id).toBe(run.id);
    expect(started?.run?.status).toBe("running");
    expect(started?.activeRuns?.map((item) => item.id)).toEqual([run.id]);

    const waiting = reduceThreadSnapshot(
      started!,
      event({
        type: "run.waiting_input",
        seq: 5,
        botId: "bot-member",
        runId: run.id,
      }),
    );
    expect(waiting?.members?.[0]?.status).toBe("waiting_input");

    const completed = reduceThreadSnapshot(
      waiting,
      event({ type: "run.completed", seq: 6, botId: "bot-member", runId: run.id }),
    );
    expect(completed?.members?.[0]?.status).toBe("idle");
  });

  it("clears only the terminal run's live progress", () => {
    const runA = threadRun("run-a", "bot-a");
    const runB = threadRun("run-b", "bot-b");
    const initial: ThreadSnapshot = {
      ...snapshot([
        {
          ...message("progress:run-a", [{ kind: "progress", text: "A" }]),
          runId: runA.id,
        },
        {
          ...message("progress:run-b", [{ kind: "progress", text: "B" }]),
          runId: runB.id,
        },
      ]),
      run: runA,
      activeRuns: [runA, runB],
    };
    const failed = event({ type: "run.failed", seq: 10, runId: runA.id });

    const next = reduceThreadSnapshot(initial, failed);

    expect(isThreadSnapshotEvent(failed)).toBe(true);
    expect(next?.messages.map((item) => item.id)).toEqual(["progress:run-b"]);
    expect(next?.run).toEqual(runB);
    expect(next?.activeRuns).toEqual([runB]);
    expect(next?.cursor).toBe(10);
  });

  it("applies the durable waiting-input run transition without a refresh", () => {
    const initial: ThreadSnapshot = {
      ...snapshot([]),
      run: {
        id: "run-1",
        botId: "bot-1",
        threadId: "thread-1",
        taskId: "task-1",
        status: "running",
        trigger: "user",
        routineId: null,
        modelProvider: null,
        modelId: null,
        error: null,
        startedAt: null,
        completedAt: null,
        createdAt: "2026-08-16T00:00:00.000Z",
      },
    };

    const waiting = reduceThreadSnapshot(
      initial,
      event({ type: "run.waiting_input", seq: 6, runId: "run-1" }),
    );

    expect(waiting?.run?.status).toBe("waiting_input");
    expect(waiting?.cursor).toBe(6);
    // A repeat changes nothing visible; only the replay cursor moves.
    const repeated = reduceThreadSnapshot(
      waiting,
      event({ type: "run.waiting_input", seq: 7, runId: "run-1" }),
    );
    expect(repeated).toEqual({ ...waiting, cursor: 7 });
    expect(repeated?.run).toBe(waiting?.run);
  });

  it("clears live progress when a run waits for input", () => {
    const run = threadRun("run-1");
    const initial: ThreadSnapshot = {
      ...snapshot([
        {
          ...message("progress:run-1", [{ kind: "progress", text: "working…" }]),
          runId: run.id,
        },
      ]),
      run,
      activeRuns: [run],
    };

    const waiting = reduceThreadSnapshot(
      initial,
      event({ type: "run.waiting_input", seq: 6, runId: run.id }),
    );

    expect(waiting?.messages).toEqual([]);
    expect(waiting?.run?.status).toBe("waiting_input");
    expect(waiting?.activeRuns?.[0]?.status).toBe("waiting_input");
  });

  it("accumulates tool-call steps and collapses repeats into a count", () => {
    const initial = snapshot([]);

    const first = reduceThreadSnapshot(
      initial,
      event({
        type: "agent.tool.called",
        seq: 4,
        runId: "run-1",
        payload: { name: "SLACK_FIND_CHANNELS" },
      }),
    );
    const second = reduceThreadSnapshot(
      first,
      event({
        type: "agent.tool.called",
        seq: 5,
        runId: "run-1",
        payload: { name: "SLACK_FETCH_CONVERSATION_HISTORY" },
      }),
    );
    const third = reduceThreadSnapshot(
      second,
      event({
        type: "agent.tool.called",
        seq: 6,
        runId: "run-1",
        payload: { name: "SLACK_FETCH_CONVERSATION_HISTORY" },
      }),
    );

    expect(third?.messages).toEqual([
      expect.objectContaining({
        id: "progress:run-1",
        blocks: [
          {
            kind: "steps",
            steps: [
              { label: "Slack find channels", count: 1 },
              { label: "Slack fetch conversation history", count: 2 },
            ],
          },
        ],
      }),
    ]);
  });

  it("advances past tool completion audit events without adding a visible message", () => {
    const initial = snapshot(
      [
        message(
          "progress:run-1",
          [{ kind: "steps", steps: [{ label: "Slack find channels", count: 1 }] }],
          4,
        ),
      ],
      4,
    );
    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "agent.tool.completed",
        seq: 5,
        runId: "run-1",
        payload: { name: "SLACK_FIND_CHANNELS", outcome: "succeeded" },
      }),
    );

    expect(next?.cursor).toBe(5);
    expect(next?.messages).toEqual(initial.messages);
  });

  it("holds a tool call that lands mid-sentence until the sentence completes", () => {
    const initial = snapshot([]);

    const afterNarration = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.progress",
        seq: 4,
        runId: "run-1",
        payload: { text: "Let me check Slack ", streaming: true },
      }),
    );
    const afterTool = reduceThreadSnapshot(
      afterNarration,
      event({
        type: "agent.tool.called",
        seq: 5,
        runId: "run-1",
        payload: { name: "SLACK_FIND_CHANNELS" },
      }),
    );

    // Still mid-sentence — the tool call stays hidden, folded into the streaming text instead.
    expect(afterTool?.messages).toEqual([
      expect.objectContaining({
        id: "progress:run-1",
        blocks: [
          {
            kind: "progress",
            text: "Let me check Slack ",
            pendingToolNames: ["SLACK_FIND_CHANNELS"],
          },
        ],
      }),
    ]);

    const afterMore = reduceThreadSnapshot(
      afterTool,
      event({
        type: "thread.progress",
        seq: 6,
        runId: "run-1",
        payload: { delta: "for a broad search.", streaming: true },
      }),
    );

    // The sentence just finished — the completed sentence and the held-back tool call appear
    // together, in that order.
    expect(afterMore?.messages).toEqual([
      expect.objectContaining({
        id: "progress:run-1",
        blocks: [
          { kind: "text", text: "Let me check Slack for a broad search." },
          { kind: "steps", steps: [{ label: "Slack find channels", count: 1 }] },
        ],
      }),
    ]);
  });

  it("survives a React StrictMode replay of the same event without double-counting", () => {
    // StrictMode invokes a setState updater twice per event in development to catch impure
    // updaters — reduceThreadSnapshot(prev, event) must return the same result both times
    // rather than mutating its pending-tool-call bookkeeping a second time.
    const initial = snapshot([]);
    const afterNarration = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.progress",
        seq: 4,
        runId: "run-1",
        payload: { text: "Let me check ", streaming: true },
      }),
    );
    const toolEvent = event({
      type: "agent.tool.called",
      seq: 5,
      runId: "run-1",
      payload: { name: "SLACK_FIND_CHANNELS" },
    });

    // The tool call lands mid-sentence, so it's held back rather than flushed immediately —
    // exactly the state a naive module-level mutation would double-push on replay.
    const first = reduceThreadSnapshot(afterNarration, toolEvent);
    const replay = reduceThreadSnapshot(afterNarration, toolEvent);
    expect(replay).toEqual(first);

    const sentenceEnd = reduceThreadSnapshot(
      first,
      event({
        type: "thread.progress",
        seq: 6,
        runId: "run-1",
        payload: { delta: "Done.", streaming: true },
      }),
    );

    // A single tool call, not two — StrictMode's replay must not have pushed it twice.
    expect(sentenceEnd?.messages).toEqual([
      expect.objectContaining({
        id: "progress:run-1",
        blocks: [
          { kind: "text", text: "Let me check Done." },
          { kind: "steps", steps: [{ label: "Slack find channels", count: 1 }] },
        ],
      }),
    ]);
  });

  it("keeps deferring a tool call across several sentence-less deltas", () => {
    const initial = snapshot([]);

    const afterNarration = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.progress",
        seq: 4,
        runId: "run-1",
        payload: { text: "Let me check Slack ", streaming: true },
      }),
    );
    const afterTool = reduceThreadSnapshot(
      afterNarration,
      event({
        type: "agent.tool.called",
        seq: 5,
        runId: "run-1",
        payload: { name: "SLACK_FIND_CHANNELS" },
      }),
    );
    const afterMore = reduceThreadSnapshot(
      afterTool,
      event({
        type: "thread.progress",
        seq: 6,
        runId: "run-1",
        payload: { delta: "Found it, now sanding", streaming: true },
      }),
    );

    // No sentence terminator has streamed in yet, so the tool call is still hidden and
    // everything so far renders as one continuous progress block.
    expect(afterMore?.messages).toEqual([
      expect.objectContaining({
        id: "progress:run-1",
        blocks: [
          {
            kind: "progress",
            text: "Let me check Slack Found it, now sanding",
            pendingToolNames: ["SLACK_FIND_CHANNELS"],
          },
        ],
      }),
    ]);
  });

  it("restores pending tool calls from a refreshed snapshot", () => {
    const refreshed = snapshot([
      message("progress:run-1", [
        {
          kind: "progress",
          text: "Let me check Slack ",
          pendingToolNames: ["SLACK_FIND_CHANNELS"],
        },
      ]),
    ]);

    const next = reduceThreadSnapshot(
      refreshed,
      event({
        type: "thread.progress",
        seq: 6,
        runId: "run-1",
        payload: { delta: "now.", streaming: true },
      }),
    );

    expect(next?.messages[0]?.blocks).toEqual([
      { kind: "text", text: "Let me check Slack now." },
      { kind: "steps", steps: [{ label: "Slack find channels", count: 1 }] },
    ]);
  });

  it("does not leak pending tool calls after clearing a thread", () => {
    const withPending = snapshot([
      message("progress:run-1", [
        {
          kind: "progress",
          text: "Old unfinished narration ",
          pendingToolNames: ["SLACK_FIND_CHANNELS"],
        },
      ]),
    ]);
    const cleared = reduceThreadSnapshot(
      withPending,
      event({ type: "thread.cleared", seq: 7, runId: undefined }),
    );
    const next = reduceThreadSnapshot(
      cleared,
      event({ type: "thread.progress", seq: 8, runId: "run-1", payload: { text: "Fresh." } }),
    );

    expect(next?.messages[0]?.blocks).toEqual([{ kind: "progress", text: "Fresh." }]);
  });

  it("preserves another active group run while updating live progress", () => {
    const runA = {
      id: "run-a",
      botId: "bot-a",
      threadId: "thread-1",
      taskId: "task-a",
      status: "running" as const,
      trigger: "user" as const,
      routineId: null,
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: null,
      completedAt: null,
      createdAt: "2026-08-16T00:00:00.000Z",
    };
    const otherLive = {
      ...message("progress:run-b", [{ kind: "progress" as const, text: "Other bot" }]),
      botId: "bot-b",
      runId: "run-b",
    };
    // The snapshot can lag behind the event stream when another group run starts.
    const initial = { ...snapshot([otherLive]), activeRuns: [runA] };

    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.progress",
        seq: 8,
        runId: "run-a",
        botId: "bot-a",
        payload: { text: "Current bot" },
      }),
    );

    expect(next?.messages.map((item) => item.id)).toEqual(["progress:run-b", "progress:run-a"]);
    expect(next?.messages.map((item) => item.botId)).toEqual(["bot-b", "bot-a"]);
  });

  it("preserves live progress from a legacy run-only snapshot", () => {
    const legacyRun = threadRun("run-legacy", "bot-legacy");
    const legacyLive = {
      ...message("progress:run-legacy", [{ kind: "progress" as const, text: "Still working" }]),
      botId: legacyRun.botId,
      runId: legacyRun.id,
    };
    const initial: ThreadSnapshot = {
      ...snapshot([legacyLive]),
      run: legacyRun,
      activeRuns: undefined,
    };

    const next = reduceThreadSnapshot(
      initial,
      event({ type: "thread.progress", runId: "run-new", payload: { text: "New work" } }),
    );

    expect(next?.messages.map((item) => item.id)).toEqual([
      "progress:run-legacy",
      "progress:run-new",
    ]);
  });

  it("preserves concurrent progress while applying a subagent update", () => {
    const activeRun = threadRun("run-active");
    const initial: ThreadSnapshot = {
      ...snapshot([
        {
          ...message("progress:run-active", [{ kind: "progress", text: "Active" }]),
          runId: "run-active",
        },
        {
          ...message("progress:run-concurrent", [{ kind: "progress", text: "Concurrent" }]),
          runId: "run-concurrent",
        },
      ]),
      run: activeRun,
      activeRuns: [activeRun],
    };

    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.subagent",
        runId: "run-active",
        payload: { agentId: "research", name: "Research", task: "Check", status: "running" },
      }),
    );

    expect(next?.messages.map((item) => item.id)).toEqual([
      "subagent:research",
      "progress:run-active",
      "progress:run-concurrent",
    ]);
  });

  it("clears the step trail once the durable answer arrives", () => {
    const initial = snapshot([
      message("progress:run-1", [
        { kind: "steps", steps: [{ label: "Slack find channels", count: 1 }] },
      ]),
    ]);

    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.message.created",
        seq: 9,
        payload: { messageId: "final", role: "bot", blocks: [{ kind: "text", text: "Done" }] },
      }),
    );

    expect(next?.messages.map((item) => item.id)).toEqual(["final"]);
  });

  it("updates a waiting group run without replacing the newer active run", () => {
    const newerRun = {
      id: "run-newer",
      botId: "bot-a",
      threadId: "thread-1",
      taskId: "task-a",
      status: "running" as const,
      trigger: "user" as const,
      routineId: null,
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: null,
      completedAt: null,
      createdAt: "2026-08-16T00:00:00.000Z",
    };
    const waitingRun = { ...newerRun, id: "run-waiting", botId: "bot-b", taskId: "task-b" };
    const initial: ThreadSnapshot = {
      ...snapshot([]),
      run: newerRun,
      activeRuns: [newerRun, waitingRun],
    };

    const waiting = reduceThreadSnapshot(
      initial,
      event({ type: "run.waiting_input", seq: 6, runId: "run-waiting" }),
    );

    expect(waiting?.run).toEqual(newerRun);
    expect(waiting?.activeRuns?.find((run) => run.id === "run-waiting")?.status).toBe(
      "waiting_input",
    );
    expect(activeThreadRuns(waiting)).toEqual([
      newerRun,
      expect.objectContaining({ id: "run-waiting", status: "waiting_input" }),
    ]);
    expect(activeThreadRuns({ ...initial, activeRuns: undefined })).toEqual([newerRun]);
  });

  it("replaces an ask message when its durable prompt state changes", () => {
    const initial = snapshot([
      message("ask-1", [{ kind: "ask", text: "Which city?", status: "pending" }]),
    ]);
    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.message.updated",
        seq: 7,
        payload: {
          messageId: "ask-1",
          role: "bot",
          blocks: [
            {
              kind: "ask",
              text: "Which city?",
              status: "answered",
              answer: "Paris",
            },
          ],
        },
      }),
    );

    expect(next?.messages).toHaveLength(1);
    expect(next?.messages[0]?.blocks[0]).toMatchObject({ status: "answered", answer: "Paris" });
  });

  it("titles the call marker in place when the wrap-up run names it", () => {
    const initial = snapshot([
      { ...message("marker-1", [{ kind: "voice_call", title: "", farewell: "" }]), callId: "c-1" },
    ]);
    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.message.updated",
        seq: 8,
        payload: {
          messageId: "marker-1",
          role: "bot",
          blocks: [{ kind: "voice_call", title: "Flight booked", farewell: "Talk soon" }],
        },
      }),
    );

    expect(next?.messages).toHaveLength(1);
    expect(next?.messages[0]?.blocks[0]).toMatchObject({ title: "Flight booked" });
    expect(next?.messages[0]?.callId).toBe("c-1");
  });

  it("preserves botId on durable bot messages", () => {
    const initial = snapshot([]);
    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.message.created",
        seq: 4,
        botId: "bot-researcher",
        payload: {
          messageId: "msg-1",
          role: "bot",
          blocks: [{ kind: "text", text: "on it." }],
        },
      }),
    );

    expect(next?.messages[0]?.botId).toBe("bot-researcher");
  });
});

describe("stale helper projection", () => {
  it.each([
    "run.waiting_input",
    "computer.takeover.requested",
    "run.completed",
    "run.failed",
    "run.cancelled",
  ] as const)("settles helpers on %s without reviving them on resume", (type) => {
    const base = {
      id: "fixture",
      threadId: "thread-1",
      runId: "run-1",
      seq: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const helper = { agentId: "helper", name: "Helper", task: "Check", status: "running" };
    let next = reduceThreadSnapshot(
      snapshot([]),
      event({ ...base, type: "thread.subagent", payload: helper }),
    );
    next = reduceThreadSnapshot(next, event({ ...base, seq: 2, type, payload: {} }));
    expect(next?.messages.find((m) => m.id === "subagent:helper")?.blocks[0]).toMatchObject({
      status: "failed",
      result: "stopped",
    });
    next = reduceThreadSnapshot(next, event({ ...base, seq: 3, type: "run.started", payload: {} }));
    next = reduceThreadSnapshot(
      next,
      event({
        ...base,
        seq: 4,
        type: "thread.subagent",
        payload: { ...helper, agentId: "resumed" },
      }),
    );
    expect(next?.messages.find((m) => m.id === "subagent:helper")?.blocks[0]).toMatchObject({
      status: "failed",
    });
    expect(next?.messages.find((m) => m.id === "subagent:resumed")?.blocks[0]).toMatchObject({
      status: "running",
    });
  });
});

function snapshot(messages: ThreadMessage[], olderCursor: number | null = null): ThreadSnapshot {
  return {
    botId: "bot-1",
    threadId: "thread-1",
    cursor: 3,
    messages,
    olderCursor,
    run: null,
    computer: computer(),
  };
}

function threadRun(id: string, botId = "bot-1"): NonNullable<ThreadSnapshot["run"]> {
  return {
    id,
    botId,
    threadId: "thread-1",
    taskId: `task-${id}`,
    status: "running",
    trigger: "user",
    routineId: null,
    modelProvider: null,
    modelId: null,
    error: null,
    startedAt: null,
    completedAt: null,
    createdAt: "2026-08-16T00:00:00.000Z",
  };
}

function computer(overrides: Partial<ComputerStatus> = {}): ComputerStatus {
  return {
    botId: "bot-1",
    mode: "team",
    kind: "fake",
    state: "booting",
    controlHolder: "none",
    controlBotId: null,
    takeoverRequested: false,
    screenAvailable: false,
    screenWidth: 1280,
    screenHeight: 800,
    homeRevision: null,
    busyBotName: null,
    canUpdate: true,
    terminalAvailable: true,
    ...overrides,
  };
}

function message(id: string, blocks: ThreadMessage["blocks"], seq = 3): ThreadMessage {
  return {
    id,
    threadId: "thread-1",
    seq,
    role: "bot",
    blocks,
    createdAt: "2026-08-16T00:00:00.000Z",
  };
}

function event(overrides: Partial<ProductEvent>): ProductEvent {
  return {
    id: "event-1",
    spaceId: "workspace-1",
    threadId: "thread-1",
    botId: "bot-1",
    seq: 4,
    type: "thread.progress",
    runId: "run-1",
    createdAt: "2026-08-16T00:00:01.000Z",
    payload: {},
    ...overrides,
  };
}

/** Mobile reads the live stream without validating it, so events and records can be sparse. */
describe("thread event reduction from sparse live events", () => {
  it("keeps a message in its call when an update leaves the call id out", () => {
    const spoken: LiveThreadMessage = {
      ...liveMessage("message-1", [{ kind: "text", text: "Hi" }]),
      callId: "call-1",
    };
    const initial = liveSnapshot([spoken]);

    const next = reduceThreadSnapshot(initial, {
      type: "thread.message.updated",
      seq: 5,
      payload: {
        messageId: "message-1",
        role: "bot",
        blocks: [{ kind: "text", text: "Hi. Talk soon." }],
      },
    });

    expect(next?.messages.find((message) => message.id === "message-1")).toMatchObject({
      callId: "call-1",
    });
  });

  it("shows peer-started group work without hiding a waiting member", () => {
    const initial: LiveSnapshot = {
      ...liveSnapshot(),
      groupId: "group-1",
      run: { id: "waiting-run", botId: "bot-1", status: "waiting_input" },
      activeRuns: [{ id: "waiting-run", botId: "bot-1", status: "waiting_input" }],
      members: [
        { botId: "bot-1", name: "Writer", color: "blue", status: "waiting_input" },
        { botId: "bot-2", name: "Researcher", color: "green", status: "idle" },
      ],
    };

    const next = reduceThreadSnapshot(initial, {
      type: "run.started",
      seq: 9,
      runId: "peer-run",
      botId: "bot-2",
      payload: { trigger: "user_message" },
    });

    expect(next?.cursor).toBe(9);
    expect(next?.run).toMatchObject({
      id: "peer-run",
      botId: "bot-2",
      status: "running",
      error: null,
    });
    expect(next?.activeRuns).toMatchObject([
      { id: "waiting-run", botId: "bot-1", status: "waiting_input" },
      { id: "peer-run", botId: "bot-2", status: "running", error: null },
    ]);
    expect(next?.members?.map((member) => member.status)).toEqual(["waiting_input", "running"]);
  });

  it("keeps group member status in sync with run lifecycle events, like web", () => {
    const initial: LiveSnapshot = {
      ...liveSnapshot(),
      botId: undefined,
      groupId: "group-1",
      members: [
        { botId: "bot-1", name: "Writer", color: "blue", status: "idle" },
        { botId: "bot-2", name: "Researcher", color: "green", status: "idle" },
      ],
    };
    const statuses = (state: LiveSnapshot | null) => state?.members?.map((member) => member.status);

    const started = reduceThreadSnapshot(initial, {
      type: "run.started",
      seq: 4,
      botId: "bot-1",
      runId: "run-1",
    });
    expect(statuses(started)).toEqual(["running", "idle"]);
    const waiting = reduceThreadSnapshot(started, {
      type: "run.waiting_input",
      seq: 5,
      botId: "bot-1",
      runId: "run-1",
    });
    expect(statuses(waiting)).toEqual(["waiting_input", "idle"]);
    const resumed = reduceThreadSnapshot(waiting, {
      type: "run.started",
      seq: 6,
      botId: "bot-1",
      runId: "run-1",
    });
    const takeover = reduceThreadSnapshot(resumed, {
      type: "computer.takeover.requested",
      seq: 7,
      botId: "bot-1",
      runId: "run-1",
    });
    expect(statuses(takeover)).toEqual(["waiting_takeover", "idle"]);
    const released = reduceThreadSnapshot(takeover, {
      type: "computer.takeover.released",
      seq: 8,
      botId: "bot-1",
      runId: "run-1",
    });
    expect(statuses(released)).toEqual(["queued", "idle"]);
    const completed = reduceThreadSnapshot(released, {
      type: "run.completed",
      seq: 9,
      botId: "bot-1",
      runId: "run-1",
    });
    expect(statuses(completed)).toEqual(["idle", "idle"]);
  });

  it("marks a waiting peer that the snapshot omitted", () => {
    const initial: LiveSnapshot = {
      ...liveSnapshot(),
      groupId: "group-1",
      members: [{ botId: "bot-2", name: "Researcher", color: "green", status: "running" }],
    };

    const next = reduceThreadSnapshot(initial, {
      type: "run.waiting_input",
      seq: 9,
      botId: "bot-2",
      runId: "peer-run",
    });

    expect(next?.run).toMatchObject({ id: "peer-run", botId: "bot-2", status: "waiting_input" });
    expect(next?.members?.[0]?.status).toBe("waiting_input");
  });

  it.each(["run.completed", "run.failed", "run.cancelled"])(
    "settles a member on %s to its next active run, or idle",
    (type) => {
      const initial: LiveSnapshot = {
        ...liveSnapshot(),
        groupId: "group-1",
        run: { id: "run-1", botId: "bot-1", status: "running" },
        activeRuns: [
          { id: "run-1", botId: "bot-1", status: "running" },
          { id: "run-2", botId: "bot-1", status: "waiting_input" },
          { id: "run-3", botId: "bot-2", status: "running" },
        ],
        members: [
          { botId: "bot-1", name: "Writer", color: "blue", status: "running" },
          { botId: "bot-2", name: "Researcher", color: "green", status: "running" },
        ],
      };

      const first = reduceThreadSnapshot(initial, {
        type,
        seq: 9,
        botId: "bot-1",
        runId: "run-1",
      });
      expect(first?.members?.map((member) => member.status)).toEqual(["waiting_input", "running"]);
      const last = reduceThreadSnapshot(first, {
        type,
        seq: 10,
        botId: "bot-2",
        runId: "run-3",
      });
      expect(last?.members?.map((member) => member.status)).toEqual(["waiting_input", "idle"]);
    },
  );

  it("consumes background run starts without changing visible work or members", () => {
    const initial: LiveSnapshot = {
      ...liveSnapshot(),
      groupId: "group-1",
      run: { id: "waiting-run", botId: "bot-1", status: "waiting_input" },
      activeRuns: [{ id: "waiting-run", botId: "bot-1", status: "waiting_input" }],
      members: [{ botId: "bot-1", name: "Writer", color: "blue", status: "waiting_input" }],
    };
    const event = {
      type: "run.started",
      seq: 9,
      runId: "ticket-run",
      botId: "bot-1",
      payload: { trigger: "tickets" },
    };

    const next = reduceThreadSnapshot(initial, event);

    expect(next?.cursor).toBe(9);
    expect(next?.run).toBe(initial.run);
    expect(next?.activeRuns).toBe(initial.activeRuns);
    expect(next?.members).toBe(initial.members);
    expect(next?.messages).toBe(initial.messages);
    expect(reduceThreadSnapshot(next, event)).toBe(next);
  });

  it("updates only the matching member and cursor when a start omits its run ID", () => {
    const initial: LiveSnapshot = {
      ...liveSnapshot(),
      groupId: "group-1",
      run: { id: "waiting-run", botId: "bot-1", status: "waiting_takeover" },
      activeRuns: [{ id: "waiting-run", botId: "bot-1", status: "waiting_takeover" }],
      members: [
        { botId: "bot-1", name: "Writer", color: "blue", status: "waiting_takeover" },
        { botId: "bot-2", name: "Researcher", color: "green", status: "idle" },
      ],
    };

    const next = reduceThreadSnapshot(initial, {
      type: "run.started",
      seq: 9,
      botId: "bot-2",
    });

    expect(next).toEqual({
      ...initial,
      cursor: 9,
      members: [
        initial.members![0],
        { botId: "bot-2", name: "Researcher", color: "green", status: "running" },
      ],
    });
    expect(next?.run).toBe(initial.run);
    expect(next?.activeRuns).toBe(initial.activeRuns);
    expect(next?.members?.[0]).toBe(initial.members?.[0]);
    expect(reduceThreadSnapshot(next, { type: "run.started", seq: 9, botId: "bot-2" })).toBe(next);
  });

  it("does not invent members for a start with an unknown bot or run ID", () => {
    const initial: LiveSnapshot = {
      ...liveSnapshot(),
      groupId: "group-1",
      members: [{ botId: "bot-1", name: "Writer", color: "blue", status: "idle" }],
    };

    const next = reduceThreadSnapshot(initial, {
      type: "run.started",
      seq: 9,
      botId: "unknown-bot",
    });

    expect(next).toEqual({ ...initial, cursor: 9 });
    expect(next?.members).toBe(initial.members);
    expect(reduceThreadSnapshot(initial, { type: "run.started" })).toBe(initial);
  });

  it("does not infer a started run's bot from the snapshot", () => {
    const initial: LiveSnapshot = {
      ...liveSnapshot(),
      members: [{ botId: "bot-1", name: "Writer", color: "blue", status: "idle" }],
    };

    const next = reduceThreadSnapshot(initial, {
      type: "run.started",
      runId: "unattributed-run",
    });

    expect(next?.cursor).toBe(3);
    expect(next?.run).toMatchObject({ id: "unattributed-run", status: "running", error: null });
    expect(next?.activeRuns).toMatchObject([
      { id: "unattributed-run", status: "running", error: null },
    ]);
    expect(next?.members).toBe(initial.members);
  });

  it("deduplicates a restarted run and retains every other active lifecycle state", () => {
    const retained = [
      { id: "queued-run", status: "queued" },
      { id: "leased-run", status: "leased" },
      { id: "running-run", status: "running" },
      { id: "ask-run", status: "waiting_input" },
      { id: "takeover-run", status: "waiting_takeover" },
    ];
    const initial: LiveSnapshot = {
      ...liveSnapshot(),
      run: retained[3]!,
      activeRuns: [
        ...retained,
        { id: "resumed-run", botId: "bot-2", status: "waiting_input" },
        { id: "resumed-run", botId: "bot-2", status: "running" },
        { id: "completed-run", status: "completed" },
        { id: "failed-run", status: "failed" },
        { id: "cancelled-run", status: "cancelled" },
      ],
    };
    const event = { type: "run.started", seq: 9, runId: "resumed-run", botId: "bot-2" };

    const next = reduceThreadSnapshot(initial, event);
    const replayed = reduceThreadSnapshot(next, event);

    expect(next?.run).toMatchObject({
      id: "resumed-run",
      botId: "bot-2",
      status: "running",
      error: null,
    });
    expect(next?.activeRuns).toMatchObject([
      ...retained,
      { id: "resumed-run", botId: "bot-2", status: "running", error: null },
    ]);
    expect(replayed?.activeRuns).toEqual(next?.activeRuns);
  });

  it("retains a waiting primary run when the snapshot omits activeRuns", () => {
    const initial: LiveSnapshot = {
      ...liveSnapshot(),
      run: { id: "waiting-run", botId: "bot-1", status: "waiting_takeover" },
    };

    const next = reduceThreadSnapshot(initial, {
      type: "run.started",
      runId: "peer-run",
      botId: "bot-2",
    });

    expect(next?.activeRuns).toMatchObject([
      { id: "waiting-run", botId: "bot-1", status: "waiting_takeover" },
      { id: "peer-run", botId: "bot-2", status: "running", error: null },
    ]);
    expect(next?.run).toMatchObject({
      id: "peer-run",
      botId: "bot-2",
      status: "running",
      error: null,
    });
  });

  it("retains an unrelated group failure until that failed run starts again", () => {
    const initial: LiveSnapshot = {
      ...liveSnapshot(),
      groupId: "group-1",
      run: { id: "failed-run", botId: "bot-1", status: "failed", error: "Provider unavailable" },
      activeRuns: [{ id: "waiting-run", botId: "bot-2", status: "waiting_input" }],
    };

    const next = reduceThreadSnapshot(initial, {
      type: "run.started",
      seq: 9,
      runId: "peer-run",
      botId: "bot-3",
    });

    expect(next?.run).toBe(initial.run);
    expect(next?.activeRuns).toMatchObject([
      { id: "waiting-run", botId: "bot-2", status: "waiting_input" },
      { id: "peer-run", botId: "bot-3", status: "running", error: null },
    ]);
    const restarted = reduceThreadSnapshot(next, {
      type: "run.started",
      seq: 10,
      runId: "failed-run",
      botId: "bot-1",
    });
    expect(restarted?.cursor).toBe(10);
    expect(restarted?.run).toMatchObject({
      id: "failed-run",
      botId: "bot-1",
      status: "running",
      error: null,
    });
    expect(restarted?.activeRuns).toMatchObject([
      { id: "waiting-run", botId: "bot-2", status: "waiting_input" },
      { id: "peer-run", botId: "bot-3", status: "running", error: null },
      { id: "failed-run", botId: "bot-1", status: "running", error: null },
    ]);
  });

  it("replaces an unrelated failure when a direct thread starts work", () => {
    const initial: LiveSnapshot = {
      ...liveSnapshot(),
      run: { id: "failed-run", status: "failed", error: "Provider unavailable" },
    };

    const next = reduceThreadSnapshot(initial, {
      type: "run.started",
      seq: 9,
      runId: "new-run",
      botId: "bot-1",
    });

    expect(next?.run).toMatchObject({
      id: "new-run",
      botId: "bot-1",
      status: "running",
      error: null,
    });
    expect(next?.activeRuns).toMatchObject([
      { id: "new-run", botId: "bot-1", status: "running", error: null },
    ]);
  });

  it("accumulates progress deltas for the same run", () => {
    const first = reduceThreadSnapshot(liveSnapshot(), {
      type: "thread.progress",
      runId: "run-1",
      payload: { delta: "Hel" },
    });
    const second = reduceThreadSnapshot(first, {
      type: "thread.progress",
      runId: "run-1",
      payload: { delta: "lo" },
    });

    expect(second?.messages).toMatchObject([
      {
        id: "progress:run-1",
        role: "bot",
        runId: "run-1",
        blocks: [{ kind: "progress", text: "Hello" }],
      },
    ]);
  });

  it("preserves progress from a legacy run-only snapshot", () => {
    const initial: LiveSnapshot = {
      ...liveSnapshot([
        {
          ...liveMessage("progress:run-legacy", [{ kind: "progress", text: "Still working" }]),
          runId: "run-legacy",
        },
      ]),
      run: { id: "run-legacy", status: "running" },
      activeRuns: undefined,
    };

    const next = reduceThreadSnapshot(initial, {
      type: "thread.progress",
      runId: "run-new",
      payload: { text: "New work" },
    });

    expect(next?.messages.map((item) => item.id)).toEqual([
      "progress:run-legacy",
      "progress:run-new",
    ]);
  });

  it("preserves concurrent progress when active-run metadata lags", () => {
    const initial: LiveSnapshot = {
      ...liveSnapshot([
        {
          ...liveMessage("progress:run-concurrent", [
            { kind: "progress", text: "Concurrent work" },
          ]),
          runId: "run-concurrent",
        },
      ]),
      run: { id: "run-current", status: "running" },
      activeRuns: [{ id: "run-current", status: "running" }],
    };

    const next = reduceThreadSnapshot(initial, {
      type: "thread.progress",
      runId: "run-current",
      payload: { text: "Current work" },
    });

    expect(next?.messages.map((item) => item.id)).toEqual([
      "progress:run-concurrent",
      "progress:run-current",
    ]);
  });

  it("deduplicates durable messages and replaces matching transient subagent state", () => {
    const initial = liveSnapshot([
      liveMessage("message-1", [{ kind: "text", text: "old" }]),
      liveMessage("subagent:research", [
        {
          kind: "subagent",
          agentId: "research",
          name: "Research",
          task: "Search",
          status: "running",
        },
      ]),
      liveMessage("subagent:other", [
        { kind: "subagent", agentId: "other", name: "Other", task: "Wait", status: "running" },
      ]),
      {
        ...liveMessage("progress:run-1", [{ kind: "progress", text: "draft" }]),
        runId: "run-1",
      },
    ]);
    const completed = {
      kind: "subagent" as const,
      agentId: "research",
      name: "Research",
      task: "Search",
      status: "completed" as const,
      result: "Done",
    };

    const next = reduceThreadSnapshot(initial, {
      id: "event-1",
      type: "thread.message.created",
      seq: 9,
      runId: "run-1",
      payload: { messageId: "message-1", role: "bot", blocks: [completed] },
    });

    expect(next?.messages.map((item) => item.id)).toEqual(["message-1", "subagent:other"]);
    expect(next?.messages[0]?.blocks).toEqual([completed]);
  });

  it("clears loaded history and active state when another client clears the thread", () => {
    const initial = liveSnapshot([liveMessage("message-1", [{ kind: "text", text: "old" }])], 1);
    initial.run = { id: "run-1", status: "running" };

    const next = reduceThreadSnapshot(initial, { type: "thread.cleared", seq: 12 });

    expect(next).toMatchObject({ cursor: 12, messages: [], olderCursor: null, run: null });
  });

  it("applies the durable waiting-input run transition", () => {
    const initial: LiveSnapshot = { ...liveSnapshot(), run: { id: "run-1", status: "running" } };
    const waiting = reduceThreadSnapshot(initial, {
      type: "run.waiting_input",
      runId: "run-1",
      seq: 8,
    });

    expect(waiting?.run?.status).toBe("waiting_input");
    expect(waiting?.cursor).toBe(8);
    const repeated = reduceThreadSnapshot(waiting, {
      type: "run.waiting_input",
      runId: "run-1",
      seq: 9,
    });
    expect(repeated?.cursor).toBe(9);
    expect(repeated?.run).toBe(waiting?.run);
  });

  it("applies the waiting-input owner only to its run", () => {
    const type = "run.waiting_input";
    const status = "waiting_input";
    const initial: LiveSnapshot = {
      ...liveSnapshot(),
      run: { id: "run-1", status: "running", userId: "old-owner" },
      activeRuns: [
        { id: "run-1", status: "running", userId: "old-owner" },
        { id: "run-2", status: "running", userId: "other-owner" },
      ],
    };
    const waiting = reduceThreadSnapshot(initial, {
      type,
      runId: "run-1",
      payload: { userId: "owner-1" },
    });

    expect(waiting?.run).toEqual({ id: "run-1", status, userId: "owner-1" });
    expect(waiting?.activeRuns).toEqual([
      { id: "run-1", status, userId: "owner-1" },
      { id: "run-2", status: "running", userId: "other-owner" },
    ]);

    const corrected = reduceThreadSnapshot(waiting, {
      type,
      runId: "run-1",
      payload: { userId: "owner-2" },
    });
    expect(corrected?.run?.userId).toBe("owner-2");
    expect(corrected?.activeRuns?.[0]?.userId).toBe("owner-2");

    const repeated = reduceThreadSnapshot(corrected, {
      type,
      runId: "run-1",
      payload: { userId: "owner-2" },
    });
    expect(repeated).toBe(corrected);

    const legacy = reduceThreadSnapshot(corrected, { type, runId: "run-1" });
    expect(legacy?.run?.userId).toBe("owner-2");
    expect(legacy?.activeRuns?.[0]?.userId).toBe("owner-2");
  });

  it("records the owner of an inserted waiting group run without changing another run", () => {
    const initial: LiveSnapshot = {
      ...liveSnapshot(),
      groupId: "group-1",
      run: { id: "run-1", status: "waiting_input", userId: "owner-1" },
      activeRuns: [{ id: "run-1", status: "waiting_input", userId: "owner-1" }],
    };
    const waiting = reduceThreadSnapshot(initial, {
      type: "run.waiting_input",
      runId: "run-2",
      botId: "bot-2",
      payload: { userId: "owner-2" },
    });

    expect(waiting?.run).toEqual(initial.run);
    expect(waiting?.activeRuns).toMatchObject([
      initial.run,
      { id: "run-2", botId: "bot-2", status: "waiting_input", userId: "owner-2" },
    ]);
    const withoutRunId = reduceThreadSnapshot(waiting, {
      type: "run.waiting_input",
      payload: { userId: "unknown-owner" },
    });
    expect(withoutRunId?.run).toEqual(waiting?.run);
    expect(withoutRunId?.activeRuns).toEqual(waiting?.activeRuns);
  });

  it("hydrates a late owner on an already-waiting group run", () => {
    const initial: LiveSnapshot = {
      ...liveSnapshot(),
      groupId: "group-1",
      run: { id: "run-newer", status: "running", userId: "other-owner" },
      activeRuns: [
        { id: "run-newer", status: "running", userId: "other-owner" },
        { id: "run-waiting", status: "waiting_input" },
      ],
    };
    const next = reduceThreadSnapshot(initial, {
      type: "run.waiting_input",
      runId: "run-waiting",
      payload: { userId: "owner" },
    });
    expect(next?.run).toBe(initial.run);
    expect(next?.activeRuns).toEqual([
      initial.run,
      { id: "run-waiting", status: "waiting_input", userId: "owner" },
    ]);
  });

  it("does not infer an owner from a legacy waiting event or takeover payload", () => {
    const legacy = reduceThreadSnapshot(liveSnapshot(), {
      type: "run.waiting_input",
      runId: "run-1",
    });
    expect(legacy?.run).toMatchObject({ id: "run-1", status: "waiting_input" });
    expect(legacy?.run?.userId).toBeUndefined();
    const takeover = reduceThreadSnapshot(liveSnapshot(), {
      type: "computer.takeover.requested",
      runId: "run-2",
      payload: { userId: "owner" },
    });
    expect(takeover?.run).toMatchObject({ id: "run-2", status: "waiting_takeover" });
    expect(takeover?.run?.userId).toBeUndefined();
  });

  it.each([undefined, "group-1"])(
    "allows only the owner to dismiss a live secret ask in %s",
    (groupId) => {
      const ask = {
        ...liveMessage("ask-1", [
          { kind: "ask", text: "Secret", input: "secret", status: "pending" },
        ]),
        runId: "run-1",
      };
      const initial: LiveSnapshot = {
        ...liveSnapshot([ask]),
        groupId,
        run: { id: "run-1", status: "running" },
        activeRuns: [{ id: "run-1", status: "running" }],
      };
      const waiting = reduceThreadSnapshot(initial, {
        type: "run.waiting_input",
        runId: "run-1",
        payload: { userId: "owner" },
      });

      expect(dismissableAskMessageIds(waiting, "owner")).toEqual(new Set(["ask-1"]));
      expect(dismissableAskMessageIds(waiting, "other")).toEqual(new Set());
      expect(
        dismissableAskMessageIds(
          reduceThreadSnapshot(initial, { type: "run.waiting_input", runId: "run-1" }),
          "owner",
        ),
      ).toEqual(new Set());
    },
  );

  it("applies computer takeover requests as waiting_takeover", () => {
    const progress = liveMessage("progress:run-1", [{ kind: "progress", text: "working…" }], 1);
    const initial: LiveSnapshot = {
      ...liveSnapshot([progress]),
      run: { id: "run-1", status: "running" },
      activeRuns: [{ id: "run-1", status: "running" }],
    };
    const waiting = reduceThreadSnapshot(initial, {
      type: "computer.takeover.requested",
      runId: "run-1",
      seq: 10,
    });

    expect(waiting?.run?.status).toBe("waiting_takeover");
    expect(waiting?.activeRuns?.[0]?.status).toBe("waiting_takeover");
    expect(waiting?.messages.some((message) => message.id.startsWith("progress:"))).toBe(false);
    expect(waiting?.cursor).toBe(10);

    const released = reduceThreadSnapshot(
      {
        ...initial,
        run: { id: "run-1", status: "waiting_takeover" },
        activeRuns: [
          { id: "run-1", status: "waiting_takeover" },
          { id: "run-2", status: "waiting_takeover" },
        ],
      },
      {
        type: "computer.takeover.released",
        runId: "run-1",
        seq: 11,
      },
    );
    expect(released?.run?.status).toBe("queued");
    expect(released?.activeRuns).toEqual([
      { id: "run-1", status: "queued" },
      { id: "run-2", status: "waiting_takeover" },
    ]);
    expect(released?.cursor).toBe(11);

    const running = reduceThreadSnapshot(
      {
        ...liveSnapshot(),
        run: { id: "run-1", status: "running" },
        activeRuns: [{ id: "run-1", status: "running" }],
      },
      { type: "computer.takeover.released", runId: "run-1", seq: 12 },
    );
    expect(running?.run?.status).toBe("running");
    expect(running?.activeRuns?.[0]?.status).toBe("running");
  });

  it("advances the cursor for durable message events", () => {
    const next = reduceThreadSnapshot(liveSnapshot(), {
      type: "thread.message.created",
      seq: 11,
      payload: { messageId: "message-1", role: "bot", blocks: [{ kind: "text", text: "Done" }] },
    });

    expect(next?.cursor).toBe(11);
  });

  it("preserves ask actions and runId on created messages", () => {
    const initial = liveSnapshot();
    const askBlock = {
      kind: "ask",
      text: "Review before writing",
      detail: "title: Result",
      status: "pending",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "always", label: "Always allow" },
        { id: "deny", label: "Deny" },
      ],
    };

    const next = reduceThreadSnapshot(initial, {
      type: "thread.message.created",
      runId: "run-1",
      payload: { messageId: "message-ask", role: "bot", blocks: [askBlock] },
    });

    expect(next?.messages.at(-1)).toMatchObject({
      id: "message-ask",
      runId: "run-1",
      blocks: [askBlock],
    });
  });

  it("keeps a failed member run's error while another member run is still active", () => {
    const runA = { id: "run-a", status: "running" };
    const runB = { id: "run-b", status: "running" };
    const initial: LiveSnapshot = {
      ...liveSnapshot([
        {
          ...liveMessage("progress:run-b", [{ kind: "progress", text: "B" }]),
          runId: runB.id,
        },
      ]),
      run: runA,
      activeRuns: [runA, runB],
    };

    const next = reduceThreadSnapshot(initial, {
      type: "run.failed",
      seq: 11,
      runId: runB.id,
      payload: { error: "member exploded" },
    });

    expect(next?.activeRuns).toEqual([runA]);
    expect(next?.run).toEqual({ id: runB.id, status: "failed", error: "member exploded" });
    expect(next?.messages).toEqual([]);
  });

  it("updates a cloud agent card from thread.cloud_agent", () => {
    const initial = liveSnapshot([
      liveMessage("msg-ca", [
        {
          kind: "cloud_agent",
          agentId: "ca-1",
          title: "Add README",
          status: "running",
          url: "https://example.test/agents/ca-1",
        },
      ]),
    ]);

    const next = reduceThreadSnapshot(initial, {
      type: "thread.cloud_agent",
      seq: 9,
      payload: {
        messageId: "msg-ca",
        agentId: "ca-1",
        title: "Add README",
        status: "finished",
        url: "https://example.test/agents/ca-1",
        branch: "cursor/add-readme",
        prUrl: "https://github.com/example/repo/pull/1",
      },
    });

    expect(next?.cursor).toBe(9);
    expect(next?.messages[0]?.blocks[0]).toEqual({
      kind: "cloud_agent",
      agentId: "ca-1",
      title: "Add README",
      status: "finished",
      url: "https://example.test/agents/ca-1",
      branch: "cursor/add-readme",
      prUrl: "https://github.com/example/repo/pull/1",
    });
  });

  it("resumes a waiting run without duplicating it or dropping other paused runs", () => {
    const initial: LiveSnapshot = {
      ...liveSnapshot(),
      run: { id: "run-1", status: "waiting_input" },
      activeRuns: [
        { id: "run-1", status: "waiting_input" },
        { id: "run-2", status: "waiting_takeover" },
        { id: "run-old", status: "completed" },
      ],
    };
    const next = reduceThreadSnapshot(initial, { type: "run.started", runId: "run-1" });
    expect(next?.run?.status).toBe("running");
    expect(next?.activeRuns).toMatchObject([
      { id: "run-2", status: "waiting_takeover" },
      { id: "run-1", status: "running", error: null },
    ]);
  });

  it("ignores background run starts and preserves group failures on member starts", () => {
    const initial: LiveSnapshot = {
      ...liveSnapshot(),
      groupId: "group-1",
      run: { id: "run-failed", status: "failed", error: "Failed" },
      activeRuns: [],
    };
    expect(
      reduceThreadSnapshot(initial, {
        type: "run.started",
        runId: "run-background",
        payload: { trigger: "tickets" },
      }),
    ).toBe(initial);
    const next = reduceThreadSnapshot(initial, { type: "run.started", runId: "run-new" });
    expect(next?.run).toBe(initial.run);
    expect(next?.activeRuns).toMatchObject([{ id: "run-new", status: "running", error: null }]);
  });

  it("leaves the snapshot unchanged for unrelated events", () => {
    const initial = liveSnapshot();
    expect(reduceThreadSnapshot(initial, { type: "thread.unrecognized" })).toBe(initial);
    expect(reduceThreadSnapshot(initial, { type: "run.checkpointed" })).toBe(initial);
    expect(reduceThreadSnapshot(null, { type: "thread.progress" })).toBeNull();
  });

  it("keeps the thread id on live messages so inline cards can act on them", () => {
    const view = reduceThreadSnapshot(
      { threadId: "chat", messages: [], olderCursor: null, run: null } as LiveSnapshot,
      {
        type: "thread.message.created",
        seq: 1,
        payload: { messageId: "card", role: "bot", blocks: [] },
      } as never,
    );
    expect(view?.messages[0]?.threadId).toBe("chat");
  });
});

type LiveSnapshot = Omit<LiveThreadSnapshot, "members"> & {
  members?: ThreadSnapshot["members"];
  computer?: Partial<ComputerStatus>;
};

function liveSnapshot(
  messages: LiveThreadMessage[] = [],
  olderCursor: number | null = null,
): LiveSnapshot {
  return {
    botId: "bot-1",
    threadId: "thread-1",
    cursor: 3,
    messages,
    olderCursor,
    run: null,
    computer: {
      state: "running",
      controlHolder: "bot",
      screenAvailable: true,
      mode: "team",
      busyBotName: null,
    },
  };
}

function liveMessage(
  id: string,
  blocks: LiveThreadMessage["blocks"],
  seq?: number,
): LiveThreadMessage {
  return { id, threadId: "thread-1", seq, role: "bot", blocks };
}
