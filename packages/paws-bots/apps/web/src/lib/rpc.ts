import { localStore, pawsFetch } from "../paws/runtime";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import type { AppContract, ProductEvent } from "@rakazo/contracts";
import { CLIENT_BUILD_HEADER, formatClientBuild } from "@rakazo/contracts";
import { displayIdentityEvent, displayIdentityResult } from "@rakazo/core";
import { clientCorrelationHeaders, responseCorrelation } from "@rakazo/logging/monitoring";
import { authClient } from "./auth";
import { CLIENT_BUILD } from "./client-build";
import { i18n } from "./i18n";
import { identityLabels } from "./identity-display";
import { reportClientError } from "./monitoring";

const SPACE_STORAGE_KEY = "rakazo:space-id";
export const ORGANIZATION_SPACES_STORAGE_KEY = "rakazo:org-spaces";

type RpcClientContext = {
  spaceId?: string | null;
  /** Finish the call even if the page is closing. */
  keepalive?: boolean;
};

export function selectedSpaceId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStore.getItem(SPACE_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Fired after the selected Space changes, so per-organization state (billing) can reload. */
export const SPACE_SELECTED_EVENT = "rakazo:space-selected";

export function selectSpace(id: string): boolean {
  let selected: boolean;
  try {
    localStore.setItem(SPACE_STORAGE_KEY, id);
    selected = true;
  } catch {
    try {
      // Write failed but the desired selection is already durable — treat as success.
      selected = localStore.getItem(SPACE_STORAGE_KEY) === id;
    } catch {
      selected = false;
    }
  }
  if (selected) window.dispatchEvent(new Event(SPACE_SELECTED_EVENT));
  return selected;
}

export function clearSpaceSelection(): void {
  try {
    localStore.removeItem(SPACE_STORAGE_KEY);
    localStore.removeItem(ORGANIZATION_SPACES_STORAGE_KEY);
  } catch {
    // Ignore storage failures on sign-out / reset paths.
  }
}

/** Adds `x-rakazo-space-id` when a space is selected. */
export function withSpaceHeaders(
  init?: HeadersInit,
  spaceId: string | null = selectedSpaceId(),
): Headers {
  const headers = new Headers(init);
  if (spaceId) headers.set("x-rakazo-space-id", spaceId);
  else headers.delete("x-rakazo-space-id");
  return headers;
}

const responseListeners = new Set<(response: Response) => void>();

/** Every API reply, for the build handshake; RPC callers still get their own result. */
export function onRpcResponse(listener: (response: Response) => void): () => void {
  responseListeners.add(listener);
  return () => {
    responseListeners.delete(listener);
  };
}

const link = new RPCLink<RpcClientContext>({
  url: () =>
    typeof window === "undefined" ? "http://127.0.0.1:5173/rpc" : `${window.location.origin}/rpc`,
  fetch: async (input, init, options) => {
    const request = new Request(input, init);
    const spaceId =
      options.context.spaceId === undefined ? selectedSpaceId() : options.context.spaceId;
    const correlation = clientCorrelationHeaders();
    const headers = withSpaceHeaders(request.headers, spaceId);
    if (CLIENT_BUILD) headers.set(CLIENT_BUILD_HEADER, formatClientBuild("web", CLIENT_BUILD));
    for (const [key, value] of Object.entries(correlation)) headers.set(key, value);
    let response: Response;
    try {
      response = await pawsFetch(request, {
        headers,
        credentials: "include",
        keepalive: options.context.keepalive,
        // Keep cancellation attached directly to fetch rather than only a cloned Request.
        signal: options.signal,
      });
    } catch (error) {
      if (!options.signal?.aborted)
        reportClientError(error, "rpc.transport", responseCorrelation(new Headers(correlation)));
      throw error;
    }
    // Server exceptions are reported by the API; do not report every HTTP failure twice.
    recheckSessionOnUnauthorized(response.status);
    if (response.status === 401 && spaceId && spaceId === selectedSpaceId())
      void leaveUnavailableSpace(spaceId);
    for (const listener of responseListeners) listener(response);
    return response;
  },
});

/**
 * A 401 means the session behind the app's last known user may be gone, but Better Auth only
 * rechecks it on focus or a timer, so a backgrounded window would keep its stale user (and every
 * screen that polls) indefinitely. Recheck now: a signed-out answer routes to sign-in.
 */
export function recheckSessionOnUnauthorized(status: number): void {
  if (status === 401) authClient.$store.notify("$sessionSignal");
}

let leavingSpace: Promise<void> | null = null;

/**
 * The server answers 401 when the selected space is no longer one of the user's, for instance
 * after they are removed from it, and every request would keep failing. Ask without a space which
 * spaces the user has in any organization; if the selected one is not among them, reload into
 * their default space.
 */
export function leaveUnavailableSpace(spaceId: string): Promise<void> {
  leavingSpace ??= (async () => {
    try {
      const { organizations } = await rpc.organizations.list(undefined, {
        context: { spaceId: null },
      });
      if (
        organizations.some((organization) => organization.spaceIds.includes(spaceId)) ||
        selectedSpaceId() !== spaceId
      )
        return;
      try {
        localStore.removeItem(SPACE_STORAGE_KEY);
      } catch {
        // Without storage the reload keeps asking without a Space.
      }
      window.location.reload();
    } catch {
      // Signed out or unreachable: leave the selection for the next request to try again.
    } finally {
      leavingSpace = null;
    }
  })();
  return leavingSpace;
}

export type RpcClient = ContractRouterClient<AppContract, RpcClientContext>;

const displayLink = {
  call: async (...args: Parameters<typeof link.call>) => {
    const [path, input, options] = args;
    const result = await link.call(path, input, options);
    if (path.join("/") === "threads/subscribe") {
      return (async function* () {
        for await (const event of result as AsyncIterable<ProductEvent>) {
          yield displayIdentityEvent(event, identityLabels());
        }
      })();
    }
    // Bootstrap can be prefetched before the locale catalog is ready. Its consumer projects it.
    return i18n.locale ? displayIdentityResult(path, result, identityLabels()) : result;
  },
};

export const rpc: RpcClient = createORPCClient(displayLink);

/** Keep late async follow-up requests in the shell's original auth boundary. */
export function createSpaceRpc(spaceId: string | null): typeof rpc {
  return createORPCClient({
    call: (path, input, options) =>
      displayLink.call(path, input, {
        ...options,
        // A call that names its own space (e.g. renaming another space's section) keeps it.
        context: {
          ...options.context,
          spaceId: options.context.spaceId === undefined ? spaceId : options.context.spaceId,
        },
      }),
  });
}

const spaceClients = new Map<string, RpcClient>();

/** Reuse a client for settings without changing the selected space. */
export function rpcForSpace(spaceId: string): RpcClient {
  let client = spaceClients.get(spaceId);
  if (!client) {
    client = createSpaceRpc(spaceId);
    spaceClients.set(spaceId, client);
  }
  return client;
}
