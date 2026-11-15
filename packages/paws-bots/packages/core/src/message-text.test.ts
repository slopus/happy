import type { ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { copyableMessageText, selectableMessageText } from "./message-text.js";

function message(blocks: ThreadMessage["blocks"]): ThreadMessage {
  return { id: "m_1", threadId: "t_1", seq: 1, role: "bot", blocks, createdAt: "2026-08-29" };
}

describe("copyableMessageText", () => {
  it("joins text, progress, and ask blocks without chrome", () => {
    expect(
      copyableMessageText(
        message([
          { kind: "text", text: "first" },
          { kind: "progress", text: "working" },
          { kind: "ask", text: "question?" },
        ]),
      ),
    ).toBe("first\nworking\nquestion?");
  });

  it("leaves out a block kind it does not know, as an older client does with a newer server's page", () => {
    // Clients read blocks without validating them, so a newer kind reaches this code as is.
    const page = { kind: "page", pageId: "page-1", version: 1, title: "Plan" };
    const blocks = [{ kind: "text", text: "Here it is" }, page] as ThreadMessage["blocks"];
    expect(copyableMessageText(message(blocks))).toBe("Here it is");
  });

  it("includes channel messages with their chat attribution", () => {
    expect(
      copyableMessageText(
        message([
          {
            kind: "channel_message",
            provider: "sendblue",
            transport: "RCS",
            channelId: "ch-1",
            fromAddress: "+15551234567",
            fromLabel: "Alice",
            text: "dinner at 7?",
            hop: 0,
          },
        ]),
      ),
    ).toBe("Alice (RCS): dinner at 7?");
  });

  it("falls back to the provider label for unknown transport values", () => {
    expect(
      copyableMessageText(
        message([
          {
            kind: "channel_message",
            provider: "sendblue",
            transport: "email",
            channelId: "ch-1",
            fromAddress: "+15551234567",
            fromLabel: "Alice",
            text: "hello",
          },
        ]),
      ),
    ).toBe("Alice (iMessage): hello");
  });

  it("leaves out card chrome between text and channel messages", () => {
    expect(
      copyableMessageText(
        message([
          { kind: "text", text: "Hello" },
          {
            kind: "channel_message",
            provider: "sendblue",
            transport: "SMS",
            channelId: "ch-1",
            fromAddress: "+15551234567",
            fromLabel: "Sender",
            text: "Reply",
          },
          { kind: "card", lines: [] },
        ]),
      ),
    ).toBe("Hello\nSender (SMS): Reply");
  });

  it("keeps leading whitespace for selection while copying trims it", () => {
    const indented = message([{ kind: "text", text: "    indented\nnext  " }]);
    expect(selectableMessageText(indented)).toBe("    indented\nnext  ");
    expect(copyableMessageText(indented)).toBe("indented\nnext");
  });
});
