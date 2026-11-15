import { describe, expect, it } from "vitest";

import { parametersFor } from "./pi-runtime-tool-parameters.js";

function wireFor(inputSchema: Record<string, unknown>) {
  return JSON.parse(
    JSON.stringify(parametersFor({ name: "test_tool", description: "Test tool", inputSchema })),
  );
}

describe("string consts in composed tool schemas", () => {
  it("keeps root and allOf constraints while converting oneOf discriminators", () => {
    const wire = wireFor({
      type: "object",
      properties: { action: { type: "string", maxLength: 10 } },
      required: ["projectId"],
      allOf: [
        {
          properties: { action: { minLength: 2 }, projectId: { type: "string" } },
          required: ["action"],
        },
      ],
      oneOf: [
        { properties: { action: { const: "start" } }, required: ["action"] },
        { properties: { action: { const: "stop" } }, required: ["action"] },
      ],
    });

    expect(wire.properties.action).toEqual({
      allOf: [
        { type: "string", maxLength: 10 },
        { minLength: 2 },
        {
          anyOf: [
            { type: "string", const: "start", enum: ["start"] },
            { type: "string", const: "stop", enum: ["stop"] },
          ],
        },
      ],
    });
    expect(wire.required).toEqual(["projectId", "action"]);
  });

  it("converts nested object and array item consts in a raw sibling union", () => {
    const wire = wireFor({
      type: "object",
      properties: {
        payload: {
          type: "object",
          properties: {
            entries: {
              type: "array",
              items: { type: "object", properties: { kind: { const: "entry" } } },
            },
          },
        },
      },
      oneOf: [
        { properties: { action: { const: "start" } } },
        { properties: { action: { const: "stop" } } },
      ],
    });

    expect(wire.properties.payload.properties.entries.items.properties.kind).toEqual({
      type: "string",
      const: "entry",
      enum: ["entry"],
    });
    expect(wire.properties.action.anyOf).toEqual([
      { type: "string", const: "start", enum: ["start"] },
      { type: "string", const: "stop", enum: ["stop"] },
    ]);
  });

  it("preserves conflicting constraints, instance data, and the input schema", () => {
    const inputSchema = {
      type: "object",
      properties: {
        incompatibleType: { type: "number", const: "text" },
        incompatibleEnum: { const: "text", enum: ["other"] },
        compatibleEnum: { const: "text", enum: ["text", "other"] },
        mode: {
          const: "enabled",
          default: { const: "default value" },
          examples: [{ const: "example value" }],
        },
      },
      oneOf: [true, { properties: { action: { const: "start" } } }],
    };
    const original = structuredClone(inputSchema);
    const wire = wireFor(inputSchema);

    expect(wire.properties.incompatibleType).toMatchObject({ type: "number", const: "text" });
    expect(wire.properties.incompatibleEnum).toMatchObject({ const: "text", enum: ["other"] });
    expect(wire.properties.compatibleEnum).toEqual({
      type: "string",
      const: "text",
      enum: ["text"],
    });
    expect(wire.properties.mode).toEqual({
      type: "string",
      const: "enabled",
      enum: ["enabled"],
      default: { const: "default value" },
      examples: [{ const: "example value" }],
    });
    expect(inputSchema).toEqual(original);
  });
});
