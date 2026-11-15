import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Evidence } from "./cases.js";
import { EMPTY_SETTINGS } from "./cases.js";
import { gradeToolChoice, loadToolChoiceCases } from "./tool-choice.js";
import { TOOL_CHOICE_CASES, TOOL_CHOICE_DEFINITIONS } from "./tool-choice-cases.js";

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    text: "",
    files: {},
    records: [],
    notes: [],
    calls: [],
    routines: [],
    memory: "",
    approvalPending: false,
    pendingApproval: null,
    priorMemory: "",
    toolNames: [],
    toolCalls: [],
    finalStep: 2,
    settings: EMPTY_SETTINGS,
    settingsBefore: EMPTY_SETTINGS,
    messaging: { originThreadId: null, outbound: [] },
    ...overrides,
  };
}

const passes = (criteria: Array<{ pass: boolean }>) => criteria.every((c) => c.pass);

describe("tool-choice grading", () => {
  it("grades only the final step's calls", () => {
    const toolCalls = [
      { step: 1, name: "update_bot", args: { name: "Scout" } },
      { step: 2, name: "web_search", args: { query: "node" } },
    ];
    expect(passes(gradeToolChoice({ notCalls: ["update_bot"] }, evidence({ toolCalls })))).toBe(
      true,
    );
    expect(
      passes(gradeToolChoice({ calls: [{ tool: "update_bot" }] }, evidence({ toolCalls }))),
    ).toBe(false);
  });

  it("matches substrings, presence, alternatives and exact values", () => {
    const toolCalls = [{ step: 2, name: "update_bot", args: { name: "Scout Bot", color: "#0a0" } }];
    const ok = (args: Record<string, unknown>) =>
      passes(
        gradeToolChoice(
          { calls: [{ tool: "update_bot", args: args as never }] },
          evidence({ toolCalls }),
        ),
      );
    expect(ok({ name: "~scout" })).toBe(true);
    expect(ok({ color: "*" })).toBe(true);
    expect(ok({ name: ["Atlas", "Scout Bot"] })).toBe(true);
    expect(ok({ name: "Scout" })).toBe(false);
    expect(ok({ description: "*" })).toBe(false);
  });

  it("forbids every tool with *", () => {
    const toolCalls = [{ step: 2, name: "remember", args: {} }];
    expect(passes(gradeToolChoice({ notCalls: ["*"] }, evidence({ toolCalls })))).toBe(false);
    expect(passes(gradeToolChoice({ notCalls: ["*"] }, evidence()))).toBe(true);
  });

  it("checks order and call limits", () => {
    const toolCalls = ["find", "use", "find"].map((name) => ({ step: 2, name, args: {} }));
    expect(passes(gradeToolChoice({ order: ["find", "use"] }, evidence({ toolCalls })))).toBe(true);
    expect(passes(gradeToolChoice({ order: ["use", "other"] }, evidence({ toolCalls })))).toBe(
      false,
    );
    expect(passes(gradeToolChoice({ maxCalls: { find: 1 } }, evidence({ toolCalls })))).toBe(false);
  });

  it("grades use_tool calls as the tool they ran, and only on tools find_tool loaded", () => {
    const found = { step: 2, name: "find_tool", args: { query: "chart" } };
    const plot = { step: 2, name: "render_plot", args: {}, viaUseTool: true };
    const expect_ = { order: ["find_tool", "render_plot"] };
    const grade = (toolCalls: Evidence["toolCalls"]) =>
      passes(gradeToolChoice(expect_, evidence({ toolCalls })));
    expect(grade([found, { ...plot, loaded: true }])).toBe(true);
    expect(grade([found, { ...plot, loaded: false }])).toBe(false);
    expect(grade([found, { ...plot, loaded: true }, { step: 2, name: "use_tool", args: {} }])).toBe(
      false,
    );
    expect(passes(gradeToolChoice({ notCalls: ["find_tool"] }, evidence()))).toBe(true);
  });

  it("grades settings by state, and treats a field-less update_bot as a read", () => {
    const before = { bot: { name: "Assistant", modelId: "a" }, user: { timezone: null } };
    const after = { bot: { name: "Assistant", modelId: "b" }, user: { timezone: null } };
    expect(
      passes(
        gradeToolChoice(
          { settingsUnchanged: true },
          evidence({ settingsBefore: before, settings: after }),
        ),
      ),
    ).toBe(false);
    expect(passes(gradeToolChoice({ bot: { modelId: "b" } }, evidence({ settings: after })))).toBe(
      true,
    );
    const read = [{ step: 2, name: "update_bot", args: { model: null, name: " " } }];
    expect(
      passes(
        gradeToolChoice(
          { settingsUnchanged: true },
          evidence({ settingsBefore: before, settings: before, toolCalls: read }),
        ),
      ),
    ).toBe(true);
    const write = [{ step: 2, name: "update_bot", args: { name: "Assistant" } }];
    expect(
      passes(
        gradeToolChoice(
          { settingsUnchanged: true },
          evidence({ settingsBefore: before, settings: before, toolCalls: write }),
        ),
      ),
    ).toBe(false);
  });

  it("has unique ids, both kinds in every behavior area, and rejects empty evidence for guards", () => {
    expect(new Set(TOOL_CHOICE_DEFINITIONS.map((c) => c.id)).size).toBe(
      TOOL_CHOICE_DEFINITIONS.length,
    );
    expect(TOOL_CHOICE_DEFINITIONS.length).toBeGreaterThanOrEqual(60);
    for (const area of ["settings", "user-settings", "product-help"])
      expect(
        new Set(TOOL_CHOICE_DEFINITIONS.filter((c) => c.area === area).map((c) => c.kind)),
      ).toEqual(new Set(["guard", "control"]));
    for (const scenario of TOOL_CHOICE_CASES) {
      const definition = TOOL_CHOICE_DEFINITIONS.find((c) => c.id === scenario.id)!;
      const empty = evidence({
        finalStep: scenario.steps.length,
        settings: { bot: { name: "Assistant" }, user: {} },
        settingsBefore: { bot: { name: "Assistant" }, user: {} },
      });
      if (definition.kind === "guard")
        expect(passes(scenario.grade(empty)), scenario.id).toBe(false);
    }
  });

  it("loads local cases as JSON lines and validates them", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tool-choice-"));
    const file = path.join(dir, "cases.ndjson");
    writeFileSync(
      file,
      `${JSON.stringify({ id: "local-a", area: "settings", kind: "control", purpose: "x", prompt: "hi", expect: { notCalls: ["*"] } })}\n`,
    );
    const [loaded] = loadToolChoiceCases(file);
    expect(loaded!.id).toBe("local-a");
    expect(loaded!.steps).toEqual([{ ask: "hi" }]);
    writeFileSync(
      file,
      JSON.stringify([
        { id: "Bad Id", area: "x", kind: "guard", purpose: "x", prompt: "x", expect: {} },
      ]),
    );
    expect(() => loadToolChoiceCases(file)).toThrow();
    writeFileSync(
      file,
      JSON.stringify([
        {
          id: "only-bans",
          area: "x",
          kind: "guard",
          purpose: "x",
          prompt: "x",
          expect: { notCalls: ["*"] },
        },
      ]),
    );
    expect(() => loadToolChoiceCases(file)).toThrow(/guard needs/);
    writeFileSync(
      file,
      JSON.stringify([
        {
          id: "empty-bot",
          area: "x",
          kind: "guard",
          purpose: "x",
          prompt: "x",
          expect: { bot: {} },
        },
      ]),
    );
    expect(() => loadToolChoiceCases(file)).toThrow(/guard needs/);
  });
});
