import { describe, expect, it } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import { parseConnectorToolArgs } from "./lazy-tool-catalog.js";
import { normalizeOpenAiToolParameters } from "./openai-tool-parameters.js";

describe("release-watch guidance", () => {
  it("exposes an exclusive timing schema for schedule_create", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "schedule_create");
    const schema = tool?.inputSchema as {
      oneOf?: Array<{ required?: string[]; additionalProperties?: boolean }>;
    };
    expect(schema.oneOf).toHaveLength(6);
    expect(schema.oneOf?.map((branch) => branch.required)).toEqual([
      ["name", "prompt", "cron"],
      ["name", "prompt", "every", "unit"],
      ["name", "prompt", "runAt"],
      ["name", "prompt", "delayMinutes"],
      ["name", "prompt", "delaySeconds"],
      ["name", "prompt", "watch"],
    ]);
    expect(schema.oneOf?.every((branch) => branch.additionalProperties === false)).toBe(true);
  });

  it("accepts null or blank leftover timing fields and rejects a second real method", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "schedule_create");
    const schema = tool?.inputSchema ?? {};
    expect(
      parseConnectorToolArgs(schema, {
        name: "Morning",
        prompt: "Send the report",
        cron: "0 9 * * *",
        every: null,
        unit: "",
        runAt: "  ",
        delayMinutes: null,
        delaySeconds: "",
      }),
    ).toMatchObject({ name: "Morning", cron: "0 9 * * *" });
    expect(() =>
      parseConnectorToolArgs(schema, {
        name: "Morning",
        prompt: "Send the report",
        cron: "0 9 * * *",
        delayMinutes: 5,
      }),
    ).toThrow(/invalid/i);

    const wire = normalizeOpenAiToolParameters(schema);
    const properties = wire.properties as Record<string, unknown>;
    for (const name of ["cron", "every", "unit", "runAt", "delayMinutes", "delaySeconds"]) {
      expect(JSON.stringify(properties[name])).toContain('"null"');
    }
  });

  it("exposes a read-only task catalog", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "task_catalog");
    expect(tool?.readOnly).toBe(true);
    expect(tool?.description).toMatch(/source of truth/i);
  });
});
