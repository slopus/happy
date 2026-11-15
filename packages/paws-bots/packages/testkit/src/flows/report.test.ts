import { describe, expect, it } from "vitest";
import { htmlReport } from "./report.js";
import type { FlowResult } from "./runner.js";

const result: FlowResult = {
  flow: "weekly-shopping",
  status: "failed",
  endedBy: "user-done",
  criteria: [{ id: "first-week-cart", pass: false, detail: "oat-milk 0/2" }],
  judgment: { pass: true, reason: "Consistent" },
  transcript: [
    { from: "user", text: "Do my shop <b>now</b>", at: "2026-10-25T10:00:00.000Z" },
    { from: "bot", text: "Done & dusted", at: "2026-10-25T10:00:10.000Z" },
  ],
  frames: [{ at: "2026-10-25T10:00:05.000Z", file: "frames/0001.png" }],
  observations: {},
  runs: [],
  routines: [],
  toolCalls: 3,
  toolCounts: {},
  durationMs: 10_000,
  botCostUsd: 0.01,
  harnessCostUsd: null,
  harnessTokens: { input: 0, output: 0 },
};

describe("flow HTML report", () => {
  it("interleaves chat and screen frames in time order, escaping app text", () => {
    const page = htmlReport({ ...result, sandbox: "boat" }, undefined);
    expect(page).toContain("Do my shop &lt;b&gt;now&lt;/b&gt;");
    expect(page).toContain("Done &amp; dusted");
    const order = ["Do my shop", "frames/0001.png", "Done &amp; dusted"].map((text) =>
      page.indexOf(text),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(page).not.toContain("<video");
  });
});
