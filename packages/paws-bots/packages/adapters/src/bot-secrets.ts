import { createHmac, randomBytes } from "node:crypto";
import type { SecretStore } from "@rakazo/adapter-kit";
import { SecretNotFoundError, SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import type {
  BotSecretDestination,
  CardSecretValue,
  LoginField,
  LoginSecretValue,
  PurchaseCardField,
  SettingsScope,
  VaultPolicy,
  VaultPreview,
} from "@rakazo/contracts";
import {
  authenticatorKey,
  BLOCKED_ITEM_ANSWER,
  BotSecretAuth,
  BotSecretName,
  botSecretDestinationSchema,
  cardExpiry,
  cardSummary,
  cardTitle,
  commandVariableName,
  commandVariableProblem,
  DEFAULT_LOGIN_FIELD_LABELS,
  decodeCardSecret,
  decodeContactSecret,
  decodeLoginSecret,
  encodeCardSecret,
  encodeContactSecret,
  encodeLoginSecret,
  GeneratedSecretRules,
  GenerateSecretInput,
  isPrivateNetworkHost,
  isSitelessAuth,
  LOGIN_FIELD_LIMIT,
  LoginFieldLabels,
  loginCommandName,
  ONE_TIME_CODE_MIN_LENGTH,
  OneTimeCodeTarget,
  otherSiteOrigin,
  SecretHttpRequest,
  sameLoginFieldLabel,
  UNCHOSEN_ITEM_ANSWER,
  VAULT_ITEM_LIMIT,
  vaultLoginKey,
} from "@rakazo/contracts";
import { resolveEncryptionKey } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  ContentDecryptionError,
  ciphertextKeyId,
  currentDbContext,
  lockSpaceSettings,
  runCodeKind,
  runCodeSpentKind,
  runLoginKind,
  settingsTarget,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { z } from "zod";
import { combineSignals, redactConnectorPayload } from "./connector-safety.js";
import type { RemoteTransportDependencies } from "./remote-mcp.js";
import {
  ConnectorRedirectError,
  createPrivateNetworkFetch,
  createSafeRemoteFetch,
  RemoteRequestSentError,
} from "./remote-mcp.js";
import { generateSecretValue } from "./secret-generator.js";
import { persistPreparedSecret } from "./secret-persistence.js";
import { isPermanentDecryptFailure } from "./secrets.js";
import { totpCode, totpCodeEnd } from "./totp.js";
import type { VaultLoginUse } from "./vault-card-use.js";
import { LOGIN_CODE_FIELD } from "./vault-card-use.js";
import { openVaultValue, sealVaultValue } from "./vault-values.js";
import { readBodyCapped, withAbort } from "./web-ssrf.js";

/**
 * The member a credential call acts for, in one Space. `vault` picks the account's vault or the
 * Space's own; omitted, it is whichever this Space uses, which is what bots read and write.
 */
export type BotSecretScope = {
  userId: string;
  spaceId: string;
  vault?: SettingsScope;
  /** Set for a bot's run, which sees only the items it may use; the owner reads without one. */
  botId?: string;
};
type VaultClient = Pick<PrismaClient, "spaceSettingOverride">;

/**
 * Orders a vault write after any change of vault (the member's settings lock) and after every
 * other write by the member, since Spaces without their own vault share the account's.
 */
async function lockVault(tx: Pick<Prisma.TransactionClient, "$queryRaw">, scope: BotSecretScope) {
  await lockSpaceSettings(tx, scope);
  await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${scope.userId} FOR UPDATE`;
}

export const SPACE_VAULT_NOT_IN_USE = "This Space uses the account vault";
export const VAULT_CHANGED = "Vault changed while saving; retry";

/**
 * A write aimed at a Space's own vault is refused once the Space stops customizing credentials,
 * since nothing would read it and it would only wait to be deleted.
 */
async function assertVaultInUse(client: VaultClient, scope: BotSecretScope) {
  if (scope.vault !== "space") return;
  if ((await settingsTarget(client, scope, "credentials")) !== "space") {
    throw new Error(SPACE_VAULT_NOT_IN_USE);
  }
}

/** The vault rows a call reads and writes: the account's (no Space) or the Space's own. */
async function vaultFields(client: VaultClient, scope: BotSecretScope) {
  const target = await settingsTarget(client, scope, "credentials", scope.vault);
  return { userId: scope.userId, spaceId: target === "space" ? scope.spaceId : null };
}

// Blocked items, and ones chosen for other bots, are still redacted, through
// loadLoginPasswordRedactions and loadCommandVariables.
async function usableVaultFields(client: VaultClient, scope: BotSecretScope) {
  const vault = await vaultFields(client, scope);
  if (!scope.botId) return vault;
  // Row security shows a tenant only its own limits in its own Space, so a bot's read under another
  // Space's or member's tenant would miss them: it finds nothing instead.
  const context = currentDbContext();
  if (
    context?.kind === "tenant" &&
    (context.spaceId !== scope.spaceId || context.userId !== scope.userId)
  )
    return { ...vault, id: { in: [] } };
  return {
    ...vault,
    policy: { not: "off" },
    // Limited in this Space only to the bots chosen here; another Space's choice never applies.
    OR: [
      { limits: { none: { spaceId: scope.spaceId } } },
      { bots: { some: { botId: scope.botId } } },
    ],
  };
}

// Says nothing of the item, as a name the bot can't use may be taken by one it can't see.
export const HIDDEN_ITEM = "That name can't be used. Use another name.";

/**
 * Which bots in this Space may use an item. `botIds` limits it to those bots; `allBots` true lets
 * every bot use it and forgets the choice; `allBots` false alone keeps the bots chosen before.
 * Left out entirely, nothing changes.
 */
export type VaultItemBots = { allBots?: boolean; botIds?: string[] };
export const UNKNOWN_BOTS = "Choose from your bots in this Space";

/**
 * Sets whether an item is limited in this Space and the bots chosen here, keeping every other
 * Space's. Any bot of a Space that uses the item's vault: in a shared Space every member's runs
 * with a bot read their own vault, so a member's choice only ever limits their own items.
 */
async function saveItemBots(
  tx: Prisma.TransactionClient,
  scope: BotSecretScope,
  credentialId: string,
  bots: VaultItemBots | undefined,
) {
  if (!bots || scope.botId) return;
  const owner = { userId: scope.userId, spaceId: scope.spaceId };
  // A choice of bots is never kept without the limit it serves, so the two can't drift apart.
  if (bots.allBots) {
    await tx.vaultCredentialLimit.deleteMany({ where: { ...owner, credentialId } });
    await tx.vaultCredentialBot.deleteMany({ where: { ...owner, credentialId } });
    return;
  }
  if (bots.allBots === undefined && !bots.botIds) return;
  const { count: limited } = await tx.vaultCredentialLimit.createMany({
    data: [{ ...owner, credentialId }],
    skipDuplicates: true,
  });
  // Newly limited, the item starts from no bots: rows an earlier save left behind on an
  // unlimited item were never a choice, so they are cleared rather than brought back.
  if (limited && !bots.botIds) {
    await tx.vaultCredentialBot.deleteMany({ where: { ...owner, credentialId } });
    return;
  }
  if (!bots.botIds) return;
  const botIds = [...new Set(bots.botIds)];
  if (botIds.length) {
    const [here, item] = await Promise.all([vaultFields(tx, owner), vaultFields(tx, scope)]);
    const found = await tx.bot.count({ where: { spaceId: scope.spaceId, id: { in: botIds } } });
    if (here.spaceId !== item.spaceId || found !== botIds.length) throw new Error(UNKNOWN_BOTS);
  }
  await tx.vaultCredentialBot.deleteMany({
    where: { ...owner, credentialId, botId: { notIn: botIds } },
  });
  await tx.vaultCredentialBot.createMany({
    data: botIds.map((botId) => ({ ...owner, credentialId, botId })),
    skipDuplicates: true,
  });
}

// What the person answering for a bot is told of an item it can't use: Blocked, or limited to others.
const hiddenAnswer = (policy: string | undefined) =>
  policy === "off" ? BLOCKED_ITEM_ANSWER : UNCHOSEN_ITEM_ANSWER;

// A blocked name stays taken, so a bot can't save another item over it.
async function hiddenFromBot(
  client: PrismaClient | Prisma.TransactionClient,
  scope: BotSecretScope,
  name: string,
) {
  if (!scope.botId) return false;
  const [saved, usable] = await Promise.all([
    client.vaultCredential.count({ where: { ...(await vaultFields(client, scope)), name } }),
    client.vaultCredential.count({ where: { ...(await usableVaultFields(client, scope)), name } }),
  ]);
  return saved > usable;
}

const metadata = { name: true, origin: true, auth: true } as const;
// What people see of an item besides its destination.
const labels = { title: true, note: true } as const;
// What reading an item's value needs: the vault it is in is part of its encryption.
const vaultRow = { id: true, userId: true, spaceId: true, ciphertext: true } as const;

const SECRET_ALREADY_SAVED = "A credential with this name is already saved";

/** A create-only save found the name taken, by an earlier save or a concurrent one. */
export function isSecretAlreadySaved(error: unknown): boolean {
  return error instanceof Error && error.message === SECRET_ALREADY_SAVED;
}
const UNUSABLE_CREDENTIAL = "Credential cannot be used with this authentication method";

/** `encodeURIComponent` throws on an unpaired surrogate. */
function percentEncoded(value: string): string | undefined {
  try {
    return encodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function commandRedactionForms(value: string): string[] {
  const forms = [value, Buffer.from(value).toString("base64")];
  const encoded = percentEncoded(value);
  if (encoded !== undefined) forms.push(encoded);
  return forms;
}

function credentialHeader(destination: BotSecretDestination, plaintext: string) {
  // A login is only typed into its site, a command variable only reaches shell commands, and a
  // card or contact is only typed into pages.
  if (
    destination.auth.type !== "bearer" &&
    destination.auth.type !== "header" &&
    destination.auth.type !== "basic"
  ) {
    throw new Error("Credential cannot be used with this authentication method");
  }
  const name = destination.auth.type === "header" ? destination.auth.name : "Authorization";
  const value =
    destination.auth.type === "bearer"
      ? `Bearer ${plaintext}`
      : destination.auth.type === "basic"
        ? `Basic ${Buffer.from(`${destination.auth.username}:${plaintext}`).toString("base64")}`
        : plaintext;
  try {
    const headers = new Headers({ [name]: value });
    if (headers.get(name) !== value) throw new Error("Header value was normalized");
  } catch {
    throw new Error("Credential cannot be used with this authentication method");
  }
  return { name, value };
}

/** Owner escape enabling plain-HTTP origins on private LAN hosts (see #907). */
export function allowPrivateHttpSecretOrigins(): boolean {
  return process.env.RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP === "1";
}

export function normalizeSecretDestination(value: unknown): BotSecretDestination {
  const parsed = botSecretDestinationSchema({
    allowPrivateHttpOrigin: allowPrivateHttpSecretOrigins(),
  }).safeParse(value);
  if (!parsed.success) {
    // Surface the actual failing field: models (and people) supply all three
    // parts and still fail on a name character or an origin rule, and a
    // generic "specify name, origin, auth" error sends them retrying blind.
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "credential"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid credential destination — ${detail}`);
  }
  if (isSitelessAuth(parsed.data.auth.type)) return parsed.data;
  return { ...parsed.data, origin: new URL(parsed.data.origin).origin };
}

function isCommandCredential(auth: unknown): boolean {
  const parsed = BotSecretAuth.safeParse(auth);
  return parsed.success && parsed.data.type === "command";
}

/**
 * What the bot's tools show for a saved credential. A command variable has no site, so it is
 * listed with the environment variable its shell commands read instead.
 */
