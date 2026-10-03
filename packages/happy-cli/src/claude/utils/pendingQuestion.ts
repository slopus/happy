/**
 * Finds the question a local Claude Code session is currently blocked on.
 *
 * In local mode Happy never sees tool calls as they happen — Claude runs as a
 * separate binary in the terminal, so there is no `canUseTool` hook to
 * intercept. The transcript is the only record of what was asked.
 *
 * The transcript alone cannot say whether a question is *still* open, though.
 * An `AskUserQuestion` that was answered gets a `tool_result`, and one the user
 * ESC-interrupted gets one too (`is_error: true`) — but a session that simply
 * moved on can leave a `tool_use` with no result at all. Measured over a day of
 * real transcripts, two of three such orphans were stale: the session had
 * written 86 and 4047 further entries past them. Treating "no tool_result" as
 * "waiting" would therefore misjudge most of them, and a question published on
 * that basis would never be withdrawn.
 *
 * So liveness is decided elsewhere — by the session status file, which reports
 * `waiting` + `waitingFor: "input needed"` and discards leftovers from dead
 * processes (see claudeStatusWatcher). This module answers only the second
 * question: *which* question is open. Callers must read it when that status
 * flips, not on a timer, both because it is the wrong authority and because
 * this reads the whole transcript, which can be very large.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "@/ui/logger";
import { getProjectPath } from "./path";

/** One question as Claude Code writes it into the tool input. */
export interface PendingQuestionAsked {
  /** Provider tool-use id, which the app joins its answer card to. */
  toolUseId: string;
  /** Raw `AskUserQuestion` input, forwarded to the app unchanged. */
  input: Record<string, unknown>;
}

interface ToolUseBlock {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
}

const ASK_USER_QUESTION = "AskUserQuestion";

/**
 * Read the transcript for `sessionId` and return the last `AskUserQuestion`
 * that has no `tool_result`, or null when there is none.
 *
 * "Last" matters: a session can accumulate several answered questions, and only
 * the most recent unresolved one can be the one Claude is blocked on now.
 */
export async function findPendingQuestion(
  workingDirectory: string,
  sessionId: string,
): Promise<PendingQuestionAsked | null> {
  const file = join(getProjectPath(workingDirectory), `${sessionId}.jsonl`);
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch {
    // No transcript yet (Claude Code writes it lazily on the first prompt), or
    // it is unreadable. Either way there is no question to forward.
    return null;
  }

  const asked = new Map<string, Record<string, unknown>>();
  const resolved = new Set<string>();

  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let parsed: { message?: { content?: unknown } };
    try {
      parsed = JSON.parse(line);
    } catch {
      // A partially flushed final line is normal while Claude is writing.
      continue;
    }
    const content = parsed.message?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content as ToolUseBlock[]) {
      if (
        block?.type === "tool_use" &&
        block.name === ASK_USER_QUESTION &&
        typeof block.id === "string" &&
        block.input !== null &&
        typeof block.input === "object"
      ) {
        asked.set(block.id, block.input as Record<string, unknown>);
      } else if (
        block?.type === "tool_result" &&
        typeof block.tool_use_id === "string"
      ) {
        // Counts whether the answer succeeded or the user interrupted with ESC
        // (`is_error: true`): either way Claude is no longer blocked on it.
        resolved.add(block.tool_use_id);
      }
    }
  }

  // Map iteration is insertion-ordered, so the last unresolved entry is the
  // most recent one in the file.
  let pending: PendingQuestionAsked | null = null;
  for (const [toolUseId, input] of asked) {
    if (!resolved.has(toolUseId)) {
      pending = { toolUseId, input };
    }
  }

  if (!pending) {
    logger.debug(
      `[PendingQuestion] status says a question is open but none is unresolved in ${sessionId}`,
    );
  }
  return pending;
}
