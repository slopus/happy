import { describe, expect, it } from "vitest";
import {
  answerableAskMessageIds,
  dismissableAskMessageIds,
  resolveAskChoice,
  selectedAskActionLabel,
} from "./answerable-ask.js";

describe("answerableAskMessageIds", () => {
  it("finds a waiting prompt even when a newer group run is active", () => {
    expect(
      answerableAskMessageIds({
        run: { id: "run-newer", status: "running" },
        activeRuns: [
          { id: "run-newer", status: "running" },
          { id: "run-waiting", status: "waiting_input" },
        ],
        messages: [
          {
            id: "ask-1",
            runId: "run-waiting",
            blocks: [{ kind: "ask", status: "pending" }],
          },
        ],
      }),
    ).toEqual(new Set(["ask-1"]));
  });

  it("keeps every pending card answerable after newer work and messages", () => {
    expect(
      answerableAskMessageIds({
        activeRuns: [
          { id: "paused-a", status: "waiting_input" },
          { id: "paused-b", status: "waiting_input" },
          { id: "new", status: "running" },
        ],
        messages: [
          { id: "question", runId: "paused-a", blocks: [{ kind: "ask", status: "pending" }] },
          { id: "approval", runId: "paused-b", blocks: [{ kind: "ask", status: "pending" }] },
          { id: "done", runId: "paused-a", blocks: [{ kind: "ask", status: "answered" }] },
          { id: "new-message", runId: "new", blocks: [{ kind: "text" }] },
        ],
      }),
    ).toEqual(new Set(["question", "approval"]));
  });

  it("ignores answered prompts and prompts from non-waiting runs", () => {
    expect(
      answerableAskMessageIds({
        run: { id: "run-1", status: "running" },
        messages: [{ id: "ask-1", runId: "run-1", blocks: [{ kind: "ask", status: "pending" }] }],
      }),
    ).toEqual(new Set());
    expect(
      answerableAskMessageIds({
        run: { id: "run-1", status: "waiting_input" },
        messages: [{ id: "ask-1", runId: "run-1", blocks: [{ kind: "ask", status: "answered" }] }],
      }),
    ).toEqual(new Set());
  });
});

describe("selectedAskActionLabel", () => {
  it("maps a choice answer id to its user-facing label", () => {
    expect(
      selectedAskActionLabel("choice-2", [
        { id: "choice-1", label: "Berlin" },
        { id: "choice-2", label: "Seoul" },
      ]),
    ).toBe("Seoul");
  });

  it("falls back to the answer when an action is unavailable", () => {
    expect(selectedAskActionLabel("custom", undefined)).toBe("custom");
  });
});

describe("resolveAskChoice", () => {
  const actions = [
    { id: "choice-1", label: "Berlin" },
    { id: "choice-2", label: "Seoul" },
  ];

  it("matches an offered choice by id or label", () => {
    expect(resolveAskChoice("choice-2", actions)).toEqual({ id: "choice-2", label: "Seoul" });
    expect(resolveAskChoice(" seoul ", actions)).toEqual({ id: "choice-2", label: "Seoul" });
  });

  it("leaves unmatched free-text as a custom answer", () => {
    expect(resolveAskChoice("Toronto", actions)).toBeUndefined();
  });
});

describe("dismissableAskMessageIds", () => {
  it.each(["run", "activeRuns"])("uses each message's run from %s", (source) => {
    const run = { id: "run-1", status: "waiting_input", userId: "owner" };
    const snapshot = {
      ...(source === "run"
        ? { run }
        : { activeRuns: [run, { ...run, id: "run-2", userId: "other" }] }),
      messages: [
        {
          id: "secret",
          runId: "run-1",
          blocks: [{ kind: "ask", input: "secret", status: "pending" }],
        },
        {
          id: "login",
          runId: "run-1",
          blocks: [
            {
              kind: "ask",
              input: "secret",
              status: "pending",
              credential: { auth: { type: "login" } },
            },
          ],
        },
        {
          id: "other",
          runId: "run-2",
          blocks: [{ kind: "ask", input: "secret", status: "pending" }],
        },
        {
          id: "answered",
          runId: "run-1",
          blocks: [{ kind: "ask", input: "secret", status: "answered" }],
        },
        { id: "question", runId: "run-1", blocks: [{ kind: "ask", status: "pending" }] },
        {
          id: "approval",
          runId: "run-1",
          blocks: [{ kind: "ask", input: "secret", approvalEffectId: "effect", status: "pending" }],
        },
      ],
    };
    expect(dismissableAskMessageIds(snapshot, "owner")).toEqual(new Set(["secret", "login"]));
    expect(dismissableAskMessageIds(snapshot, "member")).toEqual(new Set());
    expect(dismissableAskMessageIds(snapshot)).toEqual(new Set());
    expect(
      dismissableAskMessageIds(
        { ...snapshot, run: { ...run, userId: undefined }, activeRuns: undefined },
        "owner",
      ),
    ).toEqual(new Set());
    expect(
      dismissableAskMessageIds(
        { ...snapshot, run: { ...run, status: "running" }, activeRuns: undefined },
        "owner",
      ),
    ).toEqual(new Set());
    expect(dismissableAskMessageIds(null, "owner")).toEqual(new Set());
    expect(answerableAskMessageIds(snapshot).has("secret")).toBe(true);
  });
});
