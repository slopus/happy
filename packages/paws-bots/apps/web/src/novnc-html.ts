import type { IncomingHttpHeaders } from "node:http";
import type { Readable } from "node:stream";

export const MAX_NOVNC_HTML_BYTES = 1024 * 1024;

const NOVNC_PAGES = new Set(["vnc.html", "vnc_lite.html", "embed.html"]);

/** Browser-extension script URLs. Their errors must not replace the screen. */
export const NOVNC_EXTENSION_ERROR = /^[a-z-]+-extension:/;

export function isNovncExtensionError(filename: string) {
  return NOVNC_EXTENSION_ERROR.test(filename);
}

/** Whether an upstream path is a noVNC page, whichever provider serves it. */
export function isNovncPage(path: string) {
  const { pathname } = new URL(path, "http://upstream.invalid");
  return NOVNC_PAGES.has(pathname.slice(pathname.lastIndexOf("/") + 1));
}

/**
 * The proxy sandboxes screen documents without same-origin, so noVNC's settings reads from
 * localStorage throw. Only uncompressed HTML for a noVNC page is rewritten.
 */
export function shouldInjectNovncStorageShim(headers: IncomingHttpHeaders, path: string) {
  if (!isNovncPage(path)) return false;
  const encoding = String(headers["content-encoding"] ?? "")
    .trim()
    .toLowerCase();
  if (encoding && encoding !== "identity") return false;
  const contentType = String(headers["content-type"] ?? "").toLowerCase();
  return contentType.includes("text/html") || contentType.includes("application/xhtml+xml");
}

/**
 * Request a noVNC page in full and uncompressed. Without validators the upstream cannot answer
 * 304, which would let a browser keep a copy cached before the shim existed.
 */
export function novncPageRequestHeaders<T extends Record<string, unknown>>(headers: T) {
  const {
    "if-modified-since": _since,
    "if-none-match": _match,
    ...rest
  } = headers as Record<string, unknown>;
  return { ...rest, "accept-encoding": "identity" } as Omit<
    T,
    "if-modified-since" | "if-none-match"
  > & {
    "accept-encoding": string;
  };
}

/**
 * Headers for a rewritten noVNC page. Capability URLs are reused while their seal is valid, so a
 * cached page would outlive a proxy change; the rewritten page is never stored. A CDN in front of
 * the web service must not rewrite it either: script injection, minification and script loaders
 * break noVNC's module scripts, and `no-transform` is the signal CDNs honour.
 */
export function rewrittenNovncHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const {
    "content-length": _length,
    etag: _etag,
    "last-modified": _modified,
    expires: _expires,
    ...rest
  } = headers;
  return { ...rest, "cache-control": "no-store, no-transform" };
}

/**
 * Replace both storages, keep browser extensions from taking the page down, and report the
 * screen's state to the app. Extension content scripts run inside the sandboxed document too;
 * one reading storage throws a SecurityError that noVNC's global error handler would otherwise
 * show in place of the screen. The app cannot see into the frame, so the page posts "loading" as
 * soon as it runs and then follows noVNC's connection classes (which Rakazo's own embed page
 * sets as well) and its status bar.
 */
export function injectNovncStorageShim(html: string, { viewOnly = false } = {}) {
  // The app shows the screen's state itself, and noVNC's status bar names the provider's host.
  // Its side panel only has controls to offer while the user has control.
  const chrome = `<style>#noVNC_status{display:none!important}${
    viewOnly ? "#noVNC_control_bar_anchor{display:none!important}" : ""
  }</style>`;
  const shim = `${chrome}<script>
(() => {
  const memoryStorage = () => {
    const items = new Map();
    return {
      getItem(key) { return items.has(String(key)) ? items.get(String(key)) : null; },
      setItem(key, value) { items.set(String(key), String(value)); },
      removeItem(key) { items.delete(String(key)); },
      clear() { items.clear(); },
    };
  };
  for (const name of ["localStorage", "sessionStorage"]) {
    Object.defineProperty(window, name, { configurable: true, value: memoryStorage() });
  }
  window.addEventListener("error", (event) => {
    if (/${NOVNC_EXTENSION_ERROR.source}/.test(String(event.filename))) event.stopImmediatePropagation();
  }, true);
  // noVNC probes WebCodecs H.264 support while its modules evaluate. On some Android devices
  // VideoDecoder.flush() never returns, so the page never starts. Screens never use H.264.
  try { delete window.VideoDecoder; } catch {}
  // The app cannot look into this sandboxed frame, so tell it how the screen is doing.
  const report = (rakazoScreen, detail) => {
    try {
      window.parent.postMessage(detail ? { rakazoScreen, detail } : { rakazoScreen }, "*");
    } catch {}
    // The mobile app's WebView hears only the state word: no URL and none of the page's text.
    try {
      window.ReactNativeWebView?.postMessage(JSON.stringify({ rakazoScreen }));
    } catch {}
  };
  // A reconnected screen takes the keyboard back when the app asks; nothing else is accepted.
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (
      event.source !== window.parent ||
      !data ||
      typeof data !== "object" ||
      Object.keys(data).length !== 1 ||
      data.rakazoScreenFocus !== true
    )
      return;
    const canvas = document.querySelector("#screen canvas, #noVNC_container canvas, canvas");
    try {
      canvas?.focus();
    } catch {}
  });
  let last = "";
  // Pages that never set noVNC's classes (older Rakazo embed images) still build their viewer
  // canvas, which is as far as they can be followed.
  let classed = false;
  const sync = () => {
    const root = document.documentElement;
    const status = document.getElementById("noVNC_status");
    const failure = root.getAttribute("data-rakazo-screen-error");
    const statusError =
      status && status.classList.contains("noVNC_open") && status.classList.contains("noVNC_status_error");
    const connecting =
      root.classList.contains("noVNC_connecting") || root.classList.contains("noVNC_reconnecting");
    const connected = root.classList.contains("noVNC_connected");
    if (connecting || connected) classed = true;
    const state = connected
      ? "connected"
      : failure !== null || statusError
        ? "failed"
        : connecting
          ? "connecting"
          : classed
            ? last === "connected" || last === "connecting"
              ? "disconnected"
              : ""
            : document.querySelector("#screen canvas")
              ? "connecting"
              : "";
    if (!state || state === last) return;
    last = state;
    report(state, state === "failed" ? failure || String(status?.textContent || "") : undefined);
  };
  const observe = () => {
    sync();
    new MutationObserver(sync).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-rakazo-screen-error"],
      childList: true,
      subtree: true,
    });
  };
  report("loading");
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", observe);
  else observe();
})();
</script>`;
  return html.includes("<head>")
    ? html.replace("<head>", `<head>${shim}`)
    : html.replace(/<script\b/i, `${shim}<script`);
}

/** Read a noVNC document with a hard cap, and fail if the upstream ends without `end`. */
export function collectNovncHtml(incoming: Readable, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      incoming.destroy();
      reject(error);
    };
    incoming.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > maxBytes) {
        fail(new Error(`noVNC document exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(buf);
    });
    incoming.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    incoming.on("error", (error: unknown) => {
      fail(error instanceof Error ? error : new Error("noVNC upstream failed"));
    });
    incoming.on("aborted", () => {
      fail(new Error("noVNC upstream aborted"));
    });
    incoming.on("close", () => {
      if (!settled) fail(new Error("noVNC upstream closed"));
    });
  });
}
