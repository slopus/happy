import { describe, expect, it } from "vitest";
import { normalizeOpenAiToolParameters } from "./openai-tool-parameters.js";

describe("root union alternatives with sibling constraints", () => {
  it("does not impose another alternative's property constraint on an open alternative", () => {
    const normalized = normalizeOpenAiToolParameters({
      allOf: [{ properties: { value: { const: 1 } } }],
      oneOf: [{ properties: { value: { const: 2 } }, required: ["a"] }, { required: ["b"] }],
    });
    expect(normalized.properties).toEqual({ value: { const: 1 } });
  });

  it("retains the missing alternative's additionalProperties schema", () => {
    const normalized = normalizeOpenAiToolParameters({
      properties: { value: { type: "string" } },
      anyOf: [{ properties: { value: { const: "a" } } }, { additionalProperties: { const: "b" } }],
    });
    expect(normalized.properties).toEqual({
      value: {
        allOf: [{ type: "string" }, { anyOf: [{ const: "a" }, { const: "b" }] }],
      },
    });
  });

  it("keeps the constraint when a closed alternative excludes the property", () => {
    const normalized = normalizeOpenAiToolParameters({
      properties: { value: { type: "string" } },
      oneOf: [
        { properties: { value: { const: "a" } } },
        { properties: { other: { type: "string" } }, additionalProperties: false },
      ],
    });
    expect(normalized.properties).toEqual({
      value: { allOf: [{ type: "string" }, { const: "a" }] },
      other: { type: "string" },
    });
  });

  it("keeps standalone union field specifications", () => {
    const normalized = normalizeOpenAiToolParameters({
      oneOf: [{ properties: { value: { type: "string" } } }, { properties: {} }],
    });
    expect(normalized.properties).toEqual({ value: { type: "string" } });
  });

  it.each(["oneOf", "anyOf"])("handles true in %s as an unconstrained alternative", (key) => {
    const normalized = normalizeOpenAiToolParameters({
      [key]: [
        true,
        { properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false },
      ],
    });
    expect(normalized.properties).toEqual({ a: {} });
    expect(normalized).not.toHaveProperty("required");
    expect(normalized).not.toHaveProperty("additionalProperties");
  });

  it("does not close a union when an alternative accepts patterned properties", () => {
    const normalized = normalizeOpenAiToolParameters({
      oneOf: [
        { properties: { a: { type: "string" } }, additionalProperties: false },
        { patternProperties: { "^x-": { type: "string" } }, additionalProperties: false },
      ],
    });
    expect(normalized).not.toHaveProperty("additionalProperties");
  });
});