export function botSecretToolView(row: { name: string; origin: string; auth: unknown }) {
  if (!isCommandCredential(row.auth)) return row;
  const variable = commandVariableName(row.name);
  const problem = commandVariableProblem(variable);
  if (problem === undefined) return { name: row.name, auth: row.auth, variable };
  const reason =
    problem === "reserved"
      ? `$${variable} is reserved and is not exported.`
      : `$${variable} is not a valid environment variable name and is not exported.`;
  return {
    name: row.name,
    auth: row.auth,
    error: `${reason} Remove it and save it under another name.`,
  };
}

const commandRowFields = {
  userId: true,
  id: true,
  name: true,
  spaceId: true,
  auth: true,
  ciphertext: true,
} as const;

/** Each command variable of these rows, decrypted once; one that can't be read has no value. */
async function readCommandVariables(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  rows: (Parameters<typeof openVaultValue>[2] & { name: string; auth: unknown })[],
  keyOutage: "throw" | "unset",
) {
  const variables: { item: VaultItemUse; variable: string; value?: string }[] = [];
  for (const row of rows) {
    if (!isCommandCredential(row.auth)) continue;
    const variable = commandVariableName(row.name);
    if (commandVariableProblem(variable)) continue;
    const item = { id: row.id, name: row.name, spaceId: row.spaceId, kind: "command" };
    try {
      variables.push({ item, variable, value: await openForRedaction(prisma, secretStore, row) });
    } catch (error) {
      if (error instanceof VaultKeyUnavailableError && keyOutage === "throw") throw error;
      // One unreadable value must not stop every shell command; the variable is left unset.
      variables.push({ item, variable });
    }
  }
  return variables;
}

/** What a command gets: its variables, and the items they came from, without their values. */
function commandEnvironment(
  variables: { item: VaultItemUse; variable: string; value?: string }[],
  unsetVariables?: Set<string>,
): { env: Record<string, string>; used: VaultItemUse[] } {
  const env: Record<string, string> = {};
  const from = new Map<string, VaultItemUse>();
  for (const { item, variable, value } of variables) {
    if (value === undefined) unsetVariables?.add(variable);
    else if (value && !value.includes("\0")) {
      env[variable] = value;
      from.set(variable, item);
    }
  }
  return { env, used: [...from.values()] };
}

/**
 * This bot's command variables, and the values to redact: also those it may no longer use, as
 * an earlier run may have written one out. A value is exported only from the read that found the
 * bot may use it, so an item replaced and blocked between the two reads never leaks its new value.
 * Each stored value is decrypted once. The values must never be logged or returned; callers
 * register the redactions before a command runs. `used` names the items whose values are in
 * `env`, from that same read and without the values, for the caller to record once a command has
 * them: loading alone, as a run does at its start to hide the values, is no use.
 */
export async function loadCommandVariables(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  scope: BotSecretScope,
  unsetVariables?: Set<string>,
  keyOutage: "throw" | "unset" = "throw",
): Promise<{ env: Record<string, string>; used: VaultItemUse[]; redactions: string[] }> {
  const { botId: _, ...owner } = scope;
  const [usable, rows] = await Promise.all([
    prisma.vaultCredential.findMany({
      where: await usableVaultFields(prisma, scope),
      select: commandRowFields,
      orderBy: { name: "asc" },
    }),
    prisma.vaultCredential.findMany({
      where: await vaultFields(prisma, owner),
      select: commandRowFields,
      orderBy: { name: "asc" },
    }),
  ]);
  const read = new Set(usable.map((row) => `${row.id}\0${row.ciphertext}`));
  const exported = await readCommandVariables(prisma, secretStore, usable, keyOutage);
  const others = await readCommandVariables(
    prisma,
    secretStore,
    rows.filter((row) => !read.has(`${row.id}\0${row.ciphertext}`)),
    keyOutage,
  );
  return {
    ...commandEnvironment(exported, unsetVariables),
    // Encoded forms too, as secret_request does, so an accidental `base64` or URL-encoding of a
    // value is still redacted from command output.
    // Every value, not one per variable: an item's old and new value share its variable.
    redactions: [
      ...new Set(
        [...exported, ...others].flatMap(({ value }) =>
          value && !value.includes("\0") ? commandRedactionForms(value) : [],
        ),
      ),
    ],
  };
}

/**
 * The environment for one shell command: the command variables of the vault this Space uses,
 * loaded fresh. The values are handed to `registerRedactions` before this returns, so the
 * command's output is redacted. The caller records `used` once the command is sent with them.
 */
export async function shellCommandEnvironment(input: {
  prisma: PrismaClient;
  secretStore: Pick<SecretStore, "load">;
  scope: BotSecretScope;
  registerRedactions: (values: string[]) => void;
  keyOutage?: "throw" | "unset";
}): Promise<{ env: Record<string, string>; unsetEnv: string[]; used: VaultItemUse[] }> {
  const unsetVariables = new Set<string>();
  const { env, used, redactions } = await loadCommandVariables(
    input.prisma,
    input.secretStore,
    input.scope,
    unsetVariables,
    input.keyOutage,
  );
  input.registerRedactions(redactions);
  return { env, unsetEnv: [...unsetVariables], used };
}

/** Another command credential of this bot that is exported as the same variable. */
export async function findCommandVariableConflict(
  client: PrismaClient | Prisma.TransactionClient,
  scope: BotSecretScope,
  destination: BotSecretDestination,
): Promise<string | undefined> {
  if (destination.auth.type !== "command") return undefined;
  const variable = commandVariableName(destination.name);
  const rows = await client.vaultCredential.findMany({
    where: { ...(await vaultFields(client, scope)), name: { not: destination.name } },
    select: { name: true, auth: true },
  });
  const name = rows.find(
    (row) => isCommandCredential(row.auth) && commandVariableName(row.name) === variable,
  )?.name;
  // A bot is never told the name of an item it can't see.
  return name && (await hiddenFromBot(client, scope, name)) ? "another saved item" : name;
}

/** The bot must tell the user why it falls back to a takeover, so the refusal says so. */
const NOT_HTTPS_CODE =
  "Codes can only be typed on HTTPS pages, and this page isn't HTTPS. Ask the user to take over and tell them that is why.";

export type RequestSecretDestinationResult = {
  /** Metadata only. The protected value is never part of this result. */
  destination?: BotSecretDestination;
  connectionId?: string;
  /** The HTTPS origin a texted or emailed code is for. */
  oneTimeCodeOrigin?: string;
  error?: string;
};

/**
 * The model-facing schema is one object, so a credential often arrives beside
 * `connectionId`, as a JSON string, or as top-level `name` / `origin` / `auth`
 * instead of a nested `credential`. A destination that normalizes is the masked
 * reusable path. `connectionId` applies only when no credential was supplied.
 */
export function resolveRequestSecretDestination(
  args: Record<string, unknown>,
): RequestSecretDestinationResult {
  const credential = credentialArgument(args);
  if (credential !== undefined) {
    try {
      return { destination: normalizeSecretDestination(credential) };
    } catch (error) {
      return {
        error:
          error instanceof Error && error.message.startsWith("Invalid credential destination")
            ? error.message
            : "Specify a credential name, HTTPS origin, and auth method.",
      };
    }
  }
  const connectionId = connectionIdArgument(args.connectionId);
  if (connectionId) return { connectionId };
  if (args.oneTimeCode !== undefined) {
    const target = OneTimeCodeTarget.safeParse(args.oneTimeCode);
    if (target.success) return { oneTimeCodeOrigin: target.data.origin };
    const origin = isPlainObject(args.oneTimeCode) ? args.oneTimeCode.origin : undefined;
    return {
      error:
        typeof origin === "string" && URL.canParse(origin) && new URL(origin).protocol === "http:"
          ? NOT_HTTPS_CODE
          : "oneTimeCode needs the HTTPS origin of the page that asked for the code.",
    };
  }
  return {
    error:
      "Provide either a reusable credential destination, a connectionId, or oneTimeCode for a code the page asked for.",
  };
}

/** `{ origin }` only, reduced to the site: a code is never tied to a path, query or userinfo. */
export function oneTimeCodeArgument(value: unknown): unknown {
  if (!isPlainObject(value)) return value === undefined ? undefined : {};
  return { origin: originMetadata(value.origin) ?? "invalid-origin" };
}

/** Labels only, also from `{ label, hidden }` objects, so a bot's `hidden` is never recorded. */
export function loginFieldLabelsArgument(value: unknown): unknown {
  return Array.isArray(value)
    ? value.map((field) => (isPlainObject(field) ? field.label : field))
    : value;
}

/**
 * The field labels a login card asks for. Only labels: the card derives each field's starting
 * state from its label, the person has the last word, and anything else the bot sends with a
 * field is dropped.
 */
export function requestedLoginFields(value: unknown): { labels?: string[]; error?: string } {
  if (value === undefined || value === null) return {};
  const parsed = LoginFieldLabels.safeParse(loginFieldLabelsArgument(value));
  if (parsed.success) return { labels: parsed.data };
  return {
    error: `fields must list 1 to ${LOGIN_FIELD_LIMIT} different labels of at most 64 characters, such as ["Email", "Password"].`,
  };
}

const destinationFields = ["name", "origin", "auth"] as const;

/**
 * Credential object from `credential`, a JSON string of that object, or top-level fields.
 * Only destination metadata is returned. A partial `name` / `origin` / `auth` set is still
 * a credential attempt so it cannot fall through to `connectionId`.
 */
export function credentialArgument(args: Record<string, unknown>): unknown {
  if (Object.hasOwn(args, "credential") && args.credential != null && args.credential !== "") {
    return parsedCredentialObject(args.credential);
  }
  if (destinationFields.some((key) => Object.hasOwn(args, key))) {
    return destinationMetadata(args);
  }
  return undefined;
}

export function connectionIdArgument(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null" || trimmed === "undefined") return undefined;
  return trimmed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * `{ name, origin, auth }` only. Secret fields must not survive, including ones nested in
 * `auth` or carried in an origin string. The effect request is this object, and destination
 * parsing strips extras only from its own copy.
 */
function destinationMetadata(record: Record<string, unknown>): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const key of destinationFields) {
    if (!Object.hasOwn(record, key)) continue;
    if (key === "auth") {
      const auth = authMetadata(record.auth);
      if (auth !== undefined) metadata.auth = auth;
      continue;
    }
    if (key === "origin") {
      const origin = originMetadata(record.origin);
      if (origin !== undefined) metadata.origin = origin;
      continue;
    }
    if (typeof record.name === "string") {
      // Keep a real name. Anything else is replaced so a secret in that string is not recorded,
      // while destination validation still reports the name pattern.
      metadata.name = BotSecretName.safeParse(record.name).success ? record.name : "Invalid Name";
    }
  }
  return metadata;
}

/**
 * Parsed auth, or a stand-in that fails the same way. The stand-in does not copy the
 * original fields: an invalid method or header can still carry a secret, and the effect
 * row is written before destination validation.
 */
function authMetadata(value: unknown): unknown {
  const parsed = BotSecretAuth.safeParse(value);
  if (parsed.success) return parsed.data;
  if (!isPlainObject(value)) return undefined;
  if (value.type === "header") {
    if (typeof value.name !== "string") return { type: "header" };
    const header = BotSecretAuth.safeParse({ type: "header", name: value.name });
    const unsupported =
      !header.success &&
      header.error.issues.some((issue) => issue.message === "Unsupported credential header");
    return { type: "header", name: unsupported ? "Cookie" : "bad header" };
  }
  if (value.type === "basic") {
    if (typeof value.username !== "string") return { type: "basic" };
    return { type: "basic", username: ":" };
  }
  return { type: "invalid" };
}

/**
 * The site a credential is saved under when given a page URL: the origin of an http or https
 * URL, without its path, query or fragment. Any other scheme gets nothing, since
 * `blob:https://host/x` reports `https://host` without being a page on it. With
 * `allowUserinfo` false, a URL carrying a username or password gets nothing either, and so does
 * one longer than `maxLength`, checked on what was given rather than on the site it reduces to.
 */
export function pageUrlOrigin(
  value: string,
  { allowUserinfo, maxLength }: { allowUserinfo: boolean; maxLength: number },
): string | undefined {
  if (value.length > maxLength) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (!allowUserinfo && (url.username || url.password)) return undefined;
  return url.origin;
}

