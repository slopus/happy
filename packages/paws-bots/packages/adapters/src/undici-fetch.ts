import { fetch as undiciFetch } from "undici";

/** The fetch that must drive any `Agent` built from the `undici` package.
 *
 * Node's built-in fetch bundles its own undici, and undici 8 rejects a request from it through
 * a package `Agent` ("invalid onRequestStart method"), so the package's fetch is paired with
 * its `Agent`. Global `FormData` fails this package's brand check, so it is serialized first.
 * The package `Response` fails `instanceof Response` (the MCP SDK then stringifies it), so the
 * result is re-wrapped in the global `Response`. */
export const dispatcherFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const response = await undiciFetch(
    input as Parameters<typeof undiciFetch>[0],
    (await initForPackageFetch(init)) as Parameters<typeof undiciFetch>[1],
  );
  return responseForGlobalRealm(response as object);
}) as unknown as typeof globalThis.fetch;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

type PackageResponse = {
  status: number;
  statusText: string;
  headers: { forEach(callback: (value: string, key: string) => void): void };
  body: ReadableStream<Uint8Array> | null;
};

/** Copy a package `Response` into the global realm.
 *
 * Hop-by-hop headers describe the socket undici already finished and would mislabel the
 * re-streamed body. The parameter is not typed as the global `Response`: a failed `instanceof`
 * check would narrow it to `never`. */
function responseForGlobalRealm(input: object): Response {
  if (input instanceof globalThis.Response) return input;
  const response = input as PackageResponse;
  const headers = new Headers();
  response.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) headers.append(key, value);
  });
  const init = { status: response.status, statusText: response.statusText, headers };
  if (response.body == null || NULL_BODY_STATUSES.has(response.status)) {
    return new Response(null, init);
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        controller.error(withDropReason(error));
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(body, init);
}

/** undici fails any dropped body with a bare "terminated" and keeps why in `cause` (the
 * server closed the socket, a reset, a timeout). Keep that reason in the message, which is
 * all a run's error details carry. */
function withDropReason(error: unknown): unknown {
  if (!(error instanceof Error) || error.message !== "terminated") return error;
  const reason = error.cause instanceof Error ? error.cause.message.trim() : "";
  return reason ? new TypeError(`terminated (${reason})`, { cause: error.cause }) : error;
}

/** Node's fetch as this module loaded it. A later replacement of
 * `globalThis.fetch` is a different function; the original is still paired
 * here so a captured builtin is not handed the package Agent. */
const nodeFetch = globalThis.fetch;

/** Package fetch for an `Agent` from this undici.
 *
 * A missing transport, the fetch currently installed as `globalThis.fetch`,
 * and a captured builtin all use `dispatcherFetch`. Any other function is
 * the caller's transport and is returned unchanged. */
export function fetchPairedWithDispatcher(
  baseFetch?: typeof globalThis.fetch,
): typeof globalThis.fetch {
  if (
    baseFetch == null ||
    baseFetch === nodeFetch ||
    baseFetch === globalThis.fetch ||
    baseFetch === dispatcherFetch
  ) {
    return dispatcherFetch;
  }
  return baseFetch;
}

/** Snapshot a global FormData body before this package's fetch sees it.
 *
 * The snapshot's Content-Type is the boundary embedded in the bytes. Set that
 * header only when the caller did not already supply one, matching fetch. */
async function initForPackageFetch(init?: RequestInit): Promise<RequestInit | undefined> {
  if (!(init?.body instanceof FormData)) return init;
  const encoded = new Request("https://example.com/", { method: "POST", body: init.body });
  const contentType = encoded.headers.get("content-type");
  if (!contentType?.includes("boundary=")) {
    throw new Error("FormData body did not include a multipart Content-Type.");
  }
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", contentType);
  return { ...init, body: new Uint8Array(await encoded.arrayBuffer()), headers };
}
