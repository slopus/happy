import { embedded, scopedStorageKey } from "../paws/runtime";
import { listenWindow } from "../paws/runtime";
import { localStore } from "../paws/runtime";
import { t } from "@lingui/core/macro";
import type { BotAvatarSet, ProductEvent, ThreadMessage, ThreadSnapshot } from "@rakazo/contracts";
import type { CallExchange } from "@rakazo/core";
import {
  CALL_FAREWELL_TIMEOUT_MS,
  callClientNonce,
  callTurn,
  createCallSendTracker,
  createInterimBargeIn,
  errorStatus,
  isActive,
  isApprovalAskBlock,
  isCallBargeIn,
  isFarewell,
  isRunTerminalEvent,
  isSecretAskBlock,
  isThreadSnapshotEvent,
  newClientId,
  pendingCallSecretAsk,
  reduceThreadSnapshot,
  runThreadSubscription,
  speechFromBlocks,
  spokenMemory,
} from "@rakazo/core";
import { getGlobalBroadcastChannel } from "better-auth/client";
import { useSyncExternalStore } from "react";
import { pickUp } from "./call-pickup.js";
import { dictation, usesServerDictation } from "./dictation.js";
import {
  newLogoAvatarActivitySource,
  openLogoAvatarActivityFeed,
  webLogoAvatarActivity,
} from "./logo-avatar-activity.js";
import { reportClientError } from "./monitoring";
import { recheckSessionOnUnauthorized, rpc } from "./rpc.js";
import { speaker } from "./tts.js";
import { errorText } from "./user-error";

/** `ringing` until the call picks up; the rest describe the conversation. */
type CallPhase = "ringing" | "listening" | "thinking" | "speaking";

export interface CallState {
  botId: string;
  botName: string;
  botColor: string;
  botAvatarSet?: BotAvatarSet;
  /** When the call picked up; null while it is still ringing. */
  connectedAt: number | null;
  phase: CallPhase;
  muted: boolean;
  /** The call window is tucked away; the call keeps running. */
  minimized: boolean;
  transcriptOpen: boolean;
  caption: string;
  heard: string;
  exchanges: CallExchange[];
}

const RUN_ACTIVE = ["running", "queued", "leased"];
/**
 * Quiet gap between the last audio frame and opening the microphone.
 * ponytail: one fixed delay for every room and output device; make it adaptive only
 * if a measured tail actually outruns it.
 */
export const ECHO_GUARD_MS = 600;
/** Longest sign-out waits for pending hang-ups while the session still exists. */
export const SIGN_OUT_HANG_UP_MS = 3_000;
/**
 * The last signed-in user a tab confirmed. Signing in elsewhere sends no Better Auth message,
 * so other tabs learn of a new account from this key's storage event.
 */
