import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseModelJson } from "./model-json.js";

const Verdict = z.object({ pass: z.boolean(), reason: z.string() });

describe("parseModelJson", () => {
  it.each([
    ['{"pass":true,"reason":"ok"}', "strict JSON"],
    ['Verdict:\n{"pass":true,"reason":"ok"}\nDone.', "JSON inside prose"],
    ['```json\n{"pass": true, reason: "ok",}\n```', "fenced JSON with broken syntax"],
  ])("reads %j (%s)", (text) => {
    expect(parseModelJson(text, Verdict)).toEqual({ pass: true, reason: "ok" });
  });

  it.each([
    "",
    "Chat reply asks about the lease. Verdict: pass",
    '{"pass":"yes","reason":"ok"}',
    '{"pass":true,"reason":"ok"',
    '```json\n{"pass": true, "reason": "ok"',
  ])("rejects %j", (text) => {
    expect(parseModelJson(text, Verdict)).toBeUndefined();
  });
});
