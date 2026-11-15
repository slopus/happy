import { z } from "zod";
import type { BotSecretMetadata } from "./bot-secrets.js";
import {
  BotSecretDestination,
  DEFAULT_LOGIN_FIELD_LABELS,
  LoginSecretValue,
  VAULT_ITEM_LIMIT,
  VaultItemTitle,
} from "./bot-secrets.js";
import { settingsScopeInput } from "./settings-scope.js";

export const VAULT_IMPORT_FILE_LIMIT = 5_000_000;

/** One login read from an export file on the person's device. The file itself never leaves it. */
export const VaultImportRow = z.strictObject({
  title: VaultItemTitle,
  origin: z.string().max(2048),
  username: z.string().max(4096),
  password: z.string().max(4096),
});
export type VaultImportRow = z.infer<typeof VaultImportRow>;

export const VaultImportInput = settingsScopeInput.extend({
  rows: z.array(VaultImportRow).min(1).max(VAULT_ITEM_LIMIT),
});
export type VaultImportInput = z.infer<typeof VaultImportInput>;

const count = z.number().int().min(0);
export const VaultImportSkipped = z.strictObject({
  notHttps: count,
  noPassword: count,
  duplicate: count,
  invalid: count,
  limit: count,
});
export type VaultImportSkipped = z.infer<typeof VaultImportSkipped>;
const VaultImportReason = z.enum(["notHttps", "noPassword", "duplicate", "invalid", "limit"]);
export type VaultImportReason = z.infer<typeof VaultImportReason>;
export const VaultImportResult = z.strictObject({
  added: count,
  skipped: VaultImportSkipped,
  /** Each sent row that wasn't saved, by its place in the rows sent. */
  notSaved: z
    .array(z.strictObject({ index: count, reason: VaultImportReason }))
    .max(VAULT_ITEM_LIMIT),
});
export type VaultImportResult = z.infer<typeof VaultImportResult>;

export function noneSkipped(): VaultImportSkipped {
  return { notHttps: 0, noPassword: 0, duplicate: 0, invalid: 0, limit: 0 };
}

// Common column names, compared without case, spaces or punctuation.
const COLUMNS = {
  title: ["name", "title", "account", "accountname", "itemname"],
  url: ["url", "uri", "loginuri", "loginurl", "website", "websiteurl", "site", "web", "hostname"],
  // Several may be present: each row uses the first that isn't empty.
  username: [
    "username",
    "user",
    "login",
    "loginusername",
    "loginname",
    "userid",
    "email",
    "emailaddress",
  ],
  password: ["password", "loginpassword", "pass"],
} as const;
type Column = keyof typeof COLUMNS;

/**
 * Rows and fields of a CSV text (RFC 4180): quoted fields may hold commas, quotes and line breaks.
 * Any other quote makes the text unreadable, as reading past it would change a value. Each record
 * comes with the line of the text it starts on.
 */
function csvRecords(text: string): { records: string[][]; starts: number[] } | undefined {
  const records: string[][] = [];
  const starts: number[] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let closed = false;
  let line = 1;
  let start = 1;
  for (let index = text.charCodeAt(0) === 0xfeff ? 1 : 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char !== '"') {
        field += char;
        if (char === "\n" || (char === "\r" && text[index + 1] !== "\n")) line++;
      } else if (text[index + 1] === '"') {
        field += '"';
        index++;
      } else [quoted, closed] = [false, true];
      continue;
    }
    if (closed && char !== "," && char !== "\n" && char !== "\r") return undefined;
    closed = false;
    if (char === '"') {
      if (field !== "") return undefined;
      quoted = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      record.push(field);
      records.push(record);
      starts.push(start);
      start = ++line;
      record = [];
      field = "";
    } else field += char;
  }
  if (quoted) return undefined;
  if (field !== "" || record.length) {
    records.push([...record, field]);
    starts.push(start);
  }
  return { records, starts };
}

const blank = (record: string[]) => record.every((value) => value.trim() === "");

/** A row the import leaves out, as the review names it: never a username, password or key. A
 * repeat of an earlier row is named so until the server answers for that row. */
export type VaultImportProblem = {
  line: number;
  label: string;
  reason: VaultImportReason | "repeat";
};

export type VaultCsv =
  | {
      rows: VaultImportRow[];
      /** The file's line each row starts on. */
      lines: number[];
      skipped: VaultImportSkipped;
      problems: VaultImportProblem[];
    }
  | { error: "too_large" | "unreadable" | "no_logins" };

/**
 * The logins in a password manager's CSV export, matched by column name, never by vendor. A row
 * that can't be saved is only counted: one without a password, whose site isn't HTTPS, or with a
 * value too long to save. Only a title, which is a label, is shortened to fit; notes stay in the file.
 */
