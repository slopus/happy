import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelConnectInput } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvalCase, Evidence } from "./cases.js";
import {
  canonicalModelRequest,
  caseFingerprint,
  caseKey,
  firstRequestFetch,
  runFingerprint,
} from "./fingerprint.js";
import { regradeTrial } from "./grading.js";
import type { EvalJudge } from "./judge.js";
import type { TrialResult } from "./report.js";
import { emptyTrial, evidenceSnapshot } from "./report.js";
import type { StoredReport } from "./run-store.js";
import { judgeIdentity, RunStore } from "./run-store.js";

const connection: ModelConnectInput = {
  provider: "openai-compatible",
  modelId: "fixture-model",
  apiKey: "fixture-key",
  label: "Eval model",
  maxTokens: 4096,
};
const scenario: EvalCase = {
  id: "lease",
  purpose: "Recall the lease notice period",
  steps: [{ ask: "What notice does the lease need?" }],
  grade: (e) => [{ id: "answered", pass: e.text.length > 0 }],
  judge: (e) => ({ rubric: "States 90 days", evidence: e.text }),
  observe: (e) => ({ searched: e.toolNames.includes("search_history") }),
};
const request = (bot: string, now: string, ask = "What notice does the lease need?") =>
  JSON.stringify({
    model: "fixture-model",
    messages: [
      {
        role: "system",
        content: `Your home is bots/${bot}. Other bot: bots/cm0000000000000000000000z`,
      },
      { role: "user", content: `${ask}\n\nCurrent date and time: Friday, ${now} (UTC).` },
    ],
    tools: [{ type: "function", function: { name: "search_history" } }],
  });
const fingerprint = (overrides: Partial<Parameters<typeof caseFingerprint>[0]> = {}) =>
  caseFingerprint({
    request: request("cmwefwegzhl1v9sliefxpnyu2", "2026-11-13T03:51:18Z"),
    connection,
    caseVersion: "recall-v1",
    scenario,
    strategy: "current",
    replyMode: "chat",
    maxToolCalls: 30,
    ...overrides,
  });

