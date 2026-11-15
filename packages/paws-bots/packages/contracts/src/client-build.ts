/**
 * Client/server build handshake. Every API request names the client and the build it runs, and
 * every API response names the web build deployed beside the API, so an open tab can tell it is
 * running old code. A server can also refuse builds older than a minimum it is configured with.
 */

/** Request header: `web/20261022093015`. */
export const CLIENT_BUILD_HEADER = "x-rakazo-client-build";
/** Response header: the web build deployed beside the API. */
export const SERVER_BUILD_HEADER = "x-rakazo-build";
/** Error code sent with HTTP 426 when the server no longer supports the client's build. */
export const CLIENT_UPDATE_REQUIRED = "CLIENT_UPDATE_REQUIRED";
export const CLIENT_UPDATE_REQUIRED_STATUS = 426;

export const CLIENT_KINDS = ["web", "mobile"] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];
export type MinimumClientBuilds = Partial<Record<ClientKind, string>>;

export const IOS_APP_STORE_URL = "https://apps.apple.com/app/rakazo/id6801531099";
export const ANDROID_APK_URL =
  "https://github.com/elie222/rakazo/releases/download/android/rakazo.apk";
export const ANDROID_APP_STORE_URL = "https://play.google.com/store/apps/details?id=com.rakazo.app";

const BUILD_ID = /^\d{14}$/;

/** A build id is the UTC time it was built, to the second (`YYYYMMDDHHMMSS`), so ids sort as text. */
export function buildIdAt(date: Date): string {
  return date.toISOString().replace(/\D/g, "").slice(0, 14);
}

export function isBuildId(value: unknown): value is string {
  return typeof value === "string" && BUILD_ID.test(value);
}

/** Negative when `a` is older than `b`; null when either is missing or malformed, so callers act on neither. */
export function compareBuilds(a: unknown, b: unknown): number | null {
  if (!isBuildId(a) || !isBuildId(b)) return null;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function formatClientBuild(kind: ClientKind, build: string): string {
  return `${kind}/${build}`;
}

export function parseClientBuild(
  header: string | null | undefined,
): { kind: ClientKind; build: string } | null {
  const [kind, build, ...rest] = (header ?? "").trim().split("/");
  if (rest.length || !CLIENT_KINDS.includes(kind as ClientKind) || !isBuildId(build)) return null;
  return { kind: kind as ClientKind, build };
}

/** Parses `web=20261022093015,mobile=20261001000000`; throws on anything else so a typo cannot pass silently. */
export function parseMinimumClientBuilds(value: string | undefined): MinimumClientBuilds {
  const minimums: MinimumClientBuilds = {};
  for (const entry of (value ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const [kind, build, ...rest] = trimmed.split("=").map((part) => part.trim());
    if (rest.length || !CLIENT_KINDS.includes(kind as ClientKind) || !isBuildId(build)) {
      throw new Error(
        `Invalid RAKAZO_MIN_CLIENT_BUILD entry "${trimmed}": use web=YYYYMMDDHHMMSS or mobile=YYYYMMDDHHMMSS`,
      );
    }
    minimums[kind as ClientKind] = build;
  }
  return minimums;
}

/** Only a client that names a build older than its kind's minimum is refused; unnamed callers pass. */
export function clientUpdateRequired(
  header: string | null | undefined,
  minimums: MinimumClientBuilds,
): boolean {
  const client = parseClientBuild(header);
  if (!client) return false;
  return (compareBuilds(client.build, minimums[client.kind]) ?? 0) < 0;
}

export function isClientUpdateRequiredError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, status } = error as { code?: unknown; status?: unknown };
  return code === CLIENT_UPDATE_REQUIRED || status === CLIENT_UPDATE_REQUIRED_STATUS;
}
