import { createHash } from "node:crypto";
import { posix } from "node:path";
import type {
  AdapterContext,
  AgentHomeStore,
  ConnectorProvider,
  ConnectorTool,
  JobPublisher,
  PaymentWalletProvider,
  SandboxProvider,
  SecretStore,
} from "@rakazo/adapter-kit";
import { routineJobKey, routineWakeupJob } from "@rakazo/adapter-kit";
import type { RoutineWatch, RoutineWatchState } from "@rakazo/contracts";
import { RoutineWatchSchema, RoutineWatchStateSchema } from "@rakazo/contracts";
import type { ActionApprovalRule } from "@rakazo/core";
import {
  connectorKindFromToolName,
  isAbandonedRequest,
  redactSecrets,
  watchToolRefusal,
} from "@rakazo/core";
import type { ComputerMode, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  listApprovalRules,
  parseComputerMode,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import {
  loadLoginPasswordRedactions,
  shellCommandEnvironment,
  VaultKeyUnavailableError,
} from "./bot-secrets.js";
import { scheduleComputerSleep } from "./computer-idle.js";
import { ComputerBusyError, provisionComputer } from "./computer-lifecycle.js";
import { resolveBotWorkspaceCwd, teamBotWorkspaceDirectory } from "./computer-support.js";
import { connectedContext, selectRunConnections } from "./connection-context.js";
import { nativeShellCommandArgv, usesNativeShell } from "./native-shell.js";
import { isEgressRefused } from "./network-address.js";
import { loadPurchaseRedactions } from "./purchase-service.js";
import { recordVaultItemUse } from "./vault-activity.js";
import type { SafeWebFetchOptions } from "./web-ssrf.js";
import { fetchSafeHttpRequest } from "./web-ssrf.js";

/**
 * The checker behind a routine's "when something changes" trigger. It never
 * calls a model: it fingerprints the watched thing and compares the result
 * with the last one, so a routine only spends a run when there is news.
 */

/** Virtual root for validating watch paths; providers resolve the actual workspace. */
const WORKSPACE = "/home/rakazo";
const CHECK_TIMEOUT_MS = 60_000;
/** Starting a stopped computer can take longer than a check; it gets its own budget. */
const PROVISION_TIMEOUT_MS = 5 * 60_000;
/** A busy or still-booting computer is tried again this soon, not counted as a failure. */
const RETRY_AFTER_MS = 60_000;
/** Above this, a files watch keeps only the fingerprint and reports a count. */
const MAX_TRACKED_ENTRIES = 2_000;
const MAX_DETAIL = 1_500;
const MAX_LISTED = 20;

export type RoutineWatchDeps = {
  prisma: PrismaClient;
  sandbox: SandboxProvider;
  home: AgentHomeStore;
  jobs: JobPublisher;
  events: ThreadEvents;
  dataDir?: string;
  connector?: ConnectorProvider;
  /** The shell tool's desktop-protection guard: why a command is refused on a graphical computer. */
  commandRefusal?: (command: string) => string | undefined;
  /** Decrypts Vault credentials. Absent, a command watch runs without them. */
  secretStore?: SecretStore;
  paymentWallet?: PaymentWalletProvider | null;
  /** HTTP transport and DNS boundary; destination checks and limits always stay enabled. */
  http?: Pick<SafeWebFetchOptions, "fetch" | "resolveHostname">;
};

export type RoutineWatchTarget = {
  id: string;
  spaceId: string;
  userId: string;
  botId: string;
  watch: unknown;
  watchState: unknown;
};

/** Thrown when a check cannot be completed; the routine is paused and the bot says why. */
export class RoutineWatchError extends Error {}

/** Thrown when a check cannot run yet for a passing reason; it is retried shortly, not paused. */
export class RoutineWatchRetry extends Error {}

export type RoutineWatchOutcome = {
  state: RoutineWatchState;
  /** True when the routine should run now. */
  changed: boolean;
};

export function parseRoutineWatch(value: unknown): RoutineWatch | null {
  if (value == null) return null;
  const parsed = RoutineWatchSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseRoutineWatchState(value: unknown): RoutineWatchState | null {
  if (value == null) return null;
  const parsed = RoutineWatchStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function nextRoutineWatchAt(watch: Pick<RoutineWatch, "everyMinutes">, from: Date): Date {
  return new Date(from.getTime() + watch.everyMinutes * 60_000);
}

/** What a watch looks at, in a few words, for messages and the routine list. */
export function describeRoutineWatch(watch: RoutineWatch): string {
  if (watch.kind === "files") return (watch.paths ?? []).join(", ");
  if (watch.kind === "command") return `\`${watch.command ?? ""}\``;
  // A status URL can contain an access token, so do not copy it into messages.
  if (watch.kind === "http") return "HTTPS endpoint";
  return watch.tool ?? "";
}

export async function checkRoutineWatch(
  deps: RoutineWatchDeps,
  routine: RoutineWatchTarget,
  now: Date = new Date(),
): Promise<RoutineWatchOutcome> {
  const watch = parseRoutineWatch(routine.watch);
  if (!watch) throw new RoutineWatchError("The change trigger's settings are not valid.");
  const previous = parseRoutineWatchState(routine.watchState);
  const reading =
    watch.kind === "http"
      ? await readHttp(deps, watch, routine.id)
      : watch.kind === "tool"
        ? await readTool(deps, routine, watch)
        : await readComputer(deps, routine, watch);
  return compareReading(previous, reading, now);
}

type Reading = {
  fingerprint: string;
  entries?: Record<string, string>;
  /** Shown when the reading differs from the last one. */
  detail: string | null;
  /** Hidden from a change description, which can name items from the last reading. */
  secrets?: readonly string[];
};

/** A structured public GET, never a shell command or an authenticated server session. */
async function readHttp(
  deps: RoutineWatchDeps,
  watch: RoutineWatch,
  routineId: string,
): Promise<Reading> {
  let response: Awaited<ReturnType<typeof fetchSafeHttpRequest>>;
  try {
    response = await fetchSafeHttpRequest(
      watch.url!,
      { method: "GET" },
      {
        ...deps.http,
        allowedPorts: [443],
        timeoutMs: 15_000,
        maxBytes: 1_000_000,
      },
    );
  } catch (error) {
    getLogger().warn("routine.http_check_failed", {
      "routine.id": routineId,
      "http.failure.kind": httpFailureKind(error),
    });
    // Keep destination refusals permanent even when the transport wraps one in its cause.
    if (isEgressRefused(error)) throw new RoutineWatchError("Could not check the HTTPS endpoint.");
    // Never expose a transport error's URL; it can carry a token in its path or query.
    throw new RoutineWatchRetry("Could not check the HTTPS endpoint.");
  }
  if (response.status === 408 || response.status === 429 || response.status >= 500)
    throw new RoutineWatchRetry(`HTTPS check returned status ${response.status}.`);
  if (response.status < 200 || response.status >= 300)
    throw new RoutineWatchError(`HTTPS check returned status ${response.status}.`);
  if (response.truncated) throw new RoutineWatchError("HTTPS check response is too large.");
  const text = new TextDecoder().decode(response.body);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    if (watch.track) throw new RoutineWatchError("Tracked HTTP fields require a JSON response.");
    return { fingerprint: sha256(text), detail: null };
  }
  // Bound recursion in the shared JSON comparators before handing them external data.
  const pending = [{ value: data, depth: 0 }];
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (value === null || typeof value !== "object") continue;
    if (depth > 64) throw new RoutineWatchError("HTTPS check JSON is too deeply nested.");
    for (const child of Object.values(value)) {
      if (child !== null && typeof child === "object")
        pending.push({ value: child, depth: depth + 1 });
    }
  }
  // Store only a fingerprint: endpoint data must not become trusted instructions or internal tool output.
  const fingerprint = watch.track
    ? readJsonItems(data, watch.track).fingerprint
    : sha256(stableStringify(data));
  return { fingerprint, detail: null };
}

const HTTP_FAILURE_CODES: Record<string, string> = {
  ENOTFOUND: "dns",
  EAI_AGAIN: "dns",
  ECONNREFUSED: "connection",
  ECONNRESET: "connection",
  EHOSTUNREACH: "connection",
  ENETUNREACH: "connection",
  ETIMEDOUT: "timeout",
  UND_ERR_CONNECT_TIMEOUT: "timeout",
  UND_ERR_HEADERS_TIMEOUT: "timeout",
  UND_ERR_BODY_TIMEOUT: "timeout",
  CERT_HAS_EXPIRED: "tls",
  ERR_TLS_CERT_ALTNAME_INVALID: "tls",
  DEPTH_ZERO_SELF_SIGNED_CERT: "tls",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "tls",
};

/** Only fixed categories leave this boundary: error names, codes, and messages may contain secrets. */
function httpFailureKind(error: unknown): string {
  if (isEgressRefused(error)) return "destination_refused";
  if (isAbandonedRequest(error)) return "timeout";
  let current = error;
  for (let depth = 0; current !== null && typeof current === "object" && depth < 4; depth += 1) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === "string" && Object.hasOwn(HTTP_FAILURE_CODES, code))
      return HTTP_FAILURE_CODES[code]!;
    current = cause;
  }
  return "transport";
}