export const SIGNED_IN_USER_KEY = "rakazo.signedInUser";
let state: CallState | null = null;
/** The signed-in user this page belongs to; undefined until the session first resolves. */
let identity: string | null | undefined;
/** Other tabs' sign-outs and account changes are watched once a user is signed in. */
let watchingOtherTabs = false;
/** The page is being left for a new session: an answer arriving before it unloads starts nothing. */
let leaving = false;
/** Shared by every message this call sends, so the thread can group one call's exchange. */
let callId = "";
/** Cancels the ringing of a call that is hung up before it picks up. */
let pickup: AbortController | null = null;
/** The bot's opening is playing: nothing else is spoken and the mic waits for it. */
let openingPending = false;
/** Requests for this call that must persist before its server-side hang-up. */
const callSends = createCallSendTracker();
/** Server-side hang-ups still waiting on sends or in flight. */
const hangUps = new Set<Promise<void>>();
/** Bumped when the session ends: a hang-up still queued then would run signed out or as someone else. */
let sessionEpoch = 0;
let disposed = false;
let transcribe: boolean | undefined;
let thread: ThreadSnapshot | null = null;
let feed: {
  controller: AbortController;
  load: () => Promise<ThreadSnapshot | null>;
} | null = null;
/** Every bot message already spoken this call: a streaming message updates many times. */
const spokenMessageIds = new Set<string>();
let unsubSpeech: (() => void) | null = null;
let unsubDictation: (() => void) | null = null;
let hangUpAfterReply = false;
/** The bot hung up itself: its farewell is the last thing this call speaks. */
let botEndedCall = false;
let hangUpTimer: ReturnType<typeof setTimeout> | null = null;
/** Pending echo guard: the microphone stays shut until it fires. */
let guardTimer: ReturnType<typeof setTimeout> | null = null;
/** Whether dictation is running, so playback can leave it open instead of restarting it. */
let micOpen = false;
/** The caller cut the reply off: there is no tail left to wait out before listening. */
let bargedIn = false;
/** A turn is in flight: its reply must be spoken even if the mic reopened meanwhile. */
let awaitingReply = false;
/** The run whose approval card the caller was sent to answer on screen. */
let approvalRunId: string | null = null;
let awaitedRunId: string | null = null;
const finishedRunIds = new Set<string>();
/** Counting down an interim phrase heard over the reply, before it counts as cutting in. */
const interim = createInterimBargeIn(() => {
  if (state?.phase !== "speaking") return;
  // Never resume the cut-off message, and keep the idle it emits from reopening the mic.
  bargedIn = true;
  speaker.stop();
  set({ phase: "listening", caption: "" });
});
const watchers = new Set<() => void>();

export function subscribe(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}

export function getSnapshot(): CallState | null {
  return state;
}

export function useCallSession(): CallState | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function emit() {
  for (const watcher of [...watchers]) watcher();
}

function set(patch: Partial<CallState>) {
  if (!state) return;
  state = { ...state, ...patch };
  emit();
}

export function startCall(call: {
  botId: string;
  botName: string;
  botColor?: string;
  botAvatarSet?: BotAvatarSet;
  transcribe?: boolean;
  /** The bot called and the user picked up: no ringing, and the bot speaks first. */
  answered?: { callId: string; opening: string };
}): void {
  if (leaving) return;
  endCall();
  prepareCallAudio();
  callId = call.answered?.callId ?? newClientId();
  transcribe = call.transcribe;
  spokenMemory.clear();
  interim.clear();
  micOpen = false;
  bargedIn = false;
  awaitingReply = false;
  approvalRunId = null;
  awaitedRunId = null;
  finishedRunIds.clear();
  state = {
    botId: call.botId,
    botName: call.botName,
    botColor: call.botColor ?? "",
    botAvatarSet: call.botAvatarSet,
    connectedAt: null,
    phase: "ringing",
    muted: false,
    minimized: false,
    transcriptOpen: false,
    caption: "",
    heard: "",
    exchanges: [],
  };
  unsubSpeech = speaker.subscribe((speech) => {
    if (!state || state.phase === "ringing") return;
    if (openingPending && speech.status === "idle") openingPending = false;
    if (speech.status === "speaking") {
      bargedIn = false;
      set({ phase: "speaking", caption: speech.caption ?? "" });
      if (micOpen && dictation.recording) {
        dictation.stop("cancel");
        micOpen = false;
      }
      // Recognition stays open through playback so the caller can talk over the reply.
      void openMic();
    } else if (speech.status === "idle" && state.phase !== "listening" && !bargedIn) {
      set({ caption: "" });
      guardThenListen();
    }
    if (speech.error) set({ caption: speech.error });
  });
  unsubDictation = dictation.subscribe((heard) => {
    if (!state) return;
    if (state.phase === "speaking" && dictation.recording) {
      dictation.stop("cancel");
      micOpen = false;
      return;
    }
    if (heard.status === "listening") {
      set({ heard: pendingCallSecretAsk(thread) ? "" : heard.transcript });
      watchInterim(heard.transcript);
    } else interim.clear();
    if (heard.error) {
      if (heard.status === "idle") micOpen = false;
      set({ caption: heard.error });
    }
  });
  watchThread(call.botId);
  emit();
  const ringing = new AbortController();
  pickup = ringing;
  const ringingCallId = callId;
  const opening = call.answered?.opening.trim() ?? "";
  void pickUp(ringing.signal, { ring: !call.answered }).then(() => {
    if (ringing.signal.aborted || !state || callId !== ringingCallId) return;
    pickup = null;
    if (!opening) {
      set({ phase: "listening", connectedAt: Date.now() });
      void listen();
      return;
    }
    // The bot opens the call; its speech ending hands the turn to the user.
    set({
      phase: "thinking",
      connectedAt: Date.now(),
      exchanges: [{ role: "bot", text: opening }],
    });
    spokenMemory.remember(opening);
    openingPending = true;
    void speaker.speak(opening, { botId: call.botId }).catch(() => {
      if (callId !== ringingCallId) return;
      openingPending = false;
      void listen();
    });
  });
}

