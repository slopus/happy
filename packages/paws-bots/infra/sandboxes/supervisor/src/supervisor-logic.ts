import type { DesktopEnvironment } from "@rakazo/core/node/desktop-runtime";
import {
  ensureScreenCommand as coreEnsureScreenCommand,
  interactiveScreenCommand as coreInteractiveScreenCommand,
  terminalCommand as coreTerminalCommand,
  DEFAULT_DESKTOP_ENV,
  BROWSER_APPLICATIONS as DOCKER_BROWSER_ALIASES,
  MAX_DESKTOP_DISPLAY,
  resetDesktopRuntimeCommand,
  screenPorts,
  shellQuote,
  stopBrowserCommand,
  stopExtraScreenCommand,
  stopScreenTransportsCommand,
} from "@rakazo/core/node/desktop-runtime";

export {
  browserProfilePathForScreen,
  prepareBrowserProfileCommand,
  quiesceBrowserProfilesCommand,
  stopBrowserCommand,
  stopExtraScreenCommand,
} from "@rakazo/core/node/desktop-runtime";

import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import { canReleaseScreenLease, canTakeScreenLease } from "@rakazo/core";
import type Docker from "dockerode";
import { z } from "zod";
import type { SandboxInput } from "./computer-spec.js";
import { xdotoolCommand } from "./computer-spec.js";

// Docker forwarding reaches the isolated container's bridge interface; loopback cannot serve it.
const DOCKER_DESKTOP_ENV: DesktopEnvironment = { ...DEFAULT_DESKTOP_ENV, bindHost: "0.0.0.0" };

export function ensureScreenCommand(
  index: number,
  screenId: string,
  viewToken: string,
  env = DOCKER_DESKTOP_ENV,
) {
  return coreEnsureScreenCommand(index, screenId, viewToken, env);
}

export function interactiveScreenCommand(
  interactive: boolean,
  controlToken?: string,
  layout = screenPorts(0),
) {
  return coreInteractiveScreenCommand(interactive, controlToken, {
    ...layout,
    bindHost: DOCKER_DESKTOP_ENV.bindHost,
  });
}

export function terminalCommand(
  controlToken: string,
  terminalToken: string,
  cwd: string,
  env = DOCKER_DESKTOP_ENV,
  layout = screenPorts(0, env),
) {
  return coreTerminalCommand(controlToken, terminalToken, cwd, env, {
    ...layout,
    bindHost: env.bindHost,
  });
}

export const computerActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("key"), key: z.string(), modifiers: z.array(z.string()).optional() }),
  z.object({
    kind: z.literal("pointer"),
    x: z.number(),
    y: z.number(),
    button: z.enum(["left", "right"]).optional(),
    type: z.enum(["move", "down", "up", "click"]),
  }),
  z.object({ kind: z.literal("clipboard"), text: z.string() }),
  z.object({
    kind: z.literal("scroll"),
    direction: z.enum(["up", "down", "left", "right"]),
    amount: z.number().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
  }),
  z.object({ kind: z.literal("wait"), ms: z.number() }),
  z.object({ kind: z.literal("open"), path: z.string() }),
  z.object({ kind: z.literal("launch"), application: z.string(), uri: z.string().optional() }),
  z.object({ kind: z.literal("focus"), application: z.string(), uri: z.string().optional() }),
]);

export { BROWSER_APPLICATIONS as DOCKER_BROWSER_ALIASES } from "@rakazo/core/node/desktop-runtime";

export function assertRequestIdentity(
  botId: string | undefined,
  spaceId: string | undefined,
  expected: { botId: string; spaceId: string },
) {
  if (botId !== expected.botId || spaceId !== expected.spaceId) {
    throw new Error("computer identity mismatch");
  }
}

export function hasComputerIdentity(
  labels: Record<string, string> | undefined,
  botId: string,
  spaceId: string,
) {
  const labeledSpaceId = labels?.["rakazo.spaceId"] ?? labels?.["rakazo.workspaceId"];
  return labels?.["rakazo.botId"] === botId && labeledSpaceId === spaceId;
}