/** Pure: decides baseline / unchanged / changed and describes the change. */
export function compareReading(
  previous: RoutineWatchState | null,
  reading: Reading,
  now: Date,
): RoutineWatchOutcome {
  const base = {
    checkedAt: now.toISOString(),
    fingerprint: reading.fingerprint,
    ...(reading.entries ? { entries: reading.entries } : {}),
  };
  // A first check, or the first good one after a failure, only records where things stand.
  if (!previous?.fingerprint) {
    return { changed: false, state: { ...base, outcome: "baseline", detail: null } };
  }
  if (previous.fingerprint === reading.fingerprint) {
    return { changed: false, state: { ...base, outcome: "unchanged", detail: null } };
  }
  const detail =
    reading.entries && previous.entries
      ? redactSecrets(
          describeEntryChanges(previous.entries, reading.entries),
          reading.secrets ?? [],
        )
      : reading.detail;
  return { changed: true, state: { ...base, outcome: "changed", detail } };
}

export function describeEntryChanges(
  before: Record<string, string>,
  after: Record<string, string>,
): string {
  const items = [...Object.values(before), ...Object.values(after)].some((signature) =>
    signature.startsWith(ITEM_SIGNATURE),
  );
  // Files are named by path; tracked items by the title saved in their signature.
  const name = (key: string, signature: string | undefined) =>
    items ? (itemTitle(signature) ?? key) : key;
  const added: string[] = [];
  const edited: string[] = [];
  const removed: string[] = [];
  for (const [key, signature] of Object.entries(after)) {
    if (!(key in before)) added.push(name(key, signature));
    else if (itemFields(before[key]) !== itemFields(signature)) edited.push(name(key, signature));
  }
  for (const key of Object.keys(before)) if (!(key in after)) removed.push(name(key, before[key]));
  const lines: string[] = [];
  const list = (label: string, names: string[]) => {
    if (!names.length) return;
    const shown = names.sort().slice(0, MAX_LISTED);
    const more = names.length - shown.length;
    lines.push(`${label}: ${shown.join(", ")}${more > 0 ? ` (and ${more} more)` : ""}`);
  };
  list("New", added);
  list(items ? "Updated" : "Edited", edited);
  list(items ? "Gone" : "Removed", removed);
  return lines.join("\n") || (items ? "The watched items changed." : "The watched files changed.");
}