export function prepareCallAudio(): void {
  speaker.unlock();
}

export function endCall(): void {
  // A caller hang-up closes the call server-side, which files the marker and the wrap-up
  // run. The bot's own end_call already did that, so only tell the server when it did not.
  if (state && !botEndedCall) {
    const { botId, connectedAt } = state;
    const closingCallId = callId;
    const epoch = sessionEpoch;
    const durationSeconds =
      connectedAt === null ? undefined : Math.max(0, Math.round((Date.now() - connectedAt) / 1000));
    const closeServerCall = async () => {
      if (epoch !== sessionEpoch) return;
      await rpc.threads.endCall({
        botId,
        callId: closingCallId,
        ...(durationSeconds === undefined ? {} : { durationSeconds }),
      });
    };
    const closed = callSends.closeAfterSends(closingCallId, closeServerCall);
    hangUps.add(closed);
    void closed.then(() => hangUps.delete(closed));
  }
  dropCall();
}

/** Stops the call on this device only. */
function dropCall(): void {
  pickup?.abort();
  pickup = null;
  openingPending = false;
  feed?.controller.abort();
  feed = null;
  hangUpAfterReply = false;
  botEndedCall = false;
  if (hangUpTimer) clearTimeout(hangUpTimer);
  hangUpTimer = null;
  if (guardTimer) clearTimeout(guardTimer);
  guardTimer = null;
  interim.clear();
  micOpen = false;
  bargedIn = false;
  awaitingReply = false;
  approvalRunId = null;
  awaitedRunId = null;
  finishedRunIds.clear();
  unsubSpeech?.();
  unsubDictation?.();
  unsubSpeech = null;
  unsubDictation = null;
  dictation.stop("cancel");
  speaker.stop();
  thread = null;
  spokenMessageIds.clear();
  spokenMemory.clear();
  if (state) {
    state = null;
    emit();
  }
}

/** Set once the session changed under this page; a pending sign-out then reloads instead. */
let sessionChangedHere = false;
export function sessionChangedUnderPage(): boolean {
  return sessionChangedHere;
}

/** The session is already gone: end the call without a hang-up the old user can no longer send. */
function endCallSignedOut(): void {
  sessionEpoch += 1;
  dropCall();
}

/** The host is removing this bundle; release media without sending old-account RPCs. */
export function disposeCallSession(): void {
  if (disposed) return;
  disposed = true;
  leaving = true;
  identity = null;
  endCallSignedOut();
}

export function isCallSessionDisposed(): boolean {
  return disposed;
}

/**
 * The session changed under this page: end the call here, then load a fresh page so nothing
 * from the old session, such as a pending call start or a queued request, survives.
 */
function reloadForNewSession(): void {
  endCallSignedOut();
  // A sign-out still waiting to send must not send it with the new session's cookie.
  sessionChangedHere = true;
  // Already leaving, for example signing out: that page load is fresh too.
  if (leaving) return;
  leaving = true;
  window.location.reload();
}

/**
 * Hangs up while the session still exists, waiting at most `SIGN_OUT_HANG_UP_MS` for pending
 * sends and hang-ups. Hang-ups still queued after that are dropped: by the time they run, the
 * cookie they send may belong to no one or to another user. The page is left right after.
 */