/**
 * Keep only the site. Never return the raw string: `new URL` resolves `..`, so the raw
 * path can still hold a secret while the parsed path is `/`. Userinfo, query, fragment,
 * and path are removed. A placeholder keeps the origin error when no site remains.
 */
function originMetadata(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value === "") return "";
  // A sign-in redirect URL can be long; the authenticated request URL's limit, not the origin's.
  return pageUrlOrigin(value, { allowUserinfo: true, maxLength: 8192 }) ?? "invalid-origin";
}

function parsedCredentialObject(value: unknown): unknown {
  if (typeof value !== "string") {
    // Not metadata. Keep the attempt, but do not forward the raw value into the effect.
    return isPlainObject(value) ? destinationMetadata(value) : {};
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isPlainObject(parsed)) return destinationMetadata(parsed);
  } catch {
    return {};
  }
  return {};
}

export function sameSecretDestination(
  left: BotSecretDestination,
  right: BotSecretDestination,
): boolean {
  return (
    left.name === right.name &&
    left.origin === right.origin &&
    JSON.stringify(left.auth) === JSON.stringify(right.auth)
  );
}

/** Only an HTTPS login moves to another site; nothing else about it changes. */
export function canReplaceLoginSite(
  saved: BotSecretDestination,
  destination: BotSecretDestination,
): boolean {
  return (
    saved.auth.type === "login" &&
    destination.origin.startsWith("https://") &&
    sameSecretDestination({ ...saved, origin: destination.origin }, destination)
  );
}

/** The credential saved under `name`. Its row id is for a card that replaces it, never for the bot. */
export async function findBotSecret(prisma: PrismaClient, scope: BotSecretScope, name: string) {
  const row = await prisma.vaultCredential.findFirst({
    where: { ...(await vaultFields(prisma, scope)), name },
    select: { ...metadata, id: true, alsoOn: true },
  });
  if (!row) return null;
  if (await hiddenFromBot(prisma, scope, name)) return { hidden: true as const };
  return { id: row.id, destination: normalizeSecretDestination(row), alsoOn: row.alsoOn ?? [] };
}

/**
 * The one login saved for exactly this HTTPS site, or when none is, the one with it among its other
 * sites, whatever its name. Bots name logins themselves, so a later request under another name for
 * the same site still finds it. None when two match.
 */
export async function findSiteLogin(prisma: PrismaClient, scope: BotSecretScope, origin: string) {
  if (!origin.startsWith("https://")) return null;
  const rows = await prisma.vaultCredential.findMany({
    where: {
      ...(await usableVaultFields(prisma, scope)),
      // Its own OR, so the bot access filter's OR still applies.
      AND: [{ OR: [{ origin }, { alsoOn: { has: origin } }] }],
    },
    select: metadata,
  });
  // A row saved before today's name or site rules can't be filled, so it doesn't count.
  const logins = rows.flatMap((row) => {
    try {
      const login = normalizeSecretDestination(row);
      return login.auth.type === "login" ? [login] : [];
    } catch {
      return [];
    }
  });
  const own = logins.filter((login) => login.origin === origin);
  const found = own.length ? own : logins;
  return found.length === 1 ? found[0] : null;
}

/**
 * The value as it is saved: a login, card or contact in its current shape, so every reader gets
 * one form. Throws when the value is not one of its kind.
 */
export function canonicalSecretValue(destination: BotSecretDestination, plaintext: string): string {
  // Saved in its current shape, also when an older app sends a username and password.
  if (destination.auth.type === "login") {
    const { fields, otp } = decodeLoginSecret(plaintext);
    return encodeLoginSecret(otp ? { fields, otp } : { fields });
  }
  try {
    if (destination.auth.type === "card") return encodeCardSecret(JSON.parse(plaintext));
    if (destination.auth.type === "contact") return encodeContactSecret(JSON.parse(plaintext));
  } catch {
    // The parse error may quote the value, so only the kind is named.
    throw new Error(`Invalid ${destination.auth.type}`);
  }
  return plaintext;
}

export async function prepareBotSecret(input: {
  prisma: PrismaClient;
  secretStore: SecretStore;
  scope: BotSecretScope;
  destination: BotSecretDestination;
  plaintext: string;
  /** Refuse instead of replacing a credential saved under this name, even by a concurrent call. */
  createOnly?: boolean;
  /**
   * The id of the saved login of this name that this login replaces, from a login card the person
   * answered for another site. Without it, a credential's destination never changes.
   */
  replaces?: string;
  /** What people call the item and when to use it; left as they are when omitted. */
  title?: string;
  note?: string;
  policy?: VaultPolicy;
  bots?: VaultItemBots;
  /**
   * Refuse a login when one is already saved for its site with the same username. The map keeps
   * each saved login's username as read, by row and value, so one import reads each login once.
   */
  newLoginOnly?: Map<string, string>;
  /** An import using the default vault stops if that selection changes between rows. */
  expectedDefaultVault?: SettingsScope;
  alsoOn?: readonly string[];
}) {
  const { prisma, secretStore, scope } = input;
  let { plaintext } = input;
  if (!plaintext || plaintext.length > 16_384) throw new Error("Invalid credential length");
  const destination = normalizeSecretDestination(input.destination);
  const policy = policyField(destination.auth, input.policy);
  // A bot never widens where a login goes.
  if (scope.botId && input.alsoOn) throw new Error(UNSUPPORTED_ACCESS);
  const sites = alsoOnField(destination.auth, destination.origin, input.alsoOn);
  if (
    destination.auth.type === "login" ||
    destination.auth.type === "card" ||
    destination.auth.type === "contact"
  ) {
    plaintext = canonicalSecretValue(destination, plaintext);
  } else if (destination.auth.type === "command") {
    // NUL cannot be an environment value. An unpaired surrogate cannot be percent-encoded
    // later, and that throw would abort every subsequent shell command for this bot.
    if (plaintext.includes("\0") || percentEncoded(plaintext) === undefined) {
      throw new Error(UNUSABLE_CREDENTIAL);
    }
  } else credentialHeader(destination, plaintext);
  await assertVaultInUse(prisma, scope);
  const vault = await vaultFields(prisma, scope);
  const existing = await prisma.vaultCredential.findFirst({
    where: { ...vault, name: destination.name },
  });
  // A save the bot started, such as a login card the person answered for the site the bot
  // proposed, moves the login there without its key or other sites: only the owner sets them,
  // for the site they were set for, and the card shows neither. request_secret asks for no
  // such move while the login has either, so this drops only what was added while a card waited.
  const botMoves = (row: typeof existing) =>
    Boolean(scope.botId && row && normalizeSecretDestination(row).origin !== destination.origin);
  // A login saved without its authenticator key keeps the saved one; an empty key removes it.
  const keepsKey =
    destination.auth.type === "login" &&
    existing &&
    !botMoves(existing) &&
    !("otp" in JSON.parse(input.plaintext));
  if (destination.auth.type === "login" && botMoves(existing))
    plaintext = encodeLoginSecret({ fields: decodeLoginSecret(plaintext).fields });
  function validate(row: typeof existing, count: number) {
    if (row && input.createOnly) throw new Error(SECRET_ALREADY_SAVED);
    const saved = row && normalizeSecretDestination(row);
    if (
      saved &&
      !sameSecretDestination(saved, destination) &&
      !(row?.id === input.replaces && canReplaceLoginSite(saved, destination))
    )
      throw new Error("Remove the existing credential before changing its destination");
    if (!row && count >= VAULT_ITEM_LIMIT) throw new Error("Credential limit reached");
  }
  // Before the destination checks, so the person answering is told the item is blocked.
  if (existing && (await hiddenFromBot(prisma, scope, destination.name)))
    throw new Error(hiddenAnswer(existing.policy));
  // An import's login already saved is that, also in a full vault.
  const usernames = input.newLoginOnly;
  const repeats = (tx: Pick<Prisma.TransactionClient, "vaultCredential">) =>
    usernames && loginSaved(prisma, tx, secretStore, vault, destination, plaintext, usernames);
  if (await repeats(prisma)) throw new Error(LOGIN_ALREADY_SAVED);
  validate(existing, await prisma.vaultCredential.count({ where: vault }));
  if (keepsKey) {
    const otp = await savedLoginKey(prisma, secretStore, existing);
    if (otp) plaintext = encodeLoginSecret({ ...decodeLoginSecret(plaintext), otp });
  }
  const id = existing?.id ?? randomBytes(12).toString("hex");
  const ciphertext = await sealVaultValue(prisma, secretStore, { id, ...vault }, plaintext, {
    operationId: id,
    traceId: id,
    userId: scope.userId,
    spaceId: scope.spaceId,
    signal: new AbortController().signal,
  });
  return {
    id,
    ciphertext,
    async store(tx: Prisma.TransactionClient) {
      await lockVault(tx, scope);
      if (
        input.expectedDefaultVault !== undefined &&
        (await settingsTarget(tx, scope, "credentials")) !== input.expectedDefaultVault
      )
        throw new Error(VAULT_CHANGED);
      if (existing)
        await tx.$queryRaw`SELECT id FROM vault_credentials WHERE id = ${existing.id} FOR UPDATE`;
      await assertVaultInUse(tx, scope);
      // First under the lock, so an item blocked while the request waited is never replaced.
      const current = await tx.vaultCredential.findFirst({
        where: { ...vault, name: destination.name },
      });
      if (await hiddenFromBot(tx, scope, destination.name))
        throw new Error(hiddenAnswer(current?.policy));
      if (JSON.stringify(await vaultFields(tx, scope)) !== JSON.stringify(vault)) {
        throw Object.assign(new Error("Vault changed while saving; retry"), { code: "P2034" });
      }
      if (await repeats(tx)) throw new Error(LOGIN_ALREADY_SAVED);
      validate(current, await tx.vaultCredential.count({ where: vault }));
      const conflict = await findCommandVariableConflict(tx, scope, destination);
      if (conflict) {
        throw new Error(
          `Invalid credential destination — name: ${conflict} is already exported as $${commandVariableName(destination.name)}`,
        );
      }
      // The kept key was read before the lock, so a value saved since then is read again.
      if (
        current?.id !== existing?.id ||
        (keepsKey && current?.ciphertext !== existing?.ciphertext) ||
        (current && ciphertextKeyId(current.ciphertext) !== ciphertextKeyId(existing!.ciphertext))
      )
        throw Object.assign(new Error("Credential changed while saving; retry"), { code: "P2034" });
      const labelled = {
        // Its owner's own save may carry a fixed key, so its codes are typed again. A save a bot
        // started, such as a login card answered in chat, shows no key and keeps the saved one:
        // the key that was stopped is still the one there, so the stop stays.
        ...(current?.codesStoppedAt && !scope.botId ? { codesStoppedAt: null } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...policy,
        ...sites,
        ...(botMoves(current)
          ? { alsoOn: [] }
          : // A login moved to one of its other sites no longer lists that site among them.
            input.alsoOn === undefined && current?.alsoOn?.includes(destination.origin)
            ? { alsoOn: current.alsoOn.filter((site) => site !== destination.origin) }
            : {}),
      };
      // The site and the value change together; validate allowed another site only when replacing.
      if (current)
        await tx.vaultCredential.update({
          where: { id },
          data: { origin: destination.origin, ciphertext, ...labelled },
        });
      else
        await tx.vaultCredential.create({
          data: { id, ...vault, ...destination, ...labelled, ciphertext },
        });
      await saveItemBots(tx, scope, id, input.bots);
      if (usernames && destination.auth.type === "login")
        usernames.set(`${id}:${ciphertext}`, loginUsername(plaintext));
    },
  };
}

/** A saved login that can't be read for now, so a save that would change it waits. */
export const SAVED_LOGIN_UNREADABLE = "The saved login could not be read. Try again.";

/**
 * A saved value, or undefined when it is known to be gone or undecryptable. Any other failure may
 * hide the value, so it throws, never quoting the value.
 */
async function loadSavedValue(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  row: Parameters<typeof openVaultValue>[2],
): Promise<string | undefined> {
  try {
    return await openVaultValue(prisma, secretStore, row);
  } catch (error) {
    const unreadable =
      error instanceof ContentDecryptionError ||
      error instanceof SecretNotFoundError ||
      (!(error instanceof SecretStoreUnavailableError) && isPermanentDecryptFailure(error));
    if (!unreadable) throw new Error(SAVED_LOGIN_UNREADABLE);
    return undefined;
  }
}

async function savedLoginKey(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  row: Parameters<typeof openVaultValue>[2] & { auth: unknown },
) {
  if (BotSecretAuth.safeParse(row.auth).data?.type !== "login") return undefined;
  // Only a value no one can read holds no key, so the save replaces it.
  const plaintext = await loadSavedValue(prisma, secretStore, row);
  try {
    return plaintext === undefined ? undefined : decodeLoginSecret(plaintext).otp;
  } catch {
    return undefined;
  }
}

export const LOGIN_ALREADY_SAVED = "A login for this site and username is already saved";

// Also for a login saved before fields. Compared as vaultLoginKey does, as the apps compare it.
function loginUsername(plaintext: string): string {
  return decodeLoginSecret(plaintext).fields.find((field) => !field.hidden)?.value ?? "";
}

async function loginSaved(
  prisma: PrismaClient,
  tx: Pick<Prisma.TransactionClient, "vaultCredential">,
  secretStore: Pick<SecretStore, "load">,
  vault: { userId: string; spaceId: string | null },
  destination: BotSecretDestination,
  plaintext: string,
  usernames: Map<string, string>,
): Promise<boolean> {
  if (destination.auth.type !== "login") return false;
  const login = vaultLoginKey(destination.origin, loginUsername(plaintext));
  const rows = await tx.vaultCredential.findMany({
    // A login that is also on this site fills here too, so it counts.
    where: {
      ...vault,
      OR: [{ origin: destination.origin }, { alsoOn: { has: destination.origin } }],
    },
    select: { ...vaultRow, auth: true },
  });
  for (const row of rows) {
    if (BotSecretAuth.safeParse(row.auth).data?.type !== "login") continue;
    const key = `${row.id}:${row.ciphertext}`;
    let saved = usernames.get(key);
    if (saved === undefined) {
      // One no one can read can't be told apart from this login, so it doesn't count; one that
      // can't be read for now may be this login, so the import stops.
      const plaintext = await loadSavedValue(prisma, secretStore, row);
      if (plaintext === undefined) continue;
      try {
        saved = loginUsername(plaintext);
      } catch {
        continue;
      }
      usernames.set(key, saved);
    }
    if (vaultLoginKey(destination.origin, saved) === login) return true;
  }
  return false;
}

export async function storeBotSecret(input: Parameters<typeof prepareBotSecret>[0]) {
  return withTransactionRetry(async () => {
    const prepared = await prepareBotSecret(input);
    return persistPreparedSecret(input.prisma, input.secretStore, prepared, () =>
      input.prisma.$transaction(async (tx) => {
        await prepared.store(tx);
        return getBotSecretMetadata(tx, input.scope, input.destination.name);
      }),
    );
  });
}

/** Save a generated login and the command variable holding its password together, or neither. */
async function storeLoginWithCommand(
  login: Parameters<typeof prepareBotSecret>[0],
  command: Parameters<typeof prepareBotSecret>[0],
) {
  const { prisma, secretStore } = login;
  await withTransactionRetry(async () => {
    const preparedLogin = await prepareBotSecret(login);
    // Prepared inside, so a refused command variable still cleans up the login's stored value.
    await persistPreparedSecret(prisma, secretStore, preparedLogin, async () => {
      const preparedCommand = await prepareBotSecret(command);
      await persistPreparedSecret(prisma, secretStore, preparedCommand, () =>
        prisma.$transaction(async (tx) => {
          await preparedLogin.store(tx);
          await preparedCommand.store(tx);
        }),
      );
    });
  });
}

/**
 * Generate a random value and save it as a new login (with its username, for one site) or a
 * command variable. A login can also save its password as a command variable, for a CLI. Only its redaction forms are returned, for the run to hide; the model sees
 * the saved name, never the value. An existing credential is never overwritten: a site or
 * service may already use its value.
 */
export async function generateBotSecret(input: {
  prisma: PrismaClient;
  secretStore: SecretStore;
  scope: BotSecretScope;
  args: unknown;
}): Promise<{ result: Record<string, unknown>; redactions?: string[] }> {
  const parsed = GenerateSecretInput.safeParse(input.args);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
      .join("; ");
    return { result: { error: `Invalid secret — ${detail}` } };
  }
  const { name, type, origin, username } = parsed.data;
  // The same normalization as request_secret, so a sign-up page URL saves its origin.
  const { destination, error } = resolveRequestSecretDestination({
    credential: { name, origin, auth: { type } },
  });
  if (!destination) return { result: { error } };
  const command: BotSecretDestination | undefined = parsed.data.command
    ? { name: loginCommandName(name), origin: "", auth: { type: "command" } }
    : undefined;
  const found = await findBotSecret(input.prisma, input.scope, name);
  if (found && "hidden" in found) return { result: { error: HIDDEN_ITEM } };
  const existing = found?.destination;
  if (existing) {
    return {
      result: sameSecretDestination(existing, destination)
        ? {
            error:
              type === "login"
                ? "A login with this name is already saved for this site; fill it with browser_act fill_secret. Use another name for a different account."
                : "A command variable with this name is already saved; use it as it is, or use another name.",
            ...botSecretToolView(existing),
          }
        : { error: "A credential with this name already exists. Use another name." },
    };
  }
  const commandFound = command && (await findBotSecret(input.prisma, input.scope, command.name));
  if (commandFound) {
    return {
      result: {
        error:
          "hidden" in commandFound
            ? HIDDEN_ITEM
            : `A credential named ${command.name} already exists. Use another name for the login.`,
      },
    };
  }
  const value = generateSecretValue(parsed.data.rules ?? GeneratedSecretRules.parse({}));
  const save = {
    prisma: input.prisma,
    secretStore: input.secretStore,
    scope: input.scope,
    createOnly: true,
  };
  const [usernameLabel, passwordLabel] = DEFAULT_LOGIN_FIELD_LABELS;
  const plaintext = username
    ? encodeLoginSecret({
        fields: [
          { label: usernameLabel, value: username, hidden: false },
          { label: passwordLabel, value, hidden: true },
        ],
      })
    : value;
  try {
    if (command) {
      await storeLoginWithCommand(
        { ...save, destination, plaintext },
        { ...save, destination: command, plaintext: value },
      );
    } else await storeBotSecret({ ...save, destination, plaintext });
    return {
      result: {
        saved: true,
        ...botSecretToolView(destination),
        ...(command ? { command: botSecretToolView(command) } : {}),
      },
      redactions: passwordRedactionForms(value),
    };
  } catch (error) {
    return { result: { error: error instanceof Error ? error.message : "Secret was not saved." } };
  }
}

