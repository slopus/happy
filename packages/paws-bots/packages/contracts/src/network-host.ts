/**
 * One classifier for local, private, and non-public hosts. Pure TypeScript so web, Electron,
 * Expo, and the server share it.
 *
 * Address predicates take an IP literal (brackets, case, and an IPv6 zone are tolerated).
 * Host predicates take a URL hostname or a typed host and also classify names.
 *
 * Allow predicates (`isLocalhostOrLoopbackIp`, `isLoopbackHost`, `isPrivateNetworkHost`) match
 * names exactly: a trailing-dot name such as `localhost.` is sent to DNS by some resolvers, so it
 * is not trusted as local. Block predicates (`isInternalHostname`, `isCloudMetadataHost`) strip one
 * trailing dot so that form cannot slip past them.
 */

type Ipv4 = number;
/** Eight 16-bit groups. Numbers, not BigInt, so every JS runtime we ship can run it. */
type Ipv6 = readonly number[];

const CLOUD_METADATA_IPV4 = new Set([
  ipv4("169.254.169.254"),
  ipv4("169.254.170.2"),
  ipv4("100.100.100.200"),
]);
const CLOUD_METADATA_NAMES = new Set(["metadata.google.internal", "metadata.goog"]);
/** AWS IMDS over IPv6, fd00:ec2::254. */
const AWS_IMDS_IPV6 = [0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x0254];

/** IPv4 special-purpose ranges (RFC 6890) that are not globally reachable unicast. The
 * documentation ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24, and 2001:db8::/32 for
 * IPv6) are left out: they are not routed on the internet, and tests use them as public. */
const NON_PUBLIC_IPV4 = ranges([
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // RFC 1918
  ["100.64.0.0", 10], // shared address space (CGNAT, Tailscale)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // RFC 1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.88.99.0", 24], // deprecated 6to4 relay anycast
  ["192.168.0.0", 16], // RFC 1918
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, including 255.255.255.255 broadcast
]);

/** Ranges a person's own network uses: loopback, RFC 1918, and CGNAT (Tailscale). */
const PRIVATE_NETWORK_IPV4 = ranges([
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
]);

/** Lowercase, unbracketed, without one trailing dot. */
export function normalizeHost(hostname: string): string {
  return canonical(hostname).replace(/\.$/, "");
}

/** 4 or 6 for an IP literal, 0 for anything else. Mirrors `node:net` `isIP`. */
export function ipVersion(host: string): 0 | 4 | 6 {
  const value = canonical(host);
  if (parseIpv4(value) !== undefined) return 4;
  return parseIpv6(value) === undefined ? 0 : 6;
}

/** 127.0.0.0/8, ::1, and their IPv4-mapped forms. */
export function isLoopbackAddress(address: string): boolean {
  const value = canonical(address);
  const v4 = parseIpv4(value);
  if (v4 !== undefined) return v4 >>> 24 === 127;
  const v6 = parseIpv6(value);
  if (v6 === undefined) return false;
  const mapped = mappedIpv4(v6);
  if (mapped !== undefined) return mapped >>> 24 === 127;
  return isIpv6Loopback(v6);
}

/** 169.254.0.0/16 and fe80::/10, including IPv4 embedded in IPv6. */
export function isLinkLocalAddress(address: string): boolean {
  const value = canonical(address);
  const v4 = parseIpv4(value);
  if (v4 !== undefined) return isLinkLocalIpv4(v4);
  const v6 = parseIpv6(value);
  if (v6 === undefined) return false;
  const embedded = embeddedIpv4(v6);
  if (embedded !== undefined) return isLinkLocalIpv4(embedded);
  return (group(v6, 0) & 0xffc0) === 0xfe80;
}

/** Cloud provider metadata endpoints, including IPv4-mapped, NAT64, 6to4, and AWS IPv6 forms. */
export function isCloudMetadataAddress(address: string): boolean {
  const value = canonical(address);
  const v4 = parseIpv4(value);
  if (v4 !== undefined) return CLOUD_METADATA_IPV4.has(v4);
  const v6 = parseIpv6(value);
  if (v6 === undefined) return false;
  if (v6.every((part, index) => part === AWS_IMDS_IPV6[index])) return true;
  const embedded = embeddedIpv4(v6);
  return embedded !== undefined && CLOUD_METADATA_IPV4.has(embedded);
}