/** Marks an item signature, so a note can name items by title rather than identity. */
const ITEM_SIGNATURE = "item:";
const TITLE_FIELDS = ["name", "title", "subject", "summary", "filename", "snippet"];

function itemTitle(signature: string | undefined): string | null {
  if (!signature?.startsWith(ITEM_SIGNATURE)) return null;
  try {
    const { title } = JSON.parse(signature.slice(ITEM_SIGNATURE.length)) as { title?: unknown };
    return typeof title === "string" && title ? title : null;
  } catch {
    return null;
  }
}

/** Titles are display details, never implicit tracked fields. */
function itemFields(signature: string | undefined): string | undefined {
  if (!signature?.startsWith(ITEM_SIGNATURE)) return signature;
  return stableStringify(
    (JSON.parse(signature.slice(ITEM_SIGNATURE.length)) as { fields: unknown }).fields,
  );
}

/**
 * The items in a JSON result, compared by the tracked fields only. Every object
 * anywhere in the result that carries the first field is an item; that field
 * is its identity, and the rest decide whether it was updated.
 */
export function readItems(
  data: unknown,
  track: readonly string[],
  secrets: readonly string[] = [],
): Reading {
  return readJsonItems(resultJson(data), track, secrets);
}

function readJsonItems(
  data: unknown,
  track: readonly string[],
  secrets: readonly string[] = [],
): Reading {
  const [identity, ...fields] = track;
  const items = new Map<string, { fields: string[]; titles: string[] }>();
  let count = 0;
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const id = identity ? record[identity] : undefined;
    if (typeof id === "string" || typeof id === "number") {
      const key = String(id);
      const item = items.get(key) ?? { fields: [], titles: [] };
      item.fields.push(stableStringify(fields.map((field) => record[field] ?? null)));
      const titleField = TITLE_FIELDS.find((field) => typeof record[field] === "string");
      if (titleField) item.titles.push(String(record[titleField]).slice(0, 120));
      items.set(key, item);
      count++;
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(redactJsonStrings(data, secrets));
  // IDs can repeat in nested results. Preserve every object's values, independent of order.
  const entries = Object.fromEntries(
    [...items].map(([id, item]) => [
      id,
      `${ITEM_SIGNATURE}${stableStringify({ fields: item.fields.sort(), title: item.titles.sort()[0] ?? null })}`,
    ]),
  );
  const fingerprint = sha256(
    stableStringify(
      Object.fromEntries(
        Object.entries(entries).map(([id, signature]) => [id, itemFields(signature)]),
      ),
    ),
  );
  return count > MAX_TRACKED_ENTRIES
    ? { fingerprint, detail: `${count} watched items; something among them changed.` }
    : { fingerprint, entries, detail: null, secrets };
}

/** A result as JSON: the parsed text of an MCP or text result, or the data itself. */
function resultJson(data: unknown): unknown {
  if (isMcpEnvelope(data)) {
    const structured = (data as { structuredContent?: unknown }).structuredContent;
    if (structured && typeof structured === "object" && !Array.isArray(structured)) {
      return structured;
    }
    const texts = toolResultTextParts(data);
    if (texts.length > 1) {
      try {
        return texts.map((text) => JSON.parse(text));
      } catch {
        // Some servers split one JSON document across text blocks instead.
      }
    }
  }
  const text = typeof data === "string" || isMcpEnvelope(data) ? toolResultText(data) : null;
  if (text === null) return data;
  try {
    return JSON.parse(text);
  } catch {
    throw new RoutineWatchError("The result is not JSON, so its tracked fields cannot be read.");
  }
}

function redactJsonStrings(value: unknown, secrets: readonly string[]): unknown {
  if (!secrets.length) return value;
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactJsonStrings(item, secrets));
  if (value && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      redacted[redactSecrets(key, secrets)] = redactJsonStrings(child, secrets);
    }
    return redacted;
  }
  return value;
}

