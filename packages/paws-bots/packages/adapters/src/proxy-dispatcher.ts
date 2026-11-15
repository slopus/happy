import { ipVersion } from "@rakazo/contracts";
import type { Dispatcher } from "undici";
import { Agent, EnvHttpProxyAgent, Pool } from "undici";
import type { ResolvedAddress, ResolveHostname } from "./network-address.js";
import { createAddressCheckedLookup, egressRefused } from "./network-address.js";

/**
 * Honors HTTP(S)_PROXY / NO_PROXY. Direct routes connect through the checked lookup; proxied
 * requests are tunneled with CONNECT to the checked IP, so the proxy never resolves the hostname
 * itself and DNS rebinding cannot reach past it.
 */
export function createCheckedProxyDispatcher(
  resolve: ResolveHostname,
  validate: (addresses: ResolvedAddress[], hostname: string) => void,
  connectTimeout?: number,
  responseTimeouts?: Pick<Agent.Options, "headersTimeout" | "bodyTimeout">,
): Dispatcher {
  const { env } = process;
  const proxies = [env.http_proxy ?? env.HTTP_PROXY, env.https_proxy ?? env.HTTPS_PROXY];
  for (const proxy of proxies) {
    if (proxy && !/^https?:\/\//i.test(proxy)) throw new Error("Only HTTP proxies are supported");
  }
  const connect = {
    ...(connectTimeout === undefined ? {} : { timeout: connectTimeout }),
    lookup: createAddressCheckedLookup(resolve, validate),
  };
  if (!proxies.some(Boolean)) return new Agent({ ...responseTimeouts, connect });
  return new EnvHttpProxyAgent({
    ...responseTimeouts,
    connect,
    ...(connectTimeout === undefined ? {} : { connectTimeout }),
    proxyTunnel: true,
    clientFactory: (origin, options) => {
      const pool = new Pool(origin, options);
      const connect = pool.connect.bind(pool) as (
        options: Dispatcher.ConnectOptions,
      ) => Promise<Dispatcher.ConnectData>;
      return Object.assign(pool, {
        connect: async (options: Dispatcher.ConnectOptions) => {
          const authority = await checkedAuthority(options.path, resolve, validate);
          return connect({
            ...options,
            path: authority,
            headers: { ...(options.headers as Record<string, string>), host: authority },
          });
        },
      });
    },
  });
}

async function checkedAuthority(
  authority: string,
  resolve: ResolveHostname,
  validate: (addresses: ResolvedAddress[], hostname: string) => void,
): Promise<string> {
  const separator = authority.lastIndexOf(":");
  const hostname = authority.slice(0, separator).replace(/^\[|\]$/g, "");
  const family = ipVersion(hostname);
  const addresses = family === 0 ? await resolve(hostname) : [{ address: hostname, family }];
  try {
    validate(addresses, hostname);
  } catch (error) {
    throw egressRefused(hostname, error);
  }
  const address = addresses[0]?.address ?? "";
  const host = ipVersion(address) === 6 ? `[${address}]` : address;
  return `${host}${authority.slice(separator)}`;
}