describe("run fingerprint", () => {
  it("ignores record ids and the clock but keeps distinct ids distinct", () => {
    const a = request("cmwefwegzhl1v9sliefxpnyu2", "2026-11-13T03:51:18Z");
    const b = request("cmwefwgbybckfmrb1hqvk5wm3", "2026-12-02T10:00:00Z");
    expect(canonicalModelRequest(a)).toBe(canonicalModelRequest(b));
    // Two different ids in one request stay two placeholders.
    expect(canonicalModelRequest(a)).toContain("<id1>");
    expect(canonicalModelRequest(a)).toContain("<id2>");
    const same = request("cm0000000000000000000000z", "2026-11-13T03:51:18Z");
    expect(canonicalModelRequest(same)).not.toBe(canonicalModelRequest(a));
  });

  it("changes with what the model sees and how it runs, not with the key or label", () => {
    const base = fingerprint();
    expect(fingerprint({ connection: { ...connection, apiKey: "other", label: "x" } })).toBe(base);
    expect(
      fingerprint({ request: request("cmwefwgbybckfmrb1hqvk5wm3", "2027-01-05T09:00:00Z") }),
    ).toBe(base);
    for (const changed of [
      fingerprint({ request: request("cmwefwegzhl1v9sliefxpnyu2", "2026-11-13T03:51:18Z", "Hi") }),
      fingerprint({ connection: { ...connection, modelId: "other-model" } }),
      fingerprint({ connection: { ...connection, maxTokens: 1024 } }),
      fingerprint({ caseVersion: "recall-v2" }),
      fingerprint({ scenario: { ...scenario, steps: [...scenario.steps, { ask: "And rent?" }] } }),
      // A weekday the case itself states is part of the case, unlike the request's clock.
      fingerprint({ scenario: { ...scenario, steps: [{ ask: "Remind me on Tuesday" }] } }) ===
      fingerprint({ scenario: { ...scenario, steps: [{ ask: "Remind me on Friday" }] } })
        ? base
        : "differs",
      fingerprint({ strategy: "retrieval" }),
      fingerprint({ replyMode: "messages" }),
      fingerprint({ maxToolCalls: 8 }),
    ])
      expect(changed).not.toBe(base);
  });

  it("combines case fingerprints in any order and leaves out cases without one", () => {
    expect(runFingerprint({ a: "1", b: "2" })).toBe(runFingerprint({ b: "2", a: "1" }));
    expect(runFingerprint({ a: "1", b: null })).toBe(runFingerprint({ a: "1" }));
    expect(runFingerprint({ a: "1" })).not.toBe(runFingerprint({ a: "2" }));
    expect(runFingerprint({ a: null })).toBeNull();
  });

  it("sees the first eval model request before it is sent and can stop every later one", async () => {
    const upstream = vi.fn(async () => new Response("ok"));
    const seen: string[] = [];
    const stop = firstRequestFetch(upstream, "fixture-model", (body) => {
      seen.push(body);
      return false;
    });
    const other = JSON.stringify({ model: "checker-model" });
    await stop("http://model.test/v1", { method: "POST", body: other });
    await expect(
      stop("http://model.test/v1", { method: "POST", body: request("c1", "2026-11-13") }),
    ).rejects.toThrow("Stored trials replace this run");
    await expect(stop("http://model.test/v1", { method: "POST", body: other })).rejects.toThrow();
    expect(seen).toHaveLength(1);
    expect(upstream).toHaveBeenCalledTimes(1);

    // With a case, a request that does not carry its first turn (a new bot's intro) is passed by.
    const onFirst = vi.fn(() => true);
    const caseFetch = firstRequestFetch(upstream, "fixture-model", onFirst, scenario);
    await caseFetch("http://model.test/v1", {
      method: "POST",
      body: JSON.stringify({
        model: "fixture-model",
        messages: [{ content: "Introduce yourself" }],
      }),
    });
    expect(onFirst).not.toHaveBeenCalled();
    await caseFetch("http://model.test/v1", { method: "POST", body: request("c1", "2026-11-13") });
    expect(onFirst).toHaveBeenCalledTimes(1);

    const pass = firstRequestFetch(upstream, "fixture-model", () => true);
    await pass("http://model.test/v1", { method: "POST", body: request("c1", "2026-11-13") });
    expect(upstream).toHaveBeenCalledTimes(4);
  });
});

const evidence = (text: string) =>
  ({ text, toolNames: ["search_history"], files: {} }) as unknown as Evidence;
function trial(n: number, overrides: Partial<TrialResult> = {}): TrialResult {
  return {
    ...emptyTrial("lease", n),
    strategy: "current",
    status: "passed",
    category: null,
    reason: null,
    criteria: [
      { id: "answered", pass: true },
      { id: "semantic-outcome", pass: true },
    ],
    judgment: { pass: true, reason: "Says 90 days" },
    evidence: evidence("90 days"),
    costUsd: 0.01,
    ...overrides,
  };
}
const report = (
  trials: TrialResult[],
  options: { fingerprint?: string | null; rubric?: string; startedAt?: string } = {},
): StoredReport => ({
  suite: "recall",
  startedAt: options.startedAt ?? "2026-11-13T00:00:00.000Z",
  model: "fixture-model",
  provider: "openai-compatible",
  fixtureVersion: "recall-v1",
  caseFixtureVersions: { lease: "recall-v1" },
  codeRevision: "abc",
  judge: { model: "judge-model", rubricVersion: options.rubric ?? "meaning-v1" },
  ...(options.fingerprint === null
    ? {}
    : {
        fingerprint: {
          run: (options.fingerprint ?? "f1").padStart(64, "0"),
          cases: { [caseKey("lease", "current")]: options.fingerprint ?? "f1" },
        },
      }),
  workflowTotals: { costUsd: 0.03 },
  trials,
});