export function parseVaultCsv(text: string): VaultCsv {
  if (text.length > VAULT_IMPORT_FILE_LIMIT) return { error: "too_large" };
  const read = csvRecords(text);
  if (!read) return { error: "unreadable" };
  const { records, starts } = read;
  // Blank records are skipped. A row is named by the file's line it starts on, the header's being
  // 1, so a note on several lines never shifts the rows after it.
  const start = records.findIndex((record) => !blank(record));
  const header = records[start] ?? [];
  const body = start < 0 ? [] : records.slice(start + 1);
  const keys = header.map((name) => name.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const columns = Object.fromEntries(
    (Object.keys(COLUMNS) as Column[]).map((column) => [
      column,
      COLUMNS[column].flatMap((alias) =>
        keys.flatMap((key, index) => (key === alias ? [index] : [])),
      ),
    ]),
  ) as Record<Column, number[]>;
  if (!columns.url.length || !columns.password.length) return { error: "no_logins" };
  // Trimmed, so never used for the password: that is read below exactly as the file has it.
  const value = (record: string[], column: Column) =>
    columns[column].map((index) => (record[index] ?? "").trim()).find(Boolean) ?? "";
  const skipped = noneSkipped();
  const rows: VaultImportRow[] = [];
  const lines: number[] = [];
  const problems: VaultImportProblem[] = [];
  for (const [index, record] of body.entries()) {
    if (blank(record)) continue;
    const line = starts[start + 1 + index] ?? 0;
    // More cells than the header: a comma in an unquoted value shifted them, so no cell can be
    // trusted, not even as the row's name.
    if (record.length > header.length) {
      skipped.invalid++;
      problems.push({ line, label: "", reason: "invalid" });
      continue;
    }
    const origin = vaultImportOrigin(value(record, "url"));
    // The first that isn't empty, as for the other columns, but a password keeps its spaces.
    const password = columns.password.map((index) => record[index] ?? "").find(Boolean) ?? "";
    const row = VaultImportRow.safeParse({
      title: shortTitle(value(record, "title")).trim(),
      origin,
      username: value(record, "username"),
      password,
    });
    const reason: VaultImportReason | undefined = !origin
      ? "notHttps"
      : !password
        ? "noPassword"
        : // Also what the server refuses: a site no login may be for, or a value too long once saved.
          !row.success ||
            // Any name: the server picks one, so only the site is checked here.
            !BotSecretDestination.safeParse({ name: "login", origin, auth: { type: "login" } })
              .success ||
            !LoginSecretValue.safeParse(vaultImportLogin(row.data)).success
          ? "invalid"
          : undefined;
    if (reason) {
      skipped[reason]++;
      const title = shortTitle(value(record, "title"));
      problems.push({
        line,
        label: title || (origin ? new URL(origin).host : ""),
        reason,
      });
    } else if (row.success) {
      rows.push(row.data);
      lines.push(line);
    }
  }
  return { rows, lines, skipped, problems };
}

/** The login an import saves for a row: its username, when it has one, and its password. */
export function vaultImportLogin(row: VaultImportRow): LoginSecretValue {
  const [username, password] = DEFAULT_LOGIN_FIELD_LABELS;
  return {
    fields: [
      ...(row.username.trim() ? [{ label: username, value: row.username, hidden: false }] : []),
      { label: password, value: row.password, hidden: true },
    ],
  };
}

// 80 UTF-16 units, as a title holds, without leaving half of a character such as an emoji.
const shortTitle = (text: string) => text.slice(0, 80).replace(/[\uD800-\uDBFF]$/, "");

/**
 * A cell may list several sites, split by commas or lines; the login is saved for the first HTTPS
 * one. A site written without a scheme, as some exports do, is taken as HTTPS when its host has a
 * dot, and a host's trailing dot is dropped. Other text, such as "my bank.com", is no site. The
 * server reads each row sent again with it, so the same site is found already saved.
 */
export function vaultImportOrigin(cell: string): string | undefined {
  for (const site of cell.split(/[,\r\n]+/).map((part) => part.trim())) {
    const bare = !site.includes("://");
    const url = bare ? `https://${site}` : site;
    if (!URL.canParse(url)) continue;
    const parsed = new URL(url);
    if (bare && !parsed.hostname.includes(".")) continue;
    parsed.hostname = parsed.hostname.replace(/\.$/, "");
    if (parsed.protocol === "https:" && !parsed.username && !parsed.password) return parsed.origin;
  }
  return undefined;
}

/**
 * The rows to send: a login already saved for the same site (its own or one it is also on) and
 * username is left out and counted. Usernames are what the list previews. Every other row is sent
 * once, up to what one import takes: the server decides under its lock which are new and which
 * fit, so a row it refuses never takes a place the next one could use. A repeat in the file takes
 * no place either; it gets the answer its first copy gets.
 */
/**
 * What makes two logins one to an import: the site and the username, trimmed. The one rule for
 * the review's plan here and for the server's check as it saves, which has the last word.
 */
export const vaultLoginKey = (origin: string, username = "") =>
  JSON.stringify([origin, username.trim()]);

export function newVaultImportRows(
  rows: readonly VaultImportRow[],
  saved: readonly BotSecretMetadata[],
  lines: readonly number[] = [],
): {
  rows: VaultImportRow[];
  lines: number[];
  duplicate: number;
  /** Logins that look past the room left in the Vault, before the server says. */
  full: number;
  /** Of those, the ones sent all the same. */
  pastRoom: number;
  problems: VaultImportProblem[];
  /** Rows repeating a sent one, with the place of the one they follow. */
  repeats: (VaultImportProblem & { of: number })[];
} {
  const key = vaultLoginKey;
  const known = new Set(
    saved.flatMap((item) =>
      // One whose value the list couldn't read may be anyone's: the server checks it.
      item.auth?.type === "login" && item.preview
        ? [item.origin, ...(item.alsoOn ?? [])].map((site) => key(site, item.preview?.username))
        : [],
    ),
  );
  const plan = {
    rows: [] as VaultImportRow[],
    lines: [] as number[],
    problems: [] as VaultImportProblem[],
    repeats: [] as (VaultImportProblem & { of: number })[],
  };
  const sent = new Map<string, number>();
  for (const [index, row] of rows.entries()) {
    const line = lines[index] ?? index + 1;
    const id = key(row.origin, row.username);
    const of = sent.get(id);
    if (of !== undefined) {
      plan.repeats.push({ line, label: importLabel(row), reason: "repeat", of });
      continue;
    }
    const reason = known.has(id)
      ? "duplicate"
      : plan.rows.length >= VAULT_ITEM_LIMIT
        ? "limit"
        : undefined;
    if (reason) plan.problems.push({ line, label: importLabel(row), reason });
    else {
      sent.set(id, plan.rows.length);
      plan.rows.push(row);
      plan.lines.push(line);
    }
  }
  const unsent = plan.problems.filter(({ reason }) => reason === "limit").length;
  const pastRoom = Math.max(0, plan.rows.length - Math.max(0, VAULT_ITEM_LIMIT - saved.length));
  return {
    ...plan,
    duplicate: plan.problems.length - unsent,
    full: unsent + pastRoom,
    pastRoom,
  };
}

function importLabel(row: VaultImportRow): string {
  return row.title || new URL(row.origin).host;
}

type VaultImportPlan = ReturnType<typeof newVaultImportRows>;

// Before the server answers, a repeat is just that. Once it answered, a repeat of a login it saved
// is already saved, and a repeat of one it turned down is turned down the same way.
function repeatAnswers(plan: Pick<VaultImportPlan, "repeats">, result?: VaultImportResult) {
  return plan.repeats.map(({ of, ...repeat }) => ({
    ...repeat,
    reason: result
      ? (result.notSaved.find(({ index }) => index === of)?.reason ?? "duplicate")
      : repeat.reason,
  }));
}

/**
 * The rows left out, by their place in the file, for the review to list: what the file and the
 * vault left out, then what the server turned down.
 */
export function vaultImportProblems(
  file: readonly VaultImportProblem[],
  plan: Pick<VaultImportPlan, "rows" | "lines" | "problems" | "repeats">,
  result?: VaultImportResult,
): VaultImportProblem[] {
  const server = (result?.notSaved ?? []).flatMap(({ index, reason }) => {
    const row = plan.rows[index];
    return row ? [{ line: plan.lines[index] ?? index + 1, label: importLabel(row), reason }] : [];
  });
  return [...file, ...plan.problems, ...server, ...repeatAnswers(plan, result)].sort(
    (left, right) => left.line - right.line,
  );
}

export type VaultImportCount =
  | "added"
  | "toAdd"
  | "duplicate"
  | "repeat"
  | "notHttps"
  | "noPassword"
  | "full"
  | "notSaved";

/**
 * What an import review shows, before saving and after: what the file left out plus what the
 * server turned down. Only the first count is shown at zero.
 */
export function vaultImportCounts(
  skipped: VaultImportSkipped,
  plan: Pick<VaultImportPlan, "rows" | "duplicate" | "full" | "pastRoom" | "repeats">,
  result?: VaultImportResult,
): [VaultImportCount, number][] {
  const server = { ...(result?.skipped ?? noneSkipped()) };
  let repeats = 0;
  for (const { reason } of repeatAnswers(plan, result)) {
    if (reason === "repeat") repeats++;
    else server[reason]++;
  }
  const counts: [VaultImportCount, number][] = [
    result ? ["added", result.added] : ["toAdd", plan.rows.length - plan.pastRoom],
    ["duplicate", plan.duplicate + server.duplicate],
    ["repeat", repeats],
    ["notHttps", skipped.notHttps + server.notHttps],
    ["noPassword", skipped.noPassword + server.noPassword],
    // Before saving, a guess; after, what the server found had no room.
    ["full", result ? plan.full - plan.pastRoom + server.limit : plan.full],
    ["notSaved", skipped.invalid + server.invalid],
  ];
  return counts.filter(([, count], index) => index === 0 || count > 0);
}
