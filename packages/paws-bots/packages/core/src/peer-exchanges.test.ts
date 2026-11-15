import type { ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { BOT_MESSAGE_MAX_LENGTH, clampBotMessage } from "./bot-messages.js";
import { foldPeerReplies } from "./message-visibility.js";
import { peerExchangeLines, splitPeerLabel } from "./peer-exchanges.js";
import { peerMessagesFrom } from "./peer-messages.js";

function message(id: string, blocks: ThreadMessage["blocks"], runId?: string): ThreadMessage {
  return {
    id,
    threadId: "thread",
    seq: 1,
    role: "bot",
    blocks,
    runId,
    createdAt: `2026-10-20T10:00:0${id.slice(-1)}Z`,
  };
}
const received = (
  id: string,
  intent?: "request" | "question" | "result" | "status" | "fyi",
  peer = "peer",
) =>
  message(
    id,
    [
      {
        kind: "bot_message_received",
        fromBotId: peer,
        fromBotName: "Peer",
        text: "Request",
        intent,
      },
    ],
    `run-${id}`,
  );
const reply = (id: string, runId: string, text = "Answer") =>
  message(id, [{ kind: "text", text }], runId);

describe("peer exchanges", () => {
  it.each([
    { kind: "chart", name: "Summary", spec: {}, data: [] },
    { kind: "page", pageId: "page", title: "Summary", version: 1 },
  ] satisfies ThreadMessage["blocks"])(
    "preserves $kind replies and their mixed text despite an echo",
    (block) => {
      const wake = received("m1");
      const rich = message("m2", [block], wake.runId);
      const mixed = message("m3", [{ kind: "text", text: "Answer" }, block], wake.runId);
      const echo = message(
        "m4",
        [{ kind: "bot_message_sent", toBotId: "peer", toBotName: "Peer", text: "Answer" }],
        wake.runId,
      );
      const messages = [wake, rich, mixed, echo];
      expect(peerMessagesFrom(messages).map((item) => item.messageId)).toEqual([
        "m1",
        "m2",
        "m3",
        "m4",
      ]);
      expect(peerMessagesFrom(messages)[1]?.blocks).toEqual([block]);
      expect(peerMessagesFrom(messages)[2]?.blocks).toEqual(mixed.blocks);
      expect(
        peerExchangeLines(foldPeerReplies(messages, { includePeerReceipts: true })).lines.get("m1")
          ?.count,
      ).toBe(4);
    },
  );

  it.each([undefined, "request", "question"] as const)(
    "folds replies to %s wakes and counts unreturned text",
    (intent) => {
      const wake = received("m1", intent);
      const messages = [wake, reply("m2", wake.runId!)];
      const transcript = foldPeerReplies(messages, { includePeerReceipts: true });
      expect(transcript.messages.map((m) => m.id)).toEqual(["m1"]);
      expect(transcript.markerOf.get("m2")).toBe("m1");
      expect(peerExchangeLines(transcript).lines.get("m1")?.count).toBe(2);
      expect(peerMessagesFrom(messages).map((m) => m.text)).toEqual(["Request", "Answer"]);
    },
  );

  it("counts an oversized reply and its truncated return receipt once", () => {
    const wake = received("m1");
    const text = "x".repeat(BOT_MESSAGE_MAX_LENGTH + 500);
    const messages = [
      wake,
      reply("m2", wake.runId!, text),
      message(
        "m3",
        [
          {
            kind: "bot_message_sent",
            toBotId: "peer",
            toBotName: "Peer",
            text: clampBotMessage(text),
          },
        ],
        wake.runId,
      ),
    ];
    const transcript = foldPeerReplies(messages, { includePeerReceipts: true });
    expect(peerExchangeLines(transcript).lines.get("m1")?.count).toBe(2);
    expect(peerMessagesFrom(messages).map((item) => item.messageId)).toEqual(["m1", "m3"]);
  });

  it("counts a reply and its trimmed auto-return echo once", () => {
    const wake = received("m1");
    const messages = [
      wake,
      reply("m2", wake.runId!, "Answer\n"),
      message(
        "m3",
        [{ kind: "bot_message_sent", toBotId: "peer", toBotName: "Peer", text: "Answer" }],
        wake.runId,
      ),
    ];
    const transcript = foldPeerReplies(messages, { includePeerReceipts: true });
    expect(peerExchangeLines(transcript).lines.get("m1")?.count).toBe(2);
    expect(peerMessagesFrom(messages).map((m) => m.text)).toEqual(["Request", "Answer"]);
  });

  it.each(["result", "status", "fyi"] as const)(
    "keeps %s-woken replies inline at their real position",
    (intent) => {
      const wake = received("m1", intent);
      const messages = [
        wake,
        reply("m2", wake.runId!),
        message("m3", [{ kind: "text", text: "User" }]),
      ];
      const transcript = foldPeerReplies(messages, { includePeerReceipts: true });
      expect(transcript.messages).toEqual(messages);
      expect(transcript.folded.size).toBe(0);
      expect(peerMessagesFrom(messages).map((m) => m.text)).toEqual(["Request"]);
      expect(
        foldPeerReplies(messages, { includeDelegatedReplyText: false }).messages.map((m) => m.id),
      ).toEqual(["m2", "m3"]);
    },
  );

  it("merges adjacent receipts, keeps latest names and counts auto echoes once", () => {
    const wake = received("m1");
    const messages = [
      wake,
      reply("m2", wake.runId!),
      message(
        "m3",
        [
          {
            kind: "bot_message_sent",
            toBotId: "peer",
            toBotName: "Renamed",
            text: "Answer",
            intent: "result",
          },
        ],
        wake.runId,
      ),
    ];
    const projection = peerExchangeLines(foldPeerReplies(messages, { includePeerReceipts: true }));
    expect([...projection.lines.values()]).toEqual([
      {
        peerBotId: "peer",
        peerBotName: "Renamed",
        count: 2,
        direction: "received",
      },
    ]);
    expect(projection.lineOf.get("m3")).toBe("m1");
    expect(peerMessagesFrom(messages).map((m) => m.messageId)).toEqual(["m1", "m3"]);
  });

  it("does not merge across a visible row or another peer", () => {
    const messages = [
      received("m1"),
      message("m2", [{ kind: "ask", text: "Choose" }]),
      received("m3"),
      received("m4", undefined, "other"),
      received("m5"),
    ];
    expect(
      peerExchangeLines(foldPeerReplies(messages, { includePeerReceipts: true })).lines.size,
    ).toBe(4);
  });

  it("retains attachments and repeated text from different runs chronologically", () => {
    const first = received("m1");
    const second = received("m4");
    const attachment = message(
      "m3",
      [{ kind: "file", artifactId: "file", name: "report.txt", mimeType: "text/plain", size: 12 }],
      first.runId,
    );
    const projected = peerMessagesFrom([
      first,
      reply("m2", first.runId!),
      attachment,
      second,
      reply("m5", second.runId!),
    ]);
    expect(projected.map((m) => m.messageId)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(projected[2]?.blocks).toEqual(attachment.blocks);
  });

  it("consumes each identical echo only once", () => {
    const wake = received("m1");
    const echo = message(
      "m4",
      [{ kind: "bot_message_sent", toBotId: "peer", toBotName: "Peer", text: "Answer" }],
      wake.runId,
    );
    const messages = [wake, reply("m2", wake.runId!), reply("m3", wake.runId!), echo];
    expect(peerMessagesFrom(messages).map((m) => m.messageId)).toEqual(["m1", "m3", "m4"]);
    expect(
      peerExchangeLines(foldPeerReplies(messages, { includePeerReceipts: true })).lines.get("m1")
        ?.count,
    ).toBe(3);
  });
});

describe("translated peer label", () => {
  it("places the avatar before the last name occurrence", () => {
    expect(splitPeerLabel("Peer: messages with Peer today", "Peer")).toEqual({
      before: "Peer: messages with ",
      name: "Peer",
      after: " today",
    });
  });
  it("falls back to avatar first", () => {
    expect(splitPeerLabel("Translated label", "Peer")).toEqual({
      before: "",
      name: "",
      after: "Translated label",
    });
  });
});
