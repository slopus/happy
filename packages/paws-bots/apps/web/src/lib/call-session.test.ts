import { ORPCError } from "@orpc/client";
import type { ProductEvent, ThreadMessage, ThreadSnapshot } from "@rakazo/contracts";
import type * as CoreModule from "@rakazo/core";
import {
  callIdFromClientNonce,
  groupVoiceChats,
  INTERIM_BARGE_IN_MS,
  reduceThreadSnapshot,
  runThreadSubscription,
} from "@rakazo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pickUp } from "./call-pickup.js";
import { ECHO_GUARD_MS, endCall, getSnapshot, startCall, toggleMute } from "./call-session";
import { dictation, usesServerDictation } from "./dictation.js";
import { recheckSessionOnUnauthorized, rpc } from "./rpc.js";
import { speaker } from "./tts.js";

// The macro compiles away in the app build; tests run the source, so tag the template as-is.
vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
}));

vi.mock("@rakazo/core", async (importOriginal) => ({
  ...(await importOriginal<typeof CoreModule>()),
  runThreadSubscription: vi.fn(async () => undefined),
}));

vi.mock("./call-pickup.js", () => ({
  pickUp: vi.fn(async () => undefined),
}));

vi.mock("./dictation.js", () => ({
  usesServerDictation: vi.fn(() => false),
  dictation: {
    recording: false,
    listen: vi.fn(async () => undefined),
    stop: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
  },
}));

vi.mock("./tts.js", () => ({
  speaker: {
    speak: vi.fn(async () => undefined),
    stop: vi.fn(),
    unlock: vi.fn(),
    isSpeaking: vi.fn(() => false),
    subscribe: vi.fn(() => () => undefined),
  },
}));

vi.mock("./rpc.js", () => ({
  recheckSessionOnUnauthorized: vi.fn(),
  rpc: {
    threads: {
      answer: vi.fn(),
      endCall: vi.fn(async () => ({ ok: true })),
      followUp: vi.fn(),
      get: vi.fn(),
      head: vi.fn(),
      send: vi.fn(),
      subscribe: vi.fn(),
    },
  },
}));

const listen = vi.mocked(dictation.listen);
const speak = vi.mocked(speaker.speak);
const isSpeaking = vi.mocked(speaker.isSpeaking);
const send = vi.mocked(rpc.threads.send);
const answer = vi.mocked(rpc.threads.answer);
const followUp = vi.mocked(rpc.threads.followUp);
const getThread = vi.mocked(rpc.threads.get);
const endCallRpc = vi.mocked(rpc.threads.endCall);

