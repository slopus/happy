import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  isPiSessionRecordingEnabled,
  PI_SESSION_MAX_FILES_PER_BOT,
  PI_SESSION_RETENTION_DAYS,
  PiJsonlSessionRecorder,
  piSessionBotRoot,
  piSessionsRoot,
  piSessionUserRoot,
  prunePiSessionFiles,
  removePiBotSessions,
  removePiUserSessions,
  resolvePiSessionRoot,
} from "./pi-session.js";

async function readFiles(root: string): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const contents = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(root, entry.name);
      return entry.isDirectory() ? readFiles(target) : readFile(target, "utf8");
    }),
  );
  return contents.join("\n");
}

describe("Pi JSONL sessions", () => {
  it("keeps session recording opt-in and off by default", () => {
    expect(isPiSessionRecordingEnabled({})).toBe(false);
    expect(isPiSessionRecordingEnabled({ PI_SESSION_RECORDING: "false" })).toBe(false);
    expect(isPiSessionRecordingEnabled({ PI_SESSION_RECORDING: "1" })).toBe(false);
    expect(isPiSessionRecordingEnabled({ PI_SESSION_RECORDING: "true" })).toBe(true);
    expect(resolvePiSessionRoot("/data", {})).toBeUndefined();
    expect(resolvePiSessionRoot("/data", { PI_SESSION_RECORDING: "false" })).toBeUndefined();
    expect(resolvePiSessionRoot("/data", { PI_SESSION_RECORDING: "true" })).toBe(
      piSessionsRoot("/data"),
    );
  });

  it("uses Pi's session format for context and completed messages", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rakazo-pi-session-"));
    try {
      const recorder = new PiJsonlSessionRecorder(path.join(root, "sessions"), root);
      const session = await recorder.start({
        runId: "run-1",
        threadId: "thread-1",
        botId: "bot-1",
        userId: "user-1",
        traceId: "trace-1",
        provider: "openai-compatible",
        model: "qwen-test",
        thinkingLevel: "medium",
        systemPrompt: "Be concise.",
        initialMessages: [{ role: "user", content: "prior", timestamp: 1 }],
      });
      await session.appendMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I should answer." },
          { type: "text", text: "done" },
        ],
        api: "openai-completions",
        provider: "openai-compatible",
        model: "qwen-test",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        rawStopReason: "eos",
        timestamp: 2,
      } satisfies AgentMessage);

      const raw = await readFiles(path.join(root, "sessions"));
      const records = raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => JSON.parse(line));
      expect(records).toContainEqual(
        expect.objectContaining({
          kind: "entry",
          customType: "rakazo_context",
          data: expect.objectContaining({
            rakazoThreadId: "thread-1",
            rakazoTraceId: "trace-1",
          }),
        }),
      );
      expect(records[0]).toMatchObject({
        v: 4,
        kind: "header",
        id: "run-1",
        storageVersion: 1,
      });
      const entries = records.filter((record) => record.kind === "entry");
      expect(entries.map((entry) => entry.type)).toEqual(["custom", "message", "message"]);
      expect(entries.map((entry) => entry.parentId)).toEqual([null, entries[0].id, entries[1].id]);
      expect(records.slice(1).map((record) => record.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(records.at(-1)).toMatchObject({
        kind: "value",
        namespace: "pi.branch.tip",
        key: "main",
        value: entries[2].id,
      });
      expect(raw).toContain("Be concise.");
      expect(raw).toContain("prior");
      expect(raw).toContain("I should answer.");
      expect(raw).toContain("rawStopReason");
      expect(raw).toContain("eos");
      expect(
        await readFiles(piSessionBotRoot(path.join(root, "sessions"), "user-1", "bot-1")),
      ).toContain("run-1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never recreates a transcript deleted during a session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rakazo-pi-session-"));
    try {
      const session = await new PiJsonlSessionRecorder(root, root).start({
        runId: "run-1",
        threadId: "thread-1",
        botId: "bot-1",
        userId: "user-1",
        provider: "openai-compatible",
        model: "test-model",
        thinkingLevel: "off",
        systemPrompt: "Be concise.",
        initialMessages: [],
      });
      const botRoot = piSessionBotRoot(root, "user-1", "bot-1");
      const [file] = await readdir(botRoot);
      expect(file).toBeDefined();
      await rm(path.join(botRoot, file!));

      await session.appendMessage({ role: "user", content: "later", timestamp: 1 });
      await session.appendMessage({ role: "user", content: "again", timestamp: 2 });

      expect(await readdir(botRoot)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("protects the session being started from the retention count limit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rakazo-pi-retention-"));
    try {
      const botRoot = piSessionBotRoot(root, "user-1", "bot-1");
      await mkdir(botRoot, { recursive: true });
      // Newer timestamps force the new session past the count limit without protection.
      const future = new Date(Date.now() + 60_000);
      await Promise.all(
        Array.from({ length: PI_SESSION_MAX_FILES_PER_BOT }, async (_, index) => {
          const file = path.join(botRoot, `existing-${index}.jsonl`);
          await writeFile(file, "{}\n");
          await utimes(file, future, future);
        }),
      );
      await new PiJsonlSessionRecorder(root, root).start({
        runId: "run-new",
        threadId: "thread-1",
        botId: "bot-1",
        userId: "user-1",
        provider: "openai-compatible",
        model: "test-model",
        thinkingLevel: "off",
        systemPrompt: "Be concise.",
        initialMessages: [],
      });

      expect(await readdir(botRoot)).toHaveLength(PI_SESSION_MAX_FILES_PER_BOT);
      const raw = await readFiles(botRoot);
      expect(raw).toContain('"kind":"header","id":"run-new"');
      expect(raw).toContain('"customType":"rakazo_context"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps sessions scoped and bounded by the retention policy", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rakazo-pi-retention-"));
    try {
      const sessionsRoot = path.join(root, "sessions");
      const botRoot = piSessionBotRoot(sessionsRoot, "user-1", "bot-1");
      const otherBotRoot = piSessionBotRoot(sessionsRoot, "user-1", "bot-2");
      const now = Date.now();
      await mkdir(botRoot, { recursive: true });
      await mkdir(otherBotRoot, { recursive: true });
      const old = path.join(botRoot, "old.jsonl");
      const newest = path.join(botRoot, "newest.jsonl");
      const middle = path.join(botRoot, "middle.jsonl");
      const overflow = path.join(botRoot, "overflow.jsonl");
      await Promise.all(
        [old, newest, middle, overflow].map((filePath) => writeFile(filePath, "{}\n")),
      );
      await Promise.all([
        utimes(old, new Date(now - 2_000), new Date(now - 2_000)),
        utimes(newest, new Date(now - 100), new Date(now - 100)),
        utimes(middle, new Date(now - 200), new Date(now - 200)),
        utimes(overflow, new Date(now - 300), new Date(now - 300)),
      ]);

      await prunePiSessionFiles(botRoot, { now, maxAgeMs: 1_000, maxFiles: 2 });

      await expect(readFile(old)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(overflow)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(newest, "utf8")).resolves.toBe("{}\n");
      await expect(readFile(middle, "utf8")).resolves.toBe("{}\n");
      expect(await readdir(piSessionUserRoot(sessionsRoot, "user-1"))).toHaveLength(2);
      expect(PI_SESSION_RETENTION_DAYS).toBe(30);
      expect(PI_SESSION_MAX_FILES_PER_BOT).toBe(100);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes bot and account session scopes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rakazo-pi-cleanup-"));
    try {
      const sessionsRoot = path.join(root, "pi-sessions");
      const botRoot = piSessionBotRoot(sessionsRoot, "user-1", "bot-1");
      const otherBotRoot = piSessionBotRoot(sessionsRoot, "user-1", "bot-2");
      await mkdir(botRoot, { recursive: true });
      await mkdir(otherBotRoot, { recursive: true });
      await writeFile(path.join(botRoot, "session.jsonl"), "{}\n");
      await writeFile(path.join(otherBotRoot, "session.jsonl"), "{}\n");

      await removePiBotSessions(root, "user-1", "bot-1");
      await expect(readdir(botRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readdir(otherBotRoot)).resolves.toHaveLength(1);

      await removePiUserSessions(root, "user-1");
      await expect(readdir(piSessionUserRoot(sessionsRoot, "user-1"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