/**
 * Anything that is not globally reachable unicast. This is the SSRF boundary: it fails closed,
 * so a value that is not an IP literal counts as non-public.
 */
export function isNonPublicAddress(address: string): boolean {
  const value = canonical(address);
  const v4 = parseIpv4(value);
  if (v4 !== undefined) return inRanges(v4, NON_PUBLIC_IPV4);
  const v6 = parseIpv6(value);
  if (v6 === undefined) return true;
  const first = group(v6, 0);
  // ::/128 unspecified and ::1 loopback.
  if (isUnspecifiedPrefix(v6, 7) && group(v6, 7) <= 1) return true;
  // ff00::/8 multicast.
  if (first >>> 8 === 0xff) return true;
  // fe80::/10 link-local and fec0::/10 deprecated site-local.
  if ((first & 0xff80) === 0xfe80) return true;
  // fc00::/7 unique local (ULA), including fd00::/8.
  if ((first & 0xfe00) === 0xfc00) return true;
  // 64:ff9b:1::/48 local-use NAT64 (RFC 8215): translator-local, prefix length varies.
  if (first === 0x64 && group(v6, 1) === 0xff9b && group(v6, 2) === 1) return true;
  // 100::/64 discard-only.
  if (first === 0x100 && group(v6, 1) === 0 && group(v6, 2) === 0 && group(v6, 3) === 0) {
    return true;
  }
  // 2001::/23 IETF protocol assignments, including 2001::/32 Teredo and 2001:2::/48 benchmarking.
  if (first === 0x2001 && group(v6, 1) < 0x200) return true;
  const embedded = embeddedIpv4(v6);
  return embedded !== undefined && inRanges(embedded, NON_PUBLIC_IPV4);
}

/**
 * An address on the person's own network: loopback, RFC 1918, CGNAT 100.64.0.0/10, or IPv6
 * unique-local fc00::/7. Link-local and cloud metadata are excluded: those ranges host metadata
 * services and are never a legitimate server address. Like the host predicates below, it does
 * not accept IPv4-mapped IPv6 (::ffff:10.0.0.1): nobody types a server that way, and an allow
 * list should not grow a second spelling of every address.
 */
export function isPrivateNetworkAddress(address: string): boolean {
  const value = canonical(address);
  if (isCloudMetadataAddress(value)) return false;
  const v4 = parseIpv4(value);
  if (v4 !== undefined) return inRanges(v4, PRIVATE_NETWORK_IPV4);
  const v6 = parseIpv6(value);
  if (v6 === undefined) return false;
  return isIpv6Loopback(v6) || (group(v6, 0) & 0xfe00) === 0xfc00;
}

/**
 * `localhost`, 127.0.0.0/8, or ::1: the hosts that reach this machine without asking DNS. Use it
 * where a match skips DNS or address checks.
 */
export function isLocalhostOrLoopbackIp(hostname: string): boolean {
  const host = canonical(hostname);
  if (host === "localhost") return true;
  const v4 = parseIpv4(host);
  if (v4 !== undefined) return v4 >>> 24 === 127;
  const v6 = parseIpv6(host);
  return v6 !== undefined && isIpv6Loopback(v6);
}

/** This machine: `localhost`, `*.localhost` (RFC 6761), 127.0.0.0/8, or ::1. */
export function isLoopbackHost(hostname: string): boolean {
  const host = canonical(hostname);
  return isLocalhostOrLoopbackIp(host) || host.endsWith(".localhost");
}

/** HTTPS or this machine's HTTP origin; suitable for native permissions and credentials. */
export function secureHttpOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname))
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

/**
 * This machine or the person's LAN: loopback hosts, `.local` mDNS names, and private-network
 * IP literals. Where cleartext HTTP to a self-hosted server is acceptable.
 */
export function isPrivateNetworkHost(hostname: string): boolean {
  const host = canonical(hostname);
  if (isLoopbackHost(host) || host.endsWith(".local")) return true;
  return ipVersion(host) !== 0 && isPrivateNetworkAddress(host);
}

/** Names reserved for local or internal use: `localhost`, `*.localhost`, `*.local`, `*.internal`. */
export function isInternalHostname(hostname: string): boolean {
  const host = normalizeHost(hostname);
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  );
}