export async function endCallBeforeSignOut(): Promise<void> {
  leaving = true;
  endCall();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(hangUps),
    new Promise((resolve) => {
      timer = setTimeout(resolve, SIGN_OUT_HANG_UP_MS);
    }),
  ]);
  clearTimeout(timer);
  sessionEpoch += 1;
}

/** The page is being left for a new session: nothing more may be sent for the old one. */
export function isLeavingSession(): boolean {
  return leaving;
}

/** A call belongs to the signed-in user: when that user changes or signs out, the page reloads. */
export function syncCallIdentity(userId: string | null): void {
  const previous = identity;
  if (previous === userId) return;
  identity = userId;
  publishSignedInUser(userId);
  // Paws leases are mount/account bound; cookie-wide signout is a separate identity.
  if (embedded) return;
  if (typeof previous === "string") reloadForNewSession();
  else if (userId !== null) watchOtherTabs();
}

/** This page signed out and leaves on its own: other tabs reload, this one does not. */
export function forgetSignedInUser(): void {
  identity = null;
  publishSignedInUser(null);
}

/**
 * Another tab signed out or confirmed another user: this tab's session lookup may stall or
 * still report the old user, so reload before anything runs with the other session's cookie.
 */
function watchOtherTabs(): void {
  if (watchingOtherTabs) return;
  watchingOtherTabs = true;
  getGlobalBroadcastChannel().subscribe((message) => {
    if (message.data?.trigger === "signout" && typeof identity === "string") reloadForNewSession();
  });
  listenWindow("storage", (event) => {
    if (event.key !== scopedStorageKey(SIGNED_IN_USER_KEY) || typeof identity !== "string") return;
    if (event.newValue !== identity) reloadForNewSession();
  });
}

function publishSignedInUser(userId: string | null): void {
  try {
    if (userId === null) localStore.removeItem(SIGNED_IN_USER_KEY);
    else localStore.setItem(SIGNED_IN_USER_KEY, userId);
  } catch {
    // No storage (private mode, tests): other tabs still see sign-outs from Better Auth.
  }
}

export function toggleMute(): void {
  if (!state) return;
  const muted = !state.muted;
  set({ muted });
  if (muted) {
    dictation.stop("cancel");
    micOpen = false;
    set({ heard: "" });
    return;
  }
  if (state.phase === "listening") void listen();
  else if (state.phase === "speaking") void openMic();
}

export function toggleTranscript(): void {
  if (!state) return;
  set({ transcriptOpen: !state.transcriptOpen });
}

export function setCallMinimized(minimized: boolean): void {
  if (!state) return;
  set({ minimized });
}

