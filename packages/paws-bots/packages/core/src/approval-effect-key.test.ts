import { describe, expect, it } from "vitest";
import {
  approvalEffectKey,
  isToolEffectIdempotencyKey,
  legacyScopedToolEffectIdempotencyKey,
  stableJsonValue,
  toolEffectIdempotencyKey,
} from "./approval-effect-key.js";

describe("stableJsonValue", () => {
  it("sorts object keys", () => {
    expect(stableJsonValue({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("rejects values that cannot be represented uniquely as JSON", () => {
    const sparse = Array(1);

    for (const value of [undefined, [undefined], sparse, { value: undefined }, Number.NaN]) {
      expect(() => stableJsonValue(value)).toThrow("only JSON values");
    }
    expect(stableJsonValue([])).toBe("[]");
    expect(stableJsonValue([null])).toBe("[null]");
  });

  it("rejects cyclic and non-plain objects", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    expect(() => stableJsonValue(cyclic)).toThrow("only JSON values");
    expect(() => stableJsonValue(new Date(0))).toThrow("only JSON values");
  });

  it("accepts a value shared by two keys and null-prototype objects", () => {
    const shared = { a: 1 };
    expect(stableJsonValue({ x: shared, y: shared })).toBe('{"x":{"a":1},"y":{"a":1}}');
    expect(stableJsonValue(Object.assign(Object.create(null), { a: 1 }))).toBe('{"a":1}');
  });
});

describe("approvalEffectKey", () => {
  it("includes run and tool with an opaque digest of canonical args", () => {
    const key = approvalEffectKey("run-1", "destination.write", { body: "private draft" });

    expect(key).toMatch(/^run-1:destination\.write:[a-f0-9]{64}$/);
    expect(key).not.toContain("private draft");
  });
});

describe("toolEffectIdempotencyKey", () => {
  it("scopes effects to run, tool, and args without the model tool-call id", () => {
    const write = { path: "a.txt", content: "one" };
    expect(toolEffectIdempotencyKey("run-1", "write_file", write)).toMatch(
      /^run-1:write_file:[a-f0-9]{64}$/,
    );
    expect(toolEffectIdempotencyKey("run-1", "write_file", write)).toBe(
      approvalEffectKey("run-1", "write_file", write),
    );
    expect(toolEffectIdempotencyKey("run-1", "write_file", write)).not.toBe(
      toolEffectIdempotencyKey("run-2", "write_file", write),
    );
    expect(toolEffectIdempotencyKey("run-1", "write_file", write)).not.toBe(
      toolEffectIdempotencyKey("run-1", "shell", write),
    );
    expect(toolEffectIdempotencyKey("run-1", "write_file", write)).not.toBe(
      toolEffectIdempotencyKey("run-1", "write_file", {
        path: "a.txt",
        content: "two",
      }),
    );
    expect(toolEffectIdempotencyKey("run-1", "write_file", write)).not.toContain("call_0");
  });

  it("is stable across replay when the model assigns a new tool-call id", () => {
    const args = { path: "MEMORY.md", content: "fact" };
    expect(toolEffectIdempotencyKey("run-1", "remember", args)).toBe(
      toolEffectIdempotencyKey("run-1", "remember", args),
    );
    expect(legacyScopedToolEffectIdempotencyKey("run-1", "remember", "call_0", args)).not.toBe(
      toolEffectIdempotencyKey("run-1", "remember", args),
    );
  });

  it("distinguishes identical-args calls in one run via occurrence", () => {
    const args = { actions: [{ kind: "click", x: 12, y: 40 }] };
    const first = toolEffectIdempotencyKey("run-1", "computer_act", args);
    const second = toolEffectIdempotencyKey("run-1", "computer_act", args, 1);
    expect(first).toBe(approvalEffectKey("run-1", "computer_act", args));
    expect(second).not.toBe(first);
    expect(second).toBe(`${first}:1`);
    expect(isToolEffectIdempotencyKey(first, "run-1", "computer_act")).toBe(true);
    expect(isToolEffectIdempotencyKey(second, "run-1", "computer_act")).toBe(true);
    expect(isToolEffectIdempotencyKey(first, "run-2", "computer_act")).toBe(false);
    expect(isToolEffectIdempotencyKey(`${first}:1x`, "run-1", "computer_act")).toBe(false);
    expect(
      isToolEffectIdempotencyKey(
        legacyScopedToolEffectIdempotencyKey("run-1", "computer_act", "call_0", args),
        "run-1",
        "computer_act",
      ),
    ).toBe(false);
  });
});