function isMcpEnvelope(data: unknown): boolean {
  return Array.isArray((data as { content?: unknown } | null)?.content);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** JSON with sorted keys, so the same data always fingerprints the same. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_DETAIL ? `${trimmed.slice(0, MAX_DETAIL)}…` : trimmed;
}

function context(routine: RoutineWatchTarget): AdapterContext {
  const operationId = `watch:${routine.id}:${Date.now()}`;
  return {
    operationId,
    traceId: operationId,
    spaceId: routine.spaceId,
    userId: routine.userId,
    botId: routine.botId,
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  };
}

async function toolContext(
  prisma: PrismaClient,
  routine: RoutineWatchTarget,
): Promise<AdapterContext> {
  const rows = await prisma.connection.findMany({
    where: { userId: routine.userId, spaceId: routine.spaceId },
    select: {
      id: true,
      connectorId: true,
      provider: true,
      providerRef: true,
      displayName: true,
      status: true,
    },
  });
  return { ...context(routine), ...connectedContext(selectRunConnections(rows, [])) };
}

// Lists every file under each path as "path<TAB>size<TAB>mtime". A path that
// does not exist is reported rather than read as "no files", which would make
// a deleted folder look unchanged forever.
export const FILES_SCRIPT = `root="$1"; shift
if [ -n "$root" ]; then root=$(realpath -- "$root") || exit 1; fi
status=0
for p in "$@"; do
  if [ -e "$p" ]; then
    if [ -n "$root" ]; then
      actual=$(realpath -- "$p") || exit 1
      case "$actual" in "$root"|"$root"/*) ;; *) echo "Path escapes the bot folder" >&2; exit 1 ;; esac
    fi
    find -P "$p" -type f -printf '%p\\t%s\\t%T@\\n' || status=1
  else printf 'MISSING\\t%s\\n' "$p"; fi
done
exit "$status"`;

/** Team file checks stay in this bot's folder, including absolute paths. */
export function resolveWatchPath(mode: ComputerMode, botId: string, path: string): string {
  const folder = watchFolder(mode, botId);
  const resolved = posix.resolve(folder, path);
  if (mode === "team" && resolved !== folder && !resolved.startsWith(`${folder}/`)) {
    throw new RoutineWatchError("The watched path must stay inside the bot's folder.");
  }
  return resolved;
}

/** Where a bot's relative paths and commands start. */
export function watchFolder(mode: ComputerMode, botId: string): string {
  // Not resolveBotWorkspacePath(mode, botId, "."): a team computer refuses "." as escaping.
  return mode === "team" ? `${WORKSPACE}/${teamBotWorkspaceDirectory(botId)}` : WORKSPACE;
}

