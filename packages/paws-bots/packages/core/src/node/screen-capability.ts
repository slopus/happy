import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import {
  ipVersion,
  isLocalhostOrLoopbackIp,
  isPrivateNetworkAddress,
} from "@rakazo/contracts/network-host";

export const SCREEN_PROXY_TTL_MS = 60 * 60_000;
export const SCREEN_TARGET_ENDPOINT = "/api/internal/screen-target";
export const SCREEN_RECHECK_MS = 1_000;
/**
 * An open screen rides out an authority it can't reach (a timeout, a dropped connection, a
 * server error) for at most this long after the last check that said yes was sent. A refusal
 * still ends it at once.
 */
export const SCREEN_UNCONFIRMED_MAX_MS = 6_000;
/**
 * Remote seals stay the same until this much life remains. A public hop (E2B) can
 * still be presenting the capability it started with; a new one on every poll
 * aborts that handshake.
 */
export const REMOTE_SCREEN_CAPABILITY_MIN_REMAINING_MS = 10 * 60_000;

export interface ScreenCapabilityScope {
  botId: string;
  computerId: string;
  botGeneration: number;
  computerGeneration: number;
  controlLeaseId: string | null;
}

export interface ScreenProxyTarget {
  protocol: "http:" | "https:";
  hostname: string;
  port: number;
  path: string;
  interactive: boolean;
  /** Sealed provider authentication; only the server proxy receives it. */
  headers?: Record<string, string>;
}

export function isScreenProxyTarget(value: unknown): value is ScreenProxyTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Record<string, unknown>;
  return (
    (target.protocol === "http:" || target.protocol === "https:") &&
    typeof target.hostname === "string" &&
    target.hostname.length > 0 &&
    !/[\s/]/.test(target.hostname) &&
    typeof target.port === "number" &&
    Number.isInteger(target.port) &&
    target.port > 0 &&
    target.port <= 65535 &&
    isScreenProxyHeaders(target.headers) &&
    typeof target.path === "string" &&
    target.path.startsWith("/") &&
    !/[\r\n]/.test(target.path) &&
    typeof target.interactive === "boolean"
  );
}

