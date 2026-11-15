import { randomUUID } from "node:crypto";
import type Docker from "dockerode";
import type { z } from "zod";
import type { computerActionSchema } from "./supervisor-logic.js";
import {
  containerActionSteps,
  createDockerStreamDemuxer,
  demuxDockerStream,
  parseObservation,
  sandboxCommandTimedOut,
  sandboxTimeoutCommand,
} from "./supervisor-logic.js";

export async function runContainerCommand(
  container: Docker.Container,
  argv: string[],
  options: {
    workingDir?: string;
    env?: string[];
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Written to stdin without closing it; requires `signal`, whose abort closes stdin. */
    stdin?: string;
    /** Live stdout/stderr. The returned buffers are still the full demuxed result. */
    onOutput?: (chunk: { stream: "stdout" | "stderr"; data: string }) => void;
  } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  if (options.stdin !== undefined && !options.signal) throw new Error("stdin requires a signal");
  options.signal?.throwIfAborted();
  const timeoutMs = options.timeoutMs;
  const completionMarker = timeoutMs
    ? `/tmp/rakazo-command-${randomUUID()}.completed-124`
    : undefined;
  const command =
    completionMarker && timeoutMs !== undefined
      ? sandboxTimeoutCommand(argv, timeoutMs, completionMarker)
      : argv;
  const exec = await container.exec({
    Cmd: command,
    AttachStdout: true,
    AttachStderr: true,
    ...(options.signal ? { AttachStdin: true } : {}),
    WorkingDir: options.workingDir ?? "/home/rakazo",
    Env: options.env ?? [
      "DISPLAY=:1",
      "HOME=/home/rakazo",
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    ],
  });
  options.signal?.throwIfAborted();
  const stream = await exec.start({ hijack: true, stdin: Boolean(options.signal) });
  if (options.stdin !== undefined) stream.write(options.stdin);
  const chunks: Buffer[] = [];
  const demuxer = options.onOutput ? createDockerStreamDemuxer() : undefined;
  const emitOutput = (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(bytes);
    if (!demuxer || !options.onOutput) return;
    for (const piece of demuxer.push(bytes)) {
      if (piece.data) options.onOutput(piece);
    }
  };
  let onAbort: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (data: Buffer | string) => emitOutput(data));
      stream.on("end", resolve);
      stream.on("error", reject);
      onAbort = () => {
        // The page helper watches stdin EOF and exits even inside a blocked CDP call.
        stream.destroy();
        reject(options.signal?.reason ?? new Error("command cancelled"));
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
    });
  } finally {
    if (onAbort) options.signal?.removeEventListener("abort", onAbort);
  }
  if (demuxer && options.onOutput) {
    for (const piece of demuxer.finish()) {
      if (piece.data) options.onOutput(piece);
    }
  }
  const inspect = await exec.inspect();
  const code = inspect.ExitCode ?? 0;
  const completedWithExit124 =
    code === 124 && completionMarker
      ? await consumeCompletionMarker(container, completionMarker)
      : false;
  const timedOut = sandboxCommandTimedOut(code, completedWithExit124);
  const output = demuxDockerStream(Buffer.concat(chunks));
  return {
    stdout: output.stdout,
    stderr: timedOut
      ? `${output.stderr}${output.stderr.endsWith("\n") || output.stderr === "" ? "" : "\n"}command timed out after ${timeoutMs} ms\n`
      : output.stderr,
    code,
  };
}

async function consumeCompletionMarker(container: Docker.Container, marker: string) {
  const result = await runContainerCommand(container, [
    "sh",
    "-c",
    'if [ -f "$0" ]; then rm -f "$0"; exit 0; fi; exit 1',
    marker,
  ]);
  return result.code === 0;
}

export async function applyContainerActions(
  container: Docker.Container,
  actions: Array<z.infer<typeof computerActionSchema>>,
  display = ":1",
  browserProfile?: string,
) {
  const script = [
    "import json, subprocess, sys, time",
    "for step in json.loads(sys.argv[1]):",
    "  if 'waitMs' in step: time.sleep(step['waitMs'] / 1000)",
    "  else:",
    "    result = subprocess.run(step['argv'])",
    "    if result.returncode: sys.exit(result.returncode)",
  ].join("\n");
  const result = await runContainerCommand(container, [
    "python3",
    "-c",
    script,
    JSON.stringify(containerActionSteps(actions, display, browserProfile)),
  ]);
  if (result.code !== 0) throw new Error(result.stderr || "computer action failed");
}

export async function observeContainer(container: Docker.Container, display = ":1") {
  const command = [
    "set -e",
    `export DISPLAY=${display}`,
    'printf "GEOM %s\\n" "$(xdotool getdisplaygeometry 2>/dev/null || echo 1280 800)"',
    'printf "CURSOR %s\\n" "$(xdotool getmouselocation --shell 2>/dev/null | tr "\\n" " " || true)"',
    'wid="$(xdotool getactivewindow 2>/dev/null || true)"',
    'printf "WINDOW %s\\n" "$wid"',
    'printf "TITLE %s\\n" "$(test -n "$wid" && xdotool getwindowname "$wid" 2>/dev/null || true)"',
    'printf "IMAGE "',
    "import -window root png:- 2>/dev/null | base64 -w0",
    'printf "\\n"',
  ].join("; ");
  const result = await runContainerCommand(container, ["bash", "-lc", command]);
  if (result.code !== 0) throw new Error(result.stderr || "screen capture failed");
  return parseObservation(result.stdout);
}

export async function writeContainerFile(
  container: Docker.Container,
  target: string,
  content: Buffer,
  executable = false,
) {
  const script = [
    "import os, sys",
    "target = sys.argv[1]",
    "os.makedirs(os.path.dirname(target), exist_ok=True)",
    "with open(target, 'wb') as f: f.write(sys.stdin.buffer.read())",
    `os.chmod(target, ${executable ? "0o700" : "0o600"})`,
  ].join("\n");
  const exec = await container.exec({
    Cmd: ["python3", "-c", script, target],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    WorkingDir: "/home/rakazo",
    Env: ["HOME=/home/rakazo"],
  });
  const stream = await exec.start({ hijack: true, stdin: true });
  const chunks: Buffer[] = [];
  stream.on("data", (data: Buffer) => chunks.push(data));
  stream.end(content);
  await new Promise<void>((resolve, reject) => {
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  const inspect = await exec.inspect();
  if ((inspect.ExitCode ?? 0) !== 0) {
    const output = demuxDockerStream(Buffer.concat(chunks));
    throw new Error(output.stderr || output.stdout || "file write failed");
  }
}