describe("run store", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const store = () => {
    dir = mkdtempSync(path.join(tmpdir(), "rakazo-run-store-"));
    return new RunStore(dir);
  };
  const plan = (s: RunStore, fingerprint = "f1", rubric = "meaning-v1") =>
    s.plan({
      scenario,
      trials: 3,
      strategy: "current",
      fingerprint,
      judge: judgeIdentity({ model: "judge-model", rubricVersion: rubric }),
    });

  it("indexes each run with its counts and keeps a rerun beside the first", () => {
    const s = store();
    const first = s.save(report([trial(1), trial(2, { status: "failed", category: "agent" })]));
    expect(first).toMatchObject({
      fingerprint: "f1".padStart(64, "0"),
      path: path.join("f1".padStart(64, "0"), "report.json.gz"),
      trials: { planned: 2, attempted: 2, passed: 1, run: 2, reused: 0, regraded: 0 },
      costUsd: { new: 0.03, trials: 0.02 },
      judge: { model: "judge-model", rubricVersion: "meaning-v1" },
      cases: { "lease/current": "f1" },
    });
    // Reruns of one fingerprint, even with the same start time, sit beside each other.
    const again = s.save(report([trial(1)]));
    const third = s.save(report([trial(1)]));
    expect(new Set([first.path, again.path, third.path]).size).toBe(3);
    expect(readdirSync(path.join(dir, "f1".padStart(64, "0")))).toHaveLength(3);
    expect(s.entries()).toHaveLength(3);
    expect(s.read(third).trials).toHaveLength(1);
    expect(s.read(first).trials).toHaveLength(2);
  });

  it("reuses under the same judge, regrades under another, and runs on a new fingerprint", () => {
    const s = store();
    s.save(report([trial(1), trial(2)]));
    expect(plan(s)).toMatchObject({ kind: "reuse", trials: [{ trial: 1 }, { trial: 2 }] });
    expect(plan(s, "f1", "meaning-v2")).toMatchObject({ kind: "regrade" });
    expect(plan(s, "f2")).toEqual({ kind: "run" });
    // The same judge model through another provider is another judge.
    expect(
      s.plan({
        scenario,
        trials: 3,
        strategy: "current",
        fingerprint: "f1",
        judge: judgeIdentity({
          provider: "other",
          model: "judge-model",
          rubricVersion: "meaning-v1",
        }),
      }),
    ).toMatchObject({ kind: "regrade" });
    // Once a regrade is stored, the newer judge reuses it.
    s.save(report([trial(1), trial(2)], { rubric: "meaning-v2" }));
    expect(plan(s, "f1", "meaning-v2")).toMatchObject({ kind: "reuse" });
  });

  it("never reuses legacy reports, infrastructure failures, or trials it cannot regrade", () => {
    const s = store();
    const legacy = s.save(report([trial(1)], { fingerprint: null }), { label: "clean-v7/main" });
    expect(legacy).toMatchObject({ legacy: true, label: "clean-v7/main" });
    expect(() => s.save(report([trial(1)], { fingerprint: null }))).toThrow("already");
    // A fingerprint that is not a hash never becomes a path.
    const edited = report([trial(1)]);
    edited.fingerprint = { run: "../../outside", cases: { "lease/current": "f1" } };
    expect(s.save(edited)).toMatchObject({
      legacy: true,
      fingerprint: expect.stringMatching(/^legacy-/),
    });
    expect(plan(s)).toEqual({ kind: "run" });
    s.save(
      report([
        trial(1, { status: "failed", category: "provider" }),
        trial(2, { cleanupFailed: true }),
        trial(3, { evidence: undefined }),
      ]),
    );
    expect(plan(s)).toEqual({ kind: "run" });
    // A trial that failed before grading needs no evidence: no judge ever saw it.
    s.save(report([trial(1, { status: "failed", category: "agent", criteria: [] })]));
    expect(plan(s)).toMatchObject({ kind: "reuse", trials: [{ trial: 1 }] });
  });

  it("keeps stored trial numbers when an earlier trial is not usable", () => {
    const s = store();
    s.save(report([trial(1, { status: "failed", category: "provider" }), trial(2)]));
    expect(plan(s)).toMatchObject({ kind: "reuse", trials: [{ trial: 2 }] });
    // Trials past the number wanted do not make a run a better source.
    s.save(report([trial(4), trial(5), trial(6)]));
    expect(plan(s)).toMatchObject({ kind: "reuse", trials: [{ trial: 2 }] });
  });

  it("prefers the current judge once a run has the trials wanted", () => {
    const s = store();
    s.save(report([trial(1), trial(2), trial(3), trial(4)], { rubric: "meaning-v0" }));
    s.save(report([trial(1), trial(2), trial(3)]));
    expect(plan(s)).toMatchObject({ kind: "reuse", trials: [{}, {}, {}] });
  });

  it("prefers the stored run with more trials", () => {
    const s = store();
    s.save(report([trial(1)], { startedAt: "2026-11-15T00:00:00.000Z" }));
    s.save(report([trial(1), trial(2), trial(3)], { startedAt: "2026-11-14T00:00:00.000Z" }));
    expect(plan(s)).toMatchObject({ kind: "reuse", trials: [{}, {}, {}] });
  });
});