/** Metadata service names and addresses that must never become a request target. */
export function isCloudMetadataHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  return CLOUD_METADATA_NAMES.has(host) || (ipVersion(host) !== 0 && isCloudMetadataAddress(host));
}

function canonical(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

function parseIpv4(value: string): Ipv4 | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (!match) return undefined;
  let result = 0;
  for (const octet of match.slice(1)) {
    // Leading zeros read as octal in some parsers, so they are not an IP literal here.
    if (octet.length > 1 && octet.startsWith("0")) return undefined;
    const number = Number(octet);
    if (number > 255) return undefined;
    result = result * 256 + number;
  }
  return result;
}

function parseIpv6(value: string): Ipv6 | undefined {
  if (!value.includes(":")) return undefined;
  // A zone (fe80::1%en0) scopes the address to an interface; it does not change its class.
  const zone = value.indexOf("%");
  const address = zone === -1 ? value : value.slice(0, zone);
  if (zone !== -1 && !/^[0-9a-z._~-]+$/.test(value.slice(zone + 1))) return undefined;
  const halves = address.split("::");
  if (halves.length > 2) return undefined;
  const parts = halves.map((half) => (half === "" ? [] : half.split(":")));
  const tail = parts[parts.length - 1];
  const last = tail?.[tail.length - 1];
  if (tail && last?.includes(".")) {
    const v4 = parseIpv4(last);
    if (v4 === undefined) return undefined;
    tail.splice(-1, 1, (v4 >>> 16).toString(16), (v4 & 0xffff).toString(16));
  }
  const groups: number[] = [];
  for (const part of parts.flat()) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return undefined;
    groups.push(Number.parseInt(part, 16));
  }
  if (halves.length === 1) return groups.length === 8 ? groups : undefined;
  if (groups.length > 7) return undefined;
  const left = parts[0]?.length ?? 0;
  return [...groups.slice(0, left), ...Array(8 - groups.length).fill(0), ...groups.slice(left)];
}

function group(v6: Ipv6, index: number): number {
  return v6[index] ?? 0;
}

function isUnspecifiedPrefix(v6: Ipv6, groups: number): boolean {
  return v6.slice(0, groups).every((part) => part === 0);
}

function isIpv6Loopback(v6: Ipv6): boolean {
  return isUnspecifiedPrefix(v6, 7) && group(v6, 7) === 1;
}

function lowIpv4(v6: Ipv6): Ipv4 {
  return group(v6, 6) * 0x10000 + group(v6, 7);
}

/** ::ffff:0:0/96 only. Loopback trusts nothing wider. */
function mappedIpv4(v6: Ipv6): Ipv4 | undefined {
  return isUnspecifiedPrefix(v6, 5) && group(v6, 5) === 0xffff ? lowIpv4(v6) : undefined;
}

/** Every IPv6 form that carries an IPv4 destination. */
function embeddedIpv4(v6: Ipv6): Ipv4 | undefined {
  const mapped = mappedIpv4(v6);
  if (mapped !== undefined) return mapped;
  // ::/96 IPv4-compatible (deprecated).
  if (isUnspecifiedPrefix(v6, 6)) return lowIpv4(v6);
  // 64:ff9b::/96 NAT64 well-known prefix.
  if (group(v6, 0) === 0x64 && group(v6, 1) === 0xff9b && v6.slice(2, 6).every((p) => p === 0)) {
    return lowIpv4(v6);
  }
  // 2002::/16 6to4: the IPv4 address is the next 32 bits.
  if (group(v6, 0) === 0x2002) return group(v6, 1) * 0x10000 + group(v6, 2);
  return undefined;
}

function isLinkLocalIpv4(value: Ipv4): boolean {
  return value >>> 16 === 0xa9fe;
}

function ipv4(value: string): Ipv4 {
  const parsed = parseIpv4(value);
  if (parsed === undefined) throw new Error(`Invalid IPv4 constant ${value}`);
  return parsed;
}

function ranges(entries: readonly (readonly [string, number])[]) {
  return entries.map(([network, prefix]) => ({
    network: ipv4(network),
    mask: prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0,
  }));
}

function inRanges(value: Ipv4, list: ReturnType<typeof ranges>): boolean {
  return list.some(({ network, mask }) => (value & mask) >>> 0 === network);
}