/** Live feed for the bot on the call, independent of whichever thread is on screen. */
function watchThread(botId: string) {
  const controller = new AbortController();
  const avatarSource = newLogoAvatarActivitySource();
  const feedCallId = callId;
  let requestEpoch = 0;
  let acceptedEpoch = 0;
  const isCurrent = () =>
    feed?.controller === controller &&
    !controller.signal.aborted &&
    callId === feedCallId &&
    state?.botId === botId;
  const load = async () => {
    if (!isCurrent()) return null;
    const request = ++requestEpoch;
    const next = await rpc.threads.get({ botId }, { signal: controller.signal });
    if (!isCurrent()) return null;
    if (request < acceptedEpoch) return thread;
    if (thread?.threadId === next.threadId && thread.cursor > next.cursor) return thread;
    acceptedEpoch = request;
    webLogoAvatarActivity.reconcile(next);
    return commit(next);
  };
  // The subscription stops retrying on a 401 and a stalled session lookup may never route to
  // sign-in, so the call ends on any refused request. A session that expires mid-stream arrives
  // as an error inside an HTTP 200, which the response hook never sees: recheck it here too.
  const endOnUnauthorized = (error: unknown): never => {
    if (errorStatus(error) === 401 && isCurrent()) {
      recheckSessionOnUnauthorized(401);
      endCallSignedOut();
    }
    throw error;
  };
  const loadOrEnd = () => load().catch(endOnUnauthorized);
  feed = { controller, load: loadOrEnd };
  async function* endOnUnauthorizedEvents(events: AsyncIterable<ProductEvent>) {
    try {
      yield* events;
    } catch (error) {
      endOnUnauthorized(error);
    }
  }
  void runThreadSubscription({
    signal: controller.signal,
    loadInitial: loadOrEnd,
    loadHead: () =>
      rpc.threads.head({ botId }, { signal: controller.signal }).catch(endOnUnauthorized),
    refresh: loadOrEnd,
    currentSnapshot: () => thread,
    subscribe: async (cursor, signal) =>
      endOnUnauthorizedEvents(
        await openLogoAvatarActivityFeed(avatarSource, thread, cursor, signal, () =>
          rpc.threads.subscribe({ botId, cursor }, { signal }),
        ).catch(endOnUnauthorized),
      ),
    beforeEvent: (event) => webLogoAvatarActivity.apply(avatarSource, event),
    applyEvent: (event) => {
      if (event.runId && isRunTerminalEvent(event)) finishedRunIds.add(event.runId);
      if (isThreadSnapshotEvent(event)) commit(reduceThreadSnapshot(thread, event));
    },
    onEvent: (event) => {
      // The bot hung up: speak the farewell it wrote and stop there — the rest of its
      // work lands in the thread as chat, which the caller is no longer listening to.
      if (event.type !== "thread.call.ended" || event.payload.callId !== callId) return;
      if (botEndedCall) return;
      hangUpAfterReply = true;
      botEndedCall = true;
      if (hangUpTimer) clearTimeout(hangUpTimer);
      hangUpTimer = setTimeout(endCall, CALL_FAREWELL_TIMEOUT_MS);
      speakFarewell(event.payload);
    },
  });
}

/** The bot's own goodbye: the last thing this call says before the speaker goes idle. */
function speakFarewell(payload: Record<string, unknown>) {
  if (!state) return;
  const farewell = typeof payload.farewell === "string" ? payload.farewell.trim() : "";
  const messageId = typeof payload.messageId === "string" ? payload.messageId : undefined;
  if (messageId) spokenMessageIds.add(messageId);
  // Nothing to say: hang up instead of waiting out the fallback.
  if (!farewell) {
    endCall();
    return;
  }
  awaitingReply = false;
  set({ exchanges: [...state.exchanges, { role: "bot", text: farewell }], heard: "" });
  spokenMemory.remember(farewell);
  void speaker.speak(farewell, { botId: state.botId, messageId });
}

function commit(next: ThreadSnapshot | null) {
  if (!next) return null;
  const nextRuns = [...(next.activeRuns ?? []), ...(next.run ? [next.run] : [])];
  for (const run of [...(thread?.activeRuns ?? []), ...(thread?.run ? [thread.run] : [])]) {
    if (
      isActive(run.status) &&
      !nextRuns.some((nextRun) => nextRun.id === run.id && isActive(nextRun.status))
    ) {
      finishedRunIds.add(run.id);
    }
  }
  for (const run of nextRuns) {
    if (isActive(run.status)) finishedRunIds.delete(run.id);
    else finishedRunIds.add(run.id);
  }
  thread = next;
  reactToThread();
  return next;
}

/** The tail of playback reaches the microphone after the audio element ends. */
function guardThenListen() {
  // Dictation ran right through playback: there is no shut mic to hold closed.
  if (micOpen) {
    void listen();
    return;
  }
  if (guardTimer) clearTimeout(guardTimer);
  guardTimer = setTimeout(() => {
    guardTimer = null;
    void listen();
  }, ECHO_GUARD_MS);
}

async function listen() {
  if (!state) return;
  // The caller said goodbye: every path back to listening hangs up instead.
  if (hangUpAfterReply) {
    endCall();
    return;
  }
  // A reply still playing owns the audio session; its idle event calls back here.
  if (speaker.isSpeaking()) return;
  // A guard is already counting down the quiet gap; it calls back here when it ends.
  if (guardTimer) return;
  set({ phase: "listening", heard: "" });
  speaker.stop();
  if (state.muted || pendingCallSecretAsk(thread)) {
    dictation.stop("cancel");
    micOpen = false;
    return;
  }
  await openMic();
}

