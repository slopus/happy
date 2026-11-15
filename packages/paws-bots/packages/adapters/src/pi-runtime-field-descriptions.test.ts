import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { describe, expect, it } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import { jsonField, parametersFor } from "./pi-runtime-tool-parameters.js";

/** What the model is shown for a tool: the Pi parameters, serialised. */
function wire(tool: { name: string; description: string; inputSchema: Record<string, unknown> }) {
  return JSON.parse(JSON.stringify(parametersFor(tool))) as {
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
  };
}

function validate(tool: (typeof builtinAgentTools)[number], args: Record<string, unknown>) {
  const piTool = {
    name: tool.name,
    description: tool.description,
    parameters: parametersFor(tool),
  };
  return validateToolArguments(
    piTool as never,
    {
      type: "toolCall",
      id: "test",
      name: tool.name,
      arguments: args,
    } as never,
  );
}

const spawnBot = builtinAgentTools.find((tool) => tool.name === "spawn_bot");

describe("tool parameter descriptions reach the wire", () => {
  it("keeps the description on every field type", () => {
    const tool = {
      name: "described",
      description: "Every field type, each described.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "a string" },
          count: { type: "integer", description: "an integer" },
          flag: { type: "boolean", description: "a boolean" },
          tags: { type: "array", items: { type: "string" }, description: "an array" },
          nested: {
            type: "object",
            properties: { inner: { type: "string", description: "a nested string" } },
            description: "an object",
          },
          either: { type: ["string", "null"], description: "a string or null" },
          choice: { type: "string", enum: ["a", "b"], description: "an enum" },
          mixed: { enum: ["a", 1], description: "a mixed enum" },
        },
      },
    };
    const properties = wire(tool).properties;
    for (const [key, spec] of Object.entries(tool.inputSchema.properties)) {
      expect(properties[key]?.description, key).toBe(spec.description);
    }
    const nested = properties.nested?.properties as
      | Record<string, { description?: string }>
      | undefined;
    expect(nested?.inner?.description).toBe("a nested string");
  });

  it("drops no built-in tool parameter description", () => {
    const lost: string[] = [];
    for (const tool of builtinAgentTools) {
      const source = (tool.inputSchema.properties ?? {}) as Record<
        string,
        { description?: unknown }
      >;
      const properties = wire(tool).properties ?? {};
      for (const [key, spec] of Object.entries(source)) {
        if (
          typeof spec.description === "string" &&
          properties[key]?.description !== spec.description
        ) {
          lost.push(`${tool.name}.${key}`);
        }
      }
    }
    expect(lost).toEqual([]);
  });
});

describe("string enums keep their allowed values in a plain enum", () => {
  it("serialises a string enum without anyOf or const", () => {
    const field = JSON.parse(
      JSON.stringify(jsonField({ type: "string", enum: ["team", "dedicated"] })),
    );
    expect(field).toEqual({ type: "string", enum: ["team", "dedicated"] });
  });

  it("adds a one-value enum beside a string const", () => {
    const field = JSON.parse(JSON.stringify(jsonField({ type: "string", const: "bearer" })));
    expect(field).toEqual({ type: "string", const: "bearer", enum: ["bearer"] });
  });

  it("rewrites no built-in string enum to anyOf", () => {
    const rewritten: string[] = [];
    for (const tool of builtinAgentTools) {
      const source = (tool.inputSchema.properties ?? {}) as Record<string, { enum?: unknown[] }>;
      const properties = wire(tool).properties ?? {};
      for (const [key, spec] of Object.entries(source)) {
        if (Array.isArray(spec.enum) && spec.enum.every((value) => typeof value === "string")) {
          if (!Array.isArray(properties[key]?.enum) || "anyOf" in (properties[key] ?? {})) {
            rewritten.push(`${tool.name}.${key}`);
          }
        }
      }
    }
    expect(rewritten).toEqual([]);
  });

  it("shows spawn_bot's computer_mode choices and description", () => {
    expect(spawnBot).toBeDefined();
    const computerMode = wire(spawnBot!).properties.computer_mode;
    expect(computerMode).toMatchObject({ type: "string", enum: ["team", "dedicated"] });
    expect(computerMode?.description).toMatch(/dedicated \(Private\)/);
  });

  it("still validates spawn_bot's computer_mode through Pi", () => {
    for (const args of [
      { name: "Media Manager" },
      { name: "Media Manager", computer_mode: "team" },
      { name: "Media Manager", computer_mode: "dedicated" },
    ]) {
      expect(() => validate(spawnBot!, args), JSON.stringify(args)).not.toThrow();
    }
    for (const computer_mode of ["private", ""]) {
      expect(
        () => validate(spawnBot!, { name: "Media Manager", computer_mode }),
        computer_mode,
      ).toThrow();
    }
  });
});
