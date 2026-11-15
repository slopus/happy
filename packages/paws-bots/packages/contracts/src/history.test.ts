import { describe, expect, it } from "vitest";
import { HistorySearchInputSchema } from "./history.js";

describe("history date boundaries", () => {
  it.each([
    ["2026-01-01", "2026-01-01T00:00:00.000Z"],
    ["2024-02-29", "2024-02-29T00:00:00.000Z"],
    ["2026-01-01T00:00:00Z", "2026-01-01T00:00:00.000Z"],
    ["2026-01-01T00:00:00+02:00", "2025-12-31T22:00:00.000Z"],
    ["2026-01-01T00:00:00-05:30", "2026-01-01T05:30:00.000Z"],
  ])("normalizes %s without changing the intended instant", (input, expected) => {
    expect(
      HistorySearchInputSchema.parse({ query: "Aurora", before: input, after: input }),
    ).toMatchObject({ before: expected, after: expected });
  });
  it.each([
    "2026-02-29",
    "2026-02-30",
    "2026-04-31",
    "2026-13-01",
    "2026-02-29T00:00:00Z",
    "2026-01-01T00:00:00",
    "2026-01-01T00:00:00+25:00",
    "January 1, 2026",
  ])("rejects invalid or ambiguous boundary %s", (value) => {
    for (const field of ["before", "after"])
      expect(HistorySearchInputSchema.safeParse({ query: "Aurora", [field]: value }).success).toBe(
        false,
      );
  });
});

describe("history search arguments", () => {
  it("requires a query input and normalizes variants", () => {
    expect(
      HistorySearchInputSchema.parse({ queries: [" Aurora ", "aurora", "orbit"] }).queries,
    ).toEqual(["Aurora", "orbit"]);
    for (const input of [
      {},
      { queries: [] },
      { queries: [" "] },
      { queries: Array(6).fill("a") },
      { query: "a", scope: "all" },
      { query: "a", kinds: ["secret_prompt"] },
      { query: "a", offset: -1 },
    ])
      expect(HistorySearchInputSchema.safeParse(input).success).toBe(false);
  });

  it("lists messages by kind when neither query nor queries is given", () => {
    expect(HistorySearchInputSchema.parse({ kinds: ["tool_work"] })).toEqual({
      kinds: ["tool_work"],
    });
  });
});

describe("history query byte budget", () => {
  it("accepts 3000 serialized UTF-8 bytes and rejects one byte more", () => {
    const queries = ["星".repeat(499), `${"界".repeat(498)}xx`];
    expect(new TextEncoder().encode(JSON.stringify(queries)).length).toBe(3000);
    expect(HistorySearchInputSchema.safeParse({ queries }).success).toBe(true);
    expect(
      HistorySearchInputSchema.safeParse({ queries: [`${queries[0]}x`, queries[1]] }).success,
    ).toBe(false);
    expect(
      HistorySearchInputSchema.safeParse({
        queries: Array.from({ length: 5 }, (_, i) => "星".repeat(499) + i),
      }).success,
    ).toBe(false);
  });
});

describe("history query folding", () => {
  it("searches every word when a call gives both query and queries", () => {
    expect(
      HistorySearchInputSchema.parse({ query: "Aurora", queries: ["orbit", "aurora"] }),
    ).toEqual({ queries: ["Aurora", "orbit"] });
    expect(
      HistorySearchInputSchema.parse({ query: "a", queries: ["b", "c", "d", "e", "f"] }).queries,
    ).toEqual(["a", "b", "c", "d", "e"]);
    expect(
      HistorySearchInputSchema.parse({ query: "a", queries: ["A", "b", "c", "d", "e"] }).queries,
    ).toEqual(["a", "b", "c", "d", "e"]);
  });
  it("reads a bare string as one query variant", () => {
    expect(HistorySearchInputSchema.parse({ queries: "Aurora" })).toEqual({ queries: ["Aurora"] });
  });
  it("names the date forms it accepts", () => {
    const result = HistorySearchInputSchema.safeParse({ query: "a", after: "2026-11-04 08:00" });
    expect(result.error?.issues[0]?.message).toContain("2026-01-01T08:00:00+08:00");
  });
});
