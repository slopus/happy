import { createHash } from "node:crypto";
import type { AppEnv } from "./env.js";

/*
 * A support report a self-hoster can paste into a public issue. Everything printed is
 * allow-listed: booleans, counts, fixed enum values, opaque IDs and filtered health text.
 * Names, endpoints, commands, env values and message content are never read into it.
 */

export type DiagnosticsBot = { id: string; spaceId: string; userId: string; archived: boolean };

export type DiagnosticsServer = {
  id: string;
  spaceId: string;
  userId: string;
  transport: string;
  enabled: boolean;
  allSpaces: boolean;
  availableIn: string[];
  healthStatus: string;
  healthMessage: string | null;
  healthToolCount: number | null;
  healthCheckedAt: Date | null;
};

export type DiagnosticsAssignment = {
  botId: string;
  spaceId: string;
  userId: string;
  server: DiagnosticsServer;
};

export type DiagnosticsRun = {
  id: string;
  botId: string;
  status: string;
  trigger: string;
  createdAt: Date;
};

export type DiagnosticsInput = {
  env: Pick<
    AppEnv,
    | "gitSha"
    | "nodeEnv"
    | "agentRuntime"
    | "sandboxProvider"
    | "cloudAgentProvider"
    | "deploymentModelConfigured"
    | "contentEncryption"
    | "wakeupDriver"
    | "mcpStdioEnabled"
    | "mcpStdioAllowedCommands"
    | "mcpAllowPrivateEndpoint"
    | "ticketBoardEnabled"
    | "userDevicesEnabled"
    | "phoneCallsEnabled"
  > & { secretStore: string };
  nodeVersion: string;
  database:
    | { reachable: false }
    | {
        reachable: true;
        migrationsInImage: string[];
        /** Undefined when the app's database login may not read the migration table. */
        appliedMigrations?: string[];
        failedMigrations?: number;
      };
  bots: DiagnosticsBot[];
  assignments: DiagnosticsAssignment[];
  unassignedServers: DiagnosticsServer[];
  runs: DiagnosticsRun[];
};

export function renderDiagnostics(input: DiagnosticsInput): string {
  const { env } = input;
  const lines = [
    "## Rakazo diagnostics",
    "",
    `- Revision: ${token(env.gitSha, /^[0-9a-f]{7,40}$/) ?? "unknown"}`,
    `- Node: ${token(input.nodeVersion, /^v\d+\.\d+\.\d+$/) ?? "unknown"}`,
    `- NODE_ENV: ${word(env.nodeEnv)}`,
    `- AGENT_RUNTIME: ${word(env.agentRuntime)}`,
    `- Sandbox provider: ${word(env.sandboxProvider)}`,
    `- Cloud agent provider: ${word(env.cloudAgentProvider)}`,
    `- Deployment model configured: ${onOff(env.deploymentModelConfigured)}`,
    `- Secret store: ${word(env.secretStore)}`,
    `- Content encryption: ${onOff(env.contentEncryption)}`,
    `- Wakeup driver: ${word(env.wakeupDriver)}`,
    `- MCP_STDIO_ENABLED: ${onOff(env.mcpStdioEnabled)}`,
    `- MCP_STDIO_ALLOWED_COMMANDS: ${env.mcpStdioAllowedCommands.length}`,
    `- MCP_ALLOW_PRIVATE_ENDPOINT: ${onOff(env.mcpAllowPrivateEndpoint)}`,
    `- Ticket board: ${onOff(env.ticketBoardEnabled)}`,
    `- User devices: ${onOff(env.userDevicesEnabled)}`,
    `- Phone calls: ${onOff(env.phoneCallsEnabled)}`,
    "",
    "### Database",
    "",
    ...databaseLines(input.database),
  ];
  if (!input.database.reachable) return `${lines.join("\n")}\n`;

  const archived = input.bots.filter((bot) => bot.archived).length;
  lines.push("", `### Bots`, "", `- Bots: ${input.bots.length} (${archived} archived)`);
  const bots = new Map(input.bots.map((bot) => [bot.id, bot]));
  const byBot = new Map<string, DiagnosticsAssignment[]>();
  for (const assignment of input.assignments)
    byBot.set(assignment.botId, [...(byBot.get(assignment.botId) ?? []), assignment]);
  for (const [botId, assignments] of byBot) {
    const bot = bots.get(botId);
    lines.push(
      "",
      `#### Bot ${opaque(botId)}${bot?.archived ? " (archived)" : ""}`,
      "",
      "| Server | Transport | Enabled | Health | Tools | Checked | Assignment | Message |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      ...assignments.map((assignment) =>
        serverRow(assignment.server, bot ? assignmentProblems(assignment, bot) : ["bot missing"]),
      ),
    );
  }
  if (input.unassignedServers.length) {
    lines.push(
      "",
      "#### MCP servers on no bot",
      "",
      "| Server | Transport | Enabled | Health | Tools | Checked | Assignment | Message |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      ...input.unassignedServers.map((server) => serverRow(server, [])),
    );
  }

  lines.push("", "### Latest runs", "");
  if (!input.runs.length) lines.push("- None");
  else
    lines.push(
      "| Run | Bot | Status | Trigger | Created |",
      "| --- | --- | --- | --- | --- |",
      ...input.runs.map(
        (run) =>
          `| ${opaque(run.id)} | ${opaque(run.botId)} | ${word(run.status)} | ${word(run.trigger)} | ${run.createdAt.toISOString()} |`,
      ),
    );
  return `${lines.join("\n")}\n`;
}

