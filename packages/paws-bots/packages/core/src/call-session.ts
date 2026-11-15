import type { MessageBlock } from "@rakazo/contracts";
import { isApprovalAskBlock, isSecretAskBlock } from "./action-approval.js";
import { isRunWorking } from "./run-state.js";
import { spokenDecision } from "./speech-text.js";

/** One line of a call's transcript. */
export type CallExchange = { role: "user" | "bot"; text: string };

/** How long a goodbye waits for a reply that may never come before hanging up anyway. */
export const CALL_FAREWELL_TIMEOUT_MS = 20_000;

/**
 * The turns a call has sent and not yet seen land. The server checks durable user
 * messages when a call closes, so a hang-up must follow every write still in flight.
 */
export function createCallSendTracker() {
  const pending = new Map<string, Set<Promise<unknown>>>();
  return {
    /** Holds `callId`'s close until `request` settles; the returned release forgets it. */
    track(callId: string, request: Promise<unknown>): () => void {
      const sends = pending.get(callId) ?? new Set<Promise<unknown>>();
      sends.add(request);
      pending.set(callId, sends);
      return () => {
        sends.delete(request);
        if (sends.size === 0) pending.delete(callId);
      };
    },
    /**
     * Runs `close` now, or once `callId`'s in-flight sends settle. Failures are dropped; the
     * returned promise settles when `close` does.
     */
    closeAfterSends(callId: string, close: () => Promise<unknown>): Promise<void> {
      const sends = [...(pending.get(callId) ?? [])];
      const closed = sends.length === 0 ? close() : Promise.allSettled(sends).then(close);
      return closed.then(
        () => undefined,
        () => undefined,
      );
    },
  };
}

/** The parts of the call's thread that decide what a spoken turn does. */
export type CallThread = {
  run: { id: string; status: string } | null;
  /** Every active run; `run` is only the one the thread shows first. */
  activeRuns?: readonly { id: string; status: string }[];
  messages: readonly { id: string; runId?: string; blocks: readonly MessageBlock[] }[];
};

/**
 * What the caller's finished turn does:
 * - `enter_code`: the bot asked for a code or password; it is typed on screen, never spoken.
 * - `approve_on_screen`: the bot asked for an approval, which is only granted next to its details.
 * - `answer`: the spoken reply answers the bot's open question.
 * - `follow_up`: the bot is still working; the turn steers that run.
 * - `send`: a new message.
 */
export type CallTurn =
  | { kind: "enter_code" }
  | { kind: "approve_on_screen"; messageId: string; runId: string }
  | { kind: "answer"; messageId: string; runId: string; answer: string }
  | { kind: "follow_up" }
  | { kind: "send" };

export function callTurn(thread: CallThread | null, text: string): CallTurn {
  // A code asked by any waiting run is never spoken, whichever run the thread shows first.
  if (pendingCallSecretAsk(thread)) return { kind: "enter_code" };
  const ask = pendingCallAsk(thread, thread?.run);
  if (ask?.blocks.some(isApprovalAskBlock)) {
    return { kind: "approve_on_screen", messageId: ask.message.id, runId: ask.runId };
  }
  if (ask) {
    const answer = spokenDecision(text) ?? text;
    return { kind: "answer", messageId: ask.message.id, runId: ask.runId, answer };
  }
  return isRunWorking(thread?.run?.status) ? { kind: "follow_up" } : { kind: "send" };
}

/** The bot is waiting on a code or password, which the call must not listen for. */
export function pendingCallSecretAsk(thread: CallThread | null): boolean {
  // Every waiting run counts, so a code is never heard. In a shared space that includes other
  // members' runs: holding the mic for their code is the safe way to be wrong.
  const runs = [thread?.run, ...(thread?.activeRuns ?? [])];
  return runs.some((run) => pendingCallAsk(thread, run)?.blocks.some(isSecretAskBlock));
}

/**
 * The newest card `run` asked while waiting, with its unanswered asks. Spoken answers go only to
 * the run the thread shows first: other active runs can belong to other members of a shared
 * space, who alone may answer them.
 */
function pendingCallAsk(
  thread: CallThread | null,
  run: { id: string; status: string } | null | undefined,
) {
  if (run?.status !== "waiting_input") return undefined;
  const message = thread?.messages.findLast(
    (candidate) => candidate.runId === run.id && candidate.blocks.some(unansweredAsk),
  );
  return message && { message, runId: run.id, blocks: message.blocks.filter(unansweredAsk) };
}

function unansweredAsk(block: MessageBlock): boolean {
  return block.kind === "ask" && block.status !== "answered";
}