async function readComputer(
  deps: RoutineWatchDeps,
  routine: RoutineWatchTarget,
  watch: RoutineWatch,
): Promise<Reading> {
  const bot = await deps.prisma.bot.findUnique({
    where: { id: routine.botId },
    include: { computer: true },
  });
  if (!bot?.computer) throw new RoutineWatchError("This bot has no computer to check.");
  const mode = parseComputerMode(bot.computer.scope);
  if (watch.kind === "command") {
    // The guard reads bash, so it protects the Linux desktop and never a native shell.
    const guarded =
      !usesNativeShell(bot.computer.kind) && deps.sandbox.describe().capabilities.graphical;
    const refusal = guarded ? deps.commandRefusal?.(watch.command ?? "") : undefined;
    if (refusal) {
      throw new RoutineWatchError(
        `The check command is refused by the desktop-protection guard: ${refusal}.`,
      );
    }
  }
  // Loaded before the computer wakes, so a key manager outage defers the check without waking it.
  const secrets = new Set<string>();
  const secretStore = watch.kind === "command" ? deps.secretStore : undefined;
  const [commandEnvironment, loginRedactions, purchaseRedactions] = secretStore
    ? await Promise.all([
        shellCommandEnvironment({
          prisma: deps.prisma,
          secretStore,
          scope: { spaceId: routine.spaceId, userId: routine.userId, botId: bot.id },
          registerRedactions: (values) => {
            for (const value of values) secrets.add(value);
          },
        }),
        loadLoginPasswordRedactions(deps.prisma, secretStore, routine),
        deps.paymentWallet
          ? loadPurchaseRedactions({ prisma: deps.prisma, secretStore }, routine)
          : [],
      ])
    : [undefined, [], []];
  for (const value of [...loginRedactions, ...purchaseRedactions]) secrets.add(value);
  const ctx = context(routine);
  const computerId = bot.computer.id;
  let computer: Awaited<ReturnType<typeof provisionComputer>>;
  try {
    computer = await getLogger().withContext({ reason: "watch", watchKind: watch.kind }, () =>
      provisionComputer(deps, computerId, {
        ...ctx,
        signal: AbortSignal.timeout(PROVISION_TIMEOUT_MS),
      }),
    );
  } catch (error) {
    if (
      error instanceof ComputerBusyError ||
      (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))
    ) {
      throw new RoutineWatchRetry();
    }
    throw new RoutineWatchError(`Could not start the bot's computer: ${errorText(error)}`);
  }
  scheduleComputerSleep(deps.jobs, bot.computer.id);
  // The check's own time budget starts once the computer is up.
  const botFolder = watchFolder(mode, bot.id);
  const cwd = resolveBotWorkspaceCwd(mode, bot.id, undefined);
  ctx.signal = AbortSignal.timeout(CHECK_TIMEOUT_MS);

  if (watch.kind === "command") {
    // Runs this shell command on the bot's computer every interval, in its folder,
    // without a model or per-run approval: equivalent to the bot running it itself.
    const shellEnvironment = usesNativeShell(bot.computer.kind)
      ? await deps.sandbox.environment?.(computer, ctx)
      : undefined;
    const argv = shellEnvironment
      ? nativeShellCommandArgv(watch.command ?? "", shellEnvironment)
      : ["sh", "-lc", watch.command ?? ""];
    // The computer is sent the check with its variables here, so each is a use from then on,
    // recorded once the check ends, however it ends; a check refused or stopped before this got
    // none. It has no run or chat, and the audit log never throws, so the check never fails on it.
    const result = await run(
      deps,
      computer,
      ctx,
      argv,
      cwd,
      commandEnvironment && {
        env: Object.keys(commandEnvironment.env).length > 0 ? commandEnvironment.env : undefined,
        unsetEnv: commandEnvironment.unsetEnv,
      },
    ).finally(async () => {
      for (const item of commandEnvironment?.used ?? [])
        await recordVaultItemUse({
          bot,
          spaceId: routine.spaceId,
          // The routine's owner, whose vault the check reads.
          userId: routine.userId,
          tool: "routine_watch",
          item,
        });
    });
    const revealed = [...secrets];
    const stderr = redactSecrets(result.stderr, revealed);
    if (result.code !== 0) {
      throw new RoutineWatchError(
        `The check command exited with ${result.code}${stderr ? `: ${clip(stderr)}` : "."}`,
      );
    }
    // Pass the raw JSON. Parsing it here makes a `content` array look like an MCP envelope
    // on the second parse, and the watch pauses.
    if (watch.track) return readItems(result.stdout, watch.track, revealed);
    const stdout = redactSecrets(result.stdout, revealed);
    return { fingerprint: sha256(stdout), detail: clip(stdout) || null };
  }

  const paths = (watch.paths ?? []).map((path) => {
    const resolved = resolveWatchPath(mode, bot.id, path);
    const relative = posix.relative(botFolder, resolved);
    // Inside the workspace, pass the path relative to the provider's working
    // directory so a desktop computer resolves it under its own home.
    const outside = relative === ".." || relative.startsWith("../");
    if (mode !== "team" && (outside || posix.isAbsolute(relative))) return resolved;
    // `./` keeps a name such as `-reports` from being read as a `find` option.
    return !relative ? "." : outside ? relative : `./${relative}`;
  });
  const result = await run(
    deps,
    computer,
    ctx,
    ["sh", "-c", FILES_SCRIPT, "watch", mode === "team" ? "." : "", ...paths],
    cwd,
  );
  if (result.code !== 0) {
    throw new RoutineWatchError(
      `Could not list the watched files (exit ${result.code})${result.stderr ? `: ${clip(result.stderr)}` : "."}`,
    );
  }
  const entries: Record<string, string> = {};
  const missing: string[] = [];
  for (const line of result.stdout.split("\n")) {
    if (!line) continue;
    const [first, second, third] = line.split("\t");
    // Paths went in as `./name`; report them as the bot wrote them.
    if (first === "MISSING") missing.push((second ?? "").replace(/^\.\//, ""));
    else if (first) entries[first.replace(/^\.\//, "")] = `${second}:${third}`;
  }
  if (missing.length) {
    throw new RoutineWatchError(`Nothing exists at ${missing.join(", ")}.`);
  }
  const fingerprint = sha256(stableStringify(entries));
  const count = Object.keys(entries).length;
  return count > MAX_TRACKED_ENTRIES
    ? { fingerprint, detail: `${count} watched files; something among them changed.` }
    : { fingerprint, entries, detail: null };
}

async function run(
  deps: RoutineWatchDeps,
  computer: Awaited<ReturnType<typeof provisionComputer>>,
  ctx: AdapterContext,
  argv: string[],
  cwd: string | undefined,
  launch?: { env?: Record<string, string>; unsetEnv: string[] },
): Promise<{ stdout: string; stderr: string; code: number }> {
  let stdout = "";
  let stderr = "";
  let code = -1;
  try {
    for await (const event of deps.sandbox.execute(
      computer,
      {
        argv,
        cwd,
        timeoutMs: CHECK_TIMEOUT_MS,
        ...(launch?.env ? { env: launch.env } : {}),
        ...(launch ? { unsetEnv: launch.unsetEnv } : {}),
      },
      ctx,
    )) {
      if (event.type === "stdout") stdout += event.data;
      else if (event.type === "stderr") stderr += event.data;
      else if (event.type === "exit") code = event.code;
    }
  } catch (error) {
    throw new RoutineWatchError(`The check could not run on the computer: ${errorText(error)}`);
  }
  return { stdout, stderr, code };
}

async function readTool(
  deps: RoutineWatchDeps,
  routine: RoutineWatchTarget,
  watch: RoutineWatch,
): Promise<Reading> {
  const connector = deps.connector;
  if (!connector) throw new RoutineWatchError("No integrations are available to check.");
  const ctx = await toolContext(deps.prisma, routine);
  const toolName = watch.tool ?? "";
  let tools: Awaited<ReturnType<ConnectorProvider["discoverTools"]>>;
  try {
    tools = await connector.discoverTools(ctx);
  } catch (error) {
    throw new RoutineWatchError(`Could not list the integration's tools: ${errorText(error)}`);
  }
  // Discovery waits on every provider; the tool call gets its own full budget.
  ctx.signal = AbortSignal.timeout(CHECK_TIMEOUT_MS);
  const call = { tool: toolName, args: watch.args ?? {}, executionId: ctx.operationId };
  const tool = tools.find((candidate) => candidate.name === toolName);
  const resolved = tool
    ? { call: { ...call, route: tool.route }, tool }
    : await connector.resolveCall?.(call, ctx).catch(() => undefined);
  if (!resolved) {
    throw new RoutineWatchError(`No connected integration has a tool named ${toolName}.`);
  }
  const refusal = watchToolRefusal({
    toolName: resolved.tool.route?.connectionId ? resolved.tool.route.toolName : resolved.tool.name,
    toolAliases: [resolved.tool.name],
    connectorKind: connectorKindFromToolName(
      resolved.tool.route?.connectionId ? resolved.tool.route.toolName : resolved.tool.name,
      ctx.connectedConnections?.map((row) => row.externalId),
    ),
    readOnly: declaredRead(resolved.tool),
    rules: (await listApprovalRules(deps.prisma, {
      userId: routine.userId,
      spaceId: routine.spaceId,
    })) as ActionApprovalRule[],
  });
  if (refusal) throw new RoutineWatchError(refusal);
  let data: unknown;
  let failure: string | null = null;
  try {
    for await (const event of connector.execute(resolved.call, ctx)) {
      if (event.type === "result") data = event.data;
      else if (event.type === "error") failure = event.message;
    }
  } catch (error) {
    failure = errorText(error);
  }
  if (data && typeof data === "object") {
    const result = data as { isError?: boolean; error?: unknown };
    if (result.isError === true || result.error != null)
      failure = toolResultText(result.error ?? data);
  }
  if (failure) throw new RoutineWatchError(`${toolName} failed: ${clip(failure)}`);
  if (watch.track) return readItems(data, watch.track);
  // The fingerprint covers the whole result; only the note the bot reads is unwrapped.
  return {
    fingerprint: sha256(stableStringify(data ?? null)),
    detail: clip(toolResultText(data)),
  };
}

/**
 * What a tool returned, as text a bot can read: an MCP result's text parts
 * beside its structured copy, rather than its `{content:[{type:"text",text}]}`
 * envelope. A text block that only repeated the structured data is dropped on
 * the way in, so any text left is supplemental — the note needs both to keep
 * the details that triggered the routine. An error result keeps its text on the
 * way in; when the structured copy only repeats that text, the text alone is the
 * message, and any other diagnostic keeps the structured copy.
 */
export function toolResultText(data: unknown): string {
  if (typeof data === "string") return data;
  const texts = toolResultTextParts(data);
  const { structuredContent: structured, isError } =
    (data as { structuredContent?: unknown; isError?: unknown } | null) ?? {};
  const text = texts.join("\n");
  if (isError === true && text.trim() && repeatsErrorText(structured, text)) return text;
  if (structured && typeof structured === "object" && !Array.isArray(structured)) {
    const json = stableStringify(structured);
    return texts.length ? `${text}\n${json}` : json;
  }
  if (texts.length) return text;
  return stableStringify(data ?? null);
}

/**
 * Whether a structured error only repeats the error text: an object whose sole fields are
 * `error` or `message` strings the text already contains. Any other field is a diagnostic the
 * note keeps, with its key.
 */
function repeatsErrorText(data: unknown, text: string): boolean {
  if (data === null || data === undefined) return true;
  if (typeof data !== "object" || Array.isArray(data)) return false;
  return Object.entries(data).every(
    ([key, value]) =>
      (key === "error" || key === "message") && typeof value === "string" && text.includes(value),
  );
}

function toolResultTextParts(data: unknown): string[] {
  const content = (data as { content?: unknown } | null)?.content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (part): part is { type: "text"; text: string } =>
          (part as { type?: unknown })?.type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text);
  }
  return [];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type RoutineWatchTickDeps = RoutineWatchDeps & {
  jobs: JobPublisher;
};

type TickRoutine = RoutineWatchTarget & { name: string };

export type RoutineWatchTick =
  | { run: false }
  | { run: true; state: RoutineWatchState; nextRunAt: Date; note: string };

/** Starts the note a change trigger appends to a routine's prompt; what follows is not the owner's. */
const ROUTINE_WATCH_NOTE_START = "\n\nThis run was started because something you watch changed (";

/**
 * The owner's part of a routine run's task prompt, as saved when it fired: the routine's
 * instructions without the change note, whose detail comes from what the watch read.
 */
export function routineTaskInstructions(taskPrompt: string): string {
  const note = taskPrompt.indexOf(ROUTINE_WATCH_NOTE_START);
  return note === -1 ? taskPrompt : taskPrompt.slice(0, note);
}

/**
 * One scheduled check of a watching routine. Returns whether the routine
 * should run now; every other outcome is fully handled here: the next check is
 * scheduled, or the routine is paused and its bot says why.
 */
export async function tickRoutineWatch(
  deps: RoutineWatchTickDeps,
  routine: TickRoutine,
  target: { threadId: string; botId: string },
  scheduledAt: Date,
): Promise<RoutineWatchTick> {
  const watch = parseRoutineWatch(routine.watch);
  const previous = parseRoutineWatchState(routine.watchState);
  const now = new Date();
  let outcome: RoutineWatchOutcome;
  try {
    if (!watch) throw new RoutineWatchError("The change trigger's settings are not valid.");
    outcome = await checkRoutineWatch(deps, routine, now);
  } catch (error) {
    // Defer a key outage instead of pausing the routine.
    if (error instanceof RoutineWatchRetry || error instanceof VaultKeyUnavailableError) {
      if (error instanceof VaultKeyUnavailableError)
        getLogger().warn("routine.watch_deferred", { "routine.id": routine.id, error });
      const retryAt =
        watch?.kind === "http"
          ? nextRoutineWatchAt(watch, now)
          : new Date(now.getTime() + RETRY_AFTER_MS);
      const deferred = await deps.prisma.routine.updateMany({
        where: { id: routine.id, userId: routine.userId, active: true, nextRunAt: scheduledAt },
        data: {
          nextRunAt: retryAt,
          ...(watch?.kind === "http"
            ? {
                watchState: {
                  checkedAt: now.toISOString(),
                  outcome: "failed",
                  retrying: true,
                  fingerprint: previous?.fingerprint ?? null,
                  detail: error.message,
                } satisfies RoutineWatchState,
              }
            : {}),
        },
      });
      if (deferred.count === 1) {
        await deps.jobs.enqueue(routineWakeupJob(routine.id, retryAt));
        if (watch?.kind === "http" && previous?.retrying !== true) {
          await postRoutineWatchMessage(deps, {
            spaceId: routine.spaceId,
            ...target,
            role: "system",
            text: `The **${routine.name}** routine's HTTPS check failed: ${error.message} I'll keep checking.`,
          });
        }
      }
      return { run: false };
    }
    const reason = error instanceof Error ? error.message : String(error);
    const paused = await deps.prisma.routine.updateMany({
      where: { id: routine.id, userId: routine.userId, active: true, nextRunAt: scheduledAt },
      data: {
        active: false,
        nextRunAt: null,
        watchState: {
          checkedAt: now.toISOString(),
          outcome: "failed",
          fingerprint: previous?.fingerprint ?? null,
          ...(previous?.entries ? { entries: previous.entries } : {}),
          detail: reason,
        } satisfies RoutineWatchState,
      },
    });
    if (paused.count === 1) {
      await deps.jobs.cancel(routineJobKey(routine.id)).catch(() => undefined);
      await postRoutineWatchMessage(deps, {
        spaceId: routine.spaceId,
        ...target,
        role: "bot",
        text: `I paused the **${routine.name}** routine because its change check failed: ${reason}\n\nTell me how to fix it, or turn the routine back on once it's sorted.`,
      });
    }
    return { run: false };
  }
  const nextRunAt = nextRoutineWatchAt(
    watch,
    new Date(Math.max(now.getTime(), scheduledAt.getTime())),
  );
  if (outcome.changed) {
    return {
      run: true,
      state: outcome.state,
      nextRunAt,
      note: `${ROUTINE_WATCH_NOTE_START}${describeRoutineWatch(watch)}).\nWhat changed since the last check:\n${outcome.state.detail ?? "(no detail)"}`,
    };
  }
  const claimed = await deps.prisma.routine.updateMany({
    where: { id: routine.id, userId: routine.userId, active: true, nextRunAt: scheduledAt },
    data: { nextRunAt, watchState: outcome.state },
  });
  if (claimed.count !== 1) return { run: false };
  if (watch.loud) {
    await postRoutineWatchMessage(deps, {
      spaceId: routine.spaceId,
      ...target,
      role: "system",
      text:
        outcome.state.outcome === "baseline"
          ? `${routine.name} routine: watching for changes`
          : `${routine.name} routine: no changes`,
    });
  }
  await deps.jobs.enqueue(routineWakeupJob(routine.id, nextRunAt));
  return { run: false };
}

/** A line in the routine's thread without a model run. */
export async function postRoutineWatchMessage(
  deps: Pick<RoutineWatchDeps, "prisma" | "events">,
  input: {
    spaceId: string;
    threadId: string;
    botId: string;
    role: "bot" | "system";
    text: string;
  },
): Promise<void> {
  const blocks =
    input.role === "bot"
      ? [{ kind: "text" as const, text: input.text }]
      : [{ kind: "meta" as const, text: input.text }];
  try {
    const seq = await deps.prisma.$transaction(async (tx) => {
      const message = await createThreadMessageInTransaction(tx, {
        threadId: input.threadId,
        botId: input.botId,
        role: input.role,
        blocks,
      });
      const event = await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "thread.message.created",
        payload: { messageId: message.id, role: input.role, blocks },
      });
      return event.seq;
    });
    if (seq !== undefined) await deps.events.notify(input.threadId, seq).catch(() => undefined);
  } catch {
    // Best effort: the routine's state is already saved.
  }
}

