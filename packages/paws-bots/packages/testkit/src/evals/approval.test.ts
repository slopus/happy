import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AutoReviewProvider, AutoReviewRequest, AutoReviewResult } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import type { ApprovalCase } from "./approval.js";
import {
  APPROVAL_CASES,
  APPROVAL_FIXTURE_VERSION,
  approvalRequest,
  runApprovalCases,
  summarizeApproval,
} from "./approval.js";
import type { MeasuredCall } from "./measurement.js";

describe("approval cases", () => {
  it("are a versioned, reviewed set with unique ids and both outcomes", () => {
    expect(APPROVAL_FIXTURE_VERSION).toBe("approval-cases-v2");
    const ids = APPROVAL_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(APPROVAL_CASES.length).toBeGreaterThanOrEqual(25);
    for (const expected of ["pass", "ask"] as const) {
      expect(APPROVAL_CASES.filter((c) => c.expected === expected).length).toBeGreaterThan(5);
      expect(APPROVAL_CASES.some((c) => c.newSite && c.expected === expected)).toBe(true);
    }
    for (const c of APPROVAL_CASES) {
      expect(c.id).toMatch(/^[a-z0-9-]+$/);
      for (const field of [c.userTask, c.botDescription, c.toolName, c.connectorKind, c.why])
        expect(field.trim()).not.toBe("");
      if (c.newSite) expect(Object.keys(c.args)).toEqual(["url"]);
    }
  });

  it("uses only reserved example domains for addresses and URLs", () => {
    const text = JSON.stringify(APPROVAL_CASES);
    const hosts = [...text.matchAll(/(?:@|https?:\/\/)([a-z0-9.-]+\.[a-z]+)/gi)].map((m) => m[1]!);
    expect(hosts.length).toBeGreaterThan(0);
    for (const host of hosts) expect(host).toMatch(/(?:^|\.)example\.(?:com|net|org)$/);
  });

  it("builds the reviewer request the product sends", () => {
    const site = APPROVAL_CASES.find((c) => c.newSite)!;
    expect(approvalRequest(site)).toEqual({
      toolName: "web_fetch",
      connectorKind: "web",
      args: site.args,
      userTask: site.userTask,
      botDescription: site.botDescription,
      matchingRules: [],
      newSite: true,
    });
    expect(approvalRequest(APPROVAL_CASES.find((c) => !c.newSite)!)).not.toHaveProperty("newSite");
  });
});

const fixture = (id: string, expected: "pass" | "ask"): ApprovalCase => ({
  id,
  userTask: id,
  botDescription: "bot",
  toolName: "TOOL",
  connectorKind: "demo",
  args: {},
  expected,
  why: "test",
});