/**
 * What list_secrets shows. A contact is shown in full, since the bot types it into forms; a card
 * only as its brand, last four digits, expiry and name, never its number or security code.
 */
export async function listBotSecrets(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  scope: BotSecretScope,
) {
  const rows = await prisma.vaultCredential.findMany({
    where: await usableVaultFields(prisma, scope),
    select: { ...metadata, ...labels, ...vaultRow, alsoOn: true },
    orderBy: { name: "asc" },
  });
  return Promise.all(
    rows.map(async ({ id, userId, spaceId, ciphertext, title, note, alsoOn, ...row }) => {
      const preview = await itemPreview(prisma, secretStore, {
        id,
        userId,
        spaceId,
        ciphertext,
        auth: row.auth,
      });
      const view = botSecretToolView({ name: row.name, origin: row.origin, auth: row.auth });
      return {
        ...view,
        ...loginHints(alsoOn, preview),
        ...(title ? { title } : {}),
        ...(note ? { note } : {}),
        ...(preview?.card
          ? { card: { ...preview.card, expiry: cardExpiry(preview.card) } }
          : preview?.contact
            ? { contact: preview.contact }
            : {}),
      };
    }),
  );
}

// Where else a login fills, and that it can type its authenticator code; never the key.
function loginHints(alsoOn: string[] | undefined, preview: VaultPreview | undefined) {
  return {
    ...(alsoOn?.length ? { alsoOn } : {}),
    ...(preview?.otp ? { authenticatorCode: true } : {}),
  };
}

/** A saved login's hints for the bot, for request_secret's answer that it is already saved. */
export async function loginToolHints(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  scope: BotSecretScope,
  name: string,
) {
  const row = await prisma.vaultCredential.findFirst({
    where: { ...(await usableVaultFields(prisma, scope)), name },
    select: { ...vaultRow, auth: true, alsoOn: true },
  });
  return row ? loginHints(row.alsoOn, await itemPreview(prisma, secretStore, row)) : {};
}

// Owner-facing view: destination, labels and timestamps only, never the row id or ciphertext.
const ownerMetadata = { ...metadata, ...labels, createdAt: true, updatedAt: true } as const;

export async function listBotSecretMetadata(prisma: PrismaClient, scope: BotSecretScope) {
  return prisma.vaultCredential.findMany({
    where: await vaultFields(prisma, scope),
    select: ownerMetadata,
    orderBy: { name: "asc" },
  });
}

/**
 * What a list shows of an item's saved value: a login's first visible field, a card's summary, or
 * a contact. Nothing for other kinds, whose value is the secret itself, or a value that can't be read.
 */
async function itemPreview(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  row: Parameters<typeof openVaultValue>[2] & { auth: unknown },
): Promise<VaultPreview | undefined> {
  const type = BotSecretAuth.safeParse(row.auth).data?.type;
  if (type !== "login" && type !== "card" && type !== "contact") return undefined;
  try {
    const plaintext = await openVaultValue(prisma, secretStore, row);
    if (type === "card") return { card: cardSummary(decodeCardSecret(plaintext)) };
    if (type === "contact") return { contact: decodeContactSecret(plaintext) };
    const { fields, otp } = decodeLoginSecret(plaintext);
    const username = fields.find((field) => !field.hidden)?.value;
    return { ...(username ? { username } : {}), ...(otp ? { otp: true as const } : {}) };
  } catch {
    getLogger().warn("vault item could not be read for its preview", { itemId: row.id });
    return undefined;
  }
}

/** The title an item shows: the one its owner gave, or one read from the item itself. */
export function vaultItemTitle(
  row: { name: string; origin: string; title: string },
  preview: VaultPreview | undefined,
): string {
  if (row.title) return row.title;
  if (preview?.card) return cardTitle(preview.card);
  if (preview?.contact?.name) return preview.contact.name;
  if (URL.canParse(row.origin)) return new URL(row.origin).host.replace(/^www\./, "");
  return row.name;
}

/** The title a new item shows when its owner gives none, read from the value being saved. */
export function defaultVaultItemTitle(
  destination: { origin: string; auth: { type: string } },
  plaintext: string,
): string {
  const parsed = BotSecretAuth.safeParse(destination.auth);
  if (!parsed.success) return "";
  const value = canonicalSecretValue(
    { name: "item", origin: destination.origin, auth: parsed.data },
    plaintext,
  );
  const preview =
    parsed.data.type === "card"
      ? { card: cardSummary(decodeCardSecret(value)) }
      : parsed.data.type === "contact"
        ? { contact: decodeContactSecret(value) }
        : undefined;
  return vaultItemTitle({ name: "", title: "", origin: destination.origin }, preview);
}