/** Authentication headers are trusted only after the capability has been decrypted. */
function isScreenProxyHeaders(value: unknown): value is Record<string, string> | undefined {
  return (
    value === undefined ||
    (value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.entries(value).every(
        ([name, header]) =>
          /^[a-zA-Z0-9!#$%&'*+.^_`|~-]+$/.test(name) &&
          !/^(host|connection|upgrade|transfer-encoding|content-length|proxy-authorization)$/i.test(
            name,
          ) &&
          typeof header === "string" &&
          /^[\t\x20-\x7e]*$/.test(header),
      ))
  );
}

export function sealScreenCapability(
  url: string,
  secret: string,
  origin: string,
  scope: ScreenCapabilityScope,
  now = Date.now(),
  headers?: Record<string, string>,
) {
  return seal(url, secret, origin, scope, now + SCREEN_PROXY_TTL_MS, headers, false);
}

function seal(
  url: string,
  secret: string,
  origin: string,
  scope: ScreenCapabilityScope,
  expiresAt: number,
  headers: Record<string, string> | undefined,
  repeatable: boolean,
) {
  if (!isScreenProxyHeaders(headers)) throw new Error("Invalid screen authentication headers");
  const target = new URL(url);
  if (target.protocol !== "https:" && target.protocol !== "http:")
    throw new Error("Invalid screen protocol");
  const policy = target.searchParams.get("view_only") === "false" ? "control" : "view";
  const key = createHash("sha256").update(secret).digest();
  const aad = `${policy}:${expiresAt}`;
  const plaintext = JSON.stringify({ url, scope, headers });
  // A repeatable seal derives its nonce from what it seals, so equal inputs give the same
  // link on every server and different inputs never share a nonce.
  const iv = repeatable
    ? createHmac("sha256", key).update(`${aad}\0${plaintext}`).digest().subarray(0, 12)
    : randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const token = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
  const prefix = `/novnc/session/${policy}/${expiresAt}.${token}`;
  const result = new URL(`${prefix}${target.pathname || "/"}`, new URL(origin).origin);
  // noVNC reads these from the browser URL. Keep its socket inside the capability
  // route while the provider's nested socket token stays sealed server-side.
  result.search = new URLSearchParams({
    autoconnect: "true",
    resize: "scale",
    view_only: policy === "control" ? "false" : "true",
    // noVNC can resolve paths relative to its document directory. An absolute
    // path prevents it from repeating the capability prefix.
    path: target.pathname === "/embed.html" ? "websockify" : `${prefix}/websockify`,
  }).toString();
  return result.toString();
}

export function isLoopbackScreenTarget(url: string) {
  return isLocalhostOrLoopbackIp(new URL(url).hostname);
}

const REMOTE_SCREEN_SEAL_WINDOW_MS =
  SCREEN_PROXY_TTL_MS - REMOTE_SCREEN_CAPABILITY_MIN_REMAINING_MS;

/**
 * Issue a screen capability. Loopback targets get a fresh seal per call. Remote targets get
 * the same seal from every server for the same upstream URL and scope until less than
 * REMOTE_SCREEN_CAPABILITY_MIN_REMAINING_MS of it remains, so an in-flight viewer is not
 * raced by token rotation. Expiry and scope changes still revoke it.
 */
export function issueScreenCapability(
  url: string,
  secret: string,
  origin: string,
  scope: ScreenCapabilityScope,
  now = Date.now(),
  headers?: Record<string, string>,
) {
  if (isLoopbackScreenTarget(url))
    return sealScreenCapability(url, secret, origin, scope, now, headers);
  const expiresAt =
    (Math.floor(now / REMOTE_SCREEN_SEAL_WINDOW_MS) + 1) * REMOTE_SCREEN_SEAL_WINDOW_MS +
    REMOTE_SCREEN_CAPABILITY_MIN_REMAINING_MS;
  return seal(url, secret, origin, scope, expiresAt, headers, true);
}

export function addScreenProxyCapability(
  url: string,
  secret: string,
  origin: string,
  scope: ScreenCapabilityScope,
  now = Date.now(),
  headers?: Record<string, string>,
) {
  // Local/desktop providers return non-http schemes (e.g. desktop://). Those never
  // traverse the web proxy, so seal only http(s) upstream URLs.
  const protocol = new URL(url).protocol;
  if (protocol !== "http:" && protocol !== "https:") return url;
  return issueScreenCapability(url, secret, origin, scope, now, headers);
}

export function openScreenCapability(
  path: string | undefined,
  secret: string,
  now = Date.now(),
): { scope: ScreenCapabilityScope; expiresAt: number; target: ScreenProxyTarget } | null {
  const match = path?.match(
    /^\/novnc\/session\/(view|control)\/(\d+)\.([A-Za-z0-9_-]+)(\/[^?]*)?(\?.*)?$/,
  );
  if (!match) return null;
  const expiresAt = Number(match[2]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return null;
  try {
    const sealed = Buffer.from(match[3]!, "base64url");
    if (sealed.length < 28) return null;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      createHash("sha256").update(secret).digest(),
      sealed.subarray(0, 12),
      { authTagLength: 16 },
    );
    decipher.setAAD(Buffer.from(`${match[1]}:${expiresAt}`));
    decipher.setAuthTag(sealed.subarray(12, 28));
    const payload = JSON.parse(
      Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString("utf8"),
    );
    if (!isScreenProxyHeaders(payload.headers)) return null;
    const scope = payload.scope as ScreenCapabilityScope;
    if (
      !scope ||
      typeof scope.botId !== "string" ||
      typeof scope.computerId !== "string" ||
      !Number.isSafeInteger(scope.botGeneration) ||
      !Number.isSafeInteger(scope.computerGeneration) ||
      (scope.controlLeaseId !== null && typeof scope.controlLeaseId !== "string")
    )
      return null;
    const target = new URL(payload.url);
    if (target.protocol !== "https:" && target.protocol !== "http:") return null;
    const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
    if (
      target.protocol === "http:" &&
      (!isAllowedTargetName(target.hostname) || port < 1024 || port > 65535)
    )
      return null;
    const interactive = match[1] === "control";
    const requestedPath = `${match[4] || target.pathname || "/"}${match[5] || ""}`;
    return {
      scope,
      expiresAt,
      target: {
        protocol: target.protocol,
        hostname: target.hostname.replace(/^\[|\]$/g, ""),
        port,
        path: screenPolicyPath(remoteTargetPath(target, requestedPath), interactive),
        interactive,
        ...(payload.headers ? { headers: payload.headers } : {}),
      },
    };
  } catch {
    return null;
  }
}

export function screenPolicyPath(requestedPath: string, interactive: boolean) {
  const parsed = new URL(requestedPath, "http://screen.invalid");
  if (parsed.pathname === "/embed.html" || parsed.pathname === "/vnc.html") {
    parsed.searchParams.set("view_only", interactive ? "false" : "true");
  }
  return `${parsed.pathname}${parsed.search}`;
}

function remoteTargetPath(target: URL, requestedPath: string) {
  const requested = new URL(requestedPath, "https://screen.invalid");
  const path = requested.pathname || target.pathname || "/";
  if (path === "/websockify" && target.searchParams.has("path")) {
    const socket = new URL(target.searchParams.get("path")!, target);
    return `${socket.pathname}${socket.search}`;
  }
  if (path === target.pathname || path === "/websockify") {
    return `${path}${target.search}`;
  }
  return `${path}${requested.search}`;
}

/** Plain-HTTP screens stay on this machine, the private network, or a bot's Compose service. */
function isAllowedTargetName(hostname: string) {
  return (
    hostname === "localhost" ||
    (ipVersion(hostname) !== 0 && isPrivateNetworkAddress(hostname)) ||
    /^rakazo-bot-[a-zA-Z0-9_.-]+$/.test(hostname)
  );
}