/** Starts dictation unless it is already running, muted, or waiting on a typed secret. */
async function openMic() {
  if (!state || micOpen || state.muted || pendingCallSecretAsk(thread)) return;
  if (state.phase === "speaking" && usesServerDictation(transcribe)) return;
  micOpen = true;
  try {
    await dictation.listen({
      mode: "endpoint",
      transcribe,
      onFinal: (text) => void handleTranscript(text),
    });
  } catch (error) {
    micOpen = false;
    reportClientError(error, "voice.microphone");
    set({ caption: errorText(error, t`Microphone failed`) });
  }
}

async function handleTranscript(text: string) {
  if (!state) return;
  // Dictation stopped itself to deliver this final.
  micOpen = false;
  if (!text.trim()) {
    void listen();
    return;
  }
  if (state.phase === "speaking") {
    if (!isCallBargeIn(text)) {
      set({ heard: "" });
      void openMic();
      return;
    }
    // The caller talked over the reply: cut the audio, and never resume that message.
    bargedIn = true;
    speaker.stop();
    set({ phase: "thinking", caption: "" });
  }
  dictation.stop("submit");
  // The microphone caught the reply, not the caller: drop it and keep listening.
  if (spokenMemory.isEcho(text)) {
    set({ heard: "" });
    void listen();
    return;
  }
  const turn = callTurn(thread, text);
  if (turn.kind === "enter_code") {
    set({ heard: "", caption: t`Hang up, then enter the code on screen.` });
    return;
  }
  const { botId, exchanges } = state;
  // Captured now: a call started while this is in flight must not re-attach the new feed
  // or commit this turn onto it. The same bot can be called again, so the bot id is not enough.
  const callFeed = feed;
  const turnCallId = callId;
  const closing = isFarewell(text);
  // An approval is only answered on screen, next to its details; a spoken reply would be refused.
  if (turn.kind === "approve_on_screen") {
    // The caption covers a card the call never read; once tapped, it must not pass for the reply.
    spokenMessageIds.add(turn.messageId);
    approvalRunId = turn.runId;
    awaitingReply = true;
    if (closing) hangUpAfterReply = true;
    set({ heard: "", caption: t`Approve or deny it on screen.` });
    void listen();
    return;
  }
  approvalRunId = null;
  awaitedRunId = turn.kind === "answer" ? turn.runId : null;
  awaitingReply = true;
  set({ heard: text, phase: "thinking", exchanges: [...exchanges, { role: "user", text }] });
  if (closing) {
    hangUpAfterReply = true;
    // A second goodbye replaces this timer. Clear the previous one or it can
    // end the next call after this one has already hung up.
    if (hangUpTimer) clearTimeout(hangUpTimer);
    hangUpTimer = setTimeout(endCall, CALL_FAREWELL_TIMEOUT_MS);
  }
  let releasePendingSend: () => void = () => undefined;
  try {
    const clientNonce = callClientNonce(turnCallId);
    const sendRequest =
      turn.kind === "answer"
        ? rpc.threads.answer({
            botId,
            runId: turn.runId,
            messageId: turn.messageId,
            answer: turn.answer,
            clientNonce,
          })
        : turn.kind === "follow_up"
          ? rpc.threads.followUp({ botId, text, clientNonce })
          : rpc.threads.send({ botId, clientNonce, text });
    releasePendingSend = callSends.track(turnCallId, sendRequest);
    const receipt = await sendRequest;
    if (!state || state.botId !== botId || callId !== turnCallId) return;
    if ("runId" in receipt) awaitedRunId = receipt.runId;
  } catch (error) {
    if (!state || state.botId !== botId || callId !== turnCallId) return;
    awaitingReply = false;
    set({ caption: errorText(error, t`Could not send that`) });
    void listen();
    return;
  } finally {
    releasePendingSend();
  }
  if (!state || state.botId !== botId || callId !== turnCallId) return;
  try {
    await callFeed?.load();
  } catch (error) {
    if (!state || state.botId !== botId || callId !== turnCallId) return;
    awaitingReply = false;
    set({ caption: errorText(error, t`Could not send that`) });
    void listen();
  }
}