/** The owner's list, or one item by name: titles and previews, never a protected value. */
export async function listVaultItems(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  scope: BotSecretScope,
  name?: string,
  /** Off when only its metadata is needed: the preview decrypts the value. */
  withPreview = true,
) {
  const rows = await prisma.vaultCredential.findMany({
    where: { ...(await usableVaultFields(prisma, scope)), ...(name !== undefined ? { name } : {}) },
    select: { ...ownerMetadata, ...vaultRow, policy: true, alsoOn: true },
    orderBy: { name: "asc" },
  });
  // Whether each is limited in this Space, and the bots chosen here.
  const here = {
    userId: scope.userId,
    spaceId: scope.spaceId,
    credentialId: { in: rows.map((row) => row.id) },
  };
  const [limited, chosen] = await Promise.all([
    prisma.vaultCredentialLimit.findMany({ where: here, select: { credentialId: true } }),
    prisma.vaultCredentialBot.findMany({
      where: here,
      select: { credentialId: true, botId: true },
    }),
  ]);
  return Promise.all(
    rows.map(async ({ id, userId, spaceId, ciphertext, ...row }) => {
      const preview = withPreview
        ? await itemPreview(prisma, secretStore, {
            id,
            userId,
            spaceId,
            ciphertext,
            auth: row.auth,
          })
        : undefined;
      // A choice exists only while the item is limited: one left behind by an earlier save is none.
      const allBots = !limited.some((entry) => entry.credentialId === id);
      const botIds = allBots
        ? []
        : chosen.flatMap((entry) => (entry.credentialId === id ? [entry.botId] : []));
      return { ...row, allBots, botIds, title: vaultItemTitle(row, preview), preview };
    }),
  );
}

/**
 * A free handle for a new item, from its title: "Home" becomes home, a second "Home" home-2. A title
 * with no letters to use falls back to the item's kind.
 */
export async function newVaultItemName(
  prisma: PrismaClient,
  scope: BotSecretScope,
  base: string,
  kind: string,
): Promise<string> {
  const slug = base
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+|-+$/g, "")
    .slice(0, 56);
  const stem = slug || kind;
  const taken = new Set(
    (
      await prisma.vaultCredential.findMany({
        where: { ...(await vaultFields(prisma, scope)), name: { startsWith: stem } },
        select: { name: true },
      })
    ).map((row) => row.name),
  );
  if (!taken.has(stem)) return stem;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${stem}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// A contact isn't secret, so bots always see it. Only a login can ask first.
function policyField(auth: unknown, policy: VaultPolicy | undefined) {
  if (!policy) return {};
  const type = BotSecretAuth.safeParse(auth).data?.type;
  if (type === "contact" || (policy === "ask" && type !== "login"))
    throw new Error(UNSUPPORTED_ACCESS);
  return { policy };
}

export const UNSUPPORTED_ACCESS = "This item can't be used that way";

/** A login's other sites as saved: HTTPS origins, each once, without its own site. */
function alsoOnField(auth: unknown, origin: string, alsoOn: readonly string[] | undefined) {
  if (alsoOn === undefined) return {};
  if (alsoOn.length && BotSecretAuth.safeParse(auth).data?.type !== "login")
    throw new Error(UNSUPPORTED_ACCESS);
  // The editors' own check, so a site they let through is never refused here.
  const sites = alsoOn.map((site) => otherSiteOrigin(site.trim()));
  if (sites.some((site) => !site))
    throw new Error(
      "Invalid credential destination — every other site must be an HTTPS address a login " +
        "can be saved for",
    );
  return { alsoOn: [...new Set(sites as string[])].filter((site) => site !== origin) };
}

/** Change only what people call an item, when to use it, and when bots may use it. */
export async function relabelVaultItem(
  prisma: PrismaClient,
  scope: BotSecretScope,
  name: string,
  labels: {
    title?: string;
    note?: string;
    policy?: VaultPolicy;
    bots?: VaultItemBots;
    alsoOn?: readonly string[];
  },
) {
  await assertVaultInUse(prisma, scope);
  // Only these columns: the rest of a request never reaches the row.
  const data = {
    ...(labels.title !== undefined ? { title: labels.title } : {}),
    ...(labels.note !== undefined ? { note: labels.note } : {}),
  };
  return prisma.$transaction(async (tx) => {
    await lockVault(tx, scope);
    await assertVaultInUse(tx, scope);
    const row = await tx.vaultCredential.findFirst({
      where: { ...(await vaultFields(tx, scope)), name },
      select: { id: true, auth: true, origin: true },
    });
    if (!row) return false;
    await tx.vaultCredential.update({
      where: { id: row.id },
      data: {
        ...data,
        ...policyField(row.auth, labels.policy),
        ...alsoOnField(row.auth, row.origin, labels.alsoOn),
      },
    });
    await saveItemBots(tx, scope, row.id, labels.bots);
    return true;
  });
}

export async function vaultItemId(prisma: PrismaClient, scope: BotSecretScope, name: string) {
  const row = await prisma.vaultCredential.findFirst({
    where: { ...(await vaultFields(prisma, scope)), name },
    select: { id: true },
  });
  return row?.id;
}

export async function getBotSecretMetadata(
  client: PrismaClient | Prisma.TransactionClient,
  scope: BotSecretScope,
  name: string,
) {
  return client.vaultCredential.findFirst({
    where: { ...(await vaultFields(client, scope)), name },
    select: ownerMetadata,
  });
}

/**
 * A saved value for its owner to read. Only for the owner-facing reveal, which confirms the
 * person first; bots never read values. A login returns its fields.
 */
export async function revealBotSecret(input: {
  prisma: PrismaClient;
  secretStore: Pick<SecretStore, "load">;
  scope: BotSecretScope;
  name: string;
}): Promise<LoginSecretValue | { card: CardSecretValue } | { value: string } | null> {
  const row = await input.prisma.vaultCredential.findFirst({
    where: { ...(await vaultFields(input.prisma, input.scope)), name: input.name },
  });
  if (!row) return null;
  const plaintext = await openVaultValue(input.prisma, input.secretStore, row);
  const type = BotSecretAuth.safeParse(row.auth).data?.type;
  if (type === "login") return decodeLoginSecret(plaintext);
  if (type === "card") return { card: decodeCardSecret(plaintext) };
  return { value: plaintext };
}

export async function forgetBotSecret(prisma: PrismaClient, scope: BotSecretScope, name: string) {
  return prisma.$transaction(async (tx) => {
    await lockVault(tx, scope);
    // A bot can't remove an item it may not see, and is told what it would be of a missing one.
    if (await hiddenFromBot(tx, scope, name)) return { removed: false };
    const { count } = await tx.vaultCredential.deleteMany({
      where: { ...(await vaultFields(tx, scope)), name },
    });
    return { removed: count > 0 };
  });
}

/**
 * An item whose value the vault gave a bot, for the audit log; never the value. A use is recorded
 * where a value leaves for a page (resolveLoginFill, resolveVaultCardFill), a site
 * (requestWithBotSecret) or a shell command (shellCommandEnvironment), once it may have got there.
 * Reading a value only to hide it from output, to show it to its owner, or to compare it inside
 * the vault is no use; nor is a contact, which a bot reads in full as ordinary text.
 */
export type VaultItemUse = { id: string; name: string; spaceId: string | null; kind: string };

/** Response headers APIs page and rate-limit with. Other headers can echo request values. */
const PAGING_HEADERS = [
  "content-range",
  "retry-after",
  "x-next-page",
  "x-page",
  "x-per-page",
  "x-total",
  "x-total-count",
  "x-total-pages",
] as const;

/** A longer link or paging header value is dropped rather than crowd out the body. */
const MAX_PAGING_VALUE_CHARS = 2_000;
/** All returned links and paging headers together; past this, the less useful ones are left out. */
const MAX_PAGING_TOTAL_CHARS = 6_000;

/**
 * The entries of a `Link` header (RFC 8288) as their target and lowercased parameters. Quoted
 * parameter values may hold commas and semicolons; the first occurrence of a parameter counts.
 */
export function linkHeaderEntries(
  header: string,
): { target: string; params: Map<string, string> }[] {
  const entries: { target: string; params: Map<string, string> }[] = [];
  let i = 0;
  const skipSpace = () => {
    while (i < header.length && /[ \t]/.test(header[i]!)) i++;
  };
  // Skips to the next top-level `;` or `,`, stepping over quoted strings.
  const skipValue = () => {
    while (i < header.length && header[i] !== ";" && header[i] !== ",") {
      if (header[i] === '"') readQuoted();
      else i++;
    }
  };
  const readQuoted = () => {
    let value = "";
    i++;
    while (i < header.length && header[i] !== '"') {
      if (header[i] === "\\" && i + 1 < header.length) i++;
      value += header[i++];
    }
    i++;
    return value;
  };
  while (i < header.length) {
    skipSpace();
    if (header[i] !== "<") {
      // Not an entry start: skip to the next top-level separator.
      skipValue();
      i++;
      continue;
    }
    const end = header.indexOf(">", i);
    if (end === -1) break;
    const target = header.slice(i + 1, end).trim();
    i = end + 1;
    const params = new Map<string, string>();
    for (;;) {
      skipSpace();
      if (header[i] !== ";") break;
      i++;
      skipSpace();
      const nameStart = i;
      while (i < header.length && !/[=;,\s]/.test(header[i]!)) i++;
      const name = header.slice(nameStart, i).toLowerCase();
      skipSpace();
      let value = "";
      if (header[i] === "=") {
        i++;
        skipSpace();
        if (header[i] === '"') value = readQuoted();
        else {
          const valueStart = i;
          while (i < header.length && !/[;,\s]/.test(header[i]!)) i++;
          value = header.slice(valueStart, i);
        }
      }
      if (name && !params.has(name)) params.set(name, value);
    }
    skipValue();
    if (header[i] === ",") i++;
    entries.push({ target, params });
  }
  return entries;
}

/**
 * Where a paged API says the rest is: `links` from the `Link` header by relation, resolved
 * against the request URL (Canvas and GitHub put the next page there), and `headers` for the
 * other paging headers present. A value too long, a link that is not http(s), or anything that
 * carries the credential is left out.
 */
export function responsePaging(
  headers: Headers,
  requestUrl: string,
  secrets: readonly string[] = [],
): { links?: Record<string, string>; headers?: Record<string, string> } {
  // A Map, so a relation named like an Object property (constructor, __proto__) is kept as given.
  const links = new Map<string, string>();
  for (const { target, params } of linkHeaderEntries(headers.get("link") ?? "")) {
    let url: URL;
    try {
      url = new URL(target, requestUrl);
    } catch {
      continue;
    }
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.href.length > MAX_PAGING_VALUE_CHARS ||
      carriesSecret(target, secrets) ||
      carriesSecret(url.href, secrets)
    )
      continue;
    // Registered relation names compare case-insensitively; extension relations are URIs.
    for (const rel of params.get("rel")?.split(/\s+/) ?? []) {
      const name = /[:/]/.test(rel) ? rel : rel.toLowerCase();
      // An extension relation is a URI too, and can carry the credential like the link.
      if (name && !links.has(name) && !carriesSecret(name, secrets)) links.set(name, url.href);
    }
  }
  const found = new Map<string, string>();
  for (const name of PAGING_HEADERS) {
    const value = headers.get(name);
    if (value !== null && value.length <= MAX_PAGING_VALUE_CHARS && !carriesSecret(value, secrets))
      found.set(name, value);
  }
  let budget = MAX_PAGING_TOTAL_CHARS;
  const withinBudget = (entries: Iterable<[string, string]>) => {
    const kept: [string, string][] = [];
    for (const [name, value] of entries) {
      const size = name.length + value.length;
      if (size > budget) continue;
      budget -= size;
      kept.push([name, value]);
    }
    return kept;
  };
  // The next page first, then the paging headers, then the other links.
  const next = links.get("next");
  const keptNext = withinBudget(next === undefined ? [] : [["next", next]]);
  const keptHeaders = withinBudget(found);
  const keptLinks = [...keptNext, ...withinBudget([...links].filter(([name]) => name !== "next"))];
  return {
    ...(keptLinks.length ? { links: Object.fromEntries(keptLinks) } : {}),
    ...(keptHeaders.length ? { headers: Object.fromEntries(keptHeaders) } : {}),
  };
}

