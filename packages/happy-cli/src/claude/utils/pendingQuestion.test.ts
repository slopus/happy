import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { findPendingQuestion } from "./pendingQuestion";
import { getProjectPath } from "./path";

const SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** One transcript line carrying an AskUserQuestion tool call. */
const ask = (toolUseId: string, question: string) =>
  JSON.stringify({
    type: "assistant",
    uuid: `u-${toolUseId}`,
    message: {
      content: [
        {
          type: "tool_use",
          id: toolUseId,
          name: "AskUserQuestion",
          input: { questions: [{ question, header: "H", options: [] }] },
        },
      ],
    },
  });

/** The tool_result that closes one out. `isError` covers the ESC-interrupt case. */
const result = (toolUseId: string, isError = false) =>
  JSON.stringify({
    type: "user",
    uuid: `r-${toolUseId}`,
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          is_error: isError,
          content: isError ? "The user doesn't want to proceed" : "answered",
        },
      ],
    },
  });

describe("findPendingQuestion", () => {
  let workingDir: string;
  let configDir: string;
  let projectDir: string;
  let prevConfigDir: string | undefined;

  const writeTranscript = (lines: string[]) =>
    writeFile(join(projectDir, `${SESSION_ID}.jsonl`), lines.join("\n") + "\n");

  beforeEach(async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    workingDir = join(tmpdir(), `pq-work-${unique}`);
    await mkdir(workingDir, { recursive: true });

    // Isolate CLAUDE_CONFIG_DIR before deriving the project path, since
    // getProjectPath() reads it — otherwise these tests write into the
    // developer's real ~/.claude/projects.
    configDir = join(tmpdir(), `pq-config-${unique}`);
    prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;

    projectDir = getProjectPath(workingDir);
    await mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    if (prevConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    }
    for (const dir of [workingDir, configDir]) {
      if (existsSync(dir)) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("finds an unresolved question and returns its raw input", async () => {
    await writeTranscript([ask("toolu_1", "Which storage?")]);

    const pending = await findPendingQuestion(workingDir, SESSION_ID);
    expect(pending?.toolUseId).toBe("toolu_1");
    expect((pending?.input as any).questions[0].question).toBe(
      "Which storage?",
    );
  });

  it("ignores a question that was answered", async () => {
    await writeTranscript([
      ask("toolu_1", "Which storage?"),
      result("toolu_1"),
    ]);

    expect(await findPendingQuestion(workingDir, SESSION_ID)).toBeNull();
  });

  // An ESC interrupt still writes a tool_result, just with is_error set. Claude
  // is no longer blocked, so this must not be reported as open — otherwise the
  // phone would offer to answer something that was already abandoned.
  it("ignores a question the user interrupted with ESC", async () => {
    await writeTranscript([
      ask("toolu_1", "Which storage?"),
      result("toolu_1", true),
    ]);

    expect(await findPendingQuestion(workingDir, SESSION_ID)).toBeNull();
  });

  // This is the case that decides the whole design. A transcript can carry an
  // orphan tool_use with no result that the session simply moved past — two of
  // three real orphans measured were like this, with 86 and 4047 further
  // entries written after them. That is why the status file, not this function,
  // decides whether a question is still open: on its own, "last unresolved" is
  // the best available guess, and it must not be treated as proof.
  it("returns the most recent unresolved question, not an older orphan", async () => {
    await writeTranscript([
      ask("toolu_stale", "An abandoned question"),
      ask("toolu_answered", "Answered later"),
      result("toolu_answered"),
      ask("toolu_current", "The one Claude is blocked on"),
    ]);

    const pending = await findPendingQuestion(workingDir, SESSION_ID);
    expect(pending?.toolUseId).toBe("toolu_current");
  });

  it("returns null when the transcript does not exist yet", async () => {
    expect(await findPendingQuestion(workingDir, SESSION_ID)).toBeNull();
  });

  it("survives a partially written final line", async () => {
    await writeFile(
      join(projectDir, `${SESSION_ID}.jsonl`),
      ask("toolu_1", "Which storage?") + '\n{"message":{"content":[{"typ',
    );

    const pending = await findPendingQuestion(workingDir, SESSION_ID);
    expect(pending?.toolUseId).toBe("toolu_1");
  });

  it("ignores tool calls that are not AskUserQuestion", async () => {
    await writeTranscript([
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "toolu_bash", name: "Bash", input: {} },
          ],
        },
      }),
    ]);

    expect(await findPendingQuestion(workingDir, SESSION_ID)).toBeNull();
  });
});
