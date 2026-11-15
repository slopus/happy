import { setImmediate } from "node:timers/promises";
import type { ProcessEvent } from "@rakazo/adapter-kit";
import { redactSecrets } from "@rakazo/core";
import { redactShellStreams } from "./agent-environment.js";
import { automated } from "./automated-messages.js";
import { shortenPlainText } from "./context-selection.js";
import { TOOL_RESULT_TEXT_LIMIT } from "./pi-runtime-limits.js";

/**
 * Device-code logins print a code and then wait. Once that output goes quiet,
 * return it while the process is still running so the bot can show the code.
 * Fast commands that exit inside this window are unchanged.
 */
export const SHELL_STREAM_IDLE_MS = 1_000;

/**
 * Other output often pauses briefly (a header before an API call), so wait longer before
 * returning a command that is still running, such as one waiting on a prompt.
 */
const SHELL_STREAM_QUIET_MS = 10_000;

// A device-code prompt prints a link and a code together. A link alone is ordinary progress
// output (`Fetching https://...`), so it does not end the wait. Device codes are usually groups
// such as ABCD-1234 or 1234-5678, or one token mixing letters and digits such as FZ8Q4X8BJ; a
// word (ERROR), a number or a short error code (E404) is not counted. A code in another shape
// returns after the longer wait.
const SIGN_IN_LINK = /https?:\/\/\S/;
const ONE_TIME_CODE =
  /\b[Cc]ode\b[\s:"'`]*(?:is\s+)?(?:[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+|(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]{6,})\b/;
// A prompt is the latest output, so only the end of each stream is checked, which keeps long
// logs cheap. The link and the code may be on different streams.
const SIGN_IN_PROMPT_SCAN_CHARS = 4_000;

function showsSignInPrompt(snapshot: ShellCommandSnapshot): boolean {
  const recent = [snapshot.stdout, snapshot.stderr].map((stream) =>
    stream.slice(-SIGN_IN_PROMPT_SCAN_CHARS),
  );
  return (
    recent.some((stream) => SIGN_IN_LINK.test(stream)) &&
    recent.some((stream) => ONE_TIME_CODE.test(stream))
  );
}

export const SHELL_STILL_RUNNING_NOTICE =
  "Still running. Tell the user any one-time code or sign-in URL in the output.";

export interface ShellCommandSnapshot {
  stdout: string;
  stderr: string;
}

export interface FinishedShellCommand extends ShellCommandSnapshot {
  code: number;
}

export interface RunningShellCommand extends ShellCommandSnapshot {
  code: null;
  running: true;
}

export type ShellCommandResult = FinishedShellCommand | RunningShellCommand;

export function isRunningShellCommand(result: unknown): result is RunningShellCommand {
  return (
    !!result &&
    typeof result === "object" &&
    (result as { running?: unknown }).running === true &&
    (result as { code?: unknown }).code === null
  );
}

export function formatFinishedShellCommand(result: FinishedShellCommand): string {
  // Delivered in the user's role after the turn, so marked as automated: models took
  // finished console output for the user replying.
  const parts = [automated("Shell command finished."), `exit code: ${result.code}`];
  if (result.stdout) parts.push(`stdout:\n${keepHeadAndTail(result.stdout)}`);
  if (result.stderr) parts.push(`stderr:\n${keepHeadAndTail(result.stderr)}`);
  return parts.join("\n");
}

// Build and install failures print last, so keep the tail as well as the head.
function keepHeadAndTail(text: string): string {
  return text.length > TOOL_RESULT_TEXT_LIMIT
    ? shortenPlainText(text, TOOL_RESULT_TEXT_LIMIT)
    : text;
}

/**
 * After the turn that first saw a still-running shell, hand the bot the final output of
 * commands that have exited. The turn that received the live output is skipped so the bot
 * can relay a device code before the process ends.
 *
 * A turn that called tools takes only the commands that already exited: the bot is still
 * working, and waiting here would also hold back the person's messages until the sandbox
 * command timeout. A turn that would otherwise end the run waits for the rest. A turn that
 * ended in a model error or an abort makes no further request, so nothing waits on it.
 */
export async function deliverFinishedShells(
  deliver: (text: string) => void,
  pending: Array<Promise<FinishedShellCommand>>,
  turn: {
    message?: { stopReason?: string };
    toolResults: Array<{ toolName?: string; details?: unknown }>;
  },
  signal?: AbortSignal,
): Promise<void> {
  if (pending.length === 0 || turnReturnedRunningShell(turn)) return;
  if (turn.message?.stopReason === "error" || turn.message?.stopReason === "aborted") return;
  const batch =
    turn.toolResults.length > 0 ? await takeExited(pending) : pending.splice(0, pending.length);
  const results = await Promise.all(batch.map((completion) => finishOrAbort(completion, signal)));
  const texts = results.filter((result): result is FinishedShellCommand => result !== undefined);
  if (texts.length === 0) return;
  deliver(texts.map((result) => formatFinishedShellCommand(result)).join("\n\n"));
}

/** Remove and return the commands that already exited, leaving the rest pending. */
async function takeExited(
  pending: Array<Promise<FinishedShellCommand>>,
): Promise<Array<Promise<FinishedShellCommand>>> {
  const exited = new Set<Promise<FinishedShellCommand>>();
  for (const completion of pending) {
    const mark = () => exited.add(completion);
    void completion.then(mark, mark);
  }
  // A settled promise runs its callbacks before the next macrotask; a running one does not.
  await setImmediate();
  const taken = pending.filter((completion) => exited.has(completion));
  pending.splice(0, pending.length, ...pending.filter((completion) => !exited.has(completion)));
  return taken;
}

function turnReturnedRunningShell(turn: {
  toolResults: Array<{ toolName?: string; details?: unknown }>;
}): boolean {
  return turn.toolResults.some(
    (result) =>
      (result.toolName === "shell" || result.toolName === "user_computer_shell") &&
      isRunningShellCommand(result.details),
  );
}

async function finishOrAbort(
  completion: Promise<FinishedShellCommand>,
  signal?: AbortSignal,
): Promise<FinishedShellCommand | undefined> {
  if (signal?.aborted) return undefined;
  const settled = completion.then(
    (result) => result,
    (error: unknown) => ({
      stdout: "",
      stderr: error instanceof Error ? error.message : "command failed",
      code: 1,
    }),
  );
  if (!signal) return settled;
  return Promise.race([
    settled,
    new Promise<undefined>((resolve) => {
      if (signal.aborted) {
        resolve(undefined);
        return;
      }
      signal.addEventListener("abort", () => resolve(undefined), { once: true });
    }),
  ]);
}

/**
 * Read a command stream. When output arrives and then stays quiet, return it before exit
 * and keep collecting the rest on `completion`. A sign-in prompt returns after `idleMs`,
 * other output after `quietMs`.
 */
export async function observeShellCommand(
  events: AsyncIterable<ProcessEvent>,
  options: {
    secrets: string[];
    idleMs?: number;
    quietMs?: number;
    onOutput?: (snapshot: ShellCommandSnapshot) => void;
  },
): Promise<{
  result: ShellCommandResult;
  completion?: Promise<FinishedShellCommand>;
}> {
  const idleMs = options.idleMs ?? SHELL_STREAM_IDLE_MS;
  const quietMs = options.quietMs ?? SHELL_STREAM_QUIET_MS;
  let stdout = "";
  let stderr = "";
  let code: number | undefined;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveIdle: ((reason: "idle" | "done") => void) | undefined;
  const idlePromise = new Promise<"idle" | "done">((resolve) => {
    resolveIdle = resolve;
  });

  const redact = (snapshot: ShellCommandSnapshot, withholdPartial: boolean): ShellCommandSnapshot =>
    redactShellStreams(snapshot, options.secrets, { withholdPartial });

  const clearIdle = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  const armIdle = (waitMs: number) => {
    clearIdle();
    if (waitMs <= 0) {
      resolveIdle?.("idle");
      return;
    }
    timer = setTimeout(() => resolveIdle?.("idle"), waitMs);
  };

  const done = (async (): Promise<FinishedShellCommand> => {
    try {
      for await (const event of events) {
        if (event.type === "stdout") stdout += event.data;
        else if (event.type === "stderr") stderr += event.data;
        else if (event.type === "exit") {
          code = event.code;
          break;
        } else continue;
        const published = redact({ stdout, stderr }, true);
        try {
          options.onOutput?.(published);
        } catch {
          // Live output is a view. A failed update must not kill the command.
        }
        if (stdout.length > 0 || stderr.length > 0) {
          armIdle(showsSignInPrompt({ stdout, stderr }) ? idleMs : quietMs);
        }
      }
    } catch (error) {
      // Providers may include command environment values in errors. Never expose the raw
      // error or its cause to runtime tool handling or a background completion observer.
      throw new Error(
        redactSecrets(error instanceof Error ? error.message : String(error), options.secrets),
      );
    } finally {
      clearIdle();
      finished = true;
      resolveIdle?.("done");
    }
    return { ...redact({ stdout, stderr }, false), code: code ?? 0 };
  })();

  const reason = await Promise.race([
    idlePromise,
    done.then(
      () => "done" as const,
      () => "done" as const,
    ),
  ]);
  if (reason === "done" || finished || code !== undefined) {
    return { result: await done };
  }
  return {
    // The process is still running, so an unfinished secret prefix stays out of the
    // tool result. The completion publishes the rest once the command exits.
    result: { ...redact({ stdout, stderr }, true), code: null, running: true },
    completion: done,
  };
}