/**
 * Interim results are the only signal that arrives while the caller is still talking.
 * A qualifying phrase that stands for INTERIM_BARGE_IN_MS stops the audio at once; the
 * dictation session keeps running, so its silence window finishes the utterance and
 * handleTranscript sends it as the next turn.
 */
function watchInterim(text: string) {
  if (state?.phase !== "speaking") return;
  interim.hear(text);
}

/**
 * Speak the bot's reply to the caller's latest turn. A call never speaks tool activity: the
 * card's phase indicator is the only feedback, so nothing talks over the caller.
 */
function reactToThread() {
  // Nothing is spoken before the call picks up, or over the bot's opening.
  if (!state || state.phase === "ringing" || openingPending) return;
  // The bot already said goodbye: neither its marker nor the work it files after it is spoken.
  if (botEndedCall) return;
  if (pendingCallSecretAsk(thread)) {
    dictation.stop("cancel");
    micOpen = false;
    set({ heard: "" });
  }
  // A turn sent back to listening mid-flight must not drop the reply it is waiting for.
  if (state.phase === "listening" && !awaitingReply) return;
  const { botId } = state;
  const messages = thread?.messages ?? [];
  // Only what the bot wrote after the caller's latest turn answers it. A run that stopped on a
  // card keeps its live progress message after the card; that is not a reply.
  const turnIndex = messages.findLastIndex((message) => message.role === "user");
  const replyRunId = approvalRunId ?? awaitedRunId;
  const lastBot = messages
    .slice(turnIndex + 1)
    .findLast(
      (message) =>
        message.role === "bot" &&
        !(message.id.startsWith("progress:") && replyFinished(message)) &&
        (!replyRunId || message.runId === replyRunId),
    );
  if (lastBot && !spokenMessageIds.has(lastBot.id) && replyFinished(lastBot)) {
    const text = speechFromBlocks(lastBot.blocks);
    const ask = lastBot.blocks.find((block) => block.kind === "ask" && block.status !== "answered");
    const secretAsk = ask && isSecretAskBlock(ask);
    const approvalAsk = ask && isApprovalAskBlock(ask);
    if (text) {
      // Never spoken again, interrupted or not.
      spokenMessageIds.add(lastBot.id);
      // An approval is answered on screen, which sends no turn: keep waiting for the reply
      // its run writes next.
      approvalRunId = approvalAsk ? (lastBot.runId ?? null) : null;
      awaitingReply = approvalRunId !== null;
      set({ exchanges: [...state.exchanges, { role: "bot", text }], heard: "" });
      spokenMemory.remember(text);
      void speaker.speak(
        secretAsk
          ? `${text}. ${t`Hang up first, then enter the code on screen.`}`
          : approvalAsk
            ? `${text}. ${t`Approve or deny it on screen.`}`
            : ask
              ? `${text}. ${t`Say yes or no, or answer in a sentence.`}`
              : text,
        { botId, messageId: lastBot.id },
      );
      return;
    }
    if (!runActive(thread)) {
      spokenMessageIds.add(lastBot.id);
      awaitingReply = false;
      void listen();
    }
  }
  if (awaitingReply && replyRunId && finishedRunIds.has(replyRunId)) {
    awaitingReply = false;
    approvalRunId = null;
    awaitedRunId = null;
    set({ caption: errorText(thread?.run?.id === replyRunId ? thread.run.error : undefined) });
    void listen();
  }
}

/**
 * A reply is only whole once its own run stopped. Speaking a message the run is
 * still streaming clips it, and later updates of the same id never get a turn.
 */
function replyFinished(message: ThreadMessage) {
  const run = thread?.activeRuns?.find((run) => run.id === message.runId) ?? thread?.run;
  if (!run) return true;
  if (message.runId && message.runId !== run.id) return true;
  return !RUN_ACTIVE.includes(run.status);
}

function runActive(snapshot: ThreadSnapshot | null) {
  return Boolean(snapshot?.run && RUN_ACTIVE.includes(snapshot.run.status));
}