describe("regrading a stored trial", () => {
  it("grades the stored evidence with the current judge, without running the bot", async () => {
    const judge = vi.fn<EvalJudge>(async () => ({ pass: false, reason: "Says 60 days" }));
    const result = await regradeTrial(scenario, trial(1), judge, 1000);
    expect(judge).toHaveBeenCalledWith(
      { rubric: "States 90 days", evidence: "90 days" },
      expect.any(AbortSignal),
    );
    expect(result).toMatchObject({
      status: "failed",
      category: "agent",
      reason: "Outcome criteria failed",
      judgment: { pass: false, reason: "Says 60 days" },
      criteria: [
        { id: "answered", pass: true },
        { id: "semantic-outcome", pass: false },
      ],
      observations: { searched: { present: true } },
      evidence: evidence("90 days"),
    });
  });

  it("keeps a deterministic failure and a trial that never reached grading as stored", async () => {
    const judge = vi.fn<EvalJudge>(async () => ({ pass: true, reason: "fine" }));
    const failed = trial(1, {
      status: "failed",
      category: "agent",
      reason: "Outcome criteria failed",
      criteria: [{ id: "answered", pass: false }],
      judgment: undefined,
    });
    expect(await regradeTrial(scenario, failed, judge, 1000)).toMatchObject({
      status: "failed",
      reason: "Outcome criteria failed",
    });
    const early = trial(2, { status: "failed", category: "product", criteria: [], reason: "x" });
    expect(await regradeTrial(scenario, early, judge, 1000)).toEqual(early);
    expect(judge).not.toHaveBeenCalled();
  });

  it("gives judges back the maps a stored trial was graded on", async () => {
    const mapped: EvalCase = {
      ...scenario,
      judge: (e) => ({
        rubric: "Drafted",
        evidence: [...(e.apps!.mail as unknown as { drafts: Map<string, string> }).drafts.values()],
      }),
    };
    const live = {
      ...evidence("done"),
      apps: { mail: { drafts: new Map([["d1", "Hi https://private.test/x"]]) } },
    };
    const judge = vi.fn<EvalJudge>(async () => ({ pass: true, reason: "ok" }));
    await regradeTrial(mapped, trial(1, { evidence: evidenceSnapshot(live, []) }), judge, 1000);
    // Fixture links stay so the regrade sees what the live grade saw; credentials do not.
    expect(judge).toHaveBeenCalledWith(
      { rubric: "Drafted", evidence: ["Hi https://private.test/x"] },
      expect.anything(),
    );
    expect(JSON.stringify(evidenceSnapshot({ key: "sk-live123 and k1" }, ["k1"]))).toBe(
      '{"key":"[redacted] and [redacted]"}',
    );
  });

  it("labels a regraded failure the way the run did", async () => {
    const judge = vi.fn<EvalJudge>(async () => ({ pass: false, reason: "no" }));
    const issue = "The offline sandbox refused a shell command.";
    expect(
      await regradeTrial(scenario, trial(1, { harnessIssues: [issue] }), judge, 1000),
    ).toMatchObject({ status: "failed", category: "harness", reason: issue });
  });

  it("leaves the trial incomplete when the judge fails", async () => {
    const judge = vi.fn<EvalJudge>(async () => {
      throw new Error("judge down");
    });
    expect(await regradeTrial(scenario, trial(1), judge, 1000)).toMatchObject({
      status: "failed",
      category: "incomplete",
      reason: "Judge unavailable: judge down",
    });
  });
});
