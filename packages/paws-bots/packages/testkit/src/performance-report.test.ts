import { describe, expect, it } from "vitest";
import {
  parsePerformanceReport,
  parseTcpPort,
  percentageDelta,
  roundMetric,
  summarize,
} from "./performance-report.js";

describe("performance report statistics", () => {
  it("summarizes a distribution without mutating it", () => {
    const values = [40, 10, 30, 20];

    expect(summarize(values)).toEqual({
      count: 4,
      min: 10,
      median: 25,
      p95: 38.5,
      max: 40,
    });
    expect(values).toEqual([40, 10, 30, 20]);
  });

  it("calculates comparable percentage deltas", () => {
    expect(percentageDelta(100, 75)).toBe(-25);
    expect(percentageDelta(0, 0)).toBe(0);
    expect(percentageDelta(0, 1)).toBeNull();
    expect(roundMetric(1.23456)).toBe(1.23);
  });

  it("rejects an empty distribution", () => {
    expect(() => summarize([])).toThrow("empty sample");
  });
});

describe("performance report input", () => {
  it("rejects missing and unknown report schemas with a useful source name", () => {
    expect(() => parsePerformanceReport({}, "before.json")).toThrow(
      "Invalid performance report before.json: unsupported schemaVersion undefined",
    );
    expect(() => parsePerformanceReport({ schemaVersion: 99 }, "after.json")).toThrow(
      "Invalid performance report after.json: unsupported schemaVersion 99",
    );
  });

  it("migrates schema 1 memory labels to working-set labels", () => {
    const distribution = { count: 1, min: 10, median: 10, p95: 10, max: 10 };
    const report = parsePerformanceReport(
      {
        schemaVersion: 1,
        label: "before",
        environment: {},
        summary: {
          cacheColdShellUsableMs: distribution,
          warmShellUsableMs: distribution,
          settingsPaintedMs: 10,
          settingsSettledMs: 10,
          typingKeyPaintMs: distribution,
          idleCpuPercent: distribution,
          idleSummedPrivateKiB: distribution,
          streamingCpuPercent: distribution,
        },
      },
      "legacy.json",
    );

    expect(report.schemaVersion).toBe(2);
    expect(report.summary.idleSummedWorkingSetKiB).toEqual(distribution);
    expect(report.summary.hiddenSummedWorkingSetKiB).toBeNull();
  });

  it("validates configured TCP ports", () => {
    expect(parseTcpPort("55400", "PERF_WEB_PORT")).toBe(55_400);
    for (const value of ["", "nope", "0", "65536", "1.5", "Infinity"]) {
      expect(() => parseTcpPort(value, "PERF_WEB_PORT")).toThrow(
        "PERF_WEB_PORT must be an integer between 1 and 65535",
      );
    }
  });
});
