import { BOT_MEMORY_MAX_BYTES } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { Evidence } from "./cases.js";
import { EMPTY_SETTINGS } from "./cases.js";
import {
  FULL_MEMORY_SEED,
  MEMORY_EVAL_CASES,
  MEMORY_JUDGE_CALIBRATION,
  MEMORY_JUDGE_VERSION,
} from "./memory.js";

const scenario = (id: string) => MEMORY_EVAL_CASES.find((c) => c.id === `memory-${id}`)!;
const remember = (step: number, content: string, oldText?: string) => ({
  step,
  name: "remember",
  args: { content, ...(oldText ? { old_text: oldText } : {}) },
});
function evidence(memory: string, toolCalls: Evidence["toolCalls"] = [], text = ""): Evidence {
  return {
    text,
    files: {},
    records: [],
    notes: [],
    calls: [],
    routines: [],
    memory,
    approvalPending: false,
    pendingApproval: null,
    priorMemory: "",
    toolNames: toolCalls.map((c) => c.name),
    toolCalls,
    finalStep: 5,
    settings: EMPTY_SETTINGS,
    settingsBefore: EMPTY_SETTINGS,
    messaging: { originThreadId: null, outbound: [] },
  };
}
const failed = (id: string, e: Evidence) =>
  scenario(id)
    .grade(e)
    .filter((c) => !c.pass)
    .map((c) => c.id);

describe("memory outcome grading", () => {
  const firstSave = remember(1, "Lives in London.");

  it("accepts a rewritten home entry", () => {
    const e = evidence(
      "# Assistant\n\nLives in Berlin (moved from London).\n",
      [firstSave, remember(3, "Lives in Berlin (moved from London).", "Lives in London.")],
      "You live in Berlin.",
    );
    expect(failed("moved-city", e)).toEqual([]);
    expect(scenario("moved-city").judge?.(e).evidence).toEqual({
      memory: e.memory,
      reply: "You live in Berlin.",
    });
  });

  it("keeps an unchanged label line from the first save", () => {
    const e = evidence("# Assistant\n\nHome:\nBerlin\n", [
      remember(1, "Home:\nLondon"),
      remember(3, "Berlin", "London"),
    ]);
    expect(failed("moved-city", e)).toEqual([]);
  });

  it("rejects a new home appended beside the old one", () => {
    const e = evidence("# Assistant\n\nLives in London.\nMoved to Berlin.\n", [
      firstSave,
      remember(3, "Moved to Berlin."),
    ]);
    expect(failed("moved-city", e)).toEqual(["first-entry-rewritten"]);
  });

  it("rejects a pure append after a first save with a heading", () => {
    const e = evidence("# Home\n\nLives in London.\nMoved to Berlin.\n", [
      remember(1, "# Home\nLives in London."),
      remember(3, "Moved to Berlin."),
    ]);
    expect(failed("moved-city", e)).toEqual(["first-entry-rewritten"]);
  });

  it("compares a heading-only fact like any other line", () => {
    const e = evidence("# Home: Berlin\n", [
      remember(1, "# Home: London"),
      remember(3, "# Home: Berlin", "# Home: London"),
    ]);
    expect(failed("moved-city", e)).toEqual([]);
  });

  it("does not credit an update when no home was saved first", () => {
    expect(failed("moved-city", evidence("# Assistant\n\nLives in Berlin.\n"))).toEqual([
      "home-saved-first",
      "first-entry-rewritten",
    ]);
  });

  it("checks that a forgotten code is gone and was saved first", () => {
    const saved = [remember(1, "Gym locker code: 3391")];
    expect(failed("forget", evidence("# Assistant\n\n", saved))).toEqual([]);
    expect(failed("forget", evidence("# Assistant\n\nGym locker code: 3391\n", saved))).toEqual([
      "code-removed",
    ]);
    expect(failed("forget", evidence("# Assistant\n\n"))).toEqual(["fact-saved-first"]);
  });

  it("bounds entry length and total size for chatty facts", () => {
    const save = [remember(1, "Pediatric nurse")];
    expect(failed("concise", evidence("# Assistant\n\nPediatric nurse.\n", save))).toEqual([]);
    expect(failed("concise", evidence(`# Assistant\n\n${"a".repeat(201)}\n`, save))).toEqual([
      "entries-short",
    ]);
    const long = Array.from({ length: 12 }, () => "b".repeat(100)).join("\n");
    expect(failed("concise", evidence(`# Assistant\n\n${long}\n`, save))).toEqual(["memory-small"]);
  });

  it("requires the new fact within the cap when memory starts full", () => {
    const seedBytes = Buffer.byteLength(FULL_MEMORY_SEED);
    // Close enough to the cap that any appended fact is refused.
    expect(seedBytes).toBeLessThanOrEqual(BOT_MEMORY_MAX_BYTES);
    expect(seedBytes).toBeGreaterThan(BOT_MEMORY_MAX_BYTES - 12);
    expect(failed("full", evidence(FULL_MEMORY_SEED))).toEqual(["new-fact-saved"]);
    expect(failed("full", evidence(`${FULL_MEMORY_SEED}Office door code: 5829\n`))).toEqual([
      "memory-within-cap",
    ]);
    expect(failed("full", evidence("# Assistant\n\nOffice door code: 5829\n"))).toEqual([]);
  });

  it("leaves meaning to a versioned judge with labelled anchors for every rubric", () => {
    for (const c of MEMORY_EVAL_CASES) {
      const input = c.judge?.(evidence("# Assistant\n\n"));
      expect(input?.rubric.startsWith(`${MEMORY_JUDGE_VERSION}:`)).toBe(true);
      const anchors = MEMORY_JUDGE_CALIBRATION.filter((a) => a.input.rubric === input?.rubric);
      expect(new Set(anchors.map((a) => a.pass))).toEqual(new Set([true, false]));
    }
  });
});
