import { expect, it } from "vitest";
import { expectedClarificationText } from "./clarification.js";

const ask = {
  kind: "ask",
  status: "pending",
  text: "Which project do you mean?",
  actions: [{ label: "Aurora" }, { label: "Borealis" }],
};
it("accepts only explicit expected pending ask_user choices and includes every visible option", () => {
  expect(expectedClarificationText(true, "waiting_input", ["ask_user"], [ask])).toBe(
    "Which project do you mean?\nAurora\nBorealis",
  );
  expect(expectedClarificationText(false, "waiting_input", ["ask_user"], [ask])).toBeNull();
  expect(expectedClarificationText(true, "completed", ["ask_user"], [ask])).toBeNull();
  expect(expectedClarificationText(true, "waiting_input", ["request_secret"], [ask])).toBeNull();
  expect(
    expectedClarificationText(
      true,
      "waiting_input",
      ["ask_user"],
      [{ ...ask, actions: [{ label: "ORBIT-731" }, { label: "COMET-219" }] }],
    ),
  ).toContain("ORBIT-731");
});
it("rejects secret input, approval requests, malformed or multiple pending asks", () => {
  for (const blocks of [
    [{ ...ask, input: "secret" }],
    [{ ...ask, approvalEffectId: "private-effect" }],
    [{ ...ask, actions: [] }],
    [ask, ask],
  ])
    expect(expectedClarificationText(true, "waiting_input", ["ask_user"], blocks)).toBeNull();
});