export function hasValidBearerToken(authorization: string | undefined, expectedToken: string) {
  const supplied =
    authorization?.slice(0, 7).toLowerCase() === "bearer " ? authorization.slice(7) : "";
  const actual = Buffer.from(expectedToken);
  const candidate = Buffer.from(supplied);
  return actual.length === candidate.length && timingSafeEqual(actual, candidate);
}

/** Prefer the HTTP control fast path; on failure use the docker-exec fallback. */
export async function preferComputerControl<T>(
  run: (() => Promise<T>) | undefined,
  fallback: () => Promise<T>,
): Promise<T> {
  if (!run) return fallback();
  try {
    return await run();
  } catch {
    return fallback();
  }
}

export class ComputerControlUnavailableError extends Error {
  constructor(message = "computer control unavailable") {
    super(message);
    this.name = "ComputerControlUnavailableError";
  }
}

function errorText(error: unknown) {
  if (!(error instanceof Error)) return String(error).toLowerCase();
  const cause = error.cause instanceof Error ? ` ${error.cause.message}` : "";
  return `${error.message}${cause}`.toLowerCase();
}

/** True when the control service was never reached, so actions were not applied. */
export function isComputerControlUnavailable(error: unknown) {
  if (error instanceof ComputerControlUnavailableError) return true;
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError" || error.name === "AbortError") return false;
  const text = errorText(error);
  // Only pre-connect failures prove no actions ran. Mid-flight resets/hang-ups can
  // happen after the service already applied steps. undici's connect timeout
  // ("Connect Timeout Error", UND_ERR_CONNECT_TIMEOUT) fires before the socket
  // opens, e.g. when the supervisor is no longer on the computer's network.
  return (
    text.includes("connect timeout") ||
    text.includes("econnrefused") ||
    text.includes("enotfound") ||
    text.includes("ehostunreach") ||
    text.includes("enetunreach") ||
    text.includes("eai_again")
  );
}

export type ComputerControlAttempt<T> =
  | { status: "ok"; value: T }
  | { status: "unavailable" }
  | { status: "failed"; error: Error };

/**
 * Try the HTTP control fast path.
 * `unavailable` means the service was never reached (safe to fall back for actions).
 * `failed` means the request may have partially applied actions (do not replay).
 */
