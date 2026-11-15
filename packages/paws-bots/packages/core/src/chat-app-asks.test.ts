import { describe, expect, it } from "vitest";
import {
  CHAT_APP_ASK_NOTE,
  CHAT_APP_TAKEOVER_NOTE,
  chatAppAskText,
  chatAppTakeoverText,
} from "./chat-app-asks.js";
import { TAKEOVER_COMPUTER_PENDING_STATE } from "./thread-message-updates.js";

describe("chatAppAskText", () => {
  it("lists a pending question's detail and options in order", () => {
    expect(
      chatAppAskText({
        kind: "ask",
        text: "Which day?",
        detail: "Both work for Sam.",
        status: "pending",
        actions: [
          { id: "mon", label: "Monday" },
          { id: "tue", label: "Tuesday" },
        ],
      }),
    ).toBe(
      ["Which day?", "Both work for Sam.", "1. Monday", "2. Tuesday", CHAT_APP_ASK_NOTE].join("\n"),
    );
  });

  it("keeps an open question without options to its text", () => {
    expect(chatAppAskText({ kind: "ask", text: "What's the address?", input: "text" })).toBe(
      `What's the address?\n${CHAT_APP_ASK_NOTE}`,
    );
  });

  it("keeps an approval or a secret request to its title, which only their cards answer", () => {
    expect(
      chatAppAskText({
        kind: "ask",
        text: "Delete the file?",
        detail: "rm ~/notes.txt",
        approvalEffectId: "effect-1",
        actions: [
          { id: "allow", label: "Allow" },
          { id: "always", label: "Always" },
          { id: "deny", label: "Deny" },
        ],
      }),
    ).toBe(`Delete the file?\n${CHAT_APP_ASK_NOTE}`);
    expect(
      chatAppAskText({
        kind: "ask",
        text: "Your API key",
        input: "secret",
        detail: "For the CRM.",
      }),
    ).toBe(`Your API key\n${CHAT_APP_ASK_NOTE}`);
  });

  it("adds nothing for an answered question or another block", () => {
    expect(chatAppAskText({ kind: "ask", text: "Which day?", status: "answered" })).toBeUndefined();
    expect(chatAppAskText({ kind: "text", text: "Hello" })).toBeUndefined();
  });
});

describe("chatAppTakeoverText", () => {
  it("says what the bot needs on its screen and where to do it", () => {
    expect(
      chatAppTakeoverText({
        kind: "computer",
        state: TAKEOVER_COMPUTER_PENDING_STATE,
        text: "Please sign in.",
      }),
    ).toBe(`Please sign in.\n${CHAT_APP_TAKEOVER_NOTE}`);
    expect(chatAppTakeoverText({ kind: "computer", state: TAKEOVER_COMPUTER_PENDING_STATE })).toBe(
      CHAT_APP_TAKEOVER_NOTE,
    );
  });

  it("adds nothing once the request is no longer pending", () => {
    expect(chatAppTakeoverText({ kind: "computer", state: "Done", text: "x" })).toBeUndefined();
  });
});
