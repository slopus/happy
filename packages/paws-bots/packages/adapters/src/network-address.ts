import { AsyncLocalStorage } from "node:async_hooks";
import dns from "node:dns";
import type { LookupFunction } from "node:net";
import { recordSecurityEvent } from "@rakazo/db";

export type ResolvedAddress = { address: string; family: number };
export type ResolveHostname = (hostname: string) => Promise<ResolvedAddress[]>;

type PinnedDns = { hostname: string; addresses: ResolvedAddress[] };

const pinnedDns = new AsyncLocalStorage<PinnedDns>();
let dnsPinInstalled = false;

function normalizeLookupHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function familyNumber(family: unknown): number | undefined {
  if (family === "IPv4") return 4;
  if (family === "IPv6") return 6;
  return typeof family === "number" ? family : undefined;
}

function lookupOptions(options: unknown): { all?: boolean; family?: number } {
  if (options == null || typeof options === "function") return {};
  if (typeof options === "number") return { family: options };
  if (typeof options === "object") {
    const record = options as { all?: boolean; family?: unknown };
    return { all: record.all, family: familyNumber(record.family) };
  }
  return {};
}

function selectLookupAddress(
  addresses: ResolvedAddress[],
  options: { all?: boolean; family?: number },
): { all: true; addresses: ResolvedAddress[] } | { all: false; address: string; family: number } {
  const requestedFamily = typeof options.family === "number" ? options.family : 0;
  const candidates = addresses.filter(
    (entry) => requestedFamily === 0 || entry.family === requestedFamily,
  );
  if (options.all) {
    if (candidates.length === 0) throw new Error("Endpoint did not resolve to an address");
    return { all: true, addresses: candidates };
  }
  const selected = candidates[0];
  if (!selected) throw new Error("Endpoint did not resolve to an address");
  return { all: false, address: selected.address, family: selected.family };
}

function deliverLookup(
  addresses: ResolvedAddress[],
  options: { all?: boolean; family?: number },
  callback: (error: Error | null, address: string | ResolvedAddress[], family?: number) => void,
): void {
  const result = selectLookupAddress(addresses, options);
  if (result.all) callback(null, result.addresses);
  else callback(null, result.address, result.family);
}

export function createAddressCheckedLookup(
  resolve: ResolveHostname,
  validate: (addresses: ResolvedAddress[], hostname: string) => void,
): LookupFunction {
  return (hostname, options, callback) => {
    void resolve(hostname)
      .then((addresses) => {
        try {
          validate(addresses, hostname);
        } catch (error) {
          throw egressRefused(hostname, error);
        }
        deliverLookup(addresses, lookupOptions(options), callback);
      })
      .catch((error: unknown) =>
        callback(error instanceof Error ? error : new Error(String(error)), "", 0),
      );
  };
}

const refusedEgress = new WeakSet<Error>();

/** Recognize a policy refusal through transport wrappers without replacing its original type. */
export function isEgressRefused(error: unknown): boolean {
  const seen = new Set<Error>();
  while (error instanceof Error && !seen.has(error)) {
    if (refusedEgress.has(error)) return true;
    seen.add(error);
    error = error.cause;
  }
  return false;
}

/**
 * Record that an outbound-request guard refused a destination, so a probe of private addresses
 * leaves a security event. Returns the error for `throw egressRefused(...)`.
 */
export function egressRefused(hostname: string, error: unknown): Error {
  const refusal = error instanceof Error ? error : new Error(String(error));
  void recordSecurityEvent({
    type: "egress.refused",
    metadata: { host: hostname.slice(0, 253), reason: refusal.message },
  });
  refusedEgress.add(refusal);
  return refusal;
}

function pinnedAddressesFor(hostname: string): ResolvedAddress[] | undefined {
  const pin = pinnedDns.getStore();
  if (!pin) return undefined;
  if (normalizeLookupHostname(hostname) !== normalizeLookupHostname(pin.hostname)) return undefined;
  return pin.addresses;
}

function installDnsPin(): void {
  if (dnsPinInstalled) return;
  dnsPinInstalled = true;
  const originalLookup = dns.lookup.bind(dns);
  const originalPromisesLookup = dns.promises.lookup.bind(dns.promises);

  dns.lookup = ((hostname: string, options: unknown, callback?: unknown) => {
    const cb = typeof options === "function" ? options : callback;
    const pinned = pinnedAddressesFor(hostname);
    if (pinned && typeof cb === "function") {
      try {
        deliverLookup(
          pinned,
          lookupOptions(options),
          cb as (error: Error | null, address: string | ResolvedAddress[], family?: number) => void,
        );
      } catch (error) {
        cb(error instanceof Error ? error : new Error(String(error)), "", 0);
      }
      return;
    }
    return originalLookup(hostname, options as never, callback as never);
  }) as typeof dns.lookup;

  dns.promises.lookup = (async (hostname: string, options?: unknown) => {
    const pinned = pinnedAddressesFor(hostname);
    if (pinned) {
      const result = selectLookupAddress(pinned, lookupOptions(options));
      return result.all ? result.addresses : { address: result.address, family: result.family };
    }
    return originalPromisesLookup(hostname, options as never);
  }) as typeof dns.promises.lookup;
}

/** Pin `dns.lookup` for one hostname while `run` executes so Node's fetch can
 * keep the original URL hostname for TLS/SNI and still dial the already
 * validated address. No-ops for other hostnames and for callers outside this
 * async context. */
export async function withPinnedDnsLookup<T>(
  hostname: string,
  addresses: ResolvedAddress[],
  run: () => Promise<T>,
): Promise<T> {
  installDnsPin();
  return pinnedDns.run({ hostname, addresses }, run);
}