/**
 * Whether a value holds any form of a credential, compared case-insensitively and also after
 * percent-decoding (any case of escape, repeated), so an echo the body redaction would miss is
 * caught. A link or header that does is left out whole: with the value replaced it would not work.
 */
function carriesSecret(value: string, secrets: readonly string[]): boolean {
  if (secrets.length === 0) return false;
  const forms = [value, value.replace(/\+/g, " ")];
  let decoded = value;
  for (let round = 0; round < 3; round++) {
    const next = decoded.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run;
      }
    });
    if (next === decoded) break;
    forms.push(next, next.replace(/\+/g, " "));
    decoded = next;
  }
  const haystacks = forms.map((form) => form.toLowerCase());
  return secrets.some((secret) => {
    const needle = secret.toLowerCase();
    return needle.length > 0 && haystacks.some((haystack) => haystack.includes(needle));
  });
}

/** Credentials are resolved only inside this destination-bound HTTP boundary. */
export async function requestWithBotSecret(input: {
  prisma: PrismaClient;
  secretStore: SecretStore;
  scope: BotSecretScope;
  request: unknown;
  signal: AbortSignal;
  remote?: RemoteTransportDependencies;
  registerRedactions?: (values: string[]) => void;
  recordUse?: (item: VaultItemUse, site: string) => Promise<void>;
}): Promise<unknown> {
  const request = SecretHttpRequest.parse(input.request);
  const row = await input.prisma.vaultCredential.findFirst({
    where: { ...(await usableVaultFields(input.prisma, input.scope)), name: request.name },
  });
  if (!row) return { error: "Credential is unavailable. Use request_secret to save it first." };
  const destination = normalizeSecretDestination(row);
  if (destination.auth.type === "login") {
    return { error: "Website logins can only be filled into their site with browser_act." };
  }
  if (destination.auth.type === "command") {
    return {
      error: `${UNUSABLE_CREDENTIAL}. Command variables are only available to shell commands, as $${commandVariableName(destination.name)}.`,
    };
  }
  const url = new URL(request.url);
  if (url.origin !== destination.origin || url.username || url.password || url.hash) {
    return { error: "This credential cannot be sent to that destination." };
  }
  const controller = new AbortController();
  const signal = combineSignals(input.signal, controller.signal, AbortSignal.timeout(30_000));
  const plaintext = await openVaultValue(input.prisma, input.secretStore, row, signal);
  const headers = new Headers({ accept: "application/json", "content-type": request.contentType });
  const { name: headerName, value: headerValue } = credentialHeader(destination, plaintext);
  const redactions = apiKeyRedactionForms(destination, plaintext);
  input.registerRedactions?.(redactions);
  // Once the request may have gone out, so one refused before sending isn't a use.
  let recorded = false;
  const recordUse = async () => {
    if (recorded) return;
    recorded = true;
    await input.recordUse?.(
      { id: row.id, name: row.name, spaceId: row.spaceId, kind: destination.auth.type },
      destination.origin,
    );
  };
  // The safe fetch refuses plain-HTTP and private hosts outright. A credential
  // saved under the owner's private-HTTP opt-in was validated against exactly
  // those rules at save time, and the request URL is pinned to its origin, so
  // deliver it through the inverted transport instead — it re-checks that every
  // resolved address is private (metadata endpoints stay blocked) and pins the
  // connection to the validated answer.
  const privateHttpDestination =
    allowPrivateHttpSecretOrigins() &&
    url.protocol === "http:" &&
    isPrivateNetworkHost(url.hostname);
  // Cancelled while the destination is still being checked, nothing is sent, then or after.
  let sent = false;
  const beforeSend = () => {
    signal.throwIfAborted();
    sent = true;
  };
  const fetch = privateHttpDestination
    ? createPrivateNetworkFetch(input.remote?.fetch, input.remote?.resolveHostname, beforeSend)
    : createSafeRemoteFetch(
        input.remote?.fetch,
        input.remote?.resolveHostname,
        undefined,
        beforeSend,
      );
  try {
    headers.set(headerName, headerValue);
    const response = await withAbort(
      fetch(url, {
        method: request.method,
        headers,
        body: request.body,
        redirect: "manual",
        signal,
      }),
      signal,
    );
    await recordUse();
    const bytes = await readBodyCapped(response, 1_000_000, signal);
    const text = new TextDecoder().decode(bytes);
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* Plain text responses are supported. */
    }
    // Redact before truncating, so an output boundary cannot expose part of a value.
    const safe = JSON.stringify(redactConnectorPayload(body, redactions));
    const paging = redactConnectorPayload(
      responsePaging(response.headers, url.href, redactions),
      redactions,
    ) as Record<string, unknown>;
    return {
      status: response.status,
      ...paging,
      body: safe.length > 20_000 ? safe.slice(0, 20_000) : JSON.parse(safe),
      truncated: safe.length > 20_000,
    };
  } catch (error) {
    // Sent and cut off, redirected, or cancelled or timed out while out: the key may have
    // reached the site.
    if (
      error instanceof RemoteRequestSentError ||
      error instanceof ConnectorRedirectError ||
      (sent && signal.aborted)
    )
      await recordUse();
    return { error: "Authenticated request failed. Check the destination and credential." };
  } finally {
    controller.abort();
    await withAbort(fetch.close(), AbortSignal.timeout(1000)).catch(() => undefined);
  }
}

// Redaction is substring replacement, so a short visible value would mangle unrelated text.
const MIN_REDACTED_VISIBLE_VALUE = 6;
const MIN_REDACTED_HIDDEN_VALUE_EVERY_RUN = MIN_REDACTED_VISIBLE_VALUE;

function passwordRedactionForms(password: string): string[] {
  return [
    ...new Set([
      ...commandRedactionForms(password),
      // A submitted form encodes `+` for spaces and escapes `!'()~`, unlike encodeURIComponent.
      new URLSearchParams({ v: password }).toString().slice(2),
    ]),
  ];
}

/**
 * An authenticator key as a page or file may show it: as saved, as its base32 secret in either case
 * and in groups of four, and as the secret of its setup link, each in a password's encodings.
 */
function authenticatorKeyRedactionForms(otp: string): string[] {
  const secret = authenticatorKey(otp)?.secret ?? "";
  const link = URL.canParse(otp)
    ? ([...new URL(otp).searchParams].find(([name]) => name.toLowerCase() === "secret")?.[1] ?? "")
    : "";
  const groups = secret.match(/.{1,4}/g) ?? [];
  // As saved, inside its link, plain, and in fours spaced or dashed, each in either case.
  return [otp, link, secret, groups.join(" "), groups.join("-")]
    .flatMap((form) => [form, form.toLowerCase()])
    .filter((form) => form.length >= MIN_REDACTED_HIDDEN_VALUE_EVERY_RUN)
    .flatMap(passwordRedactionForms);
}

function apiKeyRedactionForms(destination: BotSecretDestination, plaintext: string): string[] {
  const { value: headerValue } = credentialHeader(destination, plaintext);
  return [
    ...new Set([
      plaintext,
      headerValue,
      Buffer.from(plaintext).toString("base64"),
      encodeURIComponent(plaintext),
      headerValue.replace(/^Basic /, ""),
    ]),
  ].filter(Boolean);
}

/**
 * A card number as pages show it: as given, digits only, and in groups of four. American Express
 * (15 digits) and Diners Club (14) print as 4-6-5 and 4-6-4.
 */
export function cardRedactionForms(number: string): string[] {
  const digits = number.replace(/\D/g, "");
  const grouped = digits.replace(/(\d{4})(?=\d)/g, "$1 ");
  const hyphenated = digits.replace(/(\d{4})(?=\d)/g, "$1-");
  const long = digits.match(/^(\d{4})(\d{6})(\d{4,5})$/);
  const printed = long ? [long.slice(1).join(" "), long.slice(1).join("-")] : [];
  return [...new Set([number, digits, grouped, hyphenated, ...printed].filter(Boolean))];
}

export class VaultKeyUnavailableError extends Error {
  constructor(cause: unknown) {
    super("A vault key could not be loaded from the key manager", { cause });
    this.name = "VaultKeyUnavailableError";
  }
}

/**
 * A value to hide in every run. When the key manager can't provide its vault's key, the run must
 * not start without hiding it, as content reads fail then too; an item whose own stored data
 * doesn't open is skipped like any other unreadable item.
 */
async function openForRedaction(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  row: Parameters<typeof openVaultValue>[2],
): Promise<string> {
  try {
    return await openVaultValue(prisma, secretStore, row);
  } catch (error) {
    if (ciphertextKeyId(row.ciphertext) !== undefined && !(error instanceof ContentDecryptionError))
      throw new VaultKeyUnavailableError(error);
    throw error;
  }
}

/**
 * Redaction forms of every saved login's hidden fields, card number and API key in the vault the
 * run uses. A filled login or card stays on its page after the run that filled it, so each run
 * hides them before any tool output reaches the model. Visible fields stay readable outside the
 * filling run: one is often the user's own email, which ordinary tasks need.
 */
export async function loadLoginPasswordRedactions(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  scope: BotSecretScope,
): Promise<string[]> {
  // Every saved login, card and API key, whether or not this bot may use it: a value an earlier
  // run wrote down stays hidden. Command variables and contacts are not read here.
  const rows = await prisma.vaultCredential.findMany({
    where: {
      ...(await vaultFields(prisma, scope)),
      OR: ["login", "card", "bearer", "header", "basic"].map((type) => ({
        auth: { path: ["type"], equals: type },
      })),
    },
    select: { ...vaultRow, name: true, origin: true, auth: true },
  });
  const forms = new Set<string>();
  for (const row of rows) {
    const type = BotSecretAuth.safeParse(row.auth).data?.type;
    if (type === "card") {
      try {
        const card = decodeCardSecret(await openForRedaction(prisma, secretStore, row));
        for (const form of cardRedactionForms(card.number)) forms.add(form);
      } catch (error) {
        if (error instanceof VaultKeyUnavailableError) throw error;
        getLogger().warn("saved card could not be loaded for redaction", { cardId: row.id });
      }
      continue;
    }
    if (type === "bearer" || type === "header" || type === "basic") {
      try {
        const plaintext = await openForRedaction(prisma, secretStore, row);
        // A short value would mangle unrelated text in every run; the run that sends it hides it.
        if (plaintext.length < MIN_REDACTED_HIDDEN_VALUE_EVERY_RUN) continue;
        const auth = BotSecretAuth.parse(row.auth);
        for (const form of apiKeyRedactionForms({ ...row, auth }, plaintext)) forms.add(form);
      } catch (error) {
        if (error instanceof VaultKeyUnavailableError) throw error;
        getLogger().warn("saved API key could not be loaded for redaction", { keyId: row.id });
      }
      continue;
    }
    if (type !== "login") continue;
    try {
      const { fields, otp } = decodeLoginSecret(await openForRedaction(prisma, secretStore, row));
      for (const form of otp ? authenticatorKeyRedactionForms(otp) : []) forms.add(form);
      for (const field of fields) {
        // Every run would mangle each occurrence of a short value; the filling run still hides it.
        if (!field.hidden || field.value.length < MIN_REDACTED_HIDDEN_VALUE_EVERY_RUN) continue;
        for (const form of passwordRedactionForms(field.value)) forms.add(form);
      }
    } catch (error) {
      if (error instanceof VaultKeyUnavailableError) throw error;
      // Like an unreadable command variable, it must not stop every computer tool. The id only:
      // an operator can see which login is no longer hidden. Not under a "secret" key, which
      // the logger scrubs.
      getLogger().warn("saved login could not be loaded for redaction", { loginId: row.id });
    }
  }
  return [...forms];
}

/**
 * The login field a fill names: by its label, or "username" and "password" for the first visible
 * and the first hidden field, as a login saved before fields existed was filled.
 */
export function findLoginField(fields: readonly LoginField[], name: string) {
  const labelled = fields.find((field) => sameLoginFieldLabel(field.label, name));
  if (labelled) return labelled;
  const key = name.trim().toLowerCase();
  if (key === "username") return fields.find((field) => !field.hidden);
  if (key === "password") return fields.find((field) => field.hidden);
  return undefined;
}

