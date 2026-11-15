import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  normalizedImageLimit,
  pruneComputerScreenshotContext,
  pruneForRebuild,
  pruneStalePageStateContext,
} from "./context-pruning.js";

describe("context pruning on rebuild", () => {
  const pageResult = (id: string, toolName: string, text = `page ${id} ${"x".repeat(1_200)}`) => ({
    role: "toolResult" as const,
    toolCallId: id,
    toolName,
    content: [{ type: "text" as const, text }],
    details: { frameId: id },
    isError: false,
    timestamp: 1,
  });

  it("trims page-state results older than the three most recent", () => {
    const messages = [
      { role: "user" as const, content: "find the cheapest coffee", timestamp: 1 },
      pageResult("s1", "browser_snapshot"),
      pageResult("s2", "browser_act"),
      {
        role: "toolResult" as const,
        toolCallId: "read-1",
        toolName: "read_file",
        content: [{ type: "text" as const, text: "tracker contents" }],
        isError: false,
        timestamp: 1,
      },
      pageResult("s3", "computer_observe"),
      pageResult("s4", "browser_snapshot"),
      pageResult("s5", "browser_navigate"),
    ];

    const pruned = pruneStalePageStateContext(messages);
    const texts = pruned.map((message) => {
      const content: unknown = "content" in message ? message.content : "";
      if (typeof content === "string") return content;
      return (content as Array<{ type: string; text?: string }>)
        .map((part) => part.text ?? part.type)
        .join("");
    });
    expect(texts).toEqual([
      "find the cheapest coffee",
      expect.stringContaining("trimmed to save context"),
      expect.stringContaining("trimmed to save context"),
      "tracker contents",
      expect.stringContaining("page s3"),
      expect.stringContaining("page s4"),
      expect.stringContaining("page s5"),
    ]);
    // The original history is untouched, so the next request trims identically.
    expect(messages[1]?.content).toEqual([
      { type: "text", text: expect.stringContaining("page s1") },
    ]);
    expect(pruned[1]).toMatchObject({ toolCallId: "s1", toolName: "browser_snapshot" });
  });

  it("neither trims nor counts small page-state results such as errors and receipts", () => {
    const messages = [
      pageResult("s1", "browser_snapshot"),
      pageResult("nav", "browser_navigate", '{"url":"https://example.test","title":"Example"}'),
      pageResult("err", "browser_act", 'Unknown element ref "e9". Call browser_snapshot.'),
      pageResult("s2", "browser_snapshot"),
      pageResult("s3", "browser_snapshot"),
    ];

    const pruned = pruneStalePageStateContext(messages);
    expect(pruned).toBe(messages);
    expect(pruneStalePageStateContext(messages, 2)[0]).toMatchObject({
      toolCallId: "s1",
      content: [{ type: "text", text: expect.stringContaining("trimmed to save context") }],
    });
    expect(pruneStalePageStateContext(messages, 2).slice(1, 3)).toEqual(messages.slice(1, 3));
  });

  it("returns the same history when nothing is stale", () => {
    const messages = ["s1", "s2", "s3"].map((id) => pageResult(id, "browser_snapshot"));
    expect(pruneStalePageStateContext(messages)).toBe(messages);
  });

  it.each(["thrown", "returned"])("does not count a long %s error as a fresh page", (kind) => {
    const failure = {
      ...pageResult("error", "browser_act", `Action failed: ${"diagnostic ".repeat(150)}`),
      isError: kind === "thrown",
      details: kind === "returned" ? { error: "action failed" } : undefined,
    };
    const messages = [
      pageResult("s1", "browser_snapshot"),
      pageResult("s2", "computer_observe"),
      pageResult("s3", "browser_snapshot"),
      failure,
    ];
    expect(pruneStalePageStateContext(messages)).toBe(messages);
  });

  it.each(["thrown", "returned"])(
    "keeps an old long %s error while trimming stale pages",
    (kind) => {
      const failure = {
        ...pageResult("error", "computer_act", `Action failed: ${"diagnostic ".repeat(150)}`),
        isError: kind === "thrown",
        details: kind === "returned" ? { error: "action failed" } : undefined,
      };
      const messages = [
        failure,
        ...["s1", "s2", "s3", "s4"].map((id) => pageResult(id, "browser_snapshot")),
      ];
      const pruned = pruneStalePageStateContext(messages);
      expect(pruned[0]).toBe(failure);
      expect(pruned[1]).toMatchObject({
        toolCallId: "s1",
        content: [{ type: "text", text: expect.stringContaining("trimmed to save context") }],
      });
      expect(pruned.slice(2)).toEqual(messages.slice(2));
      expect(messages[1]?.content).toEqual([
        { type: "text", text: expect.stringContaining("page s1") },
      ]);
    },
  );

  it("keeps the two latest computer screenshots by default", () => {
    const messages = ["frame-1", "frame-2", "frame-3"].map((frameId) => ({
      role: "toolResult" as const,
      toolCallId: frameId,
      toolName: "computer_observe",
      content: [
        { type: "text" as const, text: frameId },
        { type: "image" as const, data: frameId, mimeType: "image/png" as const },
      ],
      details: { frameId },
      isError: false,
      timestamp: 1,
    }));

    const pruned = pruneComputerScreenshotContext(messages);
    expect(
      pruned.map((message) =>
        (message as (typeof messages)[number]).content.some((part) => part.type === "image"),
      ),
    ).toEqual([false, true, true]);
  });

  it("honors a model-specific one-image limit", () => {
    const messages = ["frame-1", "frame-2", "frame-3"].map((frameId) => ({
      role: "toolResult" as const,
      toolCallId: frameId,
      toolName: "computer_observe",
      content: [
        { type: "text" as const, text: frameId },
        { type: "image" as const, data: frameId, mimeType: "image/png" as const },
      ],
      details: { frameId },
      isError: false,
      timestamp: 1,
    }));

    const pruned = pruneComputerScreenshotContext(messages, 1);
    expect(
      pruned.map((message) =>
        (message as (typeof messages)[number]).content.some((part) => part.type === "image"),
      ),
    ).toEqual([false, false, true]);
  });

  it("reserves the image budget for user attachments", () => {
    const messages = [
      {
        role: "user" as const,
        content: [{ type: "image" as const, data: "user-image", mimeType: "image/png" as const }],
        timestamp: 1,
      },
      ...["frame-1", "frame-2"].map((frameId) => ({
        role: "toolResult" as const,
        toolCallId: frameId,
        toolName: "computer_observe",
        content: [
          { type: "text" as const, text: frameId },
          { type: "image" as const, data: frameId, mimeType: "image/png" as const },
        ],
        details: { frameId },
        isError: false,
        timestamp: 1,
      })),
    ];

    const pruned = pruneComputerScreenshotContext(messages, 2);
    expect(
      pruned.map((message) =>
        (message as (typeof messages)[number]).content.some((part) => part.type === "image"),
      ),
    ).toEqual([true, false, true]);
  });

  it("rejects user images that exceed a configured model limit", () => {
    const messages = [
      {
        role: "user" as const,
        content: [
          { type: "image" as const, data: "user-image-1", mimeType: "image/png" as const },
          { type: "image" as const, data: "user-image-2", mimeType: "image/png" as const },
        ],
        timestamp: 1,
      },
    ];

    expect(() => pruneComputerScreenshotContext(messages, 1)).toThrow(
      "the prompt contains 2 non-screenshot images",
    );
  });

  it("does not apply the default screenshot retention to user images", () => {
    const messages = [
      {
        role: "user" as const,
        content: [
          { type: "image" as const, data: "user-image-1", mimeType: "image/png" as const },
          { type: "image" as const, data: "user-image-2", mimeType: "image/png" as const },
          { type: "image" as const, data: "user-image-3", mimeType: "image/png" as const },
        ],
        timestamp: 1,
      },
      ...["frame-1", "frame-2", "frame-3"].map((frameId) => ({
        role: "toolResult" as const,
        toolCallId: frameId,
        toolName: "computer_observe",
        content: [
          { type: "text" as const, text: frameId },
          { type: "image" as const, data: frameId, mimeType: "image/png" as const },
        ],
        details: { frameId },
        isError: false,
        timestamp: 1,
      })),
    ];

    const pruned = pruneComputerScreenshotContext(messages);
    expect(pruned[0]).toBe(messages[0]);
    expect((pruned[0] as (typeof messages)[number]).content).toHaveLength(3);
    expect(
      pruned
        .slice(1)
        .map((message) =>
          (message as (typeof messages)[number]).content.some((part) => part.type === "image"),
        ),
    ).toEqual([false, true, true]);
  });

  it("leaves a note where an older screenshot was removed and keeps the result text", () => {
    const messages = ["frame-1", "frame-2", "frame-3"].map((frameId) => ({
      role: "toolResult" as const,
      toolCallId: frameId,
      toolName: "computer_act",
      content: [
        { type: "text" as const, text: `${frameId} done` },
        { type: "image" as const, data: frameId, mimeType: "image/png" as const },
      ],
      details: { frameId },
      isError: false,
      timestamp: 1,
    }));

    const [oldest, ...latest] = pruneComputerScreenshotContext(messages);
    expect(oldest).toMatchObject({
      content: [
        { type: "text", text: "frame-1 done" },
        { type: "text", text: expect.stringContaining("Older screenshot removed") },
      ],
    });
    expect(latest).toEqual(messages.slice(1));
    expect(messages[0]?.content).toHaveLength(2);
  });

  it("reuses the message array when no screenshot needs pruning", () => {
    const messages = [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "hello" }],
        timestamp: 1,
      },
    ];

    expect(pruneComputerScreenshotContext(messages)).toBe(messages);
  });

  const screenshot = (frameId: string): Message => ({
    role: "toolResult",
    toolCallId: frameId,
    toolName: "computer_observe",
    content: [{ type: "image", data: frameId, mimeType: "image/png" }],
    details: { frameId },
    isError: false,
    timestamp: 1,
  });
  const userImage = (name: string): Message => ({
    role: "user",
    content: [{ type: "image", data: name, mimeType: "image/png" }],
    timestamp: 1,
  });
  const kept = (messages: Message[]) =>
    messages.map((message) =>
      Array.isArray(message.content)
        ? (message.content as Array<{ type: string }>).some((part) => part.type === "image")
        : false,
    );

  it.each([
    [undefined, undefined],
    [0, 0],
    [-3, 0],
    [1, 1],
    [2.9, 2],
    [1000, 1000],
    [Number.NaN, undefined],
    [Number.POSITIVE_INFINITY, undefined],
  ])("reads an image limit of %s as %s", (limit, expected) => {
    expect(normalizedImageLimit(limit)).toBe(expected);
  });

  it("keeps two screenshots on a rebuild even when the model allows more", () => {
    const messages = ["a", "b", "c", "d", "e"].map(screenshot);
    expect(kept(pruneComputerScreenshotContext(messages, 5))).toEqual([
      false,
      false,
      false,
      true,
      true,
    ]);
  });

  it("drops every screenshot under a zero-image limit and rejects any user image", () => {
    expect(kept(pruneComputerScreenshotContext(["a", "b"].map(screenshot), 0))).toEqual([
      false,
      false,
    ]);
    expect(() => pruneComputerScreenshotContext([userImage("u")], 0)).toThrow("image limit is 0");
  });

  it("accepts user images exactly at the limit and rejects one more", () => {
    const atLimit = [userImage("u1"), userImage("u2"), screenshot("a")];
    expect(kept(pruneComputerScreenshotContext(atLimit, 2))).toEqual([true, true, false]);
    expect(() => pruneComputerScreenshotContext([...atLimit, userImage("u3")], 2)).toThrow(
      "contains 3 non-screenshot images",
    );
  });

  it("treats a non-finite limit as no limit", () => {
    const messages = [
      userImage("u1"),
      userImage("u2"),
      userImage("u3"),
      ...["a", "b", "c"].map(screenshot),
    ];
    expect(kept(pruneComputerScreenshotContext(messages, Number.POSITIVE_INFINITY))).toEqual([
      true,
      true,
      true,
      false,
      true,
      true,
    ]);
  });

  it("prunes stale page state and screenshots together on a rebuild", () => {
    const page = (id: string): Message => ({
      role: "toolResult",
      toolCallId: id,
      toolName: "browser_snapshot",
      content: [{ type: "text", text: `${id} ${"x".repeat(1_200)}` }],
      isError: false,
      timestamp: 1,
    });
    const messages = [
      page("p1"),
      page("p2"),
      page("p3"),
      page("p4"),
      ...["a", "b", "c"].map(screenshot),
    ];
    const pruned = pruneForRebuild(messages);
    expect(JSON.stringify(pruned[0])).toContain("Earlier page state trimmed");
    expect(JSON.stringify(pruned.slice(1, 4))).not.toContain("Earlier page state trimmed");
    expect(kept(pruned.slice(4))).toEqual([false, true, true]);
    expect(pruneForRebuild(messages.slice(1, 4))).toEqual(messages.slice(1, 4));
  });
});