describe("call session", () => {
  beforeEach(() => {
    // Retry and reconnect waits are jittered; pin them to their unjittered values.
    vi.spyOn(Math, "random").mockReturnValue(0);
    endCall();
    vi.clearAllMocks();
    vi.useFakeTimers();
    isSpeaking.mockReturnValue(false);
    listen.mockResolvedValue(undefined);
    answer.mockResolvedValue({ ok: true } as never);
    followUp.mockResolvedValue({ runId: "run-1", taskId: "task-1" } as never);
    getThread.mockResolvedValue(snapshot([]) as never);
    send.mockResolvedValue({ runId: "run-1", taskId: "task-1" } as never);
    endCallRpc.mockResolvedValue({ ok: true } as never);
  });

  afterEach(() => {
    endCall();
    vi.useRealTimers();
  });

  it("starts listening for the bot on the call", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: true });
    await Promise.resolve();

    expect(getSnapshot()).toMatchObject({
      botId: "call-bot",
      botName: "Ada",
      phase: "listening",
      muted: false,
    });
    expect(listen).toHaveBeenCalledWith(expect.objectContaining({ transcribe: true }));
  });

  it("releases the microphone after an empty give-up without retrying automatically", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    await Promise.resolve();
    const watcher = vi.mocked(dictation.subscribe).mock.calls.at(-1)?.[0];
    const error = "The browser keeps dropping the microphone. Start dictation again to retry.";
    watcher?.({ status: "idle", transcript: "", error });

    expect(getSnapshot()?.caption).toBe(error);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(listen).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();

    // Playback requests the microphone again without resetting its guard first.
    const speech = vi.mocked(speaker.subscribe).mock.calls.at(-1)?.[0];
    speech?.({ status: "speaking", caption: "Are you there?" });
    await Promise.resolve();
    expect(listen).toHaveBeenCalledTimes(2);
  });

  it("reopens listening when a finished turn transcribes to nothing", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: true });
    // The dictation session ends an empty attempt by publishing idle, then the final.
    const watcher = vi.mocked(dictation.subscribe).mock.calls.at(-1)?.[0];
    watcher?.({ status: "idle", transcript: "" });
    await heard("");

    expect(listen).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled();
    expect(followUp).not.toHaveBeenCalled();
    expect(getSnapshot()?.phase).toBe("listening");
  });

  it("keeps recovered active work when an older call refresh finishes late", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    const feed = vi.mocked(runThreadSubscription).mock.calls.at(-1)![0];
    const stale = deferred<ThreadSnapshot>();
    getThread
      .mockReturnValueOnce(stale.promise as never)
      .mockResolvedValueOnce({ ...snapshot([], runningRun), cursor: 12 } as never);
    const oldRefresh = feed.refresh();
    await feed.refresh();
    feed.applyEvent({
      ...userMessageEvent("call-1"),
      seq: 13,
      type: "run.started",
      runId: "run-1",
      payload: { trigger: "user" },
    });
    stale.resolve({ ...snapshot([]), cursor: 10 });
    await oldRefresh;

    await heard("continue the current task");

    expect(followUp).toHaveBeenCalledWith(
      expect.objectContaining({ botId: "call-bot", text: "continue the current task" }),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("accepts a usable older refresh when a newer request failed", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    const feed = vi.mocked(runThreadSubscription).mock.calls.at(-1)![0];
    const available = deferred<ThreadSnapshot>();
    getThread
      .mockReturnValueOnce(available.promise as never)
      .mockRejectedValueOnce(new Error("refresh unavailable"));
    const oldRefresh = feed.refresh();
    await expect(feed.refresh()).rejects.toThrow("refresh unavailable");
    available.resolve({ ...snapshot([], runningRun), cursor: 12 });
    await oldRefresh;

    await heard("continue the recovered task");

    expect(followUp).toHaveBeenCalledWith(
      expect.objectContaining({ botId: "call-bot", text: "continue the recovered task" }),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["behind", "ahead"] as const)(
    "keeps live call work after overlapping recovery snapshots %s of the stream",
    async (position) => {
      const actual = await vi.importActual<{ runThreadSubscription: typeof runThreadSubscription }>(
        "@rakazo/core",
      );
      vi.mocked(runThreadSubscription).mockImplementationOnce(actual.runThreadSubscription);
      const first = eventStream();
      const recovered = eventStream();
      const stale = deferred<ThreadSnapshot>();
      const recoveredSnapshot = {
        ...snapshot([], position === "ahead" ? runningRun : null),
        cursor: position === "ahead" ? 15 : 12,
      };
      getThread
        .mockRejectedValueOnce(new Error("snapshot unavailable"))
        .mockReturnValueOnce(stale.promise as never)
        .mockResolvedValue(recoveredSnapshot as never);
      vi.mocked(rpc.threads.head).mockResolvedValue({
        threadId: "thread-1",
        cursor: 10,
      } as never);
      vi.mocked(rpc.threads.subscribe)
        .mockResolvedValueOnce(first.events as never)
        .mockResolvedValueOnce(recovered.events as never);

      await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
      await vi.advanceTimersByTimeAsync(250);
      for (const seq of [11, 12]) {
        first.send({ ...userMessageEvent("call-1"), id: `event-${seq}`, seq });
        await vi.advanceTimersByTimeAsync(0);
      }
      first.end();
      await vi.advanceTimersByTimeAsync(0);
      recovered.send({
        ...userMessageEvent("call-1"),
        id: "event-13",
        seq: 13,
        type: "run.started",
        runId: "run-1",
        payload: { trigger: "user" },
      });
      await vi.advanceTimersByTimeAsync(0);
      stale.resolve({
        ...snapshot([botMessage("stale-reply", "An obsolete reply")]),
        cursor: position === "ahead" ? 20 : 10,
      });
      await vi.advanceTimersByTimeAsync(0);

      await heard("continue the current task");
      await vi.advanceTimersByTimeAsync(0);
      expect(followUp).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ botId: "call-bot", text: "continue the current task" }),
      );
      expect(send).not.toHaveBeenCalled();
      expect(speak).not.toHaveBeenCalled();

      recovered.send({
        ...userMessageEvent("call-1"),
        id: "event-16",
        seq: 16,
        runId: "run-1",
        payload: {
          messageId: "current-reply",
          role: "bot",
          blocks: [{ kind: "text", text: "The current task is done" }],
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      recovered.send({
        ...userMessageEvent("call-1"),
        id: "event-17",
        seq: 17,
        type: "run.completed",
        runId: "run-1",
        payload: {},
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(speak).toHaveBeenCalledExactlyOnceWith("The current task is done", {
        botId: "call-bot",
        messageId: "current-reply",
      });
      expect(getSnapshot()?.exchanges).toEqual([
        { role: "user", text: "continue the current task" },
        { role: "bot", text: "The current task is done" },
      ]);
    },
  );

  it("keeps a newer live run when the post-send snapshot lags behind", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    const callbacks = vi.mocked(runThreadSubscription).mock.calls.at(-1)![0];
    getThread.mockResolvedValueOnce({ ...snapshot([]), cursor: 12 } as never);
    await callbacks.refresh();
    const stale = deferred<ThreadSnapshot>();
    getThread.mockReturnValueOnce(stale.promise as never);
    await heard("start the task");
    await flushMicrotasks();
    callbacks.applyEvent({
      ...userMessageEvent("call-1"),
      seq: 13,
      type: "run.started",
      runId: "run-1",
      payload: { trigger: "user" },
    });
    stale.resolve({ ...snapshot([botMessage("stale", "An obsolete reply")]), cursor: 12 });
    await flushMicrotasks();
    await heard("keep working");

    expect(followUp).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: "keep working" }),
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(speak).not.toHaveBeenCalled();
  });

  it.each([
    ["refresh", "ended"],
    ["refresh", "replaced"],
    ["post-send", "ended"],
    ["post-send", "replaced"],
  ] as const)("ignores a late %s snapshot after the call is %s", async (source, retirement) => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    const callbacks = vi.mocked(runThreadSubscription).mock.calls.at(-1)![0];
    const stale = deferred<ThreadSnapshot>();
    getThread.mockReturnValueOnce(stale.promise as never);
    const loading = source === "refresh" ? callbacks.refresh() : heard("old request");
    await flushMicrotasks();
    endCall();
    if (retirement === "replaced") {
      await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
      const replacement = vi.mocked(runThreadSubscription).mock.calls.at(-1)![0];
      getThread.mockResolvedValue({ ...snapshot([], runningRun), cursor: 12 } as never);
      await replacement.refresh();
      await heard("continue the replacement task");
      await flushMicrotasks();
    }
    stale.resolve({ ...snapshot([botMessage("stale", "An obsolete reply")]), cursor: 20 });
    await loading;
    await flushMicrotasks();

    expect(speak).not.toHaveBeenCalled();
    if (retirement === "ended") {
      expect(getSnapshot()).toBeNull();
    } else {
      expect(getSnapshot()).toMatchObject({
        phase: "thinking",
        caption: "",
        exchanges: [{ role: "user", text: "continue the replacement task" }],
      });
      await heard("still working on the replacement");
      expect(followUp).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: "still working on the replacement" }),
      );
    }
    const requests = getThread.mock.calls.length;
    await callbacks.refresh();
    expect(getThread).toHaveBeenCalledTimes(requests);
  });

  it("reports a post-send snapshot failure without losing the call", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    getThread.mockRejectedValueOnce(new Error("snapshot offline"));

    await heard("start the task");
    await flushMicrotasks();

    expect(getSnapshot()).toMatchObject({
      botId: "call-bot",
      phase: "listening",
      exchanges: [{ role: "user", text: "start the task" }],
    });
    expect(getSnapshot()?.caption).not.toBe("");
    getThread.mockResolvedValue(snapshot([botMessage("current", "The task is done")]) as never);
    await heard("try again");
    await flushMicrotasks();
    expect(speak).toHaveBeenCalledExactlyOnceWith("The task is done", {
      botId: "call-bot",
      messageId: "current",
    });
  });

  it("sends what it heard to the bot on the call, not the bot on screen", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    await heard("book the flight");

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ botId: "call-bot", text: "book the flight" }),
    );
    expect(getSnapshot()).toMatchObject({
      phase: "thinking",
      exchanges: [{ role: "user", text: "book the flight" }],
    });
  });

  it("tags a spoken answer with this call's client nonce", async () => {
    const ask = {
      ...botMessage("ask-1", ""),
      blocks: [{ kind: "ask" as const, text: "Which city?", status: "pending" as const }],
    };
    const waitingRun = { ...runningRun, status: "waiting_input" } as ThreadSnapshot["run"];
    getThread.mockResolvedValue(snapshot([ask], waitingRun) as never);
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    const feed = vi.mocked(runThreadSubscription).mock.calls.at(-1)?.[0];
    await feed?.refresh();

    await heard("Toronto");

    expect(answer).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: "call-bot",
        messageId: "ask-1",
        answer: "Toronto",
        clientNonce: expect.stringMatching(/^call:/),
      }),
    );
    expect(callIdFromClientNonce(String(answer.mock.calls[0]?.[0]?.clientNonce))).toBeDefined();
  });

  it("answers the caller's turn, never a bot message from before it", async () => {
    const earlier = { ...botMessage("earlier-1", "Booked for Friday"), runId: "run-0" };
    const turn = callerMessage("check the site");
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    const feed = vi.mocked(runThreadSubscription).mock.calls.at(-1)?.[0];
    // The caller's message lands before its run does; the earlier run already ended.
    getThread.mockResolvedValue(snapshot([earlier, turn]) as never);
    await heard("check the site");
    expect(speak).not.toHaveBeenCalled();
    expect(getSnapshot()?.phase).toBe("thinking");

    // A refreshed snapshot puts the working run's progress message last; until that run
    // stops, the call keeps waiting instead of reading another run's note.
    const note = { ...botMessage("note-1", "Daily summary ready"), runId: "run-9" };
    getThread.mockResolvedValue(
      snapshot([earlier, turn, note, streamingMessage("Checking")], runningRun) as never,
    );
    await feed?.refresh();
    expect(speak).not.toHaveBeenCalled();

    getThread.mockResolvedValue(
      snapshot([earlier, turn, note, botMessage("message-1", "On it.")]) as never,
    );
    await feed?.refresh();
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledWith(
      "On it.",
      expect.objectContaining({ messageId: "message-1" }),
    );
  });

  it.each(["failed", "cancelled", "completed"])(
    "listens after a first turn ends with run.%s and no reply, then speaks a later reply",
    async (status) => {
      await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
      const feed = vi.mocked(runThreadSubscription).mock.calls.at(-1)![0];
      getThread.mockResolvedValue(snapshot([callerMessage("hello")], runningRun) as never);
      await heard("hello");
      expect(getSnapshot()?.phase).toBe("thinking");
      feed.applyEvent({
        ...userMessageEvent("call-1"),
        seq: 10,
        type: `run.${status}`,
        runId: "run-1",
        payload: status === "failed" ? { error: "Something went wrong. Try again." } : {},
      } as ProductEvent);
      expect(getSnapshot()).toMatchObject({
        phase: "listening",
        caption: "Something went wrong. Try again.",
      });
      expect(speak).not.toHaveBeenCalled();

      send.mockResolvedValue({ runId: "run-2", taskId: "task-2" } as never);
      getThread.mockResolvedValue({
        ...snapshot([
          callerMessage("hello"),
          { ...callerMessage("try again"), id: "turn-2", runId: "run-2" },
          { ...botMessage("message-2", "Ready."), runId: "run-2" },
        ]),
        cursor: 11,
      } as never);
      await heard("try again");
      expect(speak).toHaveBeenLastCalledWith(
        "Ready.",
        expect.objectContaining({ messageId: "message-2" }),
      );
    },
  );

  it.each(["failed", "cancelled"])("stops waiting after an approval run is %s", async (status) => {
    const turn = callerMessage("check the site");
    const approval = approvalMessage();
    const feed = await approvalWait(turn, approval);
    getThread.mockResolvedValue(snapshot([turn, answered(approval)], runningRun) as never);
    await feed?.refresh();
    getThread.mockResolvedValue(
      snapshot(
        [turn, answered(approval)],
        status === "failed"
          ? ({
              ...runningRun,
              status: "failed",
              error: "Something went wrong. Try again.",
            } as ThreadSnapshot["run"])
          : null,
      ) as never,
    );
    await feed?.refresh();
    expect(getSnapshot()).toMatchObject({
      phase: "listening",
      caption: "Something went wrong. Try again.",
    });
    expect(speak).toHaveBeenCalledTimes(1);
    // A late unrelated message cannot become the failed approval's answer.
    getThread.mockResolvedValue(
      snapshot([turn, answered(approval), botMessage("late", "Late reply")]) as never,
    );
    await feed?.refresh();
    expect(speak).toHaveBeenCalledTimes(1);
  });

  it("ignores an unrelated run's reply while awaiting the caller's run", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    const feed = vi.mocked(runThreadSubscription).mock.calls.at(-1)![0];
    getThread.mockResolvedValue(snapshot([callerMessage("hello")], runningRun) as never);
    await heard("hello");
    getThread.mockResolvedValue(
      snapshot(
        [callerMessage("hello"), { ...botMessage("note", "Unrelated"), runId: "run-9" }],
        runningRun,
      ) as never,
    );
    await feed.refresh();
    expect(speak).not.toHaveBeenCalled();
    expect(getSnapshot()?.phase).toBe("thinking");
  });

  it("waits for the reply's own active run when another run is primary", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    const feed = vi.mocked(runThreadSubscription).mock.calls.at(-1)![0];
    const messages = [callerMessage("hello"), botMessage("message-1", "Still writing")];
    getThread.mockResolvedValue({
      ...snapshot(messages, { ...runningRun, id: "run-9" } as ThreadSnapshot["run"]),
      activeRuns: [runningRun],
    } as never);
    await heard("hello");
    expect(speak).not.toHaveBeenCalled();
    getThread.mockResolvedValue(
      snapshot([callerMessage("hello"), botMessage("message-1", "Finished.")]) as never,
    );
    await feed.refresh();
    expect(speak).toHaveBeenLastCalledWith(
      "Finished.",
      expect.objectContaining({ messageId: "message-1" }),
    );
  });

  it("speaks only an approval's own reply to the tap, and keeps spoken answers off it", async () => {
    const turn = callerMessage("check the site");
    const approval = approvalMessage();
    const note = { ...botMessage("note-1", "Daily summary ready"), runId: "run-9" };
    const feed = await approvalWait(turn, approval);

    // Another run posting meanwhile is not the reply.
    getThread.mockResolvedValue(snapshot([turn, approval, note], waitingRun) as never);
    await feed?.refresh();
    expect(speak).toHaveBeenCalledTimes(1);

    // Allow on screen sends no turn; the resumed run's reply is still this call's to speak.
    getThread.mockResolvedValue(
      snapshot([turn, answered(approval), note, botMessage("message-1", "Fetched it.")]) as never,
    );
    await feed?.refresh();
    expect(speak).toHaveBeenCalledTimes(2);
    expect(speak).toHaveBeenLastCalledWith(
      "Fetched it.",
      expect.objectContaining({ messageId: "message-1" }),
    );

    endCall();
    await approvalWait(turn, approval);
    const listens = listen.mock.calls.length;
    await heard("yes");
    expect(answer).not.toHaveBeenCalled();
    expect(getSnapshot()).toMatchObject({
      phase: "listening",
      caption: "Approve or deny it on screen.",
    });
    expect(listen.mock.calls.length).toBeGreaterThan(listens);
    await heard("bye");
    expect(answer).not.toHaveBeenCalled();
    expect(getSnapshot()).toBeNull();
  });

  it("never reads an approval that was pending before the caller spoke as the reply", async () => {
    const turn = callerMessage("check the site");
    const approval = approvalMessage();
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    const feed = vi.mocked(runThreadSubscription).mock.calls.at(-1)?.[0];
    getThread.mockResolvedValue(snapshot([turn, approval], waitingRun) as never);
    await feed?.refresh();
    await heard("hi");
    expect(answer).not.toHaveBeenCalled();

    // The tap updates the card before the run leaves waiting_input.
    getThread.mockResolvedValue(snapshot([turn, answered(approval)], waitingRun) as never);
    await feed?.refresh();
    getThread.mockResolvedValue(
      snapshot([turn, answered(approval), botMessage("message-1", "Fetched it.")]) as never,
    );
    await feed?.refresh();
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledWith(
      "Fetched it.",
      expect.objectContaining({ messageId: "message-1" }),
    );
  });

  it("answers the next turn after an approval denied without a reply", async () => {
    const turn = callerMessage("check the site");
    const approval = approvalMessage();
    const note = { ...botMessage("note-1", "Daily summary ready"), runId: "run-9" };
    const feed = await approvalWait(turn, approval);
    getThread.mockResolvedValue(snapshot([turn, answered(approval), note]) as never);
    await feed?.refresh();
    expect(speak).toHaveBeenCalledTimes(1);

    const next = { ...callerMessage("try another site"), id: "turn-2", runId: "run-2" };
    getThread.mockResolvedValue(
      snapshot([
        turn,
        answered(approval),
        note,
        next,
        { ...botMessage("message-2", "Sure."), runId: "run-2" },
      ]) as never,
    );
    send.mockResolvedValue({ runId: "run-2", taskId: "task-2" } as never);
    await heard("try another site");
    expect(speak).toHaveBeenLastCalledWith(
      "Sure.",
      expect.objectContaining({ messageId: "message-2" }),
    );
  });

  it("reads a card past its stopped run's progress, then listens without reading it again", async () => {
    const progress = {
      ...streamingMessage(""),
      blocks: [{ kind: "steps", steps: [{ label: "Web fetch", count: 1 }] }],
    } as ThreadMessage;
    const choice = askMessage("choice-1", {
      text: "Allow or deny?",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
    });
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    const feed = vi.mocked(runThreadSubscription).mock.calls.at(-1)?.[0];
    getThread.mockResolvedValue(
      snapshot([callerMessage("pick for me"), choice, progress], waitingRun) as never,
    );
    await heard("pick for me");
    expect(speak).toHaveBeenCalledWith(
      "Allow or deny?. Say yes or no, or answer in a sentence.",
      expect.objectContaining({ messageId: "choice-1" }),
    );
    const listens = listen.mock.calls.length;
    await finishSpeaking();
    // A spoken answer is the next turn: nothing else the bot posts meanwhile is read out.
    const note = { ...botMessage("note-1", "Daily summary ready"), runId: "run-9" };
    getThread.mockResolvedValue(
      snapshot([callerMessage("pick for me"), choice, progress, note], waitingRun) as never,
    );
    await feed?.refresh();

    expect(speak).toHaveBeenCalledTimes(1);
    expect(getSnapshot()?.phase).toBe("listening");
    expect(listen.mock.calls.length).toBeGreaterThan(listens);
  });

  it("drops a send that finishes after the same bot is called again", async () => {
    let finishSend: (value: { runId: string; taskId: string }) => void = () => undefined;
    let failSend: (error: Error) => void = () => undefined;
    send.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          finishSend = resolve;
          failSend = reject;
        }) as never,
    );

    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    const first = heard("book the flight");
    expect(send).toHaveBeenCalledTimes(1);

    endCall();
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    const listens = listen.mock.calls.length;
    getThread.mockClear();
    finishSend({ runId: "run-old", taskId: "task-old" });
    await first;

    expect(getThread).not.toHaveBeenCalled();
    expect(getSnapshot()).toMatchObject({
      botId: "call-bot",
      phase: "listening",
      caption: "",
    });
    expect(listen.mock.calls.length).toBe(listens);

    const second = heard("window seat");
    expect(send).toHaveBeenCalledTimes(2);
    endCall();
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    const listensAfter = listen.mock.calls.length;
    failSend(new Error("offline"));
    await second;

    expect(getSnapshot()).toMatchObject({
      botId: "call-bot",
      phase: "listening",
      caption: "",
    });
    expect(listen.mock.calls.length).toBe(listensAfter);
  });

  it("tags every message in one call with the same call id", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    await heard("book the flight");
    await heard("window seat please");

    const nonces = send.mock.calls.map((call) => String(call[0]?.clientNonce));
    expect(nonces).toHaveLength(2);
    expect(nonces[0]?.startsWith("call:")).toBe(true);
    expect(callIdFromClientNonce(nonces[0])).toBe(callIdFromClientNonce(nonces[1]));
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  it("speaks a reply from the call's own feed, then listens again", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    getThread.mockResolvedValue(snapshot([botMessage("message-1", "Booked for Friday")]) as never);
    await heard("book the flight");

    expect(speak).toHaveBeenCalledWith(
      "Booked for Friday",
      expect.objectContaining({ botId: "call-bot", messageId: "message-1" }),
    );
    expect(getSnapshot()?.exchanges.at(-1)).toEqual({ role: "bot", text: "Booked for Friday" });

    const speech = vi.mocked(speaker.subscribe).mock.calls[0]?.[0];
    listen.mockClear();
    speech?.({ status: "speaking", caption: "Booked for Friday" });
    await Promise.resolve();
    expect(getSnapshot()?.phase).toBe("speaking");
    // Dictation runs through playback so the caller can cut in.
    expect(listen).toHaveBeenCalledTimes(1);

    listen.mockClear();
    speech?.({ status: "idle" });
    await vi.advanceTimersByTimeAsync(ECHO_GUARD_MS);
    expect(getSnapshot()?.phase).toBe("listening");
    expect(listen).not.toHaveBeenCalled();
  });

  it("keeps a recording off until the reply finishes, so it never records the reply", async () => {
    vi.mocked(usesServerDictation).mockReturnValue(true);
    try {
      await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: true });
      getThread.mockResolvedValue(
        snapshot([botMessage("message-1", "Booked for Friday")]) as never,
      );
      await heard("book the flight");

      const speech = vi.mocked(speaker.subscribe).mock.calls[0]?.[0];
      listen.mockClear();
      speech?.({ status: "speaking", caption: "Booked for Friday" });
      await Promise.resolve();
      expect(getSnapshot()?.phase).toBe("speaking");
      expect(listen).not.toHaveBeenCalled();
      expect(usesServerDictation).toHaveBeenCalledWith(true);

      speech?.({ status: "idle" });
      await vi.advanceTimersByTimeAsync(ECHO_GUARD_MS);
      expect(getSnapshot()?.phase).toBe("listening");
      expect(listen).toHaveBeenCalledOnce();
    } finally {
      vi.mocked(usesServerDictation).mockReturnValue(false);
    }
  });

  it("stops a recording that is still open when a reply starts playing", async () => {
    vi.mocked(usesServerDictation).mockReturnValue(true);
    try {
      await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: true });
      vi.mocked(dictation.stop).mockClear();
      listen.mockClear();
      const mic = dictation as unknown as { recording: boolean };
      mic.recording = true;

      const speech = vi.mocked(speaker.subscribe).mock.calls[0]?.[0];
      speech?.({ status: "speaking", caption: "Booked for Friday" });
      await Promise.resolve();
      mic.recording = false;
      expect(dictation.stop).toHaveBeenCalledWith("cancel");
      expect(listen).not.toHaveBeenCalled();

      speech?.({ status: "idle" });
      await vi.advanceTimersByTimeAsync(ECHO_GUARD_MS);
      expect(listen).toHaveBeenCalledOnce();
    } finally {
      vi.mocked(usesServerDictation).mockReturnValue(false);
    }
  });

  it("lets a finished recording's transcription land when a reply starts", async () => {
    vi.mocked(usesServerDictation).mockReturnValue(true);
    try {
      await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: true });
      vi.mocked(dictation.stop).mockClear();

      const speech = vi.mocked(speaker.subscribe).mock.calls[0]?.[0];
      speech?.({ status: "speaking", caption: "Booked for Friday" });
      await Promise.resolve();
      expect(dictation.stop).not.toHaveBeenCalled();
    } finally {
      vi.mocked(usesServerDictation).mockReturnValue(false);
    }
  });

  it("stops a fallback recording that starts while the reply plays", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: true });
    const speech = vi.mocked(speaker.subscribe).mock.calls[0]?.[0];
    speech?.({ status: "speaking", caption: "Booked for Friday" });
    await Promise.resolve();
    vi.mocked(dictation.stop).mockClear();
    listen.mockClear();

    const mic = dictation as unknown as { recording: boolean };
    const watcher = vi.mocked(dictation.subscribe).mock.calls.at(-1)?.[0];
    mic.recording = true;
    watcher?.({ status: "listening", transcript: "" });
    mic.recording = false;
    expect(dictation.stop).toHaveBeenCalledWith("cancel");

    speech?.({ status: "idle" });
    await vi.advanceTimersByTimeAsync(ECHO_GUARD_MS);
    expect(listen).toHaveBeenCalledOnce();
  });

  it("prepares the call's audio in the tap that starts it", () => {
    startCall({ botId: "call-bot", botName: "Ada" });
    expect(speaker.unlock).toHaveBeenCalledOnce();
  });

  it("waits out the echo guard when the mic was shut through playback", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    await Promise.resolve();
    toggleMute();
    listen.mockClear();

    const speech = vi.mocked(speaker.subscribe).mock.calls.at(-1)?.[0];
    speech?.({ status: "speaking", caption: "Booked for Friday" });
    await vi.advanceTimersByTimeAsync(ECHO_GUARD_MS * 2);
    expect(listen).not.toHaveBeenCalled();
    expect(getSnapshot()?.phase).toBe("speaking");

    speech?.({ status: "idle" });
    await vi.advanceTimersByTimeAsync(ECHO_GUARD_MS - 1);
    expect(getSnapshot()?.phase).toBe("speaking");

    await vi.advanceTimersByTimeAsync(1);
    expect(getSnapshot()?.phase).toBe("listening");
  });

  it("ignores the reply leaking into the mic while it plays", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    await speakingReply("I'm here and hearing you");
    send.mockClear();
    vi.mocked(speaker.stop).mockClear();

    await heard("hey I am here and here");

    expect(send).not.toHaveBeenCalled();
    expect(speaker.stop).not.toHaveBeenCalled();
    expect(getSnapshot()?.phase).toBe("speaking");
  });

  it("stops the reply when the caller talks over it", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    const speech = await speakingReply("Booked for Friday");
    send.mockClear();
    speak.mockClear();
    vi.mocked(speaker.stop).mockClear();

    await heard("wait, what about the deploy");

    expect(speaker.stop).toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ text: "wait, what about the deploy" }),
    );
    expect(getSnapshot()?.phase).toBe("thinking");

    // The cut-off reply is spoken, so nothing resumes it and no guard runs.
    speech?.({ status: "idle" });
    await vi.advanceTimersByTimeAsync(ECHO_GUARD_MS);
    expect(speak).not.toHaveBeenCalled();
    expect(getSnapshot()?.phase).toBe("thinking");
  });

  it("lets a one-word interruption cut the reply short", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    await speakingReply("Booked for Friday");
    send.mockClear();
    vi.mocked(speaker.stop).mockClear();

    await heard("stop");

    expect(speaker.stop).toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: "stop" }));
  });

  it("keeps playing through a one-word backchannel", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    await speakingReply("Booked for Friday");
    send.mockClear();
    vi.mocked(speaker.stop).mockClear();

    await heard("yeah");

    expect(send).not.toHaveBeenCalled();
    expect(speaker.stop).not.toHaveBeenCalled();
    expect(getSnapshot()?.phase).toBe("speaking");
  });

  it("drops a transcript that is the reply coming back through the mic", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    getThread.mockResolvedValue(
      snapshot([botMessage("message-1", "I'm here and hearing you")]) as never,
    );
    await heard("book the flight");
    send.mockClear();
    listen.mockClear();

    const speech = vi.mocked(speaker.subscribe).mock.calls.at(-1)?.[0];
    speech?.({ status: "idle" });
    await vi.advanceTimersByTimeAsync(ECHO_GUARD_MS);
    await heard("hey I am here and here");

    expect(send).not.toHaveBeenCalled();
    expect(getSnapshot()?.exchanges.at(-1)).toEqual({
      role: "bot",
      text: "I'm here and hearing you",
    });
    expect(listen).toHaveBeenCalledTimes(2);
  });

  it("ignores the reply coming back after a newer one was spoken", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    const feed = vi.mocked(runThreadSubscription).mock.calls[0]?.[0];
    getThread.mockResolvedValue(
      snapshot([botMessage("message-1", "I'm here and hearing you")]) as never,
    );
    await heard("book the flight");
    getThread.mockResolvedValue(
      snapshot([
        botMessage("message-1", "I'm here and hearing you"),
        botMessage("message-2", "Booked for Friday"),
      ]) as never,
    );
    await feed?.refresh();
    expect(speak).toHaveBeenCalledTimes(2);
    send.mockClear();

    const speech = vi.mocked(speaker.subscribe).mock.calls.at(-1)?.[0];
    speech?.({ status: "idle" });
    await vi.advanceTimersByTimeAsync(ECHO_GUARD_MS);
    await heard("hey I am here and here");

    expect(send).not.toHaveBeenCalled();
  });

  it("keeps a turn taken mid-run in the call's card", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    getThread.mockResolvedValue(snapshot([], runningRun) as never);
    await heard("book the flight");
    await heard("window seat please");

    expect(send).toHaveBeenCalledTimes(1);
    expect(followUp).toHaveBeenCalledWith(
      expect.objectContaining({ botId: "call-bot", text: "window seat please" }),
    );
    const sent = String(send.mock.calls[0]?.[0]?.clientNonce);
    const followed = String(followUp.mock.calls[0]?.[0]?.clientNonce);
    expect(followed.startsWith("call:")).toBe(true);
    expect(callIdFromClientNonce(followed)).toBe(callIdFromClientNonce(sent));
    expect(followed).not.toBe(sent);
  });

  it("stops listening while muted", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    await Promise.resolve();
    listen.mockClear();

    toggleMute();
    expect(getSnapshot()).toMatchObject({ muted: true, heard: "" });
    expect(dictation.stop).toHaveBeenCalledWith("cancel");
    expect(listen).not.toHaveBeenCalled();

    toggleMute();
    await Promise.resolve();
    expect(getSnapshot()?.muted).toBe(false);
    expect(listen).toHaveBeenCalledTimes(1);
  });

  it("aborts the call feed and clears the store on hang up", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    const feed = vi.mocked(runThreadSubscription).mock.calls[0]?.[0];
    expect(feed?.signal.aborted).toBe(false);

    endCall();

    expect(feed?.signal.aborted).toBe(true);
    expect(getSnapshot()).toBeNull();
    expect(speaker.stop).toHaveBeenCalled();
  });

  it("closes the call server-side when the caller presses hang up", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    await heard("book the flight");
    const callId = String(callIdFromClientNonce(String(send.mock.calls[0]?.[0]?.clientNonce)));

    endCall();

    expect(endCallRpc).toHaveBeenCalledWith(expect.objectContaining({ botId: "call-bot", callId }));
  });

  it("waits for an in-flight spoken turn before closing the call server-side", async () => {
    const pendingSend = deferred<{ runId: string; taskId: string }>();
    send.mockReturnValueOnce(pendingSend.promise as never);
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    listen.mock.calls.at(-1)?.[0]?.onFinal("book the flight");
    expect(send).toHaveBeenCalledOnce();

    endCall();
    await flushMicrotasks();
    expect(endCallRpc).not.toHaveBeenCalled();

    pendingSend.resolve({ runId: "run-1", taskId: "task-1" });
    await pendingSend.promise;
    await flushMicrotasks();
    expect(endCallRpc).toHaveBeenCalledOnce();
  });

  it("closes the call server-side once when the caller says goodbye", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    getThread.mockResolvedValue(snapshot([botMessage("message-1", "Talk soon")]) as never);
    await heard("that's all, bye");
    const callId = String(callIdFromClientNonce(String(send.mock.calls[0]?.[0]?.clientNonce)));

    const speech = vi.mocked(speaker.subscribe).mock.calls.at(-1)?.[0];
    speech?.({ status: "speaking", caption: "Talk soon" });
    speech?.({ status: "idle" });
    await vi.advanceTimersByTimeAsync(ECHO_GUARD_MS);

    expect(getSnapshot()).toBeNull();
    expect(endCallRpc).toHaveBeenCalledTimes(1);
    expect(endCallRpc).toHaveBeenCalledWith(expect.objectContaining({ botId: "call-bot", callId }));
  });

  it("does not close the call again when the bot ended it", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    const feed = vi.mocked(runThreadSubscription).mock.calls[0]?.[0];
    getThread.mockResolvedValue(snapshot([], runningRun) as never);
    await heard("end the call and make me a list");
    const callId = String(callIdFromClientNonce(String(send.mock.calls[0]?.[0]?.clientNonce)));

    feed?.onEvent?.(callEndedEvent(callId), { threadId: "thread-1", cursor: 3 });
    const speech = vi.mocked(speaker.subscribe).mock.calls.at(-1)?.[0];
    speech?.({ status: "speaking", caption: "Talk soon" });
    speech?.({ status: "idle" });
    await vi.advanceTimersByTimeAsync(ECHO_GUARD_MS);

    expect(getSnapshot()).toBeNull();
    expect(endCallRpc).not.toHaveBeenCalled();
  });

  it("tears the previous call down before opening the next call's feed", async () => {
    const unsubSpeech = vi.fn();
    const unsubDictation = vi.fn();
    vi.mocked(speaker.subscribe).mockReturnValueOnce(unsubSpeech);
    vi.mocked(dictation.subscribe).mockReturnValueOnce(unsubDictation);
    await answeredCall({ botId: "bot-a", botName: "Ada", transcribe: false });
    const feedA = vi.mocked(runThreadSubscription).mock.calls[0]?.[0];

    let abortedWhenNextOpened: boolean | null = null;
    vi.mocked(runThreadSubscription).mockImplementationOnce(async () => {
      abortedWhenNextOpened = feedA?.signal.aborted ?? null;
    });
    await answeredCall({ botId: "bot-b", botName: "Grace", transcribe: false });
    await Promise.resolve();

    expect(unsubSpeech).toHaveBeenCalledTimes(1);
    expect(unsubDictation).toHaveBeenCalledTimes(1);
    expect(abortedWhenNextOpened).toBe(true);
    expect(getSnapshot()?.botId).toBe("bot-b");
  });

  it("does not let an earlier farewell timer end the next call", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    getThread.mockResolvedValue(snapshot([botMessage("message-1", "Talk soon")]) as never);
    await heard("that's all");
    const speech = vi.mocked(speaker.subscribe).mock.calls.at(-1)?.[0];
    speech?.({ status: "speaking", caption: "Talk soon" });
    await Promise.resolve();

    await heard("see you");
    endCall();
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(getSnapshot()?.botId).toBe("call-bot");
  });

  it("hangs up once the bot has answered a goodbye", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    getThread.mockResolvedValue(snapshot([botMessage("message-1", "Talk soon")]) as never);
    await heard("that's all, bye");

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ botId: "call-bot", text: "that's all, bye" }),
    );
    expect(speak).toHaveBeenCalledWith(
      "Talk soon",
      expect.objectContaining({ messageId: "message-1" }),
    );

    const speech = vi.mocked(speaker.subscribe).mock.calls.at(-1)?.[0];
    speech?.({ status: "speaking", caption: "Talk soon" });
    speech?.({ status: "idle" });
    await vi.advanceTimersByTimeAsync(ECHO_GUARD_MS);

    expect(getSnapshot()).toBeNull();
  });

  it("speaks the farewell and hangs up when the bot ends the call itself", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    const feed = vi.mocked(runThreadSubscription).mock.calls[0]?.[0];
    getThread.mockResolvedValue(snapshot([], runningRun) as never);
    await heard("end the call and make me a list");
    const callId = String(callIdFromClientNonce(String(send.mock.calls[0]?.[0]?.clientNonce)));

    feed?.onEvent?.(callEndedEvent(callId), { threadId: "thread-1", cursor: 3 });
    expect(speak).toHaveBeenCalledWith(
      "Talk soon",
      expect.objectContaining({ messageId: "message-marker" }),
    );

    const speech = vi.mocked(speaker.subscribe).mock.calls.at(-1)?.[0];
    speech?.({ status: "speaking", caption: "Talk soon" });
    speech?.({ status: "idle" });
    await vi.advanceTimersByTimeAsync(ECHO_GUARD_MS);

    expect(getSnapshot()).toBeNull();
  });

  it("never speaks the work the bot files after it hung up", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    const feed = vi.mocked(runThreadSubscription).mock.calls[0]?.[0];
    getThread.mockResolvedValue(snapshot([], runningRun) as never);
    await heard("end the call and make me a list");
    const callId = String(callIdFromClientNonce(String(send.mock.calls[0]?.[0]?.clientNonce)));
    feed?.onEvent?.(callEndedEvent(callId), { threadId: "thread-1", cursor: 3 });
    expect(speak).toHaveBeenCalledTimes(1);

    getThread.mockResolvedValue(snapshot([botMessage("message-2", "Here is the list")]) as never);
    await feed?.refresh();

    expect(speak).toHaveBeenCalledTimes(1);
  });

  it("ignores a call ended event from another call", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    const feed = vi.mocked(runThreadSubscription).mock.calls[0]?.[0];
    getThread.mockResolvedValue(snapshot([botMessage("message-1", "Talk soon")]) as never);
    await heard("book the flight");

    feed?.onEvent?.(callEndedEvent("someone-elses-call"), { threadId: "thread-1", cursor: 3 });
    const speech = vi.mocked(speaker.subscribe).mock.calls.at(-1)?.[0];
    speech?.({ status: "speaking", caption: "Talk soon" });
    speech?.({ status: "idle" });
    await vi.advanceTimersByTimeAsync(ECHO_GUARD_MS);

    expect(getSnapshot()?.phase).toBe("listening");
  });

  it("speaks a streaming reply once, with the text its run finished on", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    const feed = vi.mocked(runThreadSubscription).mock.calls[0]?.[0];
    getThread.mockResolvedValue(snapshot([botMessage("message-1", "Booked")], runningRun) as never);
    await heard("book the flight");
    expect(speak).not.toHaveBeenCalled();

    getThread.mockResolvedValue(
      snapshot([botMessage("message-1", "Booked for Friday")], runningRun) as never,
    );
    await feed?.refresh();
    expect(speak).not.toHaveBeenCalled();

    getThread.mockResolvedValue(snapshot([botMessage("message-1", "Booked for Friday")]) as never);
    await feed?.refresh();
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledWith(
      "Booked for Friday",
      expect.objectContaining({ messageId: "message-1" }),
    );
  });

  it("does not speak a message a refresh re-delivers", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    const feed = vi.mocked(runThreadSubscription).mock.calls[0]?.[0];
    getThread.mockResolvedValue(snapshot([botMessage("message-1", "Booked for Friday")]) as never);
    await heard("book the flight");
    expect(speak).toHaveBeenCalledTimes(1);

    await feed?.refresh();
    await feed?.refresh();
    expect(speak).toHaveBeenCalledTimes(1);
  });

  it("does not start dictation while the speaker is still speaking", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    getThread.mockResolvedValue(snapshot([botMessage("message-1", "Booked for Friday")]) as never);
    await heard("book the flight");
    listen.mockClear();

    // The previous utterance reports idle after the next one already started playing.
    isSpeaking.mockReturnValue(true);
    const speech = vi.mocked(speaker.subscribe).mock.calls.at(-1)?.[0];
    speech?.({ status: "idle" });
    await vi.advanceTimersByTimeAsync(ECHO_GUARD_MS);
    expect(listen).not.toHaveBeenCalled();
    expect(getSnapshot()?.phase).not.toBe("listening");

    isSpeaking.mockReturnValue(false);
    speech?.({ status: "idle" });
    await vi.advanceTimersByTimeAsync(ECHO_GUARD_MS);
    expect(listen).toHaveBeenCalledTimes(1);
  });

  it("tags the call's user message for the thread card before the server copy lands", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    await heard("book the flight");

    const callId = callIdFromClientNonce(String(send.mock.calls[0]?.[0]?.clientNonce));
    expect(callId).toBeDefined();
    // The event carries the call id and no runId, so the bubble groups with no run registered.
    const live = reduceThreadSnapshot(snapshot([]), userMessageEvent(String(callId)));
    expect(live?.messages[0]?.callId).toBe(callId);
    expect(groupVoiceChats(live?.messages ?? [])).toEqual([
      { kind: "voiceChat", key: `call:${callId}`, callId, messages: live?.messages },
    ]);
  });

  it("keeps quiet while the reply is still streaming, then speaks it whole", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    const feed = vi.mocked(runThreadSubscription).mock.calls[0]?.[0];
    getThread.mockResolvedValue(snapshot([streamingMessage("Hey,")], runningRun) as never);
    await heard("are you there");
    expect(speak).not.toHaveBeenCalled();

    getThread.mockResolvedValue(snapshot([botMessage("message-1", "Hey, I'm here.")]) as never);
    await feed?.refresh();
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledWith(
      "Hey, I'm here.",
      expect.objectContaining({ messageId: "message-1" }),
    );
  });

  it("never speaks tool activity on a call, and still speaks the reply", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    const feed = vi.mocked(runThreadSubscription).mock.calls[0]?.[0];
    getThread.mockResolvedValue(snapshot([subagentMessage()], runningRun) as never);
    await heard("what do you know about Anemoia");
    expect(speak).not.toHaveBeenCalled();
    expect(getSnapshot()?.phase).toBe("thinking");

    getThread.mockResolvedValue(
      snapshot([subagentMessage(), botMessage("message-1", "I know you run Anemoia")]) as never,
    );
    await feed?.refresh();
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledWith(
      "I know you run Anemoia",
      expect.objectContaining({ messageId: "message-1" }),
    );
  });

  it("cuts the reply short on an interim heard over it, then sends the finished turn", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    const speech = await speakingReply("Booked for Friday");
    send.mockClear();
    vi.mocked(speaker.stop).mockClear();

    interim("what about the deploy");
    await vi.advanceTimersByTimeAsync(INTERIM_BARGE_IN_MS - 1);
    expect(speaker.stop).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(speaker.stop).toHaveBeenCalled();
    expect(getSnapshot()?.phase).toBe("listening");

    // The cut-off reply never resumes, and the session that is still open finishes the turn.
    const sessions = listen.mock.calls.length;
    speech?.({ status: "idle" });
    await vi.advanceTimersByTimeAsync(ECHO_GUARD_MS);
    expect(listen).toHaveBeenCalledTimes(sessions);

    await heard("what about the deploy");
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: "what about the deploy" }));
  });

  it("keeps playing when the interim is the reply leaking into the mic", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    await speakingReply("I'm here and hearing you");
    vi.mocked(speaker.stop).mockClear();

    interim("I am here and hearing");
    await vi.advanceTimersByTimeAsync(INTERIM_BARGE_IN_MS * 2);

    expect(speaker.stop).not.toHaveBeenCalled();
    expect(getSnapshot()?.phase).toBe("speaking");
  });

  it("keeps playing when an interim phrase is revised back into an echo", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    await speakingReply("I'm here and hearing you");
    vi.mocked(speaker.stop).mockClear();

    interim("I am");
    await vi.advanceTimersByTimeAsync(INTERIM_BARGE_IN_MS - 100);
    interim("I am here and hearing");
    await vi.advanceTimersByTimeAsync(INTERIM_BARGE_IN_MS * 2);

    expect(speaker.stop).not.toHaveBeenCalled();
    expect(getSnapshot()?.phase).toBe("speaking");
  });

  it("does not cut the reply for a single interim word", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    await speakingReply("Booked for Friday");
    vi.mocked(speaker.stop).mockClear();

    interim("yeah");
    await vi.advanceTimersByTimeAsync(INTERIM_BARGE_IN_MS * 2);

    expect(speaker.stop).not.toHaveBeenCalled();
    expect(getSnapshot()?.phase).toBe("speaking");
  });

  it("speaks only the final reply when a mid-turn progress message came first", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    const feed = vi.mocked(runThreadSubscription).mock.calls[0]?.[0];
    getThread.mockResolvedValue(snapshot([botMessage("progress-1", "Hey,")], runningRun) as never);
    await heard("are you there");
    expect(speak).not.toHaveBeenCalled();

    getThread.mockResolvedValue(
      snapshot([
        botMessage("progress-1", "Hey,"),
        botMessage("message-1", "Hey, I'm here."),
      ]) as never,
    );
    await feed?.refresh();
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledWith(
      "Hey, I'm here.",
      expect.objectContaining({ messageId: "message-1" }),
    );
  });
});

