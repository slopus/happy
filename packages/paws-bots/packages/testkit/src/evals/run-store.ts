import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { EvalCase } from "./cases.js";
import { caseKey } from "./fingerprint.js";
import { regradable } from "./grading.js";
import type { TrialResult } from "./report.js";

/** The parts of an eval report the store reads; the rest is kept as written. */
export type StoredReport = {
  suite?: string;
  startedAt: string;
  model: string | null;
  provider: string | null;
  fixtureVersion: string | null;
  caseFixtureVersions?: Record<string, string>;
  codeRevision: string | null;
  judge: {
    model: string;
    provider?: string;
    rubricVersion: string;
    costUsd?: number | null;
  } | null;
  fingerprint?: { run: string | null; cases: Record<string, string | null> };
  workflowTotals?: { costUsd: number | null };
  trials: TrialResult[];
};

/** One line of `index.jsonl`: enough to list, compare and match runs without opening them. */
export type RunIndexEntry = {
  fingerprint: string;
  /** Imported from before fingerprints; listed and viewable, never reused. */
  legacy?: true;
  /** Where an imported report came from, such as its folder and file name. */
  label?: string;
  suite: string | null;
  model: string | null;
  provider: string | null;
  fixtureVersion: string | null;
  caseFixtureVersions: Record<string, string>;
  judge: { model: string; provider?: string; rubricVersion: string } | null;
  codeRevision: string | null;
  startedAt: string;
  trials: {
    planned: number;
    attempted: number;
    passed: number;
    run: number;
    reused: number;
    regraded: number;
  };
  /** New spend for this run, and what every trial in it cost when it ran. */
  costUsd: { new: number | null; trials: number | null };
  /** Fingerprint by case and strategy. */
  cases: Record<string, string>;
  /** The gzipped report, relative to the store. */
  path: string;
};

export type CasePlan =
  | { kind: "run" }
  | { kind: "reuse" | "regrade"; from: RunIndexEntry; trials: TrialResult[] };

/** Trials whose outcome is the bot's, not the harness's, provider's or clock's. */
const usable = (trial: TrialResult) =>
  !trial.cleanupFailed &&
  (trial.status === "passed" ||
    (trial.status === "failed" && (trial.category === "agent" || trial.category === "product")));

/** The judge's provider, model and rubric version; a change to any of them regrades. */
export const judgeIdentity = (judge: StoredReport["judge"]) =>
  judge ? `${judge.provider ?? ""}/${judge.model}@${judge.rubricVersion}` : null;

/**
 * Finished eval runs kept by fingerprint: `index.jsonl` with one line per run, and each report
 * gzipped under its fingerprint. Nothing here knows which model or provider ran.
 */
export class RunStore {
  private readonly reports = new Map<string, StoredReport>();

  constructor(readonly dir: string) {}