export async function attemptComputerControl<T>(
  run: (() => Promise<T>) | undefined,
): Promise<ComputerControlAttempt<T>> {
  if (!run) return { status: "unavailable" };
  try {
    return { status: "ok", value: await run() };
  } catch (error) {
    if (isComputerControlUnavailable(error)) return { status: "unavailable" };
    return {
      status: "failed",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/** Replay actions via docker-exec only when control was never reached. */
export function shouldReplayComputerActions(attempt: ComputerControlAttempt<unknown>) {
  return attempt.status === "unavailable";
}

const CONTROL_BASE_TIMEOUT_MS = 15_000;
const MAX_CONTROL_ACTIONS = 24;
const MAX_MAPPED_WAIT_MS = 5_000;
// control.py waits this long for one focus wrapper (FOCUS_COMPLETION_SEC).
const FOCUS_ACTION_BUDGET_MS = 13_400;
// One control request already accepts 24 actions. Focus is the slow step, so the
// HTTP ceiling covers a full batch of them plus settle. Each focus step stays 13.4s.
const CONTROL_MAX_TIMEOUT_MS =
  CONTROL_BASE_TIMEOUT_MS + MAX_CONTROL_ACTIONS * FOCUS_ACTION_BUDGET_MS + MAX_MAPPED_WAIT_MS;

/** Bound the HTTP control deadline by focus steps, mapped waits, and settle time. */
export function computerControlTimeoutMs(
  actions: Array<z.infer<typeof computerActionSchema>>,
  settleMs = 0,
) {
  let waits = 0;
  let focusSteps = 0;
  for (const action of actions) {
    if (action.kind === "wait") waits += Math.min(Math.max(action.ms, 0), MAX_MAPPED_WAIT_MS);
    else if (action.kind === "focus") focusSteps += 1;
  }
  return Math.min(
    CONTROL_MAX_TIMEOUT_MS,
    CONTROL_BASE_TIMEOUT_MS +
      waits +
      focusSteps * FOCUS_ACTION_BUDGET_MS +
      Math.min(Math.max(settleMs, 0), MAX_MAPPED_WAIT_MS),
  );
}

export function toSandboxInput(input: {
  kind: "key" | "pointer" | "clipboard";
  key?: string;
  modifiers?: string[];
  x?: number;
  y?: number;
  button?: "left" | "right";
  type?: "move" | "down" | "up" | "click";
  text?: string;
}): SandboxInput {
  if (input.kind === "key") {
    return { kind: "key", key: input.key ?? "", modifiers: input.modifiers };
  }
  if (input.kind === "clipboard") return { kind: "clipboard", text: input.text ?? "" };
  return {
    kind: "pointer",
    x: input.x ?? 0,
    y: input.y ?? 0,
    button: input.button,
    type: input.type ?? "click",
  };
}

export function nextScreenIndex(
  assigned: Map<string, ScreenAssignment>,
  screenId: string,
  leaseId?: string,
  limit = MAX_DESKTOP_DISPLAY,
): number {
  const existing = assigned.get(screenId);
  if (existing) {
    if (existing.releasing) {
      throw new Error("This Team Computer screen is still being released.");
    }
    if (leaseId) {
      if (
        existing.leaseId &&
        existing.leaseId !== leaseId &&
        !canTakeScreenLease(existing.leaseId, leaseId)
      ) {
        throw new Error("This Team Computer screen is owned by a newer execution.");
      }
      if (existing.leaseId !== leaseId && canTakeScreenLease(existing.leaseId, leaseId)) {
        existing.leaseId = leaseId;
        delete existing.idleAt;
      }
    }
    return existing.index;
  }
  const used = new Set([...assigned.values()].map((slot) => slot.index));
  for (let index = 0; index < limit; index += 1) {
    if (!used.has(index)) {
      assigned.set(screenId, { index, leaseId });
      return index;
    }
  }
  throw new Error(`This Team Computer cannot allocate another screen (limit ${limit}).`);
}

export function releaseAssignedScreen(
  assigned: Map<string, ScreenAssignment>,
  screenId: string,
  leaseId?: string,
): number | undefined {
  const slot = assigned.get(screenId);
  if (!slot || (leaseId && !canReleaseScreenLease(slot.leaseId, leaseId))) {
    return undefined;
  }
  if (slot.releasing) return slot.index;
  slot.releasing = true;
  // Release stops the screen's viewer, so the next request sets the screen up again.
  delete slot.ensuredAt;
  return slot.index;
}

export function completeReleasedScreen(
  assigned: Map<string, ScreenAssignment>,
  screenId: string,
  index: number,
): void {
  const slot = assigned.get(screenId);
  if (slot?.releasing && slot.index === index) assigned.delete(screenId);
}

export function completeWarmReleasedScreen(
  assigned: Map<string, ScreenAssignment>,
  screenId: string,
  index: number,
  idleAt: number,
): void {
  const slot = assigned.get(screenId);
  if (slot?.releasing && slot.index === index) {
    delete slot.releasing;
    delete slot.controlled;
    delete slot.controlToken;
    slot.idleAt = idleAt;
  }
}

export function oldestIdleScreen(
  assigned: Map<string, ScreenAssignment>,
  limit: number,
): string | undefined {
  return [...assigned.entries()]
    .filter(
      ([, slot]) =>
        !slot.releasing && !slot.controlled && slot.idleAt !== undefined && slot.index < limit,
    )
    .sort(
      ([screenA, a], [screenB, b]) =>
        (a.idleAt ?? 0) - (b.idleAt ?? 0) || a.index - b.index || screenA.localeCompare(screenB),
    )[0]?.[0];
}

export async function teardownReleasedScreen(
  assigned: Map<string, ScreenAssignment>,
  screenId: string,
  index: number,
  teardown: () => Promise<{ code: number; stderr: string }>,
  options: { retainBrowser?: boolean } = {},
) {
  const result = await teardown();
  if (result.code !== 0) throw new Error(result.stderr || "computer screen failed to stop");
  const slot = assigned.get(screenId);
  if (options.retainBrowser && slot?.releasing && slot.index === index) {
    // Keep the display reserved for this browser, and the fence to reject delayed releases.
    completeWarmReleasedScreen(assigned, screenId, index, Date.now());
    delete slot.viewToken;
  } else {
    completeReleasedScreen(assigned, screenId, index);
  }
}

export interface ScreenAssignment {
  index: number;
  leaseId?: string;
  releasing?: boolean;
  viewToken?: string;
  idleAt?: number;
  controlled?: boolean;
  controlToken?: string;
  /** When the setup script last finished for this screen on the current boot. */
  ensuredAt?: number;
}

/** The page helper reached no browser, before dispatching anything. */
export function pageBrowserNotReady(result: { code: number; stdout: string }) {
  if (result.code !== 0) return false;
  try {
    const output = JSON.parse(result.stdout) as {
      ok?: unknown;
      error?: unknown;
      uncertain?: unknown;
    };
    return (
      output.ok === false &&
      output.uncertain !== true &&
      typeof output.error === "string" &&
      output.error.startsWith("CDP not ready")
    );
  } catch {
    return false;
  }
}

/** The page helper's own reply when it refused a command (exit 2), or nothing when the output is not one. */
export function refusedCommand(stdout: string): { ok: false; error: string } | undefined {
  try {
    const reply = JSON.parse(stdout) as { ok?: unknown; error?: unknown };
    return reply && reply.ok === false && typeof reply.error === "string"
      ? (reply as { ok: false; error: string })
      : undefined;
  } catch {
    return undefined;
  }
}

/** How long a page-browser request trusts the last setup instead of rerunning it. */
export const SCREEN_REUSE_MS = 30_000;

/** A screen set up moments ago on this boot still runs; a human-held one may need its viewer back. */
export function screenRecentlyEnsured(slot: ScreenAssignment | undefined, now: number) {
  return (
    slot?.ensuredAt !== undefined &&
    !slot.releasing &&
    !slot.controlled &&
    !slot.controlToken &&
    now - slot.ensuredAt < SCREEN_REUSE_MS
  );
}

/** Forget screen assignments and their boot marker together on every cleanup path. */
export function clearComputerScreenRegistry(
  registry: Map<string, Map<string, ScreenAssignment>>,
  boots: Map<string, string>,
  containerId: string,
) {
  registry.delete(containerId);
  boots.delete(containerId);
}

/** Screen processes do not survive a container restart (crash, OOM kill, daemon restart).
 * A registry recorded under an earlier boot describes processes that no longer exist, and
 * a slot it left "releasing" would otherwise refuse every later screen and release request. */
export function currentComputerScreens(
  registry: Map<string, Map<string, ScreenAssignment>>,
  boots: Map<string, string>,
  containerId: string,
  startedAt: string | undefined,
): Map<string, ScreenAssignment> | undefined {
  const assigned = registry.get(containerId);
  const recordedBoot = boots.get(containerId);
  if (assigned && startedAt && recordedBoot && recordedBoot !== startedAt) {
    clearComputerScreenRegistry(registry, boots, containerId);
    return undefined;
  }
  return assigned;
}

/** Release access on DELETE /screen; only cancellation stops the browser.
 * Callers must hold the per-computer screen lock across this decision and any stop. */
export function screenReleaseStopCommand(
  index: number | undefined,
  options: {
    hasRegistry: boolean;
    cancelRunWork: boolean;
    screenId: string;
  },
): string {
  if (index !== undefined) {
    return options.cancelRunWork
      ? stopExtraScreenCommand(index, options.screenId)
      : ["set -eu", stopScreenTransportsCommand(index)].join("\n");
  }
  // Missing registry after a supervisor restart: cancel still tears down the
  // matching bot's orphaned Chromium process without touching another bot.
  // Present registry + rejected release: newer fence owns the screen — do not kill.
  if (!options.hasRegistry && options.cancelRunWork) {
    return stopBrowserCommand(options.screenId);
  }
  return "";
}

export function stopScreensCommand(screens: Array<{ screenId: string; index: number }>) {
  return [
    "set -eu",
    "failed=0",
    ...screens.map(
      ({ screenId }) => `bash -eu -c ${shellQuote(stopBrowserCommand(screenId))} || failed=1`,
    ),
    '[ "$failed" -eq 0 ] || { echo "computer browser failed to stop" >&2; exit 1; }',
  ].join("\n");
}

export function resetManagedScreensCommand() {
  return resetDesktopRuntimeCommand();
}

export async function withKeyedLock<T>(
  locks: Map<string, Promise<unknown>>,
  key: string,
  operation: () => Promise<T>,
) {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.catch(() => undefined).then(() => gate);
  locks.set(key, current);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(key) === current) locks.delete(key);
  }
}

/** X11 wheel buttons: up, down, left and right. */
const WHEEL_BUTTONS = { up: "4", down: "5", left: "6", right: "7" } as const;

export function containerActionStep(
  action: z.infer<typeof computerActionSchema>,
  display = ":1",
  browserProfile?: string,
): { argv: string[] } | { waitMs: number } {
  if (action.kind === "wait") {
    return { waitMs: Math.min(Math.max(action.ms, 0), 5_000) };
  }
  let argv: string[];
  if (action.kind === "key" || action.kind === "pointer" || action.kind === "clipboard") {
    argv = ["env", `DISPLAY=${display}`, ...xdotoolCommand(toSandboxInput(action))];
  } else if (action.kind === "scroll") {
    const wheel = [
      "click",
      "--repeat",
      String(Math.min(Math.max(Math.round(action.amount ?? 3), 1), 20)),
      WHEEL_BUTTONS[action.direction],
    ];
    // Given a point, the pointer moves there first, so the wheel scrolls what is under it.
    const at =
      action.x !== undefined && action.y !== undefined
        ? ["mousemove", "--", String(Math.round(action.x)), String(Math.round(action.y))]
        : [];
    argv = ["env", `DISPLAY=${display}`, "xdotool", ...at, ...wheel];
  } else if (action.kind === "open") {
    const isHttpUrl = /^https?:\/\//i.test(action.path);
    const target = isHttpUrl
      ? action.path
      : pathToFileURL(workspaceTarget(normalizeWorkspaceRelative(action.path)), {
          windows: false,
        }).href;
    argv = [
      "env",
      `DISPLAY=${display}`,
      ...(browserProfile ? [`RAKAZO_BROWSER_PROFILE=${browserProfile}`] : []),
      isHttpUrl ? "xdg-open" : "rakazo-browser",
      target,
    ];
  } else {
    const browser = DOCKER_BROWSER_ALIASES.has(action.application.toLowerCase());
    argv = [
      "env",
      `DISPLAY=${display}`,
      ...(browser && browserProfile ? [`RAKAZO_BROWSER_PROFILE=${browserProfile}`] : []),
      // focus routes through the image wrapper, which raises a matching window
      // by WM_CLASS or execs the allowlisted launcher to spawn one.
      ...(action.kind === "focus" ? ["rakazo-focus-or-launch"] : []),
      browser ? "rakazo-browser" : action.application,
      ...(action.uri ? [action.uri] : []),
    ];
  }
  return { argv };
}

/** Image label of computers whose control service takes aimed and sideways scrolls. */
export const AIMED_SCROLL_CONTROL_LABEL = "rakazo.control.aimedScroll";

/**
 * Whether a computer's control service can run these actions. One built before aimed and
 * sideways scrolls refuses them mid-batch, after earlier steps have run, so such a batch goes
 * to the fallback whole instead.
 */
export function controlHandlesActions(
  labels: Record<string, string> | undefined,
  actions: ReadonlyArray<z.infer<typeof computerActionSchema>>,
) {
  if (labels?.[AIMED_SCROLL_CONTROL_LABEL] === "1") return true;
  return !actions.some(
    (action) =>
      action.kind === "scroll" &&
      ((action.x !== undefined && action.y !== undefined) ||
        action.direction === "left" ||
        action.direction === "right"),
  );
}

export function containerActionSteps(
  actions: Array<z.infer<typeof computerActionSchema>>,
  display = ":1",
  browserProfile?: string,
) {
  return actions.map((action) => containerActionStep(action, display, browserProfile));
}

export function normalizeWorkspaceRelative(value: string) {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("path escapes the computer workspace");
  }
  return segments.join("/");
}