/** Starts a call and lets it pick up, the state every conversation test begins from. */
async function answeredCall(call: Parameters<typeof startCall>[0]) {
  startCall(call);
  await flushMicrotasks();
}

async function speakingReply(text: string) {
  getThread.mockResolvedValue(snapshot([botMessage("message-1", text)]) as never);
  await heard("book the flight");
  const speech = vi.mocked(speaker.subscribe).mock.calls.at(-1)?.[0];
  speech?.({ status: "speaking", caption: text });
  await Promise.resolve();
  return speech;
}

/** One interim result from the open dictation session, the way the browser reports it. */
function interim(transcript: string) {
  const watcher = vi.mocked(dictation.subscribe).mock.calls.at(-1)?.[0];
  watcher?.({ status: "listening", transcript });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function eventStream() {
  let deliver: ((result: IteratorResult<ProductEvent>) => void) | undefined;
  const events: AsyncIterable<ProductEvent> = {
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          const next = deferred<IteratorResult<ProductEvent>>();
          deliver = next.resolve;
          return next.promise;
        },
      };
    },
  };
  return {
    events,
    send: (event: ProductEvent) => deliver?.({ value: event, done: false }),
    end: () => deliver?.({ value: undefined, done: true }),
  };
}

async function flushMicrotasks() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function heard(text: string) {
  const onFinal = listen.mock.calls.at(-1)?.[0]?.onFinal;
  await onFinal?.(text);
  await Promise.resolve();
}

