import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { startClaudeStatusWatcher } from "./claudeStatusWatcher";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Find a pid that is definitely not running.
 *
 * Do not hardcode a low pid (111 and friends): on another machine, or after a
 * reboot, it may be a real system process, which flips the liveness ordering
 * and makes these tests flaky. Probing at runtime is deterministic.
 */
const findDeadPid = (): number => {
  for (const candidate of [4194303, 999983, 888887, 777769, 666649]) {
    try {
      process.kill(candidate, 0);
    } catch (error: any) {
      // EPERM means the process exists but is not ours, so it is not dead.
      if (error?.code !== "EPERM") {
        return candidate;
      }
    }
  }
  throw new Error("no reliably dead pid found; cannot test liveness ordering");
};

/**
 * These tests pin down the core semantics of claudeStatusWatcher, as observed
 * against Claude Code 2.1.220 (see that module's header comment).
 *
 * The rule running through all of them: any uncertainty must resolve to false.
 * Missing a spinner is acceptable; getting stuck showing "working" is not,
 * because that is worse than the bug being fixed.
 */
describe("startClaudeStatusWatcher", () => {
  let configDir: string;
  let sessionsDir: string;
  let stop: (() => void) | null = null;
  let prevConfigDir: string | undefined;

  const SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const DEAD_PID = findDeadPid();

  // Write a session status file in Claude Code's shape.
  const writeSessionFile = (
    pid: number,
    status: string,
    sessionId = SESSION_ID,
  ) =>
    writeFile(
      join(sessionsDir, `${pid}.json`),
      JSON.stringify({
        pid,
        sessionId,
        status,
        cwd: "/tmp",
        statusUpdatedAt: Date.now(),
      }),
    );

  beforeEach(async () => {
    configDir = join(
      tmpdir(),
      `csw-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    sessionsDir = join(configDir, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });

  afterEach(async () => {
    if (stop) {
      stop();
      stop = null;
    }
    if (prevConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    }
    if (existsSync(configDir)) {
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it("reports thinking=true on busy and resets when it returns to idle", async () => {
    await writeSessionFile(DEAD_PID, "idle");
    const changes: boolean[] = [];
    stop = startClaudeStatusWatcher({
      getSessionId: () => SESSION_ID,
      onThinkingChange: (t) => {
        changes.push(t);
      },
      pollIntervalMs: 30,
    });

    await sleep(120);
    expect(changes).toEqual([]); // steady idle must not emit any change

    await writeSessionFile(DEAD_PID, "busy");
    await sleep(150);
    expect(changes).toEqual([true]);

    // This is exactly what an ESC interrupt looks like: status returns to idle.
    await writeSessionFile(DEAD_PID, "idle");
    await sleep(150);
    expect(changes).toEqual([true, false]);
  });

  it("reports only on change, so sustained busy is not re-emitted", async () => {
    await writeSessionFile(DEAD_PID, "busy");
    const changes: boolean[] = [];
    stop = startClaudeStatusWatcher({
      getSessionId: () => SESSION_ID,
      onThinkingChange: (t) => {
        changes.push(t);
      },
      pollIntervalMs: 20,
    });

    await sleep(200);
    expect(changes).toEqual([true]);
  });

  // `shell` is one of the four values Claude Code can write. It was observed
  // once in a real session, holding for several minutes before returning to
  // `busy` on its own, but its meaning is still unverified — and anything whose
  // semantics we cannot pin down has to count as not working, or the phone
  // risks showing "working" forever.
  it("treats a status of unverified meaning (shell) as not working", async () => {
    await writeSessionFile(DEAD_PID, "busy");
    const changes: boolean[] = [];
    stop = startClaudeStatusWatcher({
      getSessionId: () => SESSION_ID,
      onThinkingChange: (t) => {
        changes.push(t);
      },
      pollIntervalMs: 20,
    });
    await sleep(120);
    expect(changes).toEqual([true]);

    await writeSessionFile(DEAD_PID, "shell");
    await sleep(150);
    expect(changes).toEqual([true, false]);
  });

  // `waiting` means Claude is blocked on the user — the same file reads
  // `waitingFor: "input needed"` while an AskUserQuestion prompt is open. It is
  // genuinely not computing then, so false here is the semantically correct
  // answer rather than merely the safe one.
  it("treats waiting (blocked on the user) as not working", async () => {
    await writeSessionFile(DEAD_PID, "busy");
    const changes: boolean[] = [];
    stop = startClaudeStatusWatcher({
      getSessionId: () => SESSION_ID,
      onThinkingChange: (t) => {
        changes.push(t);
      },
      pollIntervalMs: 20,
    });
    await sleep(120);
    expect(changes).toEqual([true]);

    await writeFile(
      join(sessionsDir, `${DEAD_PID}.json`),
      JSON.stringify({
        pid: DEAD_PID,
        sessionId: SESSION_ID,
        status: "waiting",
        waitingFor: "input needed",
        cwd: "/tmp",
        statusUpdatedAt: Date.now(),
      }),
    );
    await sleep(150);
    expect(changes).toEqual([true, false]);

    // And it resumes as soon as the user answers.
    await writeSessionFile(DEAD_PID, "busy");
    await sleep(150);
    expect(changes).toEqual([true, false, true]);
  });

  // A question that is no longer open must never stay published, so this signal
  // has to fall back to false from every path the thinking signal does.
  describe("waitingForInput", () => {
    const writeWaiting = (waitingFor: string | null) =>
      writeFile(
        join(sessionsDir, `${DEAD_PID}.json`),
        JSON.stringify({
          pid: DEAD_PID,
          sessionId: SESSION_ID,
          status: "waiting",
          ...(waitingFor === null ? {} : { waitingFor }),
          cwd: "/tmp",
          statusUpdatedAt: Date.now(),
        }),
      );

    const track = (getSessionId: () => string | null = () => SESSION_ID) => {
      const waiting: boolean[] = [];
      const dispose = startClaudeStatusWatcher({
        getSessionId,
        onThinkingChange: () => {},
        onWaitingForInputChange: (w) => {
          waiting.push(w);
        },
        pollIntervalMs: 20,
      });
      stop = dispose;
      return { waiting, dispose };
    };

    it("reports true only while an answer is awaited", async () => {
      await writeSessionFile(DEAD_PID, "busy");
      const { waiting } = track();
      await sleep(120);
      expect(waiting).toEqual([]);

      await writeWaiting("input needed");
      await sleep(150);
      expect(waiting).toEqual([true]);

      // The user answered, so Claude is computing again.
      await writeSessionFile(DEAD_PID, "busy");
      await sleep(150);
      expect(waiting).toEqual([true, false]);
    });

    // The other documented `waitingFor` values also mean "blocked on the user",
    // but they are not questions we can forward. Publishing one would leave the
    // phone offering to answer something Claude never asked.
    it("ignores a waiting state that is not a question", async () => {
      const { waiting } = track();
      await writeWaiting("permission prompt");
      await sleep(150);
      expect(waiting).toEqual([]);

      await writeWaiting("dialog open");
      await sleep(150);
      expect(waiting).toEqual([]);
    });

    it("ignores waiting with no discriminant at all", async () => {
      const { waiting } = track();
      await writeWaiting(null);
      await sleep(150);
      expect(waiting).toEqual([]);
    });

    it("does not re-report while the same question stays open", async () => {
      const { waiting } = track();
      await writeWaiting("input needed");
      await sleep(200);
      expect(waiting).toEqual([true]);
    });

    it("resets when the session id changes", async () => {
      let currentId: string | null = SESSION_ID;
      const { waiting } = track(() => currentId);
      await writeWaiting("input needed");
      await sleep(150);
      expect(waiting).toEqual([true]);

      currentId = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
      await sleep(150);
      expect(waiting).toEqual([true, false]);
    });

    it("resets when the status file vanishes", async () => {
      const { waiting } = track();
      await writeWaiting("input needed");
      await sleep(150);
      expect(waiting).toEqual([true]);

      await unlink(join(sessionsDir, `${DEAD_PID}.json`));
      await sleep(300);
      expect(waiting).toEqual([true, false]);
    });

    it("resets on stop", async () => {
      const { waiting, dispose } = track();
      await writeWaiting("input needed");
      await sleep(150);
      expect(waiting).toEqual([true]);

      dispose();
      stop = null;
      expect(waiting).toEqual([true, false]);
    });
  });

  it("reports nothing while the session id is unknown", async () => {
    await writeSessionFile(DEAD_PID, "busy");
    const changes: boolean[] = [];
    stop = startClaudeStatusWatcher({
      getSessionId: () => null,
      onThinkingChange: (t) => {
        changes.push(t);
      },
      pollIntervalMs: 20,
    });
    await sleep(150);
    expect(changes).toEqual([]);
  });

  it("ignores status files belonging to other sessions", async () => {
    await writeSessionFile(DEAD_PID, "busy", "other-session-id");
    const changes: boolean[] = [];
    stop = startClaudeStatusWatcher({
      getSessionId: () => SESSION_ID,
      onThinkingChange: (t) => {
        changes.push(t);
      },
      pollIntervalMs: 20,
    });
    await sleep(150);
    expect(changes).toEqual([]);
  });

  it("stays not-working when the session file never appears", async () => {
    const changes: boolean[] = [];
    stop = startClaudeStatusWatcher({
      getSessionId: () => SESSION_ID,
      onThinkingChange: (t) => {
        changes.push(t);
      },
      pollIntervalMs: 20,
    });
    await sleep(150);
    expect(changes).toEqual([]);
  });

  // If "cannot read the file" meant "keep the previous state" and that state
  // happened to be busy, we would be stuck at "working" forever. It has to
  // reset after a few polls of grace.
  it("resets after a grace period when the status file vanishes mid-work", async () => {
    await writeSessionFile(DEAD_PID, "busy");
    const changes: boolean[] = [];
    stop = startClaudeStatusWatcher({
      getSessionId: () => SESSION_ID,
      onThinkingChange: (t) => {
        changes.push(t);
      },
      pollIntervalMs: 20,
    });
    await sleep(120);
    expect(changes).toEqual([true]);

    await unlink(join(sessionsDir, `${DEAD_PID}.json`));
    await sleep(300);
    expect(changes).toEqual([true, false]);
  });

  // The session id changed (SessionStart hook handed us a new one, or /clear
  // wiped it). The old session's thinking must not carry over, or a new
  // session with no matching file would stay stuck at true.
  it("resets immediately when the session id changes", async () => {
    await writeSessionFile(DEAD_PID, "busy");
    const changes: boolean[] = [];
    let currentId: string | null = SESSION_ID;
    stop = startClaudeStatusWatcher({
      getSessionId: () => currentId,
      onThinkingChange: (t) => {
        changes.push(t);
      },
      pollIntervalMs: 20,
    });
    await sleep(120);
    expect(changes).toEqual([true]);

    currentId = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
    await sleep(150);
    expect(changes).toEqual([true, false]);
  });

  it("resets when the session id is cleared (/clear)", async () => {
    await writeSessionFile(DEAD_PID, "busy");
    const changes: boolean[] = [];
    let currentId: string | null = SESSION_ID;
    stop = startClaudeStatusWatcher({
      getSessionId: () => currentId,
      onThinkingChange: (t) => {
        changes.push(t);
      },
      pollIntervalMs: 20,
    });
    await sleep(120);
    expect(changes).toEqual([true]);

    currentId = null;
    await sleep(150);
    expect(changes).toEqual([true, false]);
  });

  it("resets thinking to false on stop", async () => {
    await writeSessionFile(DEAD_PID, "busy");
    const changes: boolean[] = [];
    // Also assign to `stop`, so afterEach can still clear the interval if an
    // assertion throws. A leaked timer would otherwise go on scanning the real
    // directory once CLAUDE_CONFIG_DIR is restored.
    const dispose = startClaudeStatusWatcher({
      getSessionId: () => SESSION_ID,
      onThinkingChange: (t) => {
        changes.push(t);
      },
      pollIntervalMs: 20,
    });
    stop = dispose;
    await sleep(120);
    expect(changes).toEqual([true]);

    dispose();
    // Stopping twice must be safe.
    dispose();
    stop = null;

    expect(changes).toEqual([true, false]);

    // Nothing may be emitted after stopping.
    await writeSessionFile(DEAD_PID, "busy");
    await sleep(120);
    expect(changes).toEqual([true, false]);
  });

  it("survives a half-written file with invalid JSON", async () => {
    await writeFile(join(sessionsDir, "999.json"), '{"sessionId": "trunc');
    await writeSessionFile(DEAD_PID, "busy");
    const changes: boolean[] = [];
    stop = startClaudeStatusWatcher({
      getSessionId: () => SESSION_ID,
      onThinkingChange: (t) => {
        changes.push(t);
      },
      pollIntervalMs: 20,
    });
    await sleep(150);
    expect(changes).toEqual([true]);
  });

  // Session files are named by pid and are not cleaned up on exit: killing
  // `claude` mid-turn leaves a file stuck at status=busy forever. After that
  // sessionId is resumed there are two matching files in the directory, and
  // picking the wrong one pins the phone at "working" permanently.
  describe("multiple session files for one sessionId (leftovers from killed processes)", () => {
    const writeAt = (
      pid: number,
      status: string,
      statusUpdatedAt: number,
      extra: Record<string, unknown> = {},
    ) =>
      writeFile(
        join(sessionsDir, `${pid}.json`),
        JSON.stringify({
          pid,
          sessionId: SESSION_ID,
          status,
          cwd: "/tmp",
          statusUpdatedAt,
          ...extra,
        }),
      );

    it("prefers the newer timestamp when both processes are dead (stale busy loses to newer idle)", async () => {
      await writeAt(DEAD_PID, "busy", 1_000);
      await writeAt(DEAD_PID + 1, "idle", 9_000);
      const changes: boolean[] = [];
      stop = startClaudeStatusWatcher({
        getSessionId: () => SESSION_ID,
        onThinkingChange: (t) => {
          changes.push(t);
        },
        pollIntervalMs: 20,
      });
      await sleep(150);
      expect(changes).toEqual([]);
    });

    it("and the reverse holds: newer busy beats older idle", async () => {
      await writeAt(DEAD_PID, "idle", 1_000);
      await writeAt(DEAD_PID + 1, "busy", 9_000);
      const changes: boolean[] = [];
      stop = startClaudeStatusWatcher({
        getSessionId: () => SESSION_ID,
        onThinkingChange: (t) => {
          changes.push(t);
        },
        pollIntervalMs: 20,
      });
      await sleep(150);
      expect(changes).toEqual([true]);
    });

    // The key case: timestamps alone cannot rule out a leftover file. A live
    // process that drops to idle stops advancing its timestamp, while another
    // process that flipped to busy later was then SIGKILLed — the leftover
    // busy would win forever. Hence liveness outranks the timestamp.
    it("prefers a live process's idle over a dead process's newer busy", async () => {
      await writeAt(DEAD_PID, "busy", 9_000); // dead, but newer timestamp
      await writeAt(process.pid, "idle", 1_000); // alive, older timestamp
      const changes: boolean[] = [];
      stop = startClaudeStatusWatcher({
        getSessionId: () => SESSION_ID,
        onThinkingChange: (t) => {
          changes.push(t);
        },
        pollIntervalMs: 20,
      });
      await sleep(150);
      expect(changes).toEqual([]);
    });

    it("prefers a live process's busy over a dead process's newer idle too", async () => {
      await writeAt(DEAD_PID, "idle", 9_000);
      await writeAt(process.pid, "busy", 1_000);
      const changes: boolean[] = [];
      stop = startClaudeStatusWatcher({
        getSessionId: () => SESSION_ID,
        onThinkingChange: (t) => {
          changes.push(t);
        },
        pollIntervalMs: 20,
      });
      await sleep(150);
      expect(changes).toEqual([true]);
    });

    // JSON.parse turns 1e999 into Infinity while typeof stays "number".
    // Compared directly, Infinity > Infinity is false, which would pin the
    // selection on the corrupt file forever.
    it("is not pinned by a corrupt file whose timestamp parses to Infinity", async () => {
      await writeFile(
        join(sessionsDir, `${DEAD_PID}.json`),
        `{"pid":${DEAD_PID},"sessionId":"${SESSION_ID}","status":"busy","statusUpdatedAt":1e999}`,
      );
      await writeAt(process.pid, "idle", 1_000);
      const changes: boolean[] = [];
      stop = startClaudeStatusWatcher({
        getSessionId: () => SESSION_ID,
        onThinkingChange: (t) => {
          changes.push(t);
        },
        pollIntervalMs: 20,
      });
      await sleep(150);
      // The live process's idle must win instead of being pinned at busy.
      expect(changes).toEqual([]);
    });
  });
});
