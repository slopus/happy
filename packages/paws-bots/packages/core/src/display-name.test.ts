import { describe, expect, it } from "vitest";
import { accountDisplay, displayMessageBlock, displayName } from "./display-name.js";

const email = "demo@example.com";
const opaque = [
  "__PrbLMrkR__",
  "550e8400-e29b-41d4-a716-446655440000",
  "c123456789012345678901234",
  "tz4a98xxat96iws9zmbrgj3a",
  "V1StGXR8_Z5jdHi6BmyT",
];

describe("displayName", () => {
  it.each([undefined, null, "", "  ", "__", "💬", ...opaque])(
    "hides opaque or empty names: %s",
    (name) => {
      expect(displayName(name, "Bot")).toBe("Bot");
    },
  );
  it.each([
    "Ada",
    "李雷",
    "O'Brien",
    "jean-luc",
    "dev_bot",
    "r2d2",
    "123",
    "AlexandertheGreat",
    "Ada Lovelace",
    "CustomerSupportBot2026",
    "CustomerSupport2026Team",
    "iPhoneDeveloper2026Team",
    "Customer_Support_Bot2026",
    "christopheralexandermorgan",
  ])("keeps names and short handles: %s", (name) => {
    expect(displayName(` ${name} `, "Bot")).toBe(name);
  });
});

describe("accountDisplay", () => {
  it.each([undefined, null, "", "  ", "demo", email, ...opaque])(
    "uses email for an unusable account name: %s",
    (name) => {
      expect(accountDisplay({ name, email }, "You")).toEqual({
        label: email,
        initial: "D",
        image: null,
      });
    },
  );
  it("compares email-derived names without case sensitivity", () => {
    expect(accountDisplay({ name: " Demo ", email }, "You").label).toBe(email);
  });
  it("keeps a real name and image", () => {
    expect(
      accountDisplay({ name: " Ada ", email, image: "https://example.com/avatar.png" }, "You"),
    ).toEqual({ label: "Ada", initial: "A", image: "https://example.com/avatar.png" });
  });
  it("uses the translated fallback when no account is available", () => {
    expect(accountDisplay({}, "You")).toEqual({ label: "You", initial: "Y", image: null });
  });
  it("finds the first Unicode letter or digit rather than punctuation", () => {
    expect(accountDisplay({ name: "_李雷" }, "You").initial).toBe("李");
    expect(accountDisplay({ name: "'ada" }, "You").initial).toBe("A");
    expect(accountDisplay({}, "…").initial).toBeNull();
  });
});

it("guards identity metadata without changing literal message text", () => {
  expect(
    displayMessageBlock({
      kind: "bot_message_received",
      fromBotId: "peer",
      fromBotName: "__TestTok1__",
      text: "Keep __TestTok1__ literal",
    }),
  ).toMatchObject({
    kind: "bot_message_received",
    fromBotId: "peer",
    fromBotName: "Bot",
    text: "Keep __TestTok1__ literal",
  });
  const text = { kind: "text" as const, text: "__TestTok1__" };
  expect(displayMessageBlock(text)).toBe(text);
});