function botMessage(id: string, text: string): ThreadMessage {
  return {
    id,
    threadId: "thread-1",
    seq: 4,
    role: "bot",
    runId: "run-1",
    blocks: [{ kind: "text", text }],
    createdAt: "2026-09-20T00:00:00.000Z",
  };
}

function askMessage(id: string, block: Record<string, unknown>): ThreadMessage {
  return {
    ...botMessage(id, ""),
    blocks: [{ kind: "ask", status: "pending", ...block }],
  } as ThreadMessage;
}

/** Calls, takes the turn, and reads the approval card it stops on. */
async function approvalWait(turn: ThreadMessage, approval: ThreadMessage) {
  await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
  const feed = vi.mocked(runThreadSubscription).mock.calls.at(-1)?.[0];
  getThread.mockResolvedValue(snapshot([turn, approval], waitingRun) as never);
  await heard("check the site");
  expect(speak).toHaveBeenLastCalledWith(
    "Open example.com?. Approve or deny it on screen.",
    expect.objectContaining({ messageId: "approval-1" }),
  );
  await finishSpeaking();
  return feed;
}

function approvalMessage(): ThreadMessage {
  return askMessage("approval-1", {
    text: "Open example.com?",
    approvalEffectId: "effect-1",
    actions: [
      { id: "allow", label: "Allow once" },
      { id: "deny", label: "Deny" },
    ],
  });
}

