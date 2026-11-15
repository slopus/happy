import { readFile } from "node:fs/promises";
import type { PerformanceReport } from "../performance-report.js";
import { parsePerformanceReport, percentageDelta, roundMetric } from "../performance-report.js";

const [beforePath, afterPath] = process.argv.slice(2).filter((value) => value !== "--");
if (!beforePath || !afterPath) {
  throw new Error("Usage: pnpm perf:compare <before.json> <after.json>");
}

const before = parsePerformanceReport(JSON.parse(await readFile(beforePath, "utf8")), beforePath);
const after = parsePerformanceReport(JSON.parse(await readFile(afterPath, "utf8")), afterPath);
assertComparable(before, after);
warnAboutIntentionalRuntimeChanges(before, after);

const rows = [
  row(
    "Cache-cold shell usable (median ms)",
    before.summary.cacheColdShellUsableMs.median,
    after.summary.cacheColdShellUsableMs.median,
  ),
  row(
    "Warm shell usable (median ms)",
    before.summary.warmShellUsableMs.median,
    after.summary.warmShellUsableMs.median,
  ),
  row("Settings painted (ms)", before.summary.settingsPaintedMs, after.summary.settingsPaintedMs),
  row("Settings settled (ms)", before.summary.settingsSettledMs, after.summary.settingsSettledMs),
  row(
    "Typing key-to-frame (p95 ms)",
    before.summary.typingKeyPaintMs.p95,
    after.summary.typingKeyPaintMs.p95,
  ),
  row(
    "Idle total CPU (median %)",
    before.summary.idleCpuPercent.median,
    after.summary.idleCpuPercent.median,
  ),
  row(
    "Idle summed working set (median KiB)",
    before.summary.idleSummedWorkingSetKiB.median,
    after.summary.idleSummedWorkingSetKiB.median,
  ),
  row(
    "Streaming total CPU (median %)",
    before.summary.streamingCpuPercent.median,
    after.summary.streamingCpuPercent.median,
  ),
];
if (typeof before.summary.reopenMs === "number" && typeof after.summary.reopenMs === "number") {
  rows.push(row("Dock reopen (ms)", before.summary.reopenMs, after.summary.reopenMs));
}
if (
  typeof before.summary.hiddenSummedWorkingSetKiB === "number" &&
  typeof after.summary.hiddenSummedWorkingSetKiB === "number"
) {
  rows.push(
    row(
      "Hidden app summed working set (KiB)",
      before.summary.hiddenSummedWorkingSetKiB,
      after.summary.hiddenSummedWorkingSetKiB,
    ),
  );
}

console.log(`| Metric | ${before.label} | ${after.label} | Delta |`);
console.log("| --- | ---: | ---: | ---: |");
for (const item of rows) {
  console.log(`| ${item.metric} | ${item.before} | ${item.after} | ${item.delta} |`);
}

function row(metric: string, beforeValue: number, afterValue: number) {
  const delta = percentageDelta(beforeValue, afterValue);
  return {
    metric,
    before: roundMetric(beforeValue),
    after: roundMetric(afterValue),
    delta: delta === null ? "n/a" : `${roundMetric(delta)}%`,
  };
}

function assertComparable(beforeReport: PerformanceReport, afterReport: PerformanceReport) {
  const keys = ["platform", "arch", "cpuModel", "cpuCount", "buildMode", "assetDelayMs"] as const;
  const mismatches = keys.filter(
    (key) =>
      (key === "assetDelayMs"
        ? (beforeReport.environment[key] ?? 0)
        : beforeReport.environment[key]) !==
      (key === "assetDelayMs" ? (afterReport.environment[key] ?? 0) : afterReport.environment[key]),
  );
  if (mismatches.length > 0) {
    throw new Error(`Reports are not comparable; environment differs: ${mismatches.join(", ")}`);
  }
}

function warnAboutIntentionalRuntimeChanges(
  beforeReport: PerformanceReport,
  afterReport: PerformanceReport,
) {
  const keys = ["electron", "rendererMode", "warmWindow"] as const;
  const changes = keys
    .filter((key) => beforeReport.environment[key] !== afterReport.environment[key])
    .map(
      (key) =>
        `${key}: ${beforeReport.environment[key] ?? "unspecified"} -> ${afterReport.environment[key] ?? "unspecified"}`,
    );
  if (changes.length > 0) {
    console.warn(`Combined migration comparison (${changes.join(", ")}).`);
  }
}
