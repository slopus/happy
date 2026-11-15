import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";

const mocks = vi.hoisted(() => ({
  messageBot: vi.fn(async (..._args: unknown[]) => ({
    ok: true as const,
    botId: "bot-servo",
    name: "Servo",
    note: "Sent",
  })),
  handoffToGroupBot: vi.fn(async (..._args: unknown[]) => ({ ok: true as const })),
  readWorkspaceFile: vi.fn(async (..._args: unknown[]) => ({
    bytes: new Uint8Array([1]),
  })) as ReturnType<typeof vi.fn>,
  saveWorkspaceFile: vi.fn(async (..._args: unknown[]) => ({
    artifactId: "artifact-zip",
    block: {
      kind: "file" as const,
      artifactId: "artifact-zip",
      name: "site.zip",
      mimeType: "application/zip",
      size: 19_000,
    },
  })),
}));
vi.mock("./bot-messages.js", () => ({ messageBot: mocks.messageBot }));
vi.mock("./group-handoff.js", () => ({ handoffToGroupBot: mocks.handoffToGroupBot }));
vi.mock("./run-tools-files.js", () => ({
  readWorkspaceFile: mocks.readWorkspaceFile,
  saveWorkspaceFile: mocks.saveWorkspaceFile,
}));

const { messagingTools } = await import("./run-tools-messaging.js");

function callWith(name: string, args: Record<string, unknown>) {
  return {
    name,
    args: { bot_id: "bot-servo", message: "deploy this", ...args },
    executionId: "exec-1",
    effectKey: "effect-1",
    finish: async (result: unknown) => result,
  } as unknown as ToolCall;
}

function context(servoComputerId: string) {
  const listFiles = vi.fn(async (_computer: unknown, path: string) =>
    path === "bots/bot-coder" ? [{ path: "bots/bot-coder/site", kind: "directory" }] : [],
  );
  const findMany = vi.fn(async (..._args: unknown[]) => [
    { id: "bot-coder", name: "Coder", computerId: "computer-team", computerSwitching: false },
    { id: "bot-servo", name: "Servo", computerId: servoComputerId, computerSwitching: false },
  ]);
  const ctx = {
    deps: { prisma: { bot: { findMany } }, sandbox: { listFiles } },
    run: { id: "run-1", spaceId: "space-1", userId: "user-1", threadId: "thread-1" },
    bot: { id: "bot-coder", name: "Coder", computerId: "computer-team", computerSwitching: false },
    thread: { id: "thread-1", groupId: "group-1" },
    computer: { mode: "team", get: vi.fn(async () => ({ id: "computer-team" })) },
    context: {},
    secrets: [],
    state: {},
  } as unknown as RunContext;
  return { ctx, listFiles, findMany };
}