function answered(message: ThreadMessage): ThreadMessage {
  return {
    ...message,
    blocks: message.blocks.map((block) => ({ ...block, status: "answered" })),
  } as ThreadMessage;
}

/** The reply's audio ends and the echo guard runs out. */
async function finishSpeaking() {
  const speech = vi.mocked(speaker.subscribe).mock.calls.at(-1)?.[0];
  speech?.({ status: "speaking" });
  speech?.({ status: "idle" });
  await vi.advanceTimersByTimeAsync(ECHO_GUARD_MS);
}

function callerMessage(text: string): ThreadMessage {
  return {
    id: "turn-1",
    threadId: "thread-1",
    seq: 3,
    role: "user",
    runId: "run-1",
    blocks: [{ kind: "text", text }],
    createdAt: "2026-09-20T00:00:00.000Z",
  };
}

/** The live message the thread streams the reply into while the run is still going. */
function streamingMessage(text: string): ThreadMessage {
  return {
    id: "progress:run-1",
    threadId: "thread-1",
    seq: 4,
    role: "bot",
    runId: "run-1",
    blocks: [{ kind: "progress", text }],
    createdAt: "2026-09-20T00:00:00.000Z",
  };
}

function subagentMessage(): ThreadMessage {
  return {
    id: "subagent:agent-1",
    threadId: "thread-1",
    seq: 4,
    role: "bot",
    runId: "run-1",
    blocks: [
      { kind: "subagent", agentId: "agent-1", name: "helper", task: "dig", status: "running" },
    ],
    createdAt: "2026-09-20T00:00:00.000Z",
  };
}