export function workspaceTarget(relative: string) {
  return relative ? path.posix.join("/home/rakazo", relative) : "/home/rakazo";
}

export function sandboxTimeoutCommand(argv: string[], timeoutMs: number, completionMarker: string) {
  return [
    "timeout",
    "--kill-after=1s",
    `${timeoutMs / 1_000}s`,
    "sh",
    "-c",
    '"$@"; status=$?; if [ "$status" -eq 124 ]; then : > "$0"; fi; exit "$status"',
    completionMarker,
    ...argv,
  ];
}

export function sandboxCommandTimedOut(exitCode: number, completedWithExit124: boolean) {
  return exitCode === 124 && !completedWithExit124;
}

export function parseObservation(output: string) {
  const geometry = output.match(/^GEOM\s+(\d+)\s+(\d+)$/m);
  const cursorLine = output.match(/^CURSOR\s+(.+)$/m)?.[1] ?? "";
  const cursorX = Number(cursorLine.match(/X=(\d+)/)?.[1]);
  const cursorY = Number(cursorLine.match(/Y=(\d+)/)?.[1]);
  const windowId = output.match(/^WINDOW\s*(.*)$/m)?.[1]?.trim();
  const title = output.match(/^TITLE\s*(.*)$/m)?.[1]?.trim();
  const image = output.match(/^IMAGE\s+([A-Za-z0-9+/=]+)$/m)?.[1];
  if (!image) throw new Error("screen capture returned no image");
  return {
    image,
    mimeType: "image/png" as const,
    width: Number(geometry?.[1] ?? 1280),
    height: Number(geometry?.[2] ?? 800),
    ...(Number.isFinite(cursorX) && Number.isFinite(cursorY)
      ? { cursor: { x: cursorX, y: cursorY } }
      : {}),
    ...(windowId ? { activeWindow: { id: windowId, ...(title ? { title } : {}) } } : {}),
  };
}

