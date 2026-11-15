import type { CompatibleEndpointPreset } from "@rakazo/contracts";
import {
  ipVersion,
  isCloudMetadataHost,
  isLinkLocalAddress,
  isLoopbackHost,
  isNonPublicAddress,
  matchCompatibleEndpointPreset,
  normalizeHost,
  normalizeOpenAiCompatibleBaseUrl,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from "@rakazo/contracts";

export { normalizeOpenAiCompatibleBaseUrl, OPENAI_COMPATIBLE_PROVIDER_ID };

const BUILT_IN_PUBLIC_MODEL_HOSTS = new Set(["ollama.com"]);

/** Hosted compatible services the catalog offers by name. Each one needs a key. */
export const COMPATIBLE_ENDPOINT_PRESETS: CompatibleEndpointPreset[] = [
  { name: "Ollama Cloud", baseUrl: "https://ollama.com/v1" },
];

export function compatibleEndpointPreset(baseUrl: string | undefined) {
  return matchCompatibleEndpointPreset(COMPATIBLE_ENDPOINT_PRESETS, baseUrl);
}

export function openAiCompatAllowPublicHosts(): boolean {
  return process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC !== "0";
}

export function isPrivateOpenAiCompatibleHostname(hostname: string): boolean {
  const normalized = normalizeHost(hostname);
  if (isLoopbackHost(normalized) || normalized === "host.docker.internal") return true;
  if (isCloudMetadataHost(normalized)) return false;
  if (ipVersion(normalized) !== 0) return isNonPublicAddress(normalized);
  return (process.env.RAKAZO_OPENAI_COMPAT_PRIVATE_HOSTS ?? "")
    .split(",")
    .some((entry) => entry.trim() !== "" && normalizeHost(entry.trim()) === normalized);
}

/**
 * Inside a container, loopback is the container itself, so a server the person runs
 * on their own computer is reached through the host address the deployment names.
 */
export function loopbackOnHost(url: URL): URL {
  const host = process.env.RAKAZO_LOOPBACK_HOST?.trim();
  if (!host || !isLoopbackHost(normalizeHost(url.hostname))) return url;
  const target = new URL(url);
  target.hostname = host;
  return target;
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = normalizeHost(hostname);
  return (
    isCloudMetadataHost(normalized) ||
    (ipVersion(normalized) !== 0 && isLinkLocalAddress(normalized))
  );
}

/**
 * Who may reach which model endpoints. `allowPrivate` comes from
 * operator configuration; absent means deny.
 */
export type OpenAiCompatibleUrlPolicy = { allowPublic?: boolean; allowPrivate?: boolean };

export const PRIVATE_MODEL_ENDPOINT_MESSAGE =
  "Private model endpoints need MCP_ALLOW_PRIVATE_ENDPOINT=true on the API and worker.";

export function assertAllowedOpenAiCompatibleUrl(
  raw: string,
  opts?: OpenAiCompatibleUrlPolicy,
): URL {
  const normalized = normalizeOpenAiCompatibleBaseUrl(raw);
  return assertAllowedOpenAiCompatibleRequestUrl(normalized, opts);
}

/**
 * When an API key will be sent, refuse public http:// endpoints so the Bearer
 * token is not cleartext on the public internet. Private / loopback http stays
 * allowed (local model servers). https:// is always fine for this check.
 */
export function assertHttpsForKeyedOpenAiCompatibleUrl(
  url: URL,
  apiKey: string | undefined | null,
  hasHeaders = false,
): void {
  if (!apiKey?.trim() && !hasHeaders) return;
  if (url.protocol === "https:") return;
  const hostname = normalizeHost(url.hostname);
  if (isPrivateOpenAiCompatibleHostname(hostname)) return;
  throw new Error(
    hasHeaders
      ? "OpenAI-compatible endpoints that send an API key or custom headers must use HTTPS. Use an https:// URL, or omit the API key and custom headers on a private HTTP endpoint."
      : "OpenAI-compatible endpoints that send an API key must use HTTPS. Use an https:// URL, or omit the API key on a private HTTP endpoint.",
  );
}

export function assertAllowedOpenAiCompatibleRequestUrl(
  raw: string,
  opts?: OpenAiCompatibleUrlPolicy,
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Model server URL must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Model server URL must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("Model server URL must not contain credentials");
  }
  const hostname = normalizeHost(url.hostname);
  if (isBlockedHostname(hostname)) {
    throw new Error("Base URL targets a blocked metadata or link-local host");
  }
  const allowPublic = opts?.allowPublic ?? openAiCompatAllowPublicHosts();
  if (isPrivateOpenAiCompatibleHostname(hostname)) {
    if (opts?.allowPrivate !== true) throw new Error(PRIVATE_MODEL_ENDPOINT_MESSAGE);
    return url;
  }
  const builtInPublicHost =
    url.protocol === "https:" && url.port === "" && BUILT_IN_PUBLIC_MODEL_HOSTS.has(url.hostname);
  if (!allowPublic && !builtInPublicHost) {
    throw new Error("Public model endpoints are disabled on this server.");
  }
  return url;
}
