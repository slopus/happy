import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { CallThread } from "./call-session.js";
import { callTurn, createCallSendTracker, pendingCallSecretAsk } from "./call-session.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("call send tracker", () => {
  it("closes at once when nothing is in flight", () => {
    const sends = createCallSendTracker();
    const close = vi.fn(async () => undefined);
    sends.closeAfterSends("call-1", close);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes only after every in-flight send settles, even a failed one", async () => {
    const sends = createCallSendTracker();
    const first = deferred();
    const second = deferred();
    sends.track("call-1", first.promise);
    sends.track("call-1", second.promise);
    const close = vi.fn(async () => undefined);
    sends.closeAfterSends("call-1", close);
    first.reject(new Error("offline"));
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    second.resolve();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  it("keeps calls apart and forgets released sends", () => {
    const sends = createCallSendTracker();
    const release = sends.track("call-1", new Promise(() => undefined));
    const otherCall = vi.fn(async () => undefined);
    sends.closeAfterSends("call-2", otherCall);
    expect(otherCall).toHaveBeenCalledTimes(1);
    release();
    const close = vi.fn(async () => undefined);
    sends.closeAfterSends("call-1", close);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("swallows a failed close", async () => {
    const sends = createCallSendTracker();
    const close = vi.fn(() => Promise.reject(new Error("gone")));
    await expect(sends.closeAfterSends("call-1", close)).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("call turn", () => {
  const question: MessageBlock = { kind: "ask", text: "Ship it?", status: "pending" };
  const secret: MessageBlock = { kind: "ask", text: "Code?", input: "secret", status: "pending" };
  const approval: MessageBlock = {
    kind: "ask",
    text: "Send the email?",
    status: "pending",
    approvalEffectId: "effect-1",
    actions: [
      { id: "allow", label: "Allow" },
      { id: "deny", label: "Deny" },
    ],
  };
  const waiting = (blocks: MessageBlock[], status = "waiting_input"): CallThread => ({
    run: { id: "run-1", status },
    messages: [
      { id: "older", runId: "run-1", blocks: [{ ...question, status: "answered" }] },
      { id: "ask", runId: "run-1", blocks },
    ],
  });

  it("answers the waiting run's open question, as a decision when it is one", () => {
    expect(callTurn(waiting([question]), "Yeah, go ahead")).toEqual({
      kind: "answer",
      messageId: "ask",
      runId: "run-1",
      answer: "yes",
    });
    expect(callTurn(waiting([question]), "Only the first one")).toMatchObject({
      kind: "answer",
      answer: "Only the first one",
    });
  });

  it("sends approvals and codes to the screen instead of answering them by voice", () => {
    expect(callTurn(waiting([approval]), "yes")).toEqual({
      kind: "approve_on_screen",
      messageId: "ask",
      runId: "run-1",
    });
    expect(callTurn(waiting([secret]), "one two three")).toEqual({ kind: "enter_code" });
    expect(pendingCallSecretAsk(waiting([secret]))).toBe(true);
    expect(pendingCallSecretAsk(waiting([question]))).toBe(false);
  });

  it("steers a working run and otherwise sends a new message", () => {
    expect(callTurn(waiting([question], "running"), "also this")).toEqual({ kind: "follow_up" });
    expect(callTurn(waiting([question], "completed"), "hello")).toEqual({ kind: "send" });
    expect(callTurn(waiting([{ ...question, status: "answered" }]), "hello")).toEqual({
      kind: "send",
    });
    expect(callTurn(null, "hello")).toEqual({ kind: "send" });
  });

  it("withholds speech while any waiting run asks for a code, but answers only the shown run", () => {
    const thread: CallThread = {
      run: { id: "run-1", status: "running" },
      activeRuns: [
        { id: "run-1", status: "running" },
        { id: "run-2", status: "waiting_input" },
      ],
      messages: [{ id: "code", runId: "run-2", blocks: [secret] }],
    };
    expect(pendingCallSecretAsk(thread)).toBe(true);
    expect(callTurn(thread, "one two three")).toEqual({ kind: "enter_code" });
    // A plain question on that run is not answered by voice: it may be another member's.
    const asked = { ...thread, messages: [{ id: "q", runId: "run-2", blocks: [question] }] };
    expect(pendingCallSecretAsk(asked)).toBe(false);
    expect(callTurn(asked, "yes")).toEqual({ kind: "follow_up" });
  });

  it("ignores asks left by another run", () => {
    const thread = waiting([question]);
    expect(
      callTurn({ ...thread, messages: [{ ...thread.messages[1]!, runId: "run-0" }] }, "yes"),
    ).toEqual({ kind: "send" });
  });
});
