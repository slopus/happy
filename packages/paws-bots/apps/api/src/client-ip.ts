import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { getConnInfo } from "@hono/node-server/conninfo";
import { CLIENT_IP_HEADER } from "@rakazo/auth";
import { withSecurityRequest } from "@rakazo/db";
import type { Context, MiddlewareHandler } from "hono";

export interface ClientIpConfig {
  /** Reverse proxies allowed to report the client address: IPs, CIDR ranges, or hostnames. */
  trustedProxies: string[];
  /** The forwarded header those proxies set, e.g. `x-forwarded-for`. */
  header: string;
}

type ResolveHost = (hostname: string) => Promise<string[]>;
type ListInterfaces = typeof networkInterfaces;

/**
 * Loopback and every network this process has an interface on. In Compose those are the stack's
 * own networks: the web proxy, and the network gateway a reverse proxy on the Docker host connects
 * from. Bot computers sit on networks the API is never attached to, so they cannot vouch for an
 * address.
 */
export const LOCAL_NETWORKS = "local-networks";
/** A TRUSTED_PROXIES that believes no forwarded header. */
const NO_PROXIES = "none";

/**
 * What an unset TRUSTED_PROXIES trusts. In a container, its own networks are the stack's; on a
 * host they can be a whole LAN of direct clients, so only loopback (the dev web proxy) is trusted.
 */
export function defaultTrustedProxies(
  inContainer = existsSync("/.dockerenv") || existsSync("/run/.containerenv"),
): string[] {
  return inContainer ? [LOCAL_NETWORKS] : ["127.0.0.1", "::1"];
}

const HOST_TTL_MS = 30_000;
const HOSTNAME = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;

const resolveHost: ResolveHost = async (hostname) =>
  (await lookup(hostname, { all: true })).map((entry) => entry.address);

/**
 * Resolve the caller's address. The socket peer is the answer unless it is a trusted proxy;
 * only then is the forwarded header read, right to left, skipping trusted hops. A request that
 * reaches the API directly cannot choose its own address by sending the header.
 */
export function createClientIpResolver(
  config: ClientIpConfig,
  options: { resolve?: ResolveHost; now?: () => number; interfaces?: ListInterfaces } = {},
) {
  const resolve = options.resolve ?? resolveHost;
  const now = options.now ?? Date.now;
  const ranges = new BlockList();
  const hostnames: string[] = [];
  const entries = config.trustedProxies.flatMap((entry) => {
    if (entry === NO_PROXIES) return [];
    return entry === LOCAL_NETWORKS
      ? localNetworks(options.interfaces ?? networkInterfaces)
      : [entry];
  });
  for (const entry of entries) {
    const [address = "", prefix, extra] = entry.split("/");
    const family = isIP(address);
    const type = family === 6 ? "ipv6" : "ipv4";
    const bits = Number(prefix);
    if (family && prefix === undefined) ranges.addAddress(address, type);
    else if (
      family &&
      extra === undefined &&
      /^\d+$/.test(prefix ?? "") &&
      bits <= (family === 6 ? 128 : 32)
    )
      ranges.addSubnet(address, bits, type);
    else if (!family && prefix === undefined && HOSTNAME.test(entry)) hostnames.push(entry);
    else throw new Error(`TRUSTED_PROXIES entry is not an IP, CIDR range, or hostname: ${entry}`);
  }

  const hostAddresses = new Map<string, Set<string>>();
  let resolvedAt = Number.NEGATIVE_INFINITY;
  let resolving: Promise<void> | undefined;
  const refreshHosts = async () => {
    if (hostnames.length === 0 || now() - resolvedAt < HOST_TTL_MS) return;
    resolving ??= Promise.all(
      hostnames.map(async (name) => ({
        name,
        addresses: await resolve(name).catch(() => null),
      })),
    )
      .then((results) => {
        // A failed lookup keeps the last answer instead of untrusting a proxy mid-deploy.
        for (const { name, addresses } of results) {
          if (addresses === null) continue;
          hostAddresses.set(name, new Set(addresses.map(normalizeIp)));
        }
        resolvedAt = now();
      })
      .finally(() => {
        resolving = undefined;
      });
    await resolving;
  };
  const trusted = (ip: string) =>
    ranges.check(ip, isIP(ip) === 6 ? "ipv6" : "ipv4") ||
    [...hostAddresses.values()].some((addresses) => addresses.has(ip));

  return async (request: { peer?: string; forwarded?: string }): Promise<string | undefined> => {
    const peer = request.peer ? parseIp(request.peer) : undefined;
    if (!peer) return undefined;
    await refreshHosts();
    if (!request.forwarded || !trusted(peer)) return peer;
    const hops = request.forwarded.split(",").map((hop) => parseIp(hop.trim()));
    for (let index = hops.length - 1; index >= 0; index--) {
      const hop = hops[index];
      // A malformed chain is not evidence of anything; fall back to the hop we can see.
      if (!hop) return peer;
      if (!trusted(hop)) return hop;
    }
    return hops[0] ?? peer;
  };
}

export type ClientIpResolver = ReturnType<typeof createClientIpResolver>;

function localNetworks(list: ListInterfaces): string[] {
  return Object.values(list()).flatMap((addresses) =>
    (addresses ?? []).flatMap((info) => (info.cidr ? [info.cidr.replace(/%[^/]*/, "")] : [])),
  );
}

/** An address, with IPv4-mapped IPv6, brackets, and a trailing port stripped. */
function parseIp(value: string): string | undefined {
  let candidate = value.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(candidate);
  if (bracketed?.[1]) candidate = bracketed[1];
  else if (/^[\d.]+:\d+$/.test(candidate))
    candidate = candidate.slice(0, candidate.lastIndexOf(":"));
  candidate = normalizeIp(candidate);
  return isIP(candidate) ? candidate : undefined;
}

function normalizeIp(value: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(value);
  return (mapped?.[1] ?? value).toLowerCase();
}

const CLIENT_IP_KEY = "rakazo.clientIp";

/** Resolve the caller once per request and make it available to security events. */
export function clientIpMiddleware(resolver: ClientIpResolver, header: string): MiddlewareHandler {
  return async (c, next) => {
    const ip = await resolver({ peer: socketPeer(c), forwarded: c.req.header(header) });
    c.set(CLIENT_IP_KEY, ip);
    await withSecurityRequest({ ip, userAgent: c.req.header("user-agent") }, next);
  };
}

export function requestClientIp(c: Context): string | undefined {
  return c.get(CLIENT_IP_KEY) as string | undefined;
}

function socketPeer(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    // In-process requests (tests, app.request) have no socket.
    return undefined;
  }
}

/** The request Better Auth sees: its one IP header carries the resolved address and nothing else. */
export function withClientIp(request: Request, ip: string | undefined): Request {
  if (!ip && !request.headers.has(CLIENT_IP_HEADER)) return request;
  const headers = new Headers(request.headers);
  headers.delete(CLIENT_IP_HEADER);
  if (ip) headers.set(CLIENT_IP_HEADER, ip);
  return new Request(request, { headers });
}