function databaseLines(database: DiagnosticsInput["database"]): string[] {
  if (!database.reachable) return ["- Connection: failed"];
  const image = database.migrationsInImage;
  const lines = [
    "- Connection: ok",
    `- Migrations in image: ${image.length}${image.length ? ` (latest ${migrationName(image.at(-1)!)})` : ""}`,
  ];
  if (!database.appliedMigrations) {
    lines.push("- Applied migrations: not readable by the app's database login");
    return lines;
  }
  const applied = new Set(database.appliedMigrations);
  const pending = image.filter((name) => !applied.has(name));
  lines.push(
    `- Applied migrations: ${applied.size}`,
    `- Failed migrations: ${database.failedMigrations ?? 0}`,
    `- Pending: ${pending.length ? pending.slice(0, 5).map(migrationName).join(", ") : "none"}`,
  );
  return lines;
}

/** Why `McpConnector.authorizedTools` would drop this assignment for the bot's runs. */
function assignmentProblems(assignment: DiagnosticsAssignment, bot: DiagnosticsBot): string[] {
  const { server } = assignment;
  const problems: string[] = [];
  if (assignment.spaceId !== bot.spaceId) problems.push("space differs from bot");
  if (assignment.userId !== bot.userId) problems.push("user differs from bot");
  if (server.userId !== assignment.userId) problems.push("user differs from server");
  if (
    server.spaceId !== assignment.spaceId &&
    !server.allSpaces &&
    !server.availableIn.includes(assignment.spaceId)
  )
    problems.push("server not available in space");
  return problems;
}

function serverRow(server: DiagnosticsServer, problems: string[]): string {
  return `| ${[
    opaque(server.id),
    word(server.transport),
    onOff(server.enabled),
    word(server.healthStatus),
    server.healthToolCount ?? "-",
    server.healthCheckedAt?.toISOString() ?? "-",
    problems.length ? problems.join("; ") : "ok",
    server.healthMessage ? safeMessage(server.healthMessage) : "-",
  ].join(" | ")} |`;
}

/** A stable short stand-in so rows can be correlated without exposing the real ID. */
export function opaque(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 8);
}

// Words seen in MCP launch, transport, OAuth and network errors. Anything else is dropped, so a
// user, package or command name in free-form error text never reaches the report.
const MESSAGE_VOCABULARY = new Set(
  `a about after allowed allowlist already an and any api are as at auth authorization authorized be because before
  bin by call called calling can cannot changed check client closed code command configured connect
  connected connecting connection could credentials declare denied did does during endpoint error
  exceeds exited expired explicitly failed file final fetch for found fragment from handshake has
  have host http https in install installed installing invalid is it its json key launch launches
  list listing missing mcp must name network no not npm npx oauth of on only or package permission
  permitted pkce process protocol redirect redirects refresh refused registration request required
  reset response retry run running secret server session signal spawn state status stdio stopped
  supported the this timed timeout to token tools too try unauthorized unavailable unknown unreachable
  url use was while with`.split(/\s+/),
);
const ERROR_CODE = /^E[A-Z]{2,}$/;
const NUMBER = /^-?\d{1,5}$/;
const MESSAGE_MAX_WORDS = 40;

/**
 * Keeps only words from a fixed vocabulary, error codes and short numbers from an error message;
 * every other word (names, URLs, paths, emails, tokens, anything quoted) becomes "…".
 */
export function safeMessage(message: string): string {
  const out: string[] = [];
  let quoted = false;
  for (const raw of message.split(/\s+/).filter(Boolean).slice(0, MESSAGE_MAX_WORDS)) {
    const quotes = raw.match(/["'`]/g)?.length ?? 0;
    const inQuote = quoted || quotes > 0;
    if (quotes % 2) quoted = !quoted;
    const match = /^([([]?)(.*?)([)\]]?[.,:;!?]?)$/.exec(raw)!;
    const core = match[2]!;
    const trailing = match[3]!.replace(/[^.,:;!?]/g, "");
    const kept =
      !inQuote &&
      (MESSAGE_VOCABULARY.has(core.toLowerCase()) || ERROR_CODE.test(core) || NUMBER.test(core));
    const next = kept ? core + trailing : "…";
    if (!(next === "…" && out.at(-1) === "…")) out.push(next);
  }
  return out.join(" ");
}

/** Fixed enum-like values (status, trigger, provider id) or "other". */
function word(value: string | undefined): string {
  return token(value, /^[a-z][a-z0-9_-]{0,31}$/) ?? "other";
}

function token(value: string | undefined, pattern: RegExp): string | undefined {
  return value && pattern.test(value) ? value : undefined;
}

function migrationName(name: string): string {
  return token(name, /^\d{14}_[a-z0-9_]{1,80}$/) ?? "other";
}

function onOff(value: boolean): string {
  return value ? "on" : "off";
}
