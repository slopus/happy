import { describe, expect, it } from "vitest";

import { builtinAgentTools } from "./builtin-tools.js";
import {
  normalizeOpenAiToolParameters,
  openAiToolParametersNeedNormalization,
} from "./openai-tool-parameters.js";
import { parametersFor } from "./pi-runtime-tool-parameters.js";

describe("normalizeOpenAiToolParameters", () => {
  it("conjoins referenced fields with sibling constraints and follows local reference chains", () => {
    const normalized = normalizeOpenAiToolParameters({
      $defs: {
        Alias: { $ref: "#/$defs/Base" },
        Base: { properties: { limit: { type: "integer", minimum: 1 } }, required: ["limit"] },
      },
      allOf: [
        {
          $ref: "#/$defs/Alias",
          properties: { limit: { type: "integer", maximum: 10 } },
        },
      ],
    });
    expect(normalized.properties).toEqual({
      limit: {
        allOf: [
          { type: "integer", minimum: 1 },
          { type: "integer", maximum: 10 },
        ],
      },
    });
    expect(normalized.required).toEqual(["limit"]);
    expect(normalized).not.toHaveProperty("allOf");
  });

  it("stops cyclic local references while keeping their inline fields", () => {
    const normalized = normalizeOpenAiToolParameters({
      $defs: {
        Base: {
          allOf: [
            { $ref: "#/$defs/Base" },
            { properties: { query: { type: "string" } }, required: ["query"] },
          ],
        },
      },
      allOf: [{ $ref: "#/$defs/Base" }, { $ref: "#/$defs/Base" }],
    });
    expect(normalized.properties).toEqual({ query: { type: "string" } });
    expect(normalized.required).toEqual(["query"]);
  });

  it.each(["#/$defs/missing", "#/%ZZ", "https://example.test/schema", "#/constructor"])(
    "leaves unresolved or external references unfetched: %s",
    (ref) => {
      const normalized = normalizeOpenAiToolParameters({
        allOf: [{ $ref: ref }, { properties: { query: { type: "string" } } }],
      });
      expect(normalized.properties).toEqual({ query: { type: "string" } });
    },
  );

  it("resolves URI-encoded JSON pointers through arrays", () => {
    const normalized = normalizeOpenAiToolParameters({
      $defs: { "group name": { anyOf: [{ properties: { query: { type: "string" } } }] } },
      allOf: [{ $ref: "#/$defs/group%20name/anyOf/0" }],
    });
    expect(normalized.properties).toEqual({ query: { type: "string" } });
  });

  it("fills properties for a zero-argument object schema", () => {
    expect(normalizeOpenAiToolParameters({ type: "object" })).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("keeps an empty properties map and does not invent parameters", () => {
    expect(normalizeOpenAiToolParameters({ type: "object", properties: {} })).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("flattens a root union, which Anthropic rejects, into one object schema", () => {
    const normalized = normalizeOpenAiToolParameters({
      anyOf: [
        {
          type: "object",
          properties: { label: { type: "string" }, a: { type: "string" } },
          required: ["label", "a"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: { label: { type: "string" }, b: { type: "string" } },
          required: ["label", "b"],
          additionalProperties: false,
        },
      ],
    });
    expect(normalized).toEqual({
      type: "object",
      properties: { label: { type: "string" }, a: { type: "string" }, b: { type: "string" } },
      required: ["label"],
      additionalProperties: false,
    });
  });

  it("keeps every variant of a field that differs between root union branches", () => {
    const normalized = normalizeOpenAiToolParameters({
      oneOf: [
        { type: "object", properties: { action: { const: "start" } }, required: ["action"] },
        { type: "object", properties: { action: { const: "stop" } }, required: ["action"] },
      ],
    });
    expect(normalized).toEqual({
      type: "object",
      properties: { action: { anyOf: [{ const: "start" }, { const: "stop" }] } },
      required: ["action"],
    });
  });

  it("requires every field of a root allOf", () => {
    const normalized = normalizeOpenAiToolParameters({
      allOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { type: "object", properties: { b: { type: "string" } }, required: ["b"] },
      ],
    });
    expect(normalized.required).toEqual(["a", "b"]);
    expect(normalized.allOf).toBeUndefined();
  });

  it("intersects differing specs for the same field under a root allOf", () => {
    const normalized = normalizeOpenAiToolParameters({
      allOf: [
        { type: "object", properties: { n: { type: "integer", minimum: 0 } } },
        { type: "object", properties: { n: { type: "integer", maximum: 10 } } },
      ],
    });
    expect(normalized).toEqual({
      type: "object",
      properties: {
        n: {
          allOf: [
            { type: "integer", minimum: 0 },
            { type: "integer", maximum: 10 },
          ],
        },
      },
    });
  });

  it("combines sibling allOf and oneOf fields and required constraints", () => {
    expect(
      normalizeOpenAiToolParameters({
        type: "object",
        allOf: [{ properties: { projectId: { type: "string" } }, required: ["projectId"] }],
        oneOf: [
          {
            properties: { action: { const: "start" }, startAt: { type: "string" } },
            required: ["action", "startAt"],
          },
          {
            properties: { action: { const: "stop" }, reason: { type: "string" } },
            required: ["action", "reason"],
          },
        ],
      }),
    ).toEqual({
      type: "object",
      properties: {
        projectId: { type: "string" },
        action: { anyOf: [{ const: "start" }, { const: "stop" }] },
        startAt: { type: "string" },
        reason: { type: "string" },
      },
      required: ["projectId", "action"],
    });
  });

  it("conjoins overlapping root, allOf, and union property constraints", () => {
    expect(
      normalizeOpenAiToolParameters({
        type: "object",
        properties: { count: { type: "integer" } },
        allOf: [{ properties: { count: { minimum: 1 } }, required: ["count"] }],
        oneOf: [{ properties: { count: { const: 1 } } }, { properties: { count: { const: 2 } } }],
      }),
    ).toEqual({
      type: "object",
      properties: {
        count: {
          allOf: [{ type: "integer" }, { minimum: 1 }, { anyOf: [{ const: 1 }, { const: 2 }] }],
        },
      },
      required: ["count"],
    });
  });

  it("conjoins sibling anyOf and oneOf alternatives", () => {
    expect(
      normalizeOpenAiToolParameters({
        type: "object",
        anyOf: [
          { properties: { value: { type: "string" } }, required: ["value"] },
          { properties: { value: { type: "number" } }, required: ["value"] },
        ],
        oneOf: [
          {
            properties: { value: { const: "ready" }, mode: { const: "text" } },
            required: ["mode"],
          },
          {
            properties: { value: { const: 1 }, mode: { const: "numeric" } },
            required: ["mode"],
          },
        ],
      }),
    ).toEqual({
      type: "object",
      properties: {
        value: {
          allOf: [
            { anyOf: [{ type: "string" }, { type: "number" }] },
            { anyOf: [{ const: "ready" }, { const: 1 }] },
          ],
        },
        mode: { anyOf: [{ const: "text" }, { const: "numeric" }] },
      },
      required: ["value", "mode"],
    });
  });

  it("preserves required, additionalProperties, and existing properties", () => {
    expect(
      normalizeOpenAiToolParameters({
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      }),
    ).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    });
  });

  it("replaces a non-object type with object without inventing fields", () => {
    expect(normalizeOpenAiToolParameters({ type: "string" })).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("treats nullish or non-object input as an empty object schema", () => {
    expect(normalizeOpenAiToolParameters(undefined)).toEqual({
      type: "object",
      properties: {},
    });
    expect(normalizeOpenAiToolParameters(null)).toEqual({
      type: "object",
      properties: {},
    });
    expect(normalizeOpenAiToolParameters([])).toEqual({
      type: "object",
      properties: {},
    });
  });
});

describe("openAiToolParametersNeedNormalization", () => {
  it("returns false for a complete object schema", () => {
    expect(openAiToolParametersNeedNormalization({ type: "object", properties: {} })).toBe(false);
  });

  it("returns true when type or properties are missing or malformed", () => {
    expect(openAiToolParametersNeedNormalization({ type: "object" })).toBe(true);
    expect(openAiToolParametersNeedNormalization({ anyOf: [] })).toBe(true);
    expect(
      openAiToolParametersNeedNormalization({ type: "object", properties: {}, oneOf: [] }),
    ).toBe(true);
    expect(openAiToolParametersNeedNormalization({ type: "object", properties: [] })).toBe(true);
    expect(openAiToolParametersNeedNormalization({ type: "string", properties: {} })).toBe(true);
  });
});

describe("parametersFor OpenAI wire fidelity", () => {
  it("does not close a union after dropping its branch pattern properties", () => {
    const wire = JSON.parse(
      JSON.stringify(
        parametersFor({
          name: "manage_project",
          description: "Manage a project",
          inputSchema: {
            type: "object",
            anyOf: [
              { patternProperties: { "^x": { type: "string" } }, additionalProperties: false },
            ],
          },
        }),
      ),
    );
    expect(wire).not.toHaveProperty("additionalProperties");
  });

  it("preserves an unconstrained boolean union alternative through conversion", () => {
    const wire = JSON.parse(
      JSON.stringify(
        parametersFor({
          name: "manage_project",
          description: "Manage a project",
          inputSchema: {
            type: "object",
            anyOf: [true, { properties: { action: { type: "string" } }, required: ["action"] }],
          },
        }),
      ),
    );
    expect(wire.properties.action).toEqual({});
    expect(wire).not.toHaveProperty("required");
  });

  it("retains gateway-compatible string discriminators for a plain root union", () => {
    const wire = JSON.parse(
      JSON.stringify(
        parametersFor({
          name: "manage_project",
          description: "Manage a project",
          inputSchema: {
            type: "object",
            oneOf: [
              { properties: { action: { const: "start" } }, required: ["action"] },
              { properties: { action: { const: "stop" } }, required: ["action"] },
            ],
          },
        }),
      ),
    );
    expect(wire.properties.action).toEqual({
      anyOf: [
        { type: "string", const: "start", enum: ["start"] },
        { type: "string", const: "stop", enum: ["stop"] },
      ],
    });
  });

  it("preserves root required alongside oneOf without root properties", () => {
    const wire = JSON.parse(
      JSON.stringify(
        parametersFor({
          name: "manage_project",
          description: "Manage a project",
          inputSchema: {
            type: "object",
            required: ["projectId"],
            oneOf: [
              {
                properties: { projectId: { type: "string" }, action: { const: "start" } },
                required: ["action"],
              },
              {
                properties: { projectId: { type: "string" }, action: { const: "stop" } },
                required: ["action"],
              },
            ],
          },
        }),
      ),
    );
    expect(wire).toEqual({
      type: "object",
      properties: {
        projectId: { type: "string" },
        action: {
          anyOf: [
            { type: "string", const: "start", enum: ["start"] },
            { type: "string", const: "stop", enum: ["stop"] },
          ],
        },
      },
      required: ["projectId", "action"],
    });
  });

  it("serializes sibling allOf and oneOf fields with their shared requirements", () => {
    const wire = JSON.parse(
      JSON.stringify(
        parametersFor({
          name: "manage_project",
          description: "Manage a project",
          inputSchema: {
            type: "object",
            allOf: [{ properties: { projectId: { type: "string" } }, required: ["projectId"] }],
            oneOf: [
              { properties: { action: { const: "start" } }, required: ["action"] },
              { properties: { action: { const: "stop" } }, required: ["action"] },
            ],
          },
        }),
      ),
    );
    expect(wire).toEqual({
      type: "object",
      properties: {
        projectId: { type: "string" },
        action: {
          anyOf: [
            { type: "string", const: "start", enum: ["start"] },
            { type: "string", const: "stop", enum: ["stop"] },
          ],
        },
      },
      required: ["projectId", "action"],
    });
  });

  it("serializes root properties together with oneOf fields", () => {
    const wire = JSON.parse(
      JSON.stringify(
        parametersFor({
          name: "manage_project",
          description: "Manage a project",
          inputSchema: {
            type: "object",
            properties: { projectId: { type: "string" } },
            required: ["projectId"],
            oneOf: [
              { properties: { action: { const: "start" } }, required: ["action"] },
              { properties: { action: { const: "stop" } }, required: ["action"] },
            ],
          },
        }),
      ),
    );
    expect(wire).toEqual({
      type: "object",
      properties: {
        projectId: { type: "string" },
        action: {
          anyOf: [
            { type: "string", const: "start", enum: ["start"] },
            { type: "string", const: "stop", enum: ["stop"] },
          ],
        },
      },
      required: ["projectId", "action"],
    });
  });

  it("serializes zero-argument tools with type object and empty properties", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "list_secrets");
    if (!tool) throw new Error("missing list_secrets");
    const wire = JSON.parse(JSON.stringify(parametersFor(tool))) as {
      type?: unknown;
      properties?: unknown;
    };
    expect(wire.type).toBe("object");
    expect(wire.properties).toEqual({});
  });

  it("serializes request_secret as one object with both destinations and no root union", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "request_secret");
    if (!tool) throw new Error("missing request_secret");
    const wire = JSON.parse(JSON.stringify(parametersFor(tool))) as Record<string, unknown>;
    expect(wire.type).toBe("object");
    expect(Object.keys(wire.properties as object).sort()).toEqual([
      "connectionId",
      "credential",
      "fields",
      "label",
      "oneTimeCode",
      "purpose",
      "replace",
    ]);
    expect(wire.required).toEqual(["label", "purpose"]);
    expect(wire.additionalProperties).toBe(false);
    for (const key of ["oneOf", "anyOf", "allOf"]) expect(wire).not.toHaveProperty(key);
  });

  it("never sends a root union for any builtin tool", () => {
    for (const tool of builtinAgentTools) {
      const wire = JSON.parse(JSON.stringify(parametersFor(tool))) as Record<string, unknown>;
      for (const key of ["oneOf", "anyOf", "allOf"]) {
        expect(wire, tool.name).not.toHaveProperty(key);
      }
    }
  });
});