const runningRun = {
  id: "run-1",
  botId: "call-bot",
  threadId: "thread-1",
  taskId: "task-1",
  status: "running",
  trigger: "user",
  routineId: null,
  modelProvider: null,
  modelId: null,
  error: null,
  startedAt: "2026-09-20T00:00:00.000Z",
  completedAt: null,
  createdAt: "2026-09-20T00:00:00.000Z",
} as ThreadSnapshot["run"];

const waitingRun = { ...runningRun, status: "waiting_input" } as ThreadSnapshot["run"];

function callEndedEvent(callId: string, farewell = "Talk soon"): ProductEvent {
  return {
    id: "event-2",
    seq: 6,
    spaceId: "space-1",
    threadId: "thread-1",
    botId: "call-bot",
    runId: "run-1",
    type: "thread.call.ended",
    payload: {
      botId: "call-bot",
      threadId: "thread-1",
      runId: "run-1",
      callId,
      title: "Made a list",
      farewell,
      messageId: "message-marker",
    },
    createdAt: "2026-09-20T00:00:00.000Z",
  } as ProductEvent;
}

function userMessageEvent(callId: string): ProductEvent {
  return {
    id: "event-1",
    seq: 5,
    spaceId: "space-1",
    threadId: "thread-1",
    botId: "call-bot",
    type: "thread.message.created",
    payload: { messageId: "message-user", role: "user", blocks: [], callId },
    createdAt: "2026-09-20T00:00:00.000Z",
  } as ProductEvent;
}

