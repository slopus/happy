import { createHash } from "node:crypto";
import path from "node:path";
import type { ComputerAction, ComputerObservation, ComputerRef } from "@rakazo/adapter-kit";
import type { ComputerMode } from "@rakazo/contracts";
import { DEFAULT_COMPUTER_SCREEN } from "@rakazo/core";

/** The boat image ships a 1080p screen; every other sandbox uses the core default. */
const BOAT_COMPUTER_SCREEN = { width: 1920, height: 1080 } as const;

export function computerScreenSize(kind: string | null | undefined): {
  width: number;
  height: number;
} {
  return kind === "boat" ? BOAT_COMPUTER_SCREEN : DEFAULT_COMPUTER_SCREEN;
}

export function toComputerRef(computer: {
  homeKey: string;
  kind: string;
  providerRef: string | null;
}): ComputerRef {
  if (!computer.providerRef) throw new Error("computer provider reference is missing");
  return {
    id: computer.providerRef,
    botId: computer.homeKey,
    kind: computer.kind as ComputerRef["kind"],
    providerRef: computer.providerRef,
  };
}

const EMPTY_PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

export function computerObservation(
  image: Uint8Array,
  input: Omit<ComputerObservation, "frameId" | "capturedAt" | "image">,
): ComputerObservation {
  return {
    ...input,
    image,
    frameId: createHash("sha256").update(image).digest("hex"),
    capturedAt: new Date().toISOString(),
  };
}

export function placeholderObservation(label = "ready"): ComputerObservation {
  return computerObservation(EMPTY_PNG, {
    mimeType: "image/png",
    width: 1,
    height: 1,
    activeWindow: { id: "placeholder", title: label },
  });
}

export function applyPlaceholderAction(box: { screen: string }, action: ComputerAction): void {
  if (action.kind === "clipboard") box.screen = action.text;
  else if (action.kind === "open") box.screen = `opened ${action.path}`;
  else if (action.kind === "launch") box.screen = `launched ${action.application}`;
  else if (action.kind === "focus") box.screen = `focused ${action.application}`;
  else box.screen = action.kind;
}

export function boundedComputerActions(actions: readonly ComputerAction[]): ComputerAction[] {
  if (actions.length > 24) throw new Error("computer action batch exceeds 24 actions");
  return [...actions];
}

export function clampRounded(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), max);
}

export function normalizeWorkspacePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Path escapes the computer workspace");
  }
  return segments.join("/");
}

export function workspacePath(root: string, relative: string): string {
  const normalized = normalizeWorkspacePath(relative);
  return normalized ? path.posix.join(root, normalized) : root;
}

/** The workspace path bots see on every computer. */
const VIRTUAL_HOME = "/home/rakazo";

/**
 * The directory a command runs in. Empty, ".", "/", the workspace root and any home alias
 * mean the root; absolute paths under one of them keep their tail; anything else is taken
 * relative to the root. "." and ".." segments throw, so a cwd cannot leave the workspace.
 */
export function workspaceCwd(
  root: string,
  cwd: string | undefined,
  homes: readonly string[] = [],
): string {
  if (!cwd || cwd === "." || cwd === "/") return root;
  for (const prefix of [root, VIRTUAL_HOME, ...homes]) {
    if (cwd === prefix) return root;
    if (cwd.startsWith(`${prefix}/`)) return workspacePath(root, cwd.slice(prefix.length + 1));
  }
  return workspacePath(root, cwd);
}

export function teamBotWorkspaceDirectory(botId: string): string {
  return path.posix.join("bots", normalizeWorkspacePath(botId));
}

export function teamWorkspaceInstruction(botId: string): string {
  const home = teamBotWorkspaceDirectory(botId);
  const sharedFromShell = `${path.posix.relative(home, "shared")}/`;
  return `Your Team Computer home is ${home}. Relative file paths and shell working directories start there. Put intentionally shared work under shared/. File tools resolve shared/ and bots/ from the Team root, but shell commands do not: from your home, a shell command reaches shared work as ${sharedFromShell}, and a shell cwd of shared starts in it. Other bots' folders are visible under bots/; treat them as their working areas.`;
}

export function resolveBotWorkspacePath(
  scope: ComputerMode,
  botId: string,
  rawPath: string,
): string {
  const requestedPath = expandHomePrefix(rawPath);
  if (scope !== "team") return requestedPath;
  const explicitRootPath = stripVirtualWorkspaceRoot(requestedPath);
  const normalized = normalizeWorkspacePath(explicitRootPath ?? requestedPath);
  if (explicitRootPath !== null || isTeamRootPath(normalized)) return normalized;
  return path.posix.join(teamBotWorkspaceDirectory(botId), normalized);
}

export function resolveBotWorkspaceCwd(
  scope: ComputerMode,
  botId: string,
  requestedCwd: string | undefined,
): string | undefined {
  if (scope !== "team") {
    if (requestedCwd === undefined) return undefined;
    const expanded = expandHomePrefix(requestedCwd);
    if (expanded === requestedCwd) return requestedCwd;
    return stripVirtualWorkspaceRoot(expanded) || undefined;
  }
  if (!requestedCwd || requestedCwd === ".") return teamBotWorkspaceDirectory(botId);
  if (path.posix.isAbsolute(requestedCwd) || path.win32.isAbsolute(requestedCwd))
    return requestedCwd;
  return resolveBotWorkspacePath(scope, botId, requestedCwd);
}

/** Paths a user may write while controlling this bot: its home, or shared/. */
export function resolveBotUploadPath(
  scope: ComputerMode,
  botId: string,
  requestedPath: string,
): string {
  const stored = resolveBotWorkspacePath(scope, botId, requestedPath);
  if (scope !== "team") return normalizeWorkspacePath(stored);
  const normalized = normalizeWorkspacePath(stored);
  const botDirectory = teamBotWorkspaceDirectory(botId);
  if (
    normalized === botDirectory ||
    normalized.startsWith(`${botDirectory}/`) ||
    normalized === "shared" ||
    normalized.startsWith("shared/")
  ) {
    return normalized;
  }
  throw new Error("Path escapes the bot workspace");
}

export function displayBotWorkspacePath(
  scope: ComputerMode,
  botId: string,
  requestedPath: string,
  storedPath: string,
): string {
  if (scope !== "team" || !isBotRelativeRequest(requestedPath)) return storedPath;
  const normalized = normalizeWorkspacePath(storedPath);
  const botDirectory = teamBotWorkspaceDirectory(botId);
  if (normalized === botDirectory) return "";
  return normalized.startsWith(`${botDirectory}/`)
    ? normalized.slice(botDirectory.length + 1)
    : normalized;
}

function isBotRelativeRequest(value: string): boolean {
  if (stripVirtualWorkspaceRoot(expandHomePrefix(value)) !== null) return false;
  return !isTeamRootPath(normalizeWorkspacePath(value));
}

function isTeamRootPath(value: string): boolean {
  return (
    value === "shared" ||
    value.startsWith("shared/") ||
    value === "bots" ||
    value.startsWith("bots/")
  );
}

// A leading ~ or /home/rakazo means the workspace root, the same as a leading /.
function expandHomePrefix(value: string): string {
  return value.replace(
    /^(?:~|[\\/]home[\\/]rakazo)([\\/]|$)/,
    (_, separator: string) => separator || "/",
  );
}

function stripVirtualWorkspaceRoot(value: string): string | null {
  const portable = value.replace(/\\/g, "/");
  if (portable === "/") return "";
  return portable.startsWith("/") ? portable.slice(1) : null;
}

export { shellQuote } from "@rakazo/core/node/desktop-runtime";