export function assertWatchToolReadOnly(tool: string, readOnly: boolean | undefined): void {
  const refusal = watchToolRefusal({ toolName: tool, readOnly, rules: [] });
  if (refusal) throw new RoutineWatchError(refusal);
}

/** Validate without executing a tool or provisioning a computer. */
export async function validateRoutineWatch(
  deps: { connector?: ConnectorProvider; prisma?: PrismaClient },
  watch: RoutineWatch,
  target: { spaceId: string; userId: string; botId: string },
  computer?: { scope: string } | null,
): Promise<void> {
  if (watch.kind === "files" && computer) {
    for (const path of watch.paths ?? [])
      resolveWatchPath(parseComputerMode(computer.scope), target.botId, path);
  }
  // The API composition root has a registry, not the run's authorized connector.
  // Without that provider, tool metadata must be checked by readTool at runtime.
  if (watch.kind !== "tool" || !deps.connector) return;
  const routine = { ...target, id: "validate", watch, watchState: null };
  const ctx = deps.prisma ? await toolContext(deps.prisma, routine) : context(routine);
  const name = watch.tool ?? "";
  const tool =
    (await deps.connector.discoverTools(ctx)).find((tool) => tool.name === name) ??
    (
      await deps.connector.resolveCall?.(
        { tool: name, args: watch.args ?? {}, executionId: ctx.operationId },
        ctx,
      )
    )?.tool;
  if (!tool) throw new RoutineWatchError(`No connected integration has a tool named ${name}.`);
  assertWatchToolReadOnly(name, declaredRead(tool));
}

/** A batch runs whatever actions its arguments name, so it is never a declared read. */
function declaredRead(tool: ConnectorTool): boolean | undefined {
  return tool.batch ? undefined : tool.readOnly;
}