describe("approval report", () => {
  it("separates false asks from false passes and never counts errors as passes", async () => {
    const cases = [
      fixture("pass-agree", "pass"),
      fixture("pass-false-ask", "pass"),
      fixture("pass-error", "pass"),
      fixture("ask-agree", "ask"),
      fixture("ask-false-pass", "ask"),
      fixture("ask-throws", "ask"),
    ];
    const scripted: Record<string, AutoReviewResult["decision"] | "throw"> = {
      "pass-agree": "pass",
      "pass-false-ask": "ask",
      "pass-error": "error",
      "ask-agree": "ask",
      "ask-false-pass": "pass",
      "ask-throws": "throw",
    };
    const calls: MeasuredCall[] = [];
    const reviewer: AutoReviewProvider = {
      describe: () => ({
        id: "scripted",
        contractVersion: "1",
        adapterVersion: "0",
        capabilities: { offline: true, keyless: true },
      }),
      review: async (request: AutoReviewRequest) => {
        const decision = scripted[request.userTask]!;
        calls.push({
          id: `${request.userTask}-call`,
          costUsd: 0.001,
          costSource: "provider-reported",
        });
        if (decision === "throw") throw new Error("network down\nstack");
        return { decision, model: "scripted/model" };
      },
    };
    const results = await runApprovalCases(cases, reviewer, {
      trials: 1,
      timeoutMs: 5_000,
      drainCalls: () => calls.splice(0),
    });
    expect(results.map((r) => [r.caseId, r.got, r.outcome])).toEqual([
      ["pass-agree", "pass", "agree"],
      ["pass-false-ask", "ask", "false-ask"],
      ["pass-error", "error", "unqualified"],
      ["ask-agree", "ask", "agree"],
      ["ask-false-pass", "pass", "false-pass"],
      ["ask-throws", "error", "unqualified"],
    ]);
    expect(results.at(-1)!.reason).toBe("network down");
    const summary = summarizeApproval(results);
    expect(summary).toMatchObject({
      results: 6,
      agreed: 2,
      falseAsks: 1,
      falsePasses: 1,
      unqualified: 2,
      agreementRate: 2 / 6,
      falseAskRate: 1 / 3,
      falsePassRate: 1 / 3,
      unqualifiedRate: 2 / 6,
      modelCalls: 6,
    });
    expect(summary.costUsd).toBeCloseTo(0.006);
  });

  it("reports unknown cost when a result has no recorded usage", () => {
    const base = {
      trial: 1,
      reason: null,
      model: null,
      latencyMs: 1,
      modelCalls: 0,
    } as const;
    const summary = summarizeApproval([
      { ...base, caseId: "a", expected: "pass", got: "pass", outcome: "agree", costUsd: 0.01 },
      {
        ...base,
        caseId: "b",
        expected: "ask",
        got: "error",
        outcome: "unqualified",
        costUsd: null,
      },
    ]);
    expect(summary.costUsd).toBeNull();
    expect(summary.falsePassRate).toBe(0);
    expect(summarizeApproval([]).agreementRate).toBeNull();
  });

  it("runs each trial of each case", async () => {
    const reviewer: AutoReviewProvider = {
      describe: () => ({
        id: "scripted",
        contractVersion: "1",
        adapterVersion: "0",
        capabilities: { offline: true, keyless: true },
      }),
      review: async () => ({ decision: "pass", model: "scripted/model" }),
    };
    const results = await runApprovalCases([fixture("a", "pass"), fixture("b", "ask")], reviewer, {
      trials: 2,
      timeoutMs: 5_000,
      drainCalls: () => [],
    });
    expect(results.map((r) => `${r.caseId}:${r.trial}:${r.outcome}`)).toEqual([
      "a:1:agree",
      "a:2:agree",
      "b:1:false-pass",
      "b:2:false-pass",
    ]);
    expect(results.every((r) => r.costUsd === null)).toBe(true);
  });
});

describe("approval suite CLI", () => {
  const cli = path.resolve(import.meta.dirname, "../cli/evals.ts");

  it("lists cases without importing runtime adapters", () => {
    const guard = `
      import { registerHooks } from 'node:module';
      registerHooks({
        resolve(specifier, context, nextResolve) {
          if (specifier === '@rakazo/db' || specifier === '@rakazo/adapters' || specifier.includes('adapters/src/'))
            throw new Error('Runtime imported for --list');
          return nextResolve(specifier, context);
        }
      });
    `;
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        `data:text/javascript,${encodeURIComponent(guard)}`,
        cli,
        "--suite",
        "approval",
        "--list",
      ],
      { encoding: "utf8", timeout: 20_000 },
    );
    expect(output.trim().split("\n")).toHaveLength(APPROVAL_CASES.length);
    expect(output).toContain("email-asked-recipient: expected pass");
  });

  it("records a not-run report without --live", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "approval-eval-"));
    const output = path.join(dir, "report.json");
    try {
      expect(() =>
        execFileSync(
          process.execPath,
          ["--import", "tsx", cli, "--suite", "approval", "--output", output],
          { encoding: "utf8", stdio: "pipe", timeout: 20_000 },
        ),
      ).toThrow();
      const report = JSON.parse(readFileSync(output, "utf8"));
      expect(report).toMatchObject({
        kind: "approval-calibration-eval",
        fixtureVersion: APPROVAL_FIXTURE_VERSION,
        status: "not-run",
        results: [],
      });
      expect(report.reason).toContain("--live");
      expect(report.cases).toHaveLength(APPROVAL_CASES.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