function snapshot(messages: ThreadMessage[], run: ThreadSnapshot["run"] = null): ThreadSnapshot {
  return {
    botId: "call-bot",
    threadId: "thread-1",
    cursor: 3,
    messages,
    olderCursor: null,
    run,
  };
}

describe("call pickup", () => {
  beforeEach(() => {
    endCall();
    vi.clearAllMocks();
    vi.useFakeTimers();
    isSpeaking.mockReturnValue(false);
    listen.mockResolvedValue(undefined);
    getThread.mockResolvedValue(snapshot([]) as never);
    send.mockResolvedValue({ runId: "run-1", taskId: "task-1" } as never);
    endCallRpc.mockResolvedValue({ ok: true } as never);
  });

  afterEach(() => {
    endCall();
    vi.useRealTimers();
  });

  it("rings without listening or speaking until the call picks up", async () => {
    const ring = deferred<void>();
    vi.mocked(pickUp).mockReturnValueOnce(ring.promise);
    getThread.mockResolvedValue(snapshot([botMessage("old-1", "Earlier reply")]) as never);
    startCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    const feed = vi.mocked(runThreadSubscription).mock.calls.at(-1)?.[0];
    await feed?.refresh();

    expect(getSnapshot()).toMatchObject({ phase: "ringing", connectedAt: null });
    expect(listen).not.toHaveBeenCalled();
    expect(speak).not.toHaveBeenCalled();

    ring.resolve();
    await flushMicrotasks();

    expect(getSnapshot()).toMatchObject({ phase: "listening" });
    expect(getSnapshot()?.connectedAt).toEqual(expect.any(Number));
    expect(listen).toHaveBeenCalledOnce();
  });

  it("stops ringing when the caller hangs up before pickup", async () => {
    const ring = deferred<void>();
    vi.mocked(pickUp).mockReturnValueOnce(ring.promise);
    startCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    const signal = vi.mocked(pickUp).mock.calls.at(-1)?.[0];

    endCall();
    ring.resolve();
    await flushMicrotasks();

    expect(signal?.aborted).toBe(true);
    expect(getSnapshot()).toBeNull();
    expect(listen).not.toHaveBeenCalled();
    expect(endCallRpc).toHaveBeenCalledWith({ botId: "call-bot", callId: expect.any(String) });
  });

  it("reports the connected time when the caller hangs up", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    await heard("book the flight");
    await vi.advanceTimersByTimeAsync(83_000);

    endCall();

    expect(endCallRpc).toHaveBeenCalledWith(expect.objectContaining({ durationSeconds: 83 }));
  });
});

