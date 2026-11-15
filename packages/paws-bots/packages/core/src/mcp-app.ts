import type { McpAppCsp } from "@rakazo/contracts";
import {
  ipVersion,
  isCloudMetadataHost,
  isInternalHostname,
  MCP_APP_DOMAINS_MAX,
  MCP_APP_PROTOCOL_VERSION,
} from "@rakazo/contracts";

/**
 * MCP Apps (SEP-1865) on the host side: the content policy an app runs under, the document the
 * sandbox shows, and the view-to-host protocol. Web, Electron and the native apps share it.
 *
 * The boundary is the same opaque-origin sandbox bot-made HTML runs in: no cookies, storage or
 * app DOM. This host shows an app; it does not let it act. A view can ask to open a link and to
 * put text in the composer, each only right after the person used it. Tool calls, resource reads
 * and model-context updates from a view are refused.
 */

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SOURCE = /^(https|wss):\/\/(\*\.)?([^/:]+)(?::(\d{1,5}))?\/?$/;

/**
 * The declared origins an app may reach, as CSP sources. Only public names over https (or wss
 * for connections): no IP literals, local or internal names, single-label hosts, bare wildcards,
 * or any host in `excludeHosts` (the app's own), so a declaration cannot point the view at the
 * person's network or at Rakazo itself.
 */
export function mcpAppDomains(
  values: unknown,
  kind: "connect" | "resource",
  excludeHosts: readonly string[] = [],
): string[] {
  if (!Array.isArray(values)) return [];
  const excluded = excludeHosts.map((host) => host.toLowerCase());
  const sources = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.length > 256) continue;
    const match = SOURCE.exec(value.trim().toLowerCase());
    if (!match) continue;
    const [, scheme, wildcard, host, port] = match;
    if (!host || (scheme === "wss" && kind !== "connect")) continue;
    if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) continue;
    const labels = host.split(".");
    if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) continue;
    if (ipVersion(host) !== 0 || isInternalHostname(host) || isCloudMetadataHost(host)) continue;
    const covers = (other: string) =>
      other === host || (wildcard !== undefined && other.endsWith(`.${host}`));
    if (excluded.some(covers)) continue;
    sources.add(`${scheme}://${wildcard ?? ""}${host}${port ? `:${port}` : ""}`);
    if (sources.size >= MCP_APP_DOMAINS_MAX) break;
  }
  return [...sources];
}

/** The `_meta.ui.csp` an app resource declared, narrowed to what this host allows. */
export function mcpAppCsp(declared: unknown, excludeHosts: readonly string[] = []): McpAppCsp {
  const csp = declared && typeof declared === "object" ? (declared as Record<string, unknown>) : {};
  const connectDomains = mcpAppDomains(csp.connectDomains, "connect", excludeHosts);
  const resourceDomains = mcpAppDomains(csp.resourceDomains, "resource", excludeHosts);
  return {
    ...(connectDomains.length ? { connectDomains } : {}),
    ...(resourceDomains.length ? { resourceDomains } : {}),
  };
}

/**
 * The policy an app document runs under: inline code, its declared origins, nothing else. Nested
 * frames, forms that navigate, plugins and base changes stay off whatever it declared.
 */