  entries(): RunIndexEntry[] {
    const file = path.join(this.dir, "index.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line) => {
        if (!line.trim()) return [];
        try {
          return [JSON.parse(line) as RunIndexEntry];
        } catch {
          return [];
        }
      });
  }

  read(entry: RunIndexEntry): StoredReport {
    let report = this.reports.get(entry.path);
    if (!report) {
      report = JSON.parse(
        gunzipSync(readFileSync(path.join(this.dir, entry.path))).toString("utf8"),
      ) as StoredReport;
      this.reports.set(entry.path, report);
    }
    return report;
  }

  /**
   * Saves a report under its fingerprint and indexes it. A report with no fingerprint is legacy:
   * it is keyed by its content and never matched for reuse.
   */
  save(report: StoredReport, options: { label?: string } = {}): RunIndexEntry {
    const json = JSON.stringify(report);
    // The fingerprint names a folder, so anything but a hash (an old or edited report) is legacy.
    const legacy = !/^[0-9a-f]{64}$/.test(report.fingerprint?.run ?? "");
    const fingerprint = legacy
      ? `legacy-${createHash("sha256").update(json).digest("hex").slice(0, 32)}`
      : report.fingerprint!.run!;
    if (legacy && this.entries().some((entry) => entry.fingerprint === fingerprint))
      throw new Error("This report is already in the store");
    mkdirSync(path.join(this.dir, fingerprint), { recursive: true });
    // A rerun or a regrade of the same fingerprint sits beside the first; nothing is overwritten.
    const stamp = report.startedAt.replace(/[^0-9TZ]/g, "");
    const gz = gzipSync(json);
    let relative = "";
    for (let n = 0; !relative; n++) {
      const candidate = path.join(
        fingerprint,
        n ? `report-${stamp}${n > 1 ? `-${n}` : ""}.json.gz` : "report.json.gz",
      );
      try {
        // Exclusive create: a concurrent save of the same fingerprint takes the next name.
        writeFileSync(path.join(this.dir, candidate), gz, { mode: 0o600, flag: "wx" });
        relative = candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const attempted = report.trials.filter((t) => t.status !== "not-run");
    const origin = (kind?: string) => report.trials.filter((t) => t.origin?.kind === kind).length;
    const entry: RunIndexEntry = {
      fingerprint,
      ...(legacy ? { legacy: true as const } : {}),
      ...(options.label ? { label: options.label } : {}),
      suite: report.suite ?? null,
      model: report.model,
      provider: report.provider,
      fixtureVersion: report.fixtureVersion,
      caseFixtureVersions: report.caseFixtureVersions ?? {},
      judge: report.judge
        ? {
            model: report.judge.model,
            ...(report.judge.provider ? { provider: report.judge.provider } : {}),
            rubricVersion: report.judge.rubricVersion,
          }
        : null,
      codeRevision: report.codeRevision,
      startedAt: report.startedAt,
      trials: {
        planned: report.trials.length,
        attempted: attempted.length,
        passed: report.trials.filter((t) => t.status === "passed").length,
        run: attempted.length - origin("reused") - origin("regraded"),
        reused: origin("reused"),
        regraded: origin("regraded"),
      },
      costUsd: {
        // The bot's new calls and the judge's, which a regrade alone still pays for.
        new: sumNullable(report.workflowTotals?.costUsd ?? null, report.judge?.costUsd ?? 0),
        trials: sumCosts(attempted),
      },
      cases: Object.fromEntries(
        Object.entries(report.fingerprint?.cases ?? {}).filter(
          (pair): pair is [string, string] => !!pair[1],
        ),
      ),
      path: relative,
    };
    appendFileSync(path.join(this.dir, "index.jsonl"), `${JSON.stringify(entry)}\n`, {
      mode: 0o600,
    });
    return entry;
  }

  /**
   * How to get a case's trials: from a stored run with the same fingerprint (as they are under the
   * same judge, regraded under another), or by running it. Prefers a run with enough trials, then
   * one under the current judge, then the newest. Trials keep their numbers; a planned trial with no
   * usable stored trial of that number still runs.
   */
  plan(input: {
    scenario: EvalCase;
    strategy: string;
    /** Trials the run wants; more stored than that does not make a run a better source. */
    trials: number;
    fingerprint: string;
    judge: string | null;
  }): CasePlan {
    const key = caseKey(input.scenario.id, input.strategy);
    const graded = !!(input.scenario.judge || input.scenario.observe);
    const candidates = this.entries()
      .filter((entry) => !entry.legacy && entry.cases[key] === input.fingerprint)
      .map((entry) => {
        const trials = this.read(entry)
          .trials.filter(
            (t) =>
              t.caseId === input.scenario.id &&
              t.trial <= input.trials &&
              (t.strategy ?? "current") === input.strategy &&
              usable(t) &&
              regradable(input.scenario, t),
          )
          .sort((a, b) => a.trial - b.trial);
        const sameJudge = !graded || judgeIdentity(this.read(entry).judge) === input.judge;
        return { entry, trials, sameJudge };
      })
      .filter((candidate) => candidate.trials.length > 0)
      .sort(
        (a, b) =>
          Math.min(b.trials.length, input.trials) - Math.min(a.trials.length, input.trials) ||
          Number(b.sameJudge) - Number(a.sameJudge) ||
          b.entry.startedAt.localeCompare(a.entry.startedAt),
      );
    const best = candidates[0];
    if (!best) return { kind: "run" };
    return { kind: best.sameJudge ? "reuse" : "regrade", from: best.entry, trials: best.trials };
  }
}

function sumNullable(a: number | null, b: number | null) {
  return a === null || b === null ? null : a + b;
}

function sumCosts(trials: readonly TrialResult[]) {
  return trials.length && trials.every((t) => t.costUsd !== null)
    ? trials.reduce((n, t) => n + t.costUsd!, 0)
    : null;
}