/**
 * True when `buffer` is a complete Docker multiplexed stream: every frame has
 * type 0/1/2, its payload fits in the remaining bytes, and parsing ends exactly
 * at the buffer length. Otherwise the buffer is treated as raw (TTY) stdout.
 */
function isCompleteDockerMultiplexedStream(buffer: Buffer): boolean {
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) return false;
    const type = buffer[offset];
    if (type !== 0 && type !== 1 && type !== 2) return false;
    // Bytes 1–3 are reserved padding and must be zero in Docker's multiplex format.
    if (buffer[offset + 1] !== 0 || buffer[offset + 2] !== 0 || buffer[offset + 3] !== 0) {
      return false;
    }
    const size = buffer.readUInt32BE(offset + 4);
    if (offset + 8 + size > buffer.length) return false;
    offset += 8 + size;
  }
  return offset === buffer.length;
}

export interface DockerStreamChunk {
  stream: "stdout" | "stderr";
  data: string;
}

/**
 * Split docker exec frames as they arrive. A complete multiplexed stream matches
 * demuxDockerStream; an unfinished frame is held until its payload arrives.
 */
export function createDockerStreamDemuxer() {
  let mode: "pending" | "raw" | "multiplex" = "pending";
  let buffer = Buffer.alloc(0);
  // Docker splits output at arbitrary bytes, so a character can straddle two frames.
  const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };

  const consume = (final: boolean): DockerStreamChunk[] => {
    const events: DockerStreamChunk[] = [];
    if (mode === "raw") {
      if (buffer.length === 0) return events;
      events.push({ stream: "stdout", data: decoders.stdout.write(buffer) });
      buffer = Buffer.alloc(0);
      return events;
    }
    if (mode === "pending") {
      if (buffer.length === 0) return events;
      if (!final && buffer.length < 8) return events;
      const headerReady = buffer.length >= 8 && isDockerFrameHeader(buffer, 0);
      const frameReady = headerReady && firstDockerFrameComplete(buffer);
      if (!frameReady) {
        if (!final && headerReady) return events;
        mode = "raw";
        events.push({ stream: "stdout", data: decoders.stdout.write(buffer) });
        buffer = Buffer.alloc(0);
        return events;
      }
      mode = "multiplex";
    }
    let offset = 0;
    while (offset + 8 <= buffer.length && isDockerFrameHeader(buffer, offset)) {
      const size = buffer.readUInt32BE(offset + 4);
      if (offset + 8 + size > buffer.length) break;
      const stream = buffer[offset] === 2 ? "stderr" : "stdout";
      events.push({
        stream,
        data: decoders[stream].write(buffer.subarray(offset + 8, offset + 8 + size)),
      });
      offset += 8 + size;
    }
    buffer = Buffer.from(buffer.subarray(offset));
    if (final && buffer.length > 0 && mode === "multiplex") buffer = Buffer.alloc(0);
    return events;
  };

  return {
    push(chunk: Buffer) {
      if (chunk.length > 0) buffer = Buffer.concat([buffer, chunk]);
      return consume(false);
    },
    finish() {
      const events = consume(true);
      for (const stream of ["stdout", "stderr"] as const) {
        const rest = decoders[stream].end();
        if (rest) events.push({ stream, data: rest });
      }
      return events;
    },
  };
}