/** A login kept for one run only: its fields with the card's site, stored as one secret. */
export function encodeRunLogin(origin: string, login: string): string {
  return JSON.stringify({ origin, login });
}

const RunCodeValue = z.object({ origin: z.string(), code: z.string() });

/** A code answered in chat, kept with the site it is for until it is typed there. */
export function encodeRunCode(origin: string, code: string): string {
  return JSON.stringify({ origin, code });
}

/** The run's code row as stored, or nothing when it cannot be read; only the error name is logged. */
export async function readRunCode(
  secretStore: Pick<SecretStore, "load">,
  row: { id: string; ciphertext: string },
): Promise<{ origin: string; code: string } | undefined> {
  try {
    return RunCodeValue.parse(JSON.parse(await secretStore.load(row.ciphertext, row.id)));
  } catch (error) {
    getLogger().warn("one-time code could not be read", {
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return undefined;
  }
}

/**
 * Every form of a code the model could be handed: as is, without dashes, URL-encoded, in either
 * case, and as a page draws it per character or in two groups (input-otp widgets put each digit in
 * its own element, which a snapshot reads as one digit per line).
 */
export function oneTimeCodeRedactions(code: string): string[] {
  const forms = new Set<string>();
  const joins = ["\n", "\r\n", " ", "\t", "-", " - "];
  const digits = code.replaceAll("-", "");
  // A bare short number such as 2026 would blank years and prices for the rest of the run.
  const bare = digits.length >= 6 || /[A-Za-z]/.test(digits);
  for (const written of new Set([code, code.toUpperCase(), code.toLowerCase()])) {
    for (const base of new Set([written, written.replaceAll("-", "")])) {
      if (bare) forms.add(base).add(encodeURIComponent(base));
      for (const join of joins) forms.add([...base].join(join));
      const half = Math.ceil(base.length / 2);
      for (const join of joins) forms.add(`${base.slice(0, half)}${join}${base.slice(half)}`);
    }
  }
  // A short form would blank ordinary text in every later result.
  return [...forms].filter((form) => form.length >= ONE_TIME_CODE_MIN_LENGTH);
}

const RunLoginValue = z.object({ origin: z.string(), login: z.string() });

function decodeRunLogin(plaintext: string): LoginSecretValue & { origin: string } {
  const { origin, login } = RunLoginValue.parse(JSON.parse(plaintext));
  return { origin, ...decodeLoginSecret(login) };
}

/** This run's login under `name` that the person chose not to save, if any. */
export async function findRunLogin(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  scope: BotSecretScope,
  runId: string,
  name: string,
): Promise<(LoginSecretValue & { origin: string }) | undefined> {
  const row = await prisma.secret.findFirst({
    where: { userId: scope.userId, spaceId: scope.spaceId, kind: runLoginKind(runId, name) },
    select: { id: true, ciphertext: true },
  });
  return row ? decodeRunLogin(await secretStore.load(row.ciphertext, row.id)) : undefined;
}

/**
 * Redaction forms of this run's logins that weren't saved, from the start of the run: hidden
 * fields as every run hides a saved login's, and every field as the run that fills one does.
 */
export async function loadRunLoginRedactions(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  scope: BotSecretScope,
  runId: string,
): Promise<string[]> {
  const rows = await prisma.secret.findMany({
    where: {
      userId: scope.userId,
      spaceId: scope.spaceId,
      kind: { startsWith: runLoginKind(runId, "") },
    },
    select: { id: true, ciphertext: true },
  });
  const forms = new Set<string>();
  for (const row of rows) {
    const { fields } = decodeRunLogin(await secretStore.load(row.ciphertext, row.id));
    for (const form of loginFillRedactions(fields)) forms.add(form);
    for (const field of fields) {
      if (!field.hidden || field.value.length < MIN_REDACTED_HIDDEN_VALUE_EVERY_RUN) continue;
      for (const form of passwordRedactionForms(field.value)) forms.add(form);
    }
  }
  return [...forms];
}

function loginFillRedactions(fields: readonly LoginField[]): string[] {
  return [
    ...new Set(
      fields
        .filter((entry) => entry.hidden || entry.value.length >= MIN_REDACTED_VISIBLE_VALUE)
        .flatMap((entry) => [entry.value, encodeURIComponent(entry.value)]),
    ),
  ];
}

const HTTPS_ONLY = "Website logins can only be filled on an HTTPS origin.";

/**
 * Resolve one field of a website login for a page fill: this run's login that wasn't saved under
 * the name first, since it is what the person just typed, then a saved one. The caller must pass
 * `origin` to the page browser, which refuses to fill unless the page is still on that origin,
 * and must type a hidden field only into a password field.
 */
export async function resolveLoginFill(input: {
  prisma: PrismaClient;
  secretStore: SecretStore;
  scope: BotSecretScope;
  runId: string;
  name: string;
  field: string;
  /** The user's approval of this call, which a login that asks first needs. */
  approval?: VaultLoginUse;
  /** The page the run's browser last reported; a login fills there when it is one of its sites. */
  pageUrl?: string;
  /** The current code of the login's authenticator key instead of a field. */
  code?: true;
}): Promise<
  | {
      text: string;
      hidden: boolean;
      origin: string;
      /** Every site the login fills on. */
      sites: string[];
      redactions: string[];
      used?: VaultItemUse;
      /** For a saved login's code: the login and the stored value the code came from, for loginCodeClaim. */
      login?: { id: string; ciphertext: string };
      /** For a code: until when it is the authenticator's current one, in epoch milliseconds. */
      codeEnds?: number;
    }
  | { error: string }
> {
  const runLogin = await findRunLogin(
    input.prisma,
    input.secretStore,
    input.scope,
    input.runId,
    input.name,
  );
  const row = runLogin
    ? undefined
    : await input.prisma.vaultCredential.findFirst({
        where: { ...(await usableVaultFields(input.prisma, input.scope)), name: input.name },
      });
  const stored = runLogin
    ? { name: input.name, origin: runLogin.origin, auth: { type: "login" } }
    : row;
  if (!stored) return { error: "Login is unavailable. Use request_secret to save it first." };
  const storedType = BotSecretAuth.safeParse(stored.auth).data?.type;
  if (storedType === "card") {
    return { error: "This is a saved card. Type it with browser_act fill_card, passing card." };
  }
  if (storedType === "contact") {
    return {
      error:
        "A contact is not secret: read it with list_secrets and type it with browser_act fill.",
    };
  }
  if (isCommandCredential(stored.auth)) {
    return {
      error: `${UNUSABLE_CREDENTIAL}. Command variables are only available to shell commands.`,
    };
  }
  // Checked on the stored origin itself, so the private-LAN HTTP allowance cannot widen a login.
  let storedOrigin: URL;
  try {
    storedOrigin = new URL(stored.origin);
  } catch {
    return { error: HTTPS_ONLY };
  }
  if (storedOrigin.protocol !== "https:") return { error: HTTPS_ONLY };
  const destination = normalizeSecretDestination(stored);
  if (destination.auth.type !== "login") {
    return { error: "This credential is not a website login." };
  }
  if (destination.origin !== storedOrigin.origin) return { error: HTTPS_ONLY };
  // The page browser still types only while the page is on the one origin sent, so a stale or
  // redirected page is refused there, and an older computer image needs no change.
  const page = input.pageUrl && URL.canParse(input.pageUrl) ? new URL(input.pageUrl).origin : "";
  const { approval } = input;
  // An approved call is replayed in a fresh attempt that hasn't seen the page yet, so it fills on
  // the site the user approved while that is still one of the login's.
  const approvedSite =
    row?.policy === "ask" &&
    approval &&
    [destination.origin, ...(row.alsoOn ?? [])].includes(approval.site)
      ? approval.site
      : undefined;
  const origin = approvedSite ?? (row?.alsoOn?.includes(page) ? page : destination.origin);
  // Read again here, so the login as it is now is the one the user approved, on this site.
  if (row?.policy === "ask") {
    if (
      approval?.login !== row.name ||
      approval.site !== origin ||
      !approval.fields.includes(input.code ? LOGIN_CODE_FIELD : input.field.trim())
    )
      return { error: "The user has not approved signing in with this login here." };
    if (approval.savedAt !== row.updatedAt.toISOString())
      return {
        error:
          "This login changed after the user approved it, so nothing was typed. Call browser_act again to ask them.",
      };
  }
  const { fields, otp } =
    runLogin ?? decodeLoginSecret(await openVaultValue(input.prisma, input.secretStore, row!));
  const key = input.code && otp ? authenticatorKey(otp) : undefined;
  if (input.code && !key)
    return { error: "This login has no authenticator key. Use request_secret with oneTimeCode." };
  if (input.code && row?.codesStoppedAt) return { error: LOGIN_CODES_USED_UP };
  const now = Date.now();
  const code = key && totpCode(key, now);
  const field = code ? { value: code, hidden: true } : findLoginField(fields, input.field);
  if (!field) {
    return {
      error: `This login has no field named ${JSON.stringify(input.field)}. Its fields: ${fields.map((entry) => entry.label).join(", ")}.`,
    };
  }
  return {
    text: field.value,
    hidden: field.hidden,
    origin,
    sites: [destination.origin, ...(row?.alsoOn ?? [])],
    // Its key too, which may be newer than the run: the run hides from then on the key it used.
    redactions: [
      ...(code ? oneTimeCodeRedactions(code) : loginFillRedactions(fields)),
      ...(otp ? authenticatorKeyRedactionForms(otp) : []),
    ],
    // Only a saved login is a vault item; this run's own login was never saved.
    ...(row && { used: { id: row.id, name: row.name, spaceId: row.spaceId, kind: "login" } }),
    ...(row && input.code && { login: { id: row.id, ciphertext: row.ciphertext } }),
    ...(key && { codeEnds: totpCodeEnd(key, now) }),
  };
}

/**
 * Redaction forms of this run's codes, those waiting and those the page took, from the start of
 * every attempt: a filled code stays on its page and in what the run has read.
 */
export async function loadRunCodeRedactions(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  scope: BotSecretScope,
  runId: string,
): Promise<string[]> {
  const rows = await prisma.secret.findMany({
    where: {
      userId: scope.userId,
      spaceId: scope.spaceId,
      kind: { in: [runCodeKind(runId), runCodeSpentKind(runId)] },
    },
    select: { id: true, ciphertext: true },
  });
  const forms = new Set<string>();
  for (const row of rows) {
    const held = await readRunCode(secretStore, row);
    for (const form of held ? oneTimeCodeRedactions(held.code) : []) forms.add(form);
  }
  return [...forms];
}

const NO_CODE_WAITING =
  "No code is waiting. Use request_secret with oneTimeCode to ask the user for it first.";

/**
 * This run's code for a page fill. Like a login's, the caller must pass `origin` to the page
 * browser, which refuses to fill unless the page is still on it. The code is only read here:
 * `claim` takes it for one fill, atomically, so two fills never both get it (the loser gets why),
 * and `restore` gives it back when the page refused, so the fill can be tried again on the right
 * page. A claimed code stays as a spent row, which the run keeps hiding until it ends.
 */
export async function resolveCodeFill(input: {
  prisma: PrismaClient;
  secretStore: SecretStore;
  scope: BotSecretScope;
  runId: string;
}): Promise<
  | {
      text: string;
      origin: string;
      redactions: string[];
      claim: () => Promise<string | undefined>;
      restore: () => Promise<void>;
    }
  | { error: string }
> {
  const where = { userId: input.scope.userId, spaceId: input.scope.spaceId };
  const row = await input.prisma.secret.findFirst({
    where: { ...where, kind: runCodeKind(input.runId) },
    select: { id: true, ciphertext: true },
  });
  if (!row) return { error: NO_CODE_WAITING };
  const held = await readRunCode(input.secretStore, row);
  if (!held) return { error: "This code could not be loaded." };
  if (!URL.canParse(held.origin) || new URL(held.origin).protocol !== "https:")
    return { error: NOT_HTTPS_CODE };
  const move = async (from: string, to: string) =>
    (
      await input.prisma.secret.updateMany({
        where: { id: row.id, kind: from },
        data: { kind: to },
      })
    ).count === 1;
  return {
    text: held.code,
    origin: held.origin,
    redactions: oneTimeCodeRedactions(held.code),
    claim: async () =>
      (await move(runCodeKind(input.runId), runCodeSpentKind(input.runId)))
        ? undefined
        : NO_CODE_WAITING,
    restore: async () => {
      await move(runCodeSpentKind(input.runId), runCodeKind(input.runId));
    },
  };
}

export const LOGIN_CODE_CHANGED =
  "The authenticator moved on to its next code before this one could be typed, so nothing was typed. Call browser_act again.";
export const LOGIN_REMOVED =
  "This login is no longer saved, so nothing was typed. Use request_secret with oneTimeCode to ask the user for the code.";
export const LOGIN_VALUE_CHANGED =
  "This login changed before its code could be typed, so nothing was typed. Call browser_act again.";
export const CODE_ALREADY_TYPED =
  "This code was already typed in this run. Wait for the authenticator's next code, then call fill_code again.";

/**
 * Codes of one login a run types; a site that refused them all likely has another key, so once a
 * run has typed that many, no run types its codes until the login is saved again.
 */
export const LOGIN_CODE_TRIES = 3;
/**
 * How soon after a login's code was typed the next request for one reads as the site asking
 * again. The backend can't see whether a site took a code; a wrong key is told apart from a
 * working one used several times by its codes coming in quick succession.
 */
export const LOGIN_CODE_REPEAT_WINDOW_MS = 5 * 60_000;
export const LOGIN_CODES_USED_UP = `A site asked for this login's authenticator code ${LOGIN_CODE_TRIES} times in a row, so its saved key may be wrong, and none are typed until the user saves the login again. Use request_secret with oneTimeCode to ask the user for the code.`;

/**
 * Typing a saved login's authenticator code once in this run. The state, all of it under the
 * login's row lock:
 * - The login is stopped or not (`codesStoppedAt`). Only the claim below stops it; only its
 *   owner's own save of its value clears it. A relabel changes neither, nor does a save a bot
 *   started, such as a login card answered in chat: it keeps the key that was stopped.
 * - Per run and saved value the code came from (the row's ciphertext; a save makes a new one),
 *   the codes claimed, each with the time it was claimed, as spent run codes the run's later
 *   attempts reload to hide. Codes of an earlier value are never counted again.
 * A claim of a code:
 * - is refused with LOGIN_REMOVED when the login was removed since the fill read it;
 * - is refused with LOGIN_VALUE_CHANGED when the login value changed since the fill read it;
 * - is refused with LOGIN_CODES_USED_UP while the login is stopped, for every run and value;
 * - is refused with CODE_ALREADY_TYPED when this run claimed the same code of this value;
 * - else counts `asked`: this code, plus the run's earlier codes of this value walking back
 *   from now, each claimed within LOGIN_CODE_REPEAT_WINDOW_MS of the one after it (the site
 *   asked again, which is what a refusal looks like from here; the backend can't see whether
 *   a site took a code). A code outside the window starts over, so a working key is used as
 *   often as runs need;
 * - past LOGIN_CODE_TRIES is refused with LOGIN_CODES_USED_UP;
 * - else is written, and when `asked` reaches LOGIN_CODE_TRIES with the saved value still the
 *   one the code came from, the login is stopped at this claim's time, keeping `updatedAt` so
 *   an approval given for the login holds. Parallel claims are serialised by the lock, so at
 *   most three count and exactly one stops.
 * A restore, for a code the page clearly never typed, deletes the claim, and clears the stop
 * when it is this run's (set at this or a remaining claim's time) and fewer than
 * LOGIN_CODE_TRIES codes now stand within the window of each other up to that time; a stop
 * three other codes still justify stays. A fill the page may have typed changes nothing: the
 * stop stands. Webhook and helper runs are refused before any fill, by the tool gate.
 */
export function loginCodeClaim(input: {
  prisma: PrismaClient;
  secretStore: Pick<SecretStore, "put">;
  scope: BotSecretScope;
  runId: string;
  /** The saved login and the stored value the code came from; a save since keeps its codes. */
  login: { id: string; ciphertext: string };
  origin: string;
  code: string;
}) {
  const { prisma, scope, runId } = input;
  // Keyed with the deployment's secret, as parallel-web's session ids are: a plain hash of a
  // six-digit code could be reversed by anyone who can read the table.
  const keyed = (text: string, length: number) =>
    createHmac("sha256", resolveEncryptionKey())
      .update("rakazo:vault-code-claim:v1\0")
      .update(text)
      .digest("hex")
      .slice(0, length);
  // Starts the same for each code of this value of the login in this run, so the run counts
  // them, and the codes of a value the owner has replaced no longer.
  const value = `${runId}:${input.login.id}:${input.login.ciphertext}`;
  const login = `run-totp-${keyed(value, 16)}-`;
  const id = `${login}${keyed(`${value}:${input.code}`, 32)}`;
  const spentKind = runCodeSpentKind(runId);
  // The run's codes of this value, latest first.
  const claimed = async (tx: Prisma.TransactionClient) =>
    (
      await tx.secret.findMany({
        where: { userId: scope.userId, spaceId: scope.spaceId, kind: spentKind },
        select: { id: true, createdAt: true },
      })
    )
      .filter((row) => row.id.startsWith(login))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  // How many of `rows` were asked for again: claimed within the window of the one after, back
  // from `until`.
  const asked = (rows: { createdAt: Date }[], until: number) => {
    let count = 0;
    for (const row of rows) {
      if (row.createdAt.getTime() > until) continue;
      if (until - row.createdAt.getTime() > LOGIN_CODE_REPEAT_WINDOW_MS) break;
      count += 1;
      until = row.createdAt.getTime();
    }
    return count;
  };
  // One claim or restore of this login at a time, across every run and process; an owner's save
  // of the login waits on the same row.
  const locked = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    withTransactionRetry(() =>
      prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM vault_credentials WHERE id = ${input.login.id} FOR UPDATE`;
        return fn(tx);
      }),
    );
  // When this claim was written, so a stop set then is known as its own.
  let at: Date | undefined;
  const take = () =>
    locked(async (tx) => {
      const spent = await claimed(tx);
      const current = await tx.vaultCredential.findFirst({
        where: { id: input.login.id },
        select: { ciphertext: true, codesStoppedAt: true, updatedAt: true },
      });
      // The owner removed the login since this run read it.
      if (!current) return LOGIN_REMOVED;
      if (current.ciphertext !== input.login.ciphertext) return LOGIN_VALUE_CHANGED;
      // Another run stopped the login since this one read it.
      if (current.codesStoppedAt) return LOGIN_CODES_USED_UP;
      if (spent.some((row) => row.id === id)) return CODE_ALREADY_TYPED;
      at = new Date();
      const repeats = 1 + asked(spent, at.getTime());
      if (repeats > LOGIN_CODE_TRIES) return LOGIN_CODES_USED_UP;
      const stored = await input.secretStore.put(
        encodeRunCode(input.origin, input.code),
        { operationId: runId, traceId: runId, ...scope, signal: new AbortController().signal },
        { recordId: id, ephemeral: true },
      );
      await tx.secret.create({
        data: {
          id,
          userId: scope.userId,
          spaceId: scope.spaceId,
          kind: spentKind,
          ciphertext: stored.ciphertext,
          createdAt: at,
        },
      });
      // The last code a site keeps asking for stops the login, but only for the value it came
      // from: a key saved since may be right. The time it was saved stays, so an approval given
      // for it holds.
      if (repeats >= LOGIN_CODE_TRIES) {
        await tx.vaultCredential.updateMany({
          where: { id: input.login.id, ciphertext: current.ciphertext },
          data: { codesStoppedAt: at, updatedAt: current.updatedAt },
        });
      }
      return undefined;
    });
  return {
    claim: async (): Promise<string | undefined> => {
      try {
        return await take();
      } catch (error) {
        // The same code's row, written by a previous release's claim that takes no lock.
        if ((error as { code?: unknown } | null)?.code === "P2002") return CODE_ALREADY_TYPED;
        throw error;
      }
    },
    restore: async () => {
      await locked(async (tx) => {
        const { count } = await tx.secret.deleteMany({ where: { id, kind: spentKind } });
        if (!count) return;
        const current = await tx.vaultCredential.findFirst({
          where: { id: input.login.id },
          select: { codesStoppedAt: true, updatedAt: true },
        });
        const stop = current?.codesStoppedAt?.getTime();
        if (!stop) return;
        const rest = await claimed(tx);
        // Only a stop this run's codes of this value caused, by this claim or one still standing.
        const ours = stop === at?.getTime() || rest.some((row) => row.createdAt.getTime() === stop);
        if (ours && asked(rest, stop) < LOGIN_CODE_TRIES)
          await tx.vaultCredential.updateMany({
            where: { id: input.login.id, codesStoppedAt: current!.codesStoppedAt! },
            data: { codesStoppedAt: null, updatedAt: current!.updatedAt },
          });
      });
    },
  };
}

/**
 * One field of a saved card for browser_act fill_card, only on `site`: the checkout the person
 * approved typing this card into. The caller passes the returned origin to the page browser,
 * which refuses to fill unless the page is still on it. The number's forms are returned for the
 * run to hide; later runs hide them too, through loadLoginPasswordRedactions.
 */
export async function resolveVaultCardFill(input: {
  prisma: PrismaClient;
  secretStore: Pick<SecretStore, "load">;
  scope: BotSecretScope;
  name: string;
  field: PurchaseCardField;
  site: string;
  /** When the approved card was last saved; a card replaced since then is not typed. */
  savedAt: string;
}): Promise<
  { text: string; origin: string; redactions: string[]; used: VaultItemUse } | { error: string }
> {
  const target = OneTimeCodeTarget.safeParse({ origin: input.site });
  if (!target.success) return { error: "site must be the checkout page's HTTPS origin." };
  const usable = await usableVaultFields(input.prisma, input.scope);
  const row = await input.prisma.vaultCredential.findFirst({
    where: { ...usable, name: input.name },
  });
  if (!row || BotSecretAuth.safeParse(row.auth).data?.type !== "card") {
    return { error: "No card is saved under this name. Check list_secrets." };
  }
  if (row.updatedAt.toISOString() !== input.savedAt) {
    return {
      error:
        "This card changed after the user approved it, so nothing was typed. Call browser_act again to ask them.",
    };
  }
  const card = decodeCardSecret(await openVaultValue(input.prisma, input.secretStore, row));
  const fill = {
    origin: new URL(target.data.origin).origin,
    redactions: cardRedactionForms(card.number),
    used: { id: row.id, name: row.name, spaceId: row.spaceId, kind: "card" },
  };
  if (input.field === "number") return { text: card.number, ...fill };
  if (input.field === "expiry") return { text: cardExpiry(card), ...fill };
  if (input.field === "cvc") {
    // Only the number is hidden, as for a wallet card: hiding 3 or 4 digits would blank every total
    // and order number that contains them for the rest of the run.
    return card.cvc
      ? { text: card.cvc, ...fill }
      : { error: "This card has no security code saved." };
  }
  const billing = card.billing
    ? await input.prisma.vaultCredential.findFirst({ where: { ...usable, name: card.billing } })
    : null;
  const postalCode =
    billing && BotSecretAuth.safeParse(billing.auth).data?.type === "contact"
      ? decodeContactSecret(await openVaultValue(input.prisma, input.secretStore, billing))
          .postalCode
      : undefined;
  // A billing contact the bot can't use, or one removed, is withheld, not left for it to guess.
  if (card.billing && !billing)
    return { error: "This card has no billing address this bot can use." };
  return postalCode
    ? { text: postalCode, ...fill }
    : {
        error:
          "This card has no billing postal code saved. Type the postal code of the user's billing address yourself.",
      };
}
