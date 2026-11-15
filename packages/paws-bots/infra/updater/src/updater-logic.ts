import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  DEFAULT_IMAGE_TAG,
  IMAGE_TAG_ENV,
  isValidImageName,
  isValidImageTag,
  OFFICIAL_SERVER_IMAGE,
  PREVIOUS_IMAGE_TAG_ENV,
  RECREATED_SERVICES,
  resolveComposeProjectName,
  resolveUpdaterToken,
} from "@rakazo/core";

export const DEFAULT_UPDATER_PORT = 7092;
export const DEFAULT_COMPOSE_FILE = "infra/compose/docker-compose.prod.yml";
/** Compose's own convention for a multi-file list, matching COMPOSE_FILE. */
export const DEFAULT_COMPOSE_PATH_SEPARATOR = ":";
const SERVICE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
/** The sidecar itself, which must never appear in the set of services an update recreates. */
const UPDATER_SERVICE = "updater";
export const MAX_STEP_OUTPUT = 8_000;

export interface UpdaterConfig {
  /** Bind-mounted at the same absolute path it has on the host, so Compose resolves identically. */
  deployDir: string;
  /** Overlay order, absolute. Each becomes its own `--file`. */
  composeFiles: readonly string[];
  /** Services the update pulls, recreates and rolls back. */
  updateServices: readonly string[];
  envFile: string;
  /** Passed as `docker compose -p`. Compose injects this into running services. */
  projectName: string;
  image: string;
  token: string;
  host: string;
  port: number;
}

/**
 * The deployment directory has to be an absolute path because Compose derives every relative bind
 * mount from it. Mounting it anywhere other than its host path would make this container reconcile
 * a *different* tree than the operator's. The project name is passed as `-p` separately so a custom
 * `docker compose -p` stack is the one that is updated.
 */
export function resolveUpdaterConfig(env: NodeJS.ProcessEnv): UpdaterConfig {
  const deployDir = env.RAKAZO_DEPLOY_DIR?.trim() ?? "";
  if (deployDir === "" || !path.posix.isAbsolute(deployDir)) {
    throw new Error("Set RAKAZO_DEPLOY_DIR to the absolute path of the deployment directory.");
  }
  const image = env.RAKAZO_IMAGE?.trim() || OFFICIAL_SERVER_IMAGE;
  if (!isValidImageName(image))
    throw new Error(`RAKAZO_IMAGE is not a usable image name: ${image}`);
  // Compose itself takes a list here (COMPOSE_FILE with COMPOSE_PATH_SEPARATOR), and a deployment
  // that layers an overlay must be reconciled with the same list the operator runs by hand. Every
  // entry is validated separately: one bad path in a list is still a path escape.
  const separator = env.COMPOSE_PATH_SEPARATOR?.trim() || DEFAULT_COMPOSE_PATH_SEPARATOR;
  const composeFiles = (env.RAKAZO_COMPOSE_FILE?.trim() || DEFAULT_COMPOSE_FILE)
    .split(separator)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (composeFiles.length === 0) {
    throw new Error("RAKAZO_COMPOSE_FILE must name at least one Compose file.");
  }
  for (const composeFile of composeFiles) {
    if (path.posix.isAbsolute(composeFile) || composeFile.split("/").includes("..")) {
      throw new Error("RAKAZO_COMPOSE_FILE must list paths inside the deployment directory.");
    }
  }
  // An overlay that adds a service built from the application image has to be recreated with the
  // rest, or an update leaves it running the old code. These are appended to the built-in set
  // rather than replacing it, so a typo cannot drop `api` from an update.
  const extraServices = (env.RAKAZO_UPDATE_SERVICES ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  for (const service of extraServices) {
    if (!SERVICE_NAME.test(service)) {
      throw new Error(`RAKAZO_UPDATE_SERVICES contains an unusable service name: ${service}`);
    }
    // The sidecar is the process running the update. Recreating it would kill the request
    // mid-flight, so there would be nothing left to finish the run, report it, or recover from a
    // failed step. RECREATED_SERVICES already excludes it on purpose; this keeps that true.
    if (service === UPDATER_SERVICE) {
      throw new Error(
        "RAKAZO_UPDATE_SERVICES must not contain the updater: it cannot recreate itself mid-update.",
      );
    }
  }
  const updateServices = [
    ...RECREATED_SERVICES,
    ...extraServices.filter((service) => !RECREATED_SERVICES.includes(service as never)),
  ];
  const port = Number(env.RAKAZO_UPDATER_PORT ?? DEFAULT_UPDATER_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("RAKAZO_UPDATER_PORT is not a port number.");
  }
  return {
    deployDir,
    composeFiles: composeFiles.map((composeFile) => path.posix.join(deployDir, composeFile)),
    updateServices,
    envFile: path.posix.join(deployDir, ".env"),
    projectName: resolveComposeProjectName(env),
    image,
    token: resolveUpdaterToken(env),
    host: env.RAKAZO_UPDATER_HOST?.trim() || "127.0.0.1",
    port,
  };
}

/**
 * Reads one assignment out of a `.env` file: later assignments win, Compose-style comments and
 * blank lines are ignored, and one layer of quoting is removed.
 */
export function readEnvAssignment(contents: string, key: string): string | null {
  let found: string | null = null;
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0 || line.slice(0, separator).trim() !== key) continue;
    const value = line.slice(separator + 1);
    const quoted =
      value.trim().match(/^"((?:\\.|[^"\\])*)"\s*(?:#.*)?$/) ??
      value.trim().match(/^'((?:\\.|[^'\\])*)'\s*(?:#.*)?$/);
    // Preserve hashes inside quotes or without separating whitespace. Keep the leading space
    // until comments are removed so `KEY= # comment` is correctly read as an empty value.
    found = quoted ? (quoted[1] ?? "") : value.replace(/\s+#.*$/, "").trim();
  }
  return found;
}

/**
 * Secrets a newer Compose file requires that an older `.env` never had. An update writes the
 * missing ones so its recreate does not stop at `Set POSTGRES_APP_PASSWORD in .env`; values
 * already present, however they are set, are never replaced.
 */
export function missingSecretAssignments(
  envContents: string,
  generate: () => string = () => randomBytes(16).toString("hex"),
): Record<string, string> {
  const value = readEnvAssignment(envContents, "POSTGRES_APP_PASSWORD");
  return value === null || value === "" ? { POSTGRES_APP_PASSWORD: generate() } : {};
}

export interface TagState {
  currentTag: string;
  previousTag: string | null;
}

/** What the deployment is pinned to now, ignoring anything in the file that is not a usable tag. */
export function readTagState(envContents: string): TagState {
  const current = readEnvAssignment(envContents, IMAGE_TAG_ENV);
  const previous = readEnvAssignment(envContents, PREVIOUS_IMAGE_TAG_ENV);
  return {
    currentTag: current !== null && isValidImageTag(current) ? current : DEFAULT_IMAGE_TAG,
    previousTag: previous !== null && isValidImageTag(previous) ? previous : null,
  };
}

export function truncateOutput(value: string): string {
  const text = value.trimEnd();
  if (text.length <= MAX_STEP_OUTPUT) return text;
  return `…${text.slice(-MAX_STEP_OUTPUT)}`;
}

/**
 * The sidecar answers with a plain reason when it will not act, so the API can surface it as a bad
 * request instead of an opaque 500.
 */
export class UpdateRefused extends Error {}