describe("sending files to another bot", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses more files than one message can carry before reading any", async () => {
    const { ctx, listFiles } = context("computer-team");
    await expect(
      messagingTools.message_bot!(
        ctx,
        callWith("message_bot", { files: ["a", "b", "c", "d", "e"] }),
      ),
    ).resolves.toEqual({ error: "send at most 4 files; zip the rest into one file" });
    expect(listFiles).not.toHaveBeenCalled();
    expect(mocks.messageBot).not.toHaveBeenCalled();
  });

  it("refuses a files value that is not a list of paths", async () => {
    const { ctx } = context("computer-team");
    for (const files of ["site.zip", [""], [3]]) {
      await expect(
        messagingTools.message_bot!(ctx, callWith("message_bot", { files })),
      ).resolves.toEqual({ error: "files must be a list of file paths" });
    }
    expect(mocks.messageBot).not.toHaveBeenCalled();
  });

  it("passes paths on a shared computer instead of copying them", async () => {
    const { ctx } = context("computer-team");
    await messagingTools.message_bot!(ctx, callWith("message_bot", { files: ["site"] }));
    expect(mocks.readWorkspaceFile).not.toHaveBeenCalled();
    expect(mocks.saveWorkspaceFile).not.toHaveBeenCalled();
    expect(mocks.messageBot).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        message: "deploy this\n\nFiles on our shared computer:\n- bots/bot-coder/site",
        files: [],
      }),
    );
  });

  it("hands off shared paths to a member of the group", async () => {
    const { ctx, findMany } = context("computer-team");
    await messagingTools.handoff_to_bot!(ctx, callWith("handoff_to_bot", { files: ["site"] }));
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ groupMembers: { some: { groupId: "group-1" } } }),
      }),
    );
    expect(mocks.handoffToGroupBot).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "group-1",
      expect.objectContaining({
        message: "deploy this\n\nFiles on our shared computer:\n- bots/bot-coder/site",
        files: [],
      }),
    );
  });

  it("refuses a shared path that does not exist", async () => {
    const { ctx } = context("computer-team");
    await expect(
      messagingTools.message_bot!(ctx, callWith("message_bot", { files: ["missing"] })),
    ).resolves.toEqual({ error: "missing: not found. Nothing was sent." });
    expect(mocks.messageBot).not.toHaveBeenCalled();
  });

  it("copies files for a bot with its own computer", async () => {
    const { ctx, listFiles } = context("computer-servo");
    await messagingTools.message_bot!(ctx, callWith("message_bot", { files: ["site.zip"] }));
    expect(listFiles).not.toHaveBeenCalled();
    // Filed under Servo's chat, where the copy is shown.
    expect(mocks.saveWorkspaceFile).toHaveBeenCalledWith(
      ctx,
      expect.anything(),
      "site.zip",
      expect.any(Uint8Array),
      { botId: "bot-servo" },
    );
    expect(mocks.messageBot).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        message: "deploy this",
        files: [expect.objectContaining({ artifactId: "artifact-zip" })],
      }),
    );
  });

  it("asks for a zip when a copy cannot be made of a folder", async () => {
    const { ctx } = context("computer-servo");
    mocks.readWorkspaceFile.mockResolvedValueOnce({ error: "file not found or unreadable" });
    await expect(
      messagingTools.message_bot!(ctx, callWith("message_bot", { files: ["site"] })),
    ).resolves.toEqual({
      error: "site: file not found or unreadable; zip it and send the zip. Nothing was sent.",
    });
    expect(mocks.messageBot).not.toHaveBeenCalled();
  });

  it("saves nothing when any file cannot be read", async () => {
    const { ctx } = context("computer-servo");
    mocks.readWorkspaceFile
      .mockResolvedValueOnce({ bytes: new Uint8Array([1]) })
      .mockResolvedValueOnce({ error: "unsupported attachment type" });
    await expect(
      messagingTools.message_bot!(ctx, callWith("message_bot", { files: ["site.zip", "app.ts"] })),
    ).resolves.toEqual({
      error: "app.ts: unsupported attachment type; zip it and send the zip. Nothing was sent.",
    });
    expect(mocks.saveWorkspaceFile).not.toHaveBeenCalled();
    expect(mocks.messageBot).not.toHaveBeenCalled();
  });

  it("reads nothing for a recipient it cannot find", async () => {
    const { ctx } = context("computer-servo");
    await expect(
      messagingTools.message_bot!(
        ctx,
        callWith("message_bot", { bot_id: "bot-gone", files: ["site.zip"] }),
      ),
    ).resolves.toEqual({ error: "no bot found with that id or name. Nothing was sent." });
    expect(mocks.readWorkspaceFile).not.toHaveBeenCalled();
  });

  it("files a handoff's copies under the group that shows them", async () => {
    const { ctx } = context("computer-servo");
    (ctx.thread as { groupId: string | null }).groupId = null;
    await messagingTools.handoff_to_bot!(
      ctx,
      callWith("handoff_to_bot", { group_id: "group-2", files: ["site.zip"] }),
    );
    expect(mocks.saveWorkspaceFile).toHaveBeenCalledWith(
      ctx,
      expect.anything(),
      "site.zip",
      expect.any(Uint8Array),
      { botId: "bot-coder", groupId: "group-2" },
    );
  });

  it("delivers to the bot the files were prepared for, by id", async () => {
    const { ctx } = context("computer-team");
    await messagingTools.message_bot!(
      ctx,
      callWith("message_bot", { bot_id: undefined, confirm_name: "servo", files: ["site"] }),
    );
    expect(mocks.messageBot).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ bot_id: "bot-servo", confirm_name: undefined }),
    );
  });

  it("refuses to share a path that holds a secret", async () => {
    const { ctx, listFiles } = context("computer-team");
    listFiles.mockResolvedValueOnce([
      { path: "bots/bot-coder/sk-live-1234567890", kind: "directory" },
    ]);
    (ctx as { secrets: string[] }).secrets = ["sk-live-1234567890"];
    await expect(
      messagingTools.message_bot!(ctx, callWith("message_bot", { files: ["sk-live-1234567890"] })),
    ).resolves.toEqual({
      error: "one of the paths can't be shared. Nothing was sent.",
    });
    expect(mocks.messageBot).not.toHaveBeenCalled();
  });

  it("sends an empty file list as a plain message without touching the computer", async () => {
    const { ctx, findMany } = context("computer-team");
    await messagingTools.message_bot!(ctx, callWith("message_bot", { files: [] }));
    expect(findMany).not.toHaveBeenCalled();
    expect(ctx.computer.get).not.toHaveBeenCalled();
    expect(mocks.messageBot).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ message: "deploy this", files: [] }),
    );
  });

  it("reports an unreachable computer instead of failing the call", async () => {
    const { ctx } = context("computer-team");
    vi.mocked(ctx.computer.get).mockRejectedValueOnce(new Error("boot failed"));
    await expect(
      messagingTools.message_bot!(ctx, callWith("message_bot", { files: ["site"] })),
    ).resolves.toEqual({ error: "could not reach your computer. Nothing was sent." });
    expect(mocks.messageBot).not.toHaveBeenCalled();
  });

  it("refuses a blank message even when shared paths would fill it", async () => {
    const { ctx, listFiles } = context("computer-team");
    for (const tool of ["message_bot", "handoff_to_bot"] as const) {
      await expect(
        messagingTools[tool]!(ctx, callWith(tool, { message: "  ", files: ["site"] })),
      ).resolves.toEqual({ error: "message is required" });
    }
    expect(listFiles).not.toHaveBeenCalled();
    expect(mocks.messageBot).not.toHaveBeenCalled();
    expect(mocks.handoffToGroupBot).not.toHaveBeenCalled();
  });

  it("refuses an oversized message before copying any file", async () => {
    const { ctx } = context("computer-servo");
    for (const tool of ["message_bot", "handoff_to_bot"] as const) {
      await expect(
        messagingTools[tool]!(
          ctx,
          callWith(tool, { message: "x".repeat(8_001), files: ["site.zip"] }),
        ),
      ).resolves.toEqual({
        error:
          "message exceeds the 8000 character limit. Nothing was sent. Save long content to a file and send it with files instead of splitting it across messages.",
      });
    }
    expect(mocks.readWorkspaceFile).not.toHaveBeenCalled();
    expect(mocks.saveWorkspaceFile).not.toHaveBeenCalled();
    expect(mocks.messageBot).not.toHaveBeenCalled();
    expect(mocks.handoffToGroupBot).not.toHaveBeenCalled();
  });

  it("refuses a message the shared file list would push over the limit", async () => {
    const { ctx } = context("computer-team");
    const list = "\n\nFiles on our shared computer:\n- bots/bot-coder/site";
    const room = 8_000 - list.length;
    await expect(
      messagingTools.message_bot!(
        ctx,
        callWith("message_bot", { message: "x".repeat(room + 1), files: ["site"] }),
      ),
    ).resolves.toEqual({
      error: `with the file list added, the message must stay under ${room} characters. Nothing was sent.`,
    });
    await messagingTools.message_bot!(
      ctx,
      callWith("message_bot", { message: "x".repeat(room), files: ["site"] }),
    );
    expect(mocks.messageBot).toHaveBeenCalledTimes(1);
  });

  it("names an unreadable computer as well as a wrong path when listing fails", async () => {
    const { ctx, listFiles } = context("computer-team");
    listFiles.mockRejectedValueOnce(new Error("timed out"));
    await expect(
      messagingTools.message_bot!(ctx, callWith("message_bot", { files: ["site"] })),
    ).resolves.toEqual({
      error: "site: not found, or your computer could not be read. Nothing was sent.",
    });
  });
});
