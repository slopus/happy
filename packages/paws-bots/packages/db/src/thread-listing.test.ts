import { describe, expect, it } from "vitest";
import { previewFromBlocks, primaryActiveRun, threadRunStatus } from "./thread-listing.js";

describe("previewFromBlocks", () => {
  it("skips malformed stored elements", () => {
    expect(previewFromBlocks([null, { kind: "text", text: "Hi" }])).toBe("Hi");
  });
  it("shows nothing for a delivery, whose text is the bot's hidden prompt", () => {
    expect(
      previewFromBlocks([{ kind: "delivery" }, { kind: "text", text: 'Run routine "CRM sync":' }]),
    ).toBe("");
  });
  it("preserves literal URL paths in autolinks", () => {
    expect(previewFromBlocks([{ kind: "text", text: "Open <https://example.test/_draft_>" }])).toBe(
      "Open https://example.test/_draft_",
    );
  });
  it("preserves filenames while removing surrounding Markdown", () => {
    expect(previewFromBlocks([{ kind: "text", text: "Saved **monthly_sales_report.csv**" }])).toBe(
      "Saved monthly_sales_report.csv",
    );
  });
  it("returns the first text block with Markdown stripped", () => {
    expect(
      previewFromBlocks([
        { kind: "steps", steps: [{ label: "Read file", count: 1 }] },
        { kind: "text", text: "Created **Projects-CoS** as a **Project**" },
      ]),
    ).toBe("Created Projects-CoS as a Project");
  });

  it("returns empty when there is no text block", () => {
    expect(previewFromBlocks([{ kind: "steps", steps: [] }])).toBe("");
    expect(previewFromBlocks(undefined)).toBe("");
  });
});

describe("primaryActiveRun", () => {
  it.each([
    [["queued", "running"], "running"],
    [["queued"], "queued"],
    [["queued", "waiting_input"], "waiting_input"],
    [["queued", "leased"], "leased"],
    [["queued", "leased", "running"], "running"],
    [["running", "waiting_input"], "waiting_input"],
    [["running", "waiting_takeover"], "waiting_takeover"],
    [["leased", "waiting_input"], "waiting_input"],
    [["leased", "waiting_takeover"], "waiting_takeover"],
    [[], undefined],
  ])("prioritizes %j as %s", (statuses, expected) => {
    const runs = statuses.map((status) => ({ status }));
    expect(primaryActiveRun(runs)?.status).toBe(expected);
    expect(primaryActiveRun([...runs].reverse())?.status).toBe(expected);
  });
});

describe("threadRunStatus", () => {
  it("reads only the runs in the given thread", () => {
    const runs = [
      { status: "running", threadId: "group-thread" },
      { status: "queued", threadId: "own-thread" },
    ];
    expect(threadRunStatus(runs, "own-thread")).toBe("queued");
    expect(threadRunStatus(runs.slice(0, 1), "own-thread")).toBe("idle");
  });
});
