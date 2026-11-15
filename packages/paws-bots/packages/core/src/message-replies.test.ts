import type { MessageBlock } from "@rakazo/contracts";
import { ReplyPreviewSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { deriveMessageQuote, messageReplyPreview } from "./message-quote.js";
import {
  channelMessageSender,
  isPageOriginReply,
  memberMessageAlerts,
  messageUnreadFor,
  otherAuthor,
  payloadAuthor,
  previewMessageText,
  replyAttachment,
  replyLabel,
  replyLineText,
  replyMetadata,
} from "./message-replies.js";

describe("shared reply presentation", () => {
  it("keeps selected quotes on one line and uses preview before local fallback", () => {
    expect(replyLineText("First\nSecond", "preview", "fallback")).toBe("First Second");
    expect(replyLineText(undefined, "First\nSecond", "fallback")).toBe("First");
    expect(replyLineText(undefined, undefined, "Local\nSecond")).toBe("Local");
    expect(replyLineText()).toBe("");
  });
  it("preserves omitted metadata and accepts authoritative unavailable previews", () => {
    const previous = {
      replyToMessageId: "parent",
      replyQuote: "",
      replyPreview: { role: "bot" as const, text: "Earlier" },
    };
    expect(replyMetadata({}, previous)).toEqual(previous);
    expect(replyMetadata({ replyPreview: { text: 12 } }, previous)).toEqual(previous);
    expect(replyMetadata({ replyPreview: null }, previous)).toEqual({
      ...previous,
      replyPreview: null,
    });
    expect(
      replyMetadata(
        {
          replyQuote: "new",
          replyToMessageId: "other",
          replyPreview: { role: "user", text: "New" },
        },
        previous,
      ),
    ).toEqual({
      replyQuote: "new",
      replyToMessageId: "other",
      replyPreview: { role: "user", text: "New" },
    });
  });
});

const image: MessageBlock = { kind: "image", artifactId: "photo", mimeType: "image/png", name: "" };
const file: MessageBlock = {
  kind: "file",
  artifactId: "document",
  mimeType: "text/plain",
  name: "notes.txt",
  size: 12,
};
it("prefers the first parent image and copies only attachment metadata", () => {
  expect(replyAttachment([file, image, { ...image, artifactId: "second" }])).toEqual(image);
  expect(replyAttachment([file])).toEqual({
    kind: "file",
    artifactId: "document",
    mimeType: "text/plain",
    name: "notes.txt",
  });
  expect(replyAttachment([])).toBeUndefined();
});
it("uses quote, caption, localized photo, filename, and attachment in order", () => {
  const labels = { photo: "Foto", attachment: "Anhang" };
  expect(replyLabel("selected\ntext", "caption", image, labels)).toBe("selected text");
  expect(replyLabel(undefined, "caption", image, labels)).toBe("caption");
  expect(replyLabel(undefined, "", image, labels)).toBe("Foto");
  expect(replyLabel(undefined, "", replyAttachment([file]), labels)).toBe("notes.txt");
  expect(replyLabel(undefined, "", { ...file, name: "" }, labels)).toBe("Anhang");
});
it.each([
  { role: "user", text: "legacy" },
  { role: "bot", botId: "bot", text: "legacy" },
])("accepts legacy previews and strips unexpected top-level fields: %j", (preview) => {
  expect(ReplyPreviewSchema.parse(preview)).toEqual(preview);
  expect(ReplyPreviewSchema.parse({ ...preview, source: "cache" })).toEqual(preview);
});
it("strips unknown preview and attachment fields and preserves known metadata in events", () => {
  const preview = { role: "user", text: "", attachment: image };
  expect(replyMetadata({ replyPreview: preview }).replyPreview).toEqual(preview);
  const cachedPreview = {
    ...preview,
    source: "cache",
    attachment: { ...image, contentBase64: "bytes", size: 12 },
  };
  expect(ReplyPreviewSchema.safeParse(cachedPreview)).toEqual({ success: true, data: preview });
  expect(replyMetadata({ replyPreview: cachedPreview }).replyPreview).toEqual(preview);
});
it("still rejects missing or invalid known preview and attachment fields", () => {
  expect(ReplyPreviewSchema.safeParse({ role: "user" }).success).toBe(false);
  expect(ReplyPreviewSchema.safeParse({ role: "invalid", text: "" }).success).toBe(false);
  expect(ReplyPreviewSchema.safeParse({ role: "user", text: 12 }).success).toBe(false);
  const preview = { role: "user", text: "" };
  expect(ReplyPreviewSchema.safeParse({ ...preview, attachment: { kind: "image" } }).success).toBe(
    false,
  );
  expect(
    ReplyPreviewSchema.safeParse({ ...preview, attachment: { ...image, mimeType: 12 } }).success,
  ).toBe(false);
});

it("localizes legacy image-only quotes while retaining real selected caption text", () => {
  const labels = { photo: "Foto", attachment: "Anhang" };
  expect(replyLabel("[image: ]", "", image, labels)).toBe("Foto");
  expect(replyLabel("photo.png", "", { ...image, name: "photo.png" }, labels)).toBe("Foto");
  expect(
    replyLabel("photo.png", "Caption photo.png", { ...image, name: "photo.png" }, labels),
  ).toBe("photo.png");
});

describe("message authors", () => {
  const ana = { id: "user-a", name: "Ana" };

  it("names only someone other than me", () => {
    expect(otherAuthor(ana, "user-b")).toEqual(ana);
    expect(otherAuthor(ana, "user-a")).toBeUndefined();
    expect(otherAuthor(undefined, "user-b")).toBeUndefined();
    // Before the session loads, nobody is named rather than everyone.
    expect(otherAuthor(ana, undefined)).toBeUndefined();
  });

  it("counts a bot's message and another member's as unread, never my own", () => {
    expect(messageUnreadFor({ role: "bot" }, "user-a")).toBe(true);
    expect(messageUnreadFor({ role: "user", author: ana }, "user-b")).toBe(true);
    expect(messageUnreadFor({ role: "user", author: ana }, "user-a")).toBe(false);
    // A message with no known author, such as a webhook's, leaves the chat as it was.
    expect(messageUnreadFor({ role: "user" }, "user-b")).toBe(false);
  });

  it("alerts the space for typed text, not a spoken call turn, a reaction or a file alone", () => {
    const typed = [{ kind: "text", text: "Saturday works" }];
    expect(memberMessageAlerts({ blocks: typed })).toBe(true);
    expect(memberMessageAlerts({ blocks: typed, callId: "call-1" })).toBe(false);
    expect(memberMessageAlerts({ blocks: [{ kind: "file", name: "plan.pdf" }] })).toBe(false);
    expect(memberMessageAlerts({ blocks: [{ kind: "text", text: "  " }] })).toBe(false);
    // A reaction is a one-emoji reply; a typed reply with words still alerts.
    const reply = (text: string) => ({
      blocks: [{ kind: "text", text }],
      replyToMessageId: "message-1",
    });
    expect(memberMessageAlerts(reply("👍"))).toBe(false);
    expect(memberMessageAlerts(reply("Yes, Saturday"))).toBe(true);
  });

  it("reads a live event's author and keeps the known one across updates", () => {
    expect(payloadAuthor({ author: ana })).toEqual({ author: ana });
    expect(payloadAuthor({}, { author: ana })).toEqual({ author: ana });
    expect(payloadAuthor({ author: { id: "user-a" } })).toEqual({});
    expect(payloadAuthor({})).toEqual({});
  });
});

describe("channelMessageSender", () => {
  const channel = {
    kind: "channel_message" as const,
    provider: "telegram",
    channelId: "channel",
    fromAddress: "ada",
    fromLabel: "Ada",
    text: "On my way",
  };

  it("names the outside sender of a relayed message", () => {
    expect(channelMessageSender([channel])).toBe("Ada");
  });

  it("is undefined for the user's own messages and for a blank sender", () => {
    expect(channelMessageSender([{ kind: "text", text: "hi" }])).toBeUndefined();
    expect(channelMessageSender([{ ...channel, fromLabel: "  " }])).toBeUndefined();
  });
});

describe("previewMessageText", () => {
  it("never previews or quotes a delivery's hidden prompt", () => {
    const blocks: MessageBlock[] = [
      { kind: "delivery" },
      { kind: "text", text: 'Run routine "Triage":\nTriage this.' },
    ];
    expect(messageReplyPreview(blocks, "user")).toEqual({ role: "user", text: "" });
    expect(deriveMessageQuote(blocks, "Triage this.", "plain-text")).toBeUndefined();
  });

  const labels = { photo: "Photo", attachment: "Attachment", message: "Message" };

  it("joins text, reading bot Markdown as plain text", () => {
    expect(
      previewMessageText(
        {
          role: "bot",
          blocks: [
            { kind: "text", text: "**Hello**" },
            { kind: "text", text: "there" },
          ],
        },
        labels,
      ),
    ).toBe("Hello there");
    expect(
      previewMessageText({ role: "user", blocks: [{ kind: "text", text: "**hi**" }] }, labels),
    ).toBe("**hi**");
  });

  it("shows a channel message's text alone, like the server preview", () => {
    expect(
      previewMessageText(
        {
          role: "user",
          blocks: [
            {
              kind: "channel_message",
              provider: "telegram",
              channelId: "channel",
              fromAddress: "ada",
              fromLabel: "Ada",
              text: "On my way",
            },
          ],
        },
        labels,
      ),
    ).toBe("On my way");
  });

  it.each(["pending", "answered"] as const)(
    "previews a %s question before the server preview arrives",
    (status) => {
      const blocks: MessageBlock[] = [
        { kind: "ask", text: "Which release?", status, detail: "Extra context", answer: "Stable" },
      ];
      expect(previewMessageText({ role: "bot", blocks }, labels)).toBe("Which release?");
      expect(previewMessageText({ role: "bot", blocks }, labels)).toBe(
        messageReplyPreview(blocks, "bot").text,
      );
    },
  );

  it.each([
    "\n  Which release?  \nMore context",
    "\r\n  Which release?  \r\nMore context",
    "a".repeat(300),
    `${"a".repeat(279)}😀more`,
    `${" ".repeat(100_000)}Outside the preview limit`,
  ])("matches the server preview for bounded question text: %j", (text) => {
    const blocks: MessageBlock[] = [{ kind: "ask", text }];
    expect(previewMessageText({ role: "bot", blocks }, labels)).toBe(
      messageReplyPreview(blocks, "bot").text || labels.message,
    );
  });

  it("does not expose delivery questions in local reply previews", () => {
    const blocks: MessageBlock[] = [{ kind: "delivery" }, { kind: "ask", text: "Hidden question" }];
    expect(previewMessageText({ role: "bot", blocks }, labels)).toBe(labels.message);
    expect(messageReplyPreview(blocks, "bot").text).toBe("");
  });

  it("keeps channel text ahead of ordinary questions after sending", () => {
    const blocks: MessageBlock[] = [
      { kind: "ask", text: "Which release?" },
      {
        kind: "channel_message",
        provider: "test",
        channelId: "channel",
        fromAddress: "sender",
        fromLabel: "Sender",
        text: "Channel context",
      },
    ];
    expect(previewMessageText({ role: "bot", blocks }, labels)).toBe("Channel context");
    expect(messageReplyPreview(blocks, "bot").text).toBe("Channel context");
    expect(
      messageReplyPreview([...blocks, { kind: "text", text: "Primary context" }], "bot").text,
    ).toBe("Primary context");
  });

  it("keeps mixed-card question previews stable after sending", () => {
    const blocks: MessageBlock[] = [
      { kind: "choice", question: "Pick a channel", options: [] },
      { kind: "ask", text: "Which release?" },
    ];
    expect(previewMessageText({ role: "bot", blocks }, labels)).toBe("Which release?");
    expect(messageReplyPreview(blocks, "bot").text).toBe("Which release?");
  });

  it("keeps text ahead of questions and questions ahead of attachments", () => {
    const ask: MessageBlock = { kind: "ask", text: "Which release?" };
    expect(
      previewMessageText(
        { role: "bot", blocks: [ask, { kind: "text", text: "**Context**" }] },
        labels,
      ),
    ).toBe("Context");
    expect(previewMessageText({ role: "bot", blocks: [image, ask] }, labels)).toBe(
      "Which release?",
    );
    expect(
      previewMessageText(
        {
          role: "bot",
          blocks: [
            { kind: "ask", text: "  " },
            { kind: "ask", text: " Use **stable**? " },
          ],
        },
        labels,
      ),
    ).toBe("Use **stable**?");
  });

  it.each([
    { kind: "ask", text: "Secret request", input: "secret" },
    { kind: "ask", text: "Approval", approvalEffectId: "approval" },
    {
      kind: "ask",
      text: "Instructions",
      instructionUpdate: { botId: "bot", before: "", after: "New", reason: "Update" },
    },
  ] satisfies MessageBlock[])("does not expand protected-card previews: %j", (block) => {
    expect(previewMessageText({ role: "bot", blocks: [block] }, labels)).toBe("Message");
  });

  it("falls back to attachment labels, then a generic label", () => {
    const image = { kind: "image", artifactId: "a", mimeType: "image/png", name: "a.png" } as const;
    const file = { kind: "file", artifactId: "f", mimeType: "application/pdf", size: 1 } as const;
    expect(previewMessageText({ role: "user", blocks: [image] }, labels)).toBe("Photo");
    expect(previewMessageText({ role: "user", blocks: [{ ...file, name: "a.pdf" }] }, labels)).toBe(
      "a.pdf",
    );
    expect(previewMessageText({ role: "user", blocks: [{ ...file, name: "" }] }, labels)).toBe(
      "Attachment",
    );
    expect(previewMessageText({ role: "bot", blocks: [] }, labels)).toBe("Message");
  });
});

describe("page card replies", () => {
  it("marks a page card parent so a reply sent from the open page shows no quote", () => {
    const card = messageReplyPreview(
      [{ kind: "page", pageId: "p1", version: 2, title: "Q3 plan" }],
      "bot",
    );
    expect(ReplyPreviewSchema.parse(card)).toMatchObject({ page: true, text: "Q3 plan" });
    expect(isPageOriginReply({ replyPreview: card })).toBe(true);
    expect(isPageOriginReply({ replyPreview: card, replyQuote: "Q3 plan" })).toBe(false);
    const text = messageReplyPreview([{ kind: "text", text: "hi" }], "bot");
    expect(text.page).toBeUndefined();
    expect(isPageOriginReply({ replyPreview: text })).toBe(false);
  });
});