describe("answered incoming call", () => {
  beforeEach(() => {
    endCall();
    vi.clearAllMocks();
    vi.useFakeTimers();
    isSpeaking.mockReturnValue(false);
    listen.mockResolvedValue(undefined);
    getThread.mockResolvedValue(snapshot([botMessage("old-1", "Third reminder.")]) as never);
    endCallRpc.mockResolvedValue({ ok: true } as never);
  });

  afterEach(() => {
    endCall();
    vi.useRealTimers();
  });

  it("skips the ringing, speaks the bot's opening, then listens", async () => {
    startCall({
      botId: "call-bot",
      botName: "Ada",
      transcribe: false,
      answered: { callId: "bot-call-1", opening: "You missed my reminders, so I'm calling." },
    });
    const feed = vi.mocked(runThreadSubscription).mock.calls.at(-1)?.[0];
    await feed?.refresh();
    await flushMicrotasks();

    expect(pickUp).toHaveBeenCalledWith(expect.anything(), { ring: false });
    expect(speak).toHaveBeenCalledOnce();
    expect(speak).toHaveBeenCalledWith("You missed my reminders, so I'm calling.", {
      botId: "call-bot",
    });
    expect(listen).not.toHaveBeenCalled();
    expect(getSnapshot()?.exchanges).toEqual([
      { role: "bot", text: "You missed my reminders, so I'm calling." },
    ]);

    const speech = vi.mocked(speaker.subscribe).mock.calls.at(-1)?.[0];
    speech?.({ status: "speaking", caption: "You missed my reminders" });
    speech?.({ status: "idle" });
    await vi.advanceTimersByTimeAsync(ECHO_GUARD_MS);
    expect(listen).toHaveBeenCalled();
    expect(speak).toHaveBeenCalledOnce();
  });

  it("hangs up on the bot's call id", async () => {
    startCall({
      botId: "call-bot",
      botName: "Ada",
      transcribe: false,
      answered: { callId: "bot-call-2", opening: "Hi!" },
    });
    await flushMicrotasks();
    endCall();
    expect(endCallRpc).toHaveBeenCalledWith(
      expect.objectContaining({ botId: "call-bot", callId: "bot-call-2" }),
    );
  });
});

describe("session ends during a call", () => {
  beforeEach(() => {
    endCall();
    vi.clearAllMocks();
    vi.useFakeTimers();
    isSpeaking.mockReturnValue(false);
    listen.mockResolvedValue(undefined);
    getThread.mockResolvedValue(snapshot([]) as never);
    endCallRpc.mockResolvedValue({ ok: true } as never);
  });

  afterEach(() => {
    endCall();
    vi.useRealTimers();
  });

  it("ends the call and rechecks the session when its stream reports the session gone", async () => {
    await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
    const feed = vi.mocked(runThreadSubscription).mock.calls.at(-1)![0];
    vi.mocked(rpc.threads.subscribe).mockResolvedValue(
      (async function* () {
        yield* [];
        throw new ORPCError("UNAUTHORIZED");
      })() as never,
    );
    const events = await feed.subscribe(3, new AbortController().signal);
    await expect(
      (async () => {
        for await (const _event of events);
      })(),
    ).rejects.toMatchObject({ status: 401 });

    expect(getSnapshot()).toBeNull();
    expect(dictation.stop).toHaveBeenCalledWith("cancel");
    expect(recheckSessionOnUnauthorized).toHaveBeenCalledWith(401);
    expect(endCallRpc).not.toHaveBeenCalled();
  });

  it.each([
    [
      "stream connect",
      () => vi.mocked(rpc.threads.subscribe),
      (feed: Feed) => feed.subscribe(3, new AbortController().signal),
    ],
    ["snapshot", () => getThread, (feed: Feed) => feed.refresh()],
    ["head", () => vi.mocked(rpc.threads.head), (feed: Feed) => feed.loadHead()],
  ] as const)(
    "ends the call when its %s request is refused as unauthorized",
    async (_name, request, run) => {
      await answeredCall({ botId: "call-bot", botName: "Ada", transcribe: false });
      const feed = vi.mocked(runThreadSubscription).mock.calls.at(-1)![0];
      request().mockRejectedValue(new ORPCError("UNAUTHORIZED"));
      vi.mocked(dictation.stop).mockClear();

      await expect(run(feed)).rejects.toMatchObject({ status: 401 });
      expect(getSnapshot()).toBeNull();
      expect(dictation.stop).toHaveBeenCalledWith("cancel");
      expect(endCallRpc).not.toHaveBeenCalled();
    },
  );
});

type Feed = Parameters<typeof runThreadSubscription>[0];
