import type { MessagingInboundMessage } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { prefersTeamChatSurface, settleWithTimeout } from "./team-chat-startup.js";

function message(overrides: Partial<MessagingInboundMessage> = {}): MessagingInboundMessage {
  return {
    type: "message",
    provider: "slack",
    handle: "Ev-1",
    threadId: "C-1",
    isDirect: true,
    from: "U-1",
    fromLabel: "Ada",
    channelName: null,
    participants: [],
    content: "hello",
    mediaUrl: null,
    workspaceId: "T-1",
    conversationKey: "im:U-1",
    kind: "direct",
    ...overrides,
  };
}

describe("team chat startup helpers", () => {
  it("prefers TeamChat for configured workspace surfaces", () => {
    expect(prefersTeamChatSurface(message({ isDirect: false }), "bot-1")).toBe(true);
    expect(
      prefersTeamChatSurface(
        message({ isDirect: false, provider: "teamchat-emulator", workspaceId: undefined }),
        "bot-1",
      ),
    ).toBe(true);
    expect(prefersTeamChatSurface(message(), "bot-1")).toBe(false);
    expect(
      prefersTeamChatSurface(message({ provider: "sendblue", workspaceId: undefined }), "bot-1"),
    ).toBe(false);
    expect(prefersTeamChatSurface(message({ isDirect: false }), undefined)).toBe(false);
  });

  it("settles once the task ends, whether it succeeds or fails", async () => {
    await expect(settleWithTimeout(undefined, 1_000)).resolves.toBe("done");
    await expect(settleWithTimeout(Promise.resolve(), 1_000)).resolves.toBe("done");
    await expect(settleWithTimeout(Promise.reject(new Error("failed")), 1_000)).resolves.toBe(
      "done",
    );
  });

  it("bounds settlement when the task stays blocked", async () => {
    vi.useFakeTimers();
    try {
      let resolveTask: (() => void) | undefined;
      const task = new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
      const settled = settleWithTimeout(task, 1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(settled).resolves.toBe("timeout");
      resolveTask?.();
    } finally {
      vi.useRealTimers();
    }
  });
});
