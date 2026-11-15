import { isIP } from "node:net";
import { USER_DEVICE_CONNECT_PATH } from "@rakazo/contracts/user-devices";
import type { ProxyOptions } from "vite";
import { appendForwardedFor } from "./forwarded-for.js";

/** Vite treats a proxy key starting with `^` as a pattern for the request's path and query. */
export const DEVICE_SOCKET = `^${USER_DEVICE_CONNECT_PATH}(?:\\?|$)`;

/**
 * What the web server forwards to the API, keyed the way Vite's proxy matches: a prefix, or a
 * pattern when the key starts with `^`. True marks the only route that forwards upgrades: a
 * user's own computer keeps its device socket open there, so it is anchored to the exact path.
 */
export const API_ROUTES: Readonly<Record<string, boolean>> = {
  "/api": false,
  [DEVICE_SOCKET]: true,
  "/rpc": false,
  // Native app domain association, served by the API from deployment settings.
  "/.well-known/apple-app-site-association": false,
  "/.well-known/assetlinks.json": false,
};

/** Whether the API takes this request, or with `upgrade`, this upgrade; matched as Vite does. */
export function forwardsToApi(url: string | undefined, upgrade = false): boolean {
  if (url === undefined) return false;
  return Object.entries(API_ROUTES).some(
    ([key, upgrades]) =>
      (!upgrade || upgrades) &&
      (key.startsWith("^") ? new RegExp(key).test(url) : url.startsWith(key)),
  );
}

/**
 * The API routes as Vite proxy options, for development and `vite preview` deployments.
 * `allowedHosts` reads the running server's own list: Vite checks it for plain requests but not
 * for the upgrades its proxy forwards.
 */
export function apiProxy(
  target: string,
  allowedHosts: () => readonly string[] | true,
): Record<string, ProxyOptions> {
  const options = (upgrades: boolean): ProxyOptions => ({
    target,
    changeOrigin: true,
    ws: upgrades,
    ...(upgrades
      ? {
          bypass: (req) => {
            const hosts = allowedHosts();
            return hosts === true || hostAllowed(req.headers.host, hosts) ? undefined : false;
          },
        }
      : {}),
    // Append the hop this proxy saw, so the API never mistakes a caller's own header for its
    // address. The API reads past this hop only when it is listed in TRUSTED_PROXIES.
    configure: (proxy) => {
      proxy.on("proxyReq", (proxyReq, req) => {
        proxyReq.setHeader("x-forwarded-for", appendForwardedFor(req));
      });
      if (upgrades) {
        proxy.on("proxyReqWs", (proxyReq, req) => {
          proxyReq.setHeader("x-forwarded-for", appendForwardedFor(req));
        });
      }
    },
  });
  return Object.fromEntries(
    Object.entries(API_ROUTES).map(([route, upgrades]) => [route, options(upgrades)]),
  );
}

/** Vite's own Host check for plain requests (isHostAllowedInternal), which it doesn't export. */
export function hostAllowed(host: string | undefined, allowedHosts: readonly string[]): boolean {
  if (host === undefined) return true;
  if (/^(?:file|.+-extension):/i.test(host)) return true;
  const trimmed = host.trim();
  if (trimmed[0] === "[") {
    const end = trimmed.indexOf("]");
    return end >= 0 && isIP(trimmed.slice(1, end)) === 6;
  }
  const colon = trimmed.indexOf(":");
  const hostname = colon === -1 ? trimmed : trimmed.slice(0, colon);
  if (isIP(hostname) === 4) return true;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  return allowedHosts.some(
    (allowed) =>
      allowed === hostname ||
      (allowed[0] === "." && (allowed.slice(1) === hostname || hostname.endsWith(allowed))),
  );
}