function isDockerFrameHeader(buffer: Buffer, offset: number): boolean {
  if (offset + 8 > buffer.length) return false;
  const type = buffer[offset];
  if (type !== 0 && type !== 1 && type !== 2) return false;
  return buffer[offset + 1] === 0 && buffer[offset + 2] === 0 && buffer[offset + 3] === 0;
}

function firstDockerFrameComplete(buffer: Buffer): boolean {
  if (!isDockerFrameHeader(buffer, 0)) return false;
  const size = buffer.readUInt32BE(4);
  return buffer.length >= 8 + size;
}

/**
 * Split a Docker exec stream into stdout and stderr. Without a TTY each frame is an
 * 8-byte header (type, 3 reserved bytes, big-endian length) plus payload; a raw (TTY)
 * stream, or anything that does not validate, is all stdout.
 */
export function demuxDockerStream(buffer: Buffer): { stdout: string; stderr: string } {
  if (!isCompleteDockerMultiplexedStream(buffer)) {
    return { stdout: buffer.toString("utf8"), stderr: "" };
  }
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    const payload = buffer.subarray(offset + 8, offset + 8 + size);
    (buffer[offset] === 2 ? stderr : stdout).push(payload);
    offset += 8 + size;
  }
  return {
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

/**
 * Environment for commands in a computer: the bot's shell tool and the user's terminal share
 * it. Neither exec sets a Docker `User`, so both run as the container's workspace user.
 */
export function computerCommandEnv(layout: { display: string }) {
  return [
    `DISPLAY=${layout.display}`,
    "HOME=/home/rakazo",
    "PATH=/home/rakazo/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "NPM_CONFIG_PREFIX=/home/rakazo/.local",
    "PIP_USER=1",
  ];
}

/** Resolve the inspected ID before removing, so a changed name cannot target another container. */
export async function removeOwnedComputer(
  named: Pick<Docker.Container, "inspect">,
  remove: (id: string) => Promise<unknown>,
  owns: (info: Docker.ContainerInspectInfo) => boolean,
  removed: (id: string) => void,
): Promise<boolean> {
  try {
    const info = await named.inspect();
    if (!info.Id || !owns(info)) return false;
    await remove(info.Id);
    removed(info.Id);
    return true;
  } catch {
    return false;
  }
}

/** Only create's 409 can reclaim an owned name holder; never retry start failures. */
export async function createComputerWithNameRetry<T>(
  create: () => Promise<T>,
  removeNamed: () => Promise<boolean>,
): Promise<T> {
  try {
    return await create();
  } catch (error) {
    if ((error as { statusCode?: number })?.statusCode !== 409 || !(await removeNamed())) {
      throw error;
    }
    return await create();
  }
}

export function isManagedComputer(
  info: Docker.ContainerInspectInfo,
  botId: string,
  spaceId: string,
  image: string,
) {
  const labels = info.Config.Labels ?? {};
  const managed = labels["rakazo.managed"] === "true" || info.Config.Image === image;
  return managed && hasComputerIdentity(labels, botId, spaceId);
}