export function mcpAppContentSecurityPolicy(
  declared: McpAppCsp | undefined,
  excludeHosts: readonly string[] = [],
): string {
  const csp = mcpAppCsp(declared, excludeHosts);
  const resources = (csp.resourceDomains ?? []).join(" ");
  const connect = (csp.connectDomains ?? []).join(" ") || "'none'";
  const withResources = (base: string) => (resources ? `${base} ${resources}` : base);
  return [
    "default-src 'none'",
    `script-src ${withResources("'unsafe-inline'")}`,
    `style-src ${withResources("'unsafe-inline'")}`,
    `img-src ${withResources("data: blob:")}`,
    `font-src ${withResources("data:")}`,
    `media-src ${withResources("data: blob:")}`,
    `connect-src ${connect}`,
    "frame-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

const LEADING_DOCTYPE = /^﻿?\s*<!doctype[^>]*>/i;

/**
 * An app's HTML split for the viewer shell, which puts its gesture guard between the two: the
 * head carries the policy first, so nothing in the app's own markup runs before it applies.
 */
export function mcpAppDocument(
  html: string,
  csp: McpAppCsp | undefined,
  excludeHosts: readonly string[] = [],
): { head: string; body: string } {
  const policy = mcpAppContentSecurityPolicy(csp, excludeHosts);
  return {
    head: `<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer">`,
    body: html.replace(LEADING_DOCTYPE, ""),
  };
}

/** The viewer shell's own policy. The app document narrows it with its own; this is the ceiling. */
const SHELL_CSP =
  "default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; connect-src https: wss:; frame-src about:; child-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";

/**
 * The shell between the host and an app. On the web it is served as its own file (so it does
 * not inherit the app's policy) and framed with `sandbox="allow-scripts allow-forms"`; on phones
 * it is the WebView's document. Either way the app runs one frame down, in an opaque-origin
 * srcdoc frame, and has a real parent to talk to.
 *
 * Each document gets a fresh key that only the guard placed first in it knows; the guard
 * reports trusted clicks and keys, so a view cannot claim a gesture the person did not make.
 * The shell passes JSON-RPC both ways and marks a view's message with the latest gesture, if
 * it is still fresh.
 */
export const MCP_APP_SHELL_HTML = `<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="${SHELL_CSP}"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{margin:0;background:transparent}iframe{display:block;width:100%;height:100%;border:0;background:transparent}html,body{height:100%}</style><iframe id="app" title="App" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer"></iframe><!--rakazo-app-boot--><script>
(() => {
  const frame = document.getElementById("app");
  const native = Boolean(window.ReactNativeWebView);
  const up = (message) => native ? window.ReactNativeWebView.postMessage(JSON.stringify(message)) : parent.postMessage(message, "*");
  const GESTURE_WINDOW_MS = 1000;
  let key = "", gesture = 0, gestureAt = 0;
  const guard = () => {
    key = Array.from(crypto.getRandomValues(new Uint32Array(4)), (n) => n.toString(36)).join("");
    return \`<script>(() => { const up = parent, key = "\${key}"; document.currentScript.remove(); const apply = Reflect.apply, repeat = Object.getOwnPropertyDescriptor(KeyboardEvent.prototype, "repeat").get; const tell = () => up.postMessage({ type: "rakazo-app:gesture", key }, "*"); addEventListener("pointerup", (event) => { if (event.isTrusted) tell(); }, true); addEventListener("keydown", (event) => { if (event.isTrusted && !apply(repeat, event, [])) tell(); }, true); })();</\${"script"}>\`;
  };
  const load = (app) => {
    if (!app || typeof app.head !== "string" || typeof app.body !== "string") return;
    gesture = 0;
    frame.srcdoc = app.head + guard() + app.body;
  };
  const rpc = (data) => Boolean(data) && typeof data === "object" && data.jsonrpc === "2.0";
  addEventListener("message", (event) => {
    const data = event.data;
    if (event.source === frame.contentWindow) {
      const active = navigator.userActivation ? navigator.userActivation.isActive : false;
      if (data && data.type === "rakazo-app:gesture") {
        if (key && data.key === key && active) { gesture += 1; gestureAt = Date.now(); }
        return;
      }
      if (!rpc(data)) return;
      const fresh = active && gesture > 0 && Date.now() - gestureAt <= GESTURE_WINDOW_MS ? key + ":" + gesture : null;
      up({ type: "rakazo-app:view", message: data, gesture: fresh });
      return;
    }
    const fromHost = native ? event.source === window : event.source === parent && parent !== window;
    if (!fromHost || !data || typeof data !== "object") return;
    if (data.type === "rakazo-app:load") load(data);
    else if (data.type === "rakazo-app:host" && rpc(data.message)) frame.contentWindow.postMessage(data.message, "*");
  });
  if (window.__rakazoApp) load(window.__rakazoApp);
})();
</script>`;

/** The shell with the app already in it, for a WebView that loads one document. */
export function mcpAppShellDocument(app: { head: string; body: string }): string {
  const boot = JSON.stringify(app)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  // A function, so `$&` and the like in the app's own code are not read as replacement patterns.
  return MCP_APP_SHELL_HTML.replace(
    "<!--rakazo-app-boot-->",
    () => `<script>window.__rakazoApp=${boot};</script>`,
  );
}

/** Text a view asked to put in the composer, on one line; null when unusable. */
export function mcpAppMessageText(params: unknown): string | null {
  if (!params || typeof params !== "object") return null;
  const { role, content } = params as { role?: unknown; content?: unknown };
  if (role !== "user") return null;
  const blocks = Array.isArray(content) ? content : [content];
  const text = blocks
    .map((block) =>
      block && typeof block === "object" && (block as { type?: unknown }).type === "text"
        ? (block as { text?: unknown }).text
        : undefined,
    )
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text && text.length <= MCP_APP_MESSAGE_MAX_LENGTH ? text : null;
}

export const MCP_APP_MESSAGE_MAX_LENGTH = 2_000;

/** The view's requests this host answers; the rest get "method not found". */
type JsonRpcId = string | number;
type ViewMessage = { id?: JsonRpcId; method?: string; params?: unknown };

/** Where a view's own requests land; each runs only when `allowAction` vouches for a gesture. */
export interface McpAppHostOptions {
  input: Record<string, unknown>;
  result: Record<string, unknown>;
  /** The `hostContext` a view gets at initialize: theme, locale, sizes. */
  hostContext: Record<string, unknown>;
  /** The domains this host let the app reach, echoed to it as granted. */
  csp?: McpAppCsp;
  /** Posts a JSON-RPC message down to the view. */
  send(message: object): void;
  /** Whether a fresh gesture covers the view's request. Called only for one that acts. */
  allowAction(): boolean;
  openLink(url: string): void;
  /** Puts text in the composer; the person still sends it. */
  offerMessage(text: string): void;
  onHeight(height: number): void;
}

const DENIED = -32000;
const METHOD_NOT_FOUND = -32601;
const MAX_VIEW_MESSAGE_LENGTH = 64_000;

/**
 * The host half of one view's session. It answers `ui/initialize`, sends the call's input and
 * result once the view says it is ready, and never before, as the protocol requires.
 */
export function createMcpAppHost(options: McpAppHostOptions) {
  let initialized = false;
  let teardowns = 0;
  const reply = (id: JsonRpcId, result: object) => options.send({ jsonrpc: "2.0", id, result });
  const refuse = (id: JsonRpcId, code: number, message: string) =>
    options.send({ jsonrpc: "2.0", id, error: { code, message } });
  const notify = (method: string, params: object) =>
    options.send({ jsonrpc: "2.0", method, params });

  function request(id: JsonRpcId, method: string, params: unknown) {
    switch (method) {
      case "ui/initialize":
        return reply(id, {
          protocolVersion: MCP_APP_PROTOCOL_VERSION,
          hostInfo: { name: "rakazo", version: "1.0.0" },
          hostCapabilities: {
            openLinks: {},
            message: { text: {} },
            sandbox: { csp: options.csp ?? {} },
          },
          hostContext: options.hostContext,
        });
      case "ping":
        return reply(id, {});
      case "ui/request-display-mode":
        return reply(id, { mode: "inline" });
      case "ui/open-link": {
        const url = mcpAppLink(params);
        if (!url) return refuse(id, DENIED, "Invalid URL");
        if (!options.allowAction()) return refuse(id, DENIED, "Link opening denied");
        options.openLink(url);
        return reply(id, {});
      }
      case "ui/message": {
        const text = mcpAppMessageText(params);
        if (!text) return refuse(id, DENIED, "Invalid message format");
        if (!options.allowAction()) return refuse(id, DENIED, "Message sending denied");
        options.offerMessage(text);
        return reply(id, {});
      }
      default:
        // tools/call, resources/read, ui/update-model-context, sampling and anything newer.
        return refuse(id, METHOD_NOT_FOUND, "Method not found");
    }
  }

  function notification(method: string, params: unknown) {
    if (method === "ui/notifications/initialized") {
      if (initialized) return;
      initialized = true;
      notify("ui/notifications/tool-input", { arguments: options.input });
      notify("ui/notifications/tool-result", options.result);
      return;
    }
    if (method === "ui/notifications/size-changed" && params && typeof params === "object") {
      const { height } = params as { height?: unknown };
      if (typeof height === "number" && Number.isFinite(height) && height >= 0) {
        options.onHeight(height);
      }
    }
  }

  return {
    /** A JSON-RPC message the view sent, as the shell passed it up. */
    receive(data: unknown) {
      if (!data || typeof data !== "object") return;
      if (JSON.stringify(data).length > MAX_VIEW_MESSAGE_LENGTH) return;
      const { id, method, params } = data as ViewMessage;
      if (typeof method !== "string") return; // A response to our teardown, or noise.
      if (typeof id === "string" || typeof id === "number") request(id, method, params);
      else notification(method, params);
    },
    /** Host context that changed, such as the theme. */
    updateContext(context: Record<string, unknown>) {
      if (initialized) notify("ui/notifications/host-context-changed", context);
    },
    /** Tells the view it is going away; nothing waits for its answer. */
    teardown() {
      if (!initialized) return;
      teardowns += 1;
      options.send({
        jsonrpc: "2.0",
        id: `rakazo-teardown-${teardowns}`,
        method: "ui/resource-teardown",
        params: {},
      });
    },
  };
}

/** A web or mail link a view asked to open; anything else stays inside the view. */
export function mcpAppLink(params: unknown): string | null {
  if (!params || typeof params !== "object") return null;
  const { url } = params as { url?: unknown };
  if (typeof url !== "string" || url.length > 4096) return null;
  try {
    const parsed = new URL(url);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}
