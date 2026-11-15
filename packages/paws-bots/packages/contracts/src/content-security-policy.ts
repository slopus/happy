/**
 * Content-Security-Policy for documents the web server (and the desktop bundled renderer) serves.
 * The app talks only to its own origin: /api, /rpc, the Sentry tunnel and the /novnc screen proxy
 * all live there, so 'self' covers fetches, WebSockets and screen frames in every deployment. The
 * web server may add operator-configured https origins for a script its CDN injects.
 */

/** Static shell for SandboxedHtmlViewer. It must load from the network so it does not inherit the
 * app policy the way a srcdoc frame would; its own meta CSP governs it and its nested preview. */
export const HTML_VIEWER_PATH = "/html-viewer.html";

/** Static shell for MCP app cards; see `MCP_APP_SHELL_HTML` in core. Framed only by the app. */
export const MCP_APP_VIEWER_PATH = "/mcp-app-viewer.html";

/** Embedded computer screen and its local runtime assets. */
export const COMPUTER_SCREEN_PATH = "/computer-screen/screen.html";
export const COMPUTER_SCREEN_PREFIX = "/computer-screen/";
export const COMPUTER_SCREEN_RUNTIME_PATH = "/computer-screen/sdk/ASP/container.html";

/** Adapter-owned policies for the embedded page and its opaque nested runtime. */
export interface EmbeddedComputerScreenPolicy {
  screen: string;
  runtime: string;
}

/** Same-origin endpoint browsers send violation reports to, so a blocked resource is not silent. */
export const CSP_REPORT_PATH = "/api/csp-report";
const CSP_REPORT_GROUP = "csp";

export const CSP_REPORTING_ENDPOINTS = `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`;

const APP_DIRECTIVES: Record<string, string[]> = {
  "default-src": ["'self'"],
  "script-src": ["'self'"],
  // Mermaid SVGs and some UI libraries inject <style> elements and style attributes as markup.
  "style-src": ["'self'", "'unsafe-inline'"],
  // Markdown images, link favicons and attachment previews (object URLs).
  "img-src": ["'self'", "data:", "blob:", "https:"],
  "font-src": ["'self'", "data:"],
  // Voice replies and video attachments play from object URLs.
  "media-src": ["'self'", "blob:"],
  "connect-src": ["'self'"],
  // The /novnc screen proxy, the HTML viewer shell and PDF object URLs.
  "frame-src": ["'self'", "blob:"],
  "object-src": ["'none'"],
  "base-uri": ["'self'"],
  "form-action": ["'self'"],
  "frame-ancestors": ["'none'"],
  // Browsers with the Reporting API use report-to and ignore report-uri; the rest use report-uri.
  "report-uri": [CSP_REPORT_PATH],
  "report-to": [CSP_REPORT_GROUP],
};

function serialize(directives: Record<string, string[]>) {
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(" ")}`)
    .join("; ");
}

/** Origins an operator adds for a script a CDN in front of the app injects, such as analytics. */
export interface ContentSecurityPolicyExtensions {
  scriptSrc?: readonly string[];
  connectSrc?: readonly string[];
  /** Allows the Crisp chat widget the paywall loads when `CRISP_WEBSITE_ID` is set. */
  crisp?: boolean;
}

// The required origins from Crisp's domain list; images already pass the https: img-src.
const CRISP = "https://client.crisp.chat";
const CRISP_DIRECTIVES: Record<string, string[]> = {
  "script-src": [CRISP],
  "connect-src": [CRISP, "https://storage.crisp.chat", "wss://client.relay.crisp.chat"],
  "style-src": [CRISP],
  "font-src": [CRISP],
  "media-src": [CRISP],
  // Its bot checks run in workers loaded from blob: URLs.
  "worker-src": ["'self'", "blob:", CRISP],
};

const CRISP_WEBSITE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `CRISP_WEBSITE_ID` is optional; a malformed one throws so the server refuses to start. */
export function parseCrispWebsiteId(value: string | undefined): string | null {
  const id = value?.trim();
  if (!id) return null;
  if (!CRISP_WEBSITE_ID.test(id)) throw new Error("CRISP_WEBSITE_ID must be a Crisp website ID");
  return id.toLowerCase();
}

// An https origin with an optional port and no path. A wildcard covers subdomains of a base with at
// least two labels (https://*.example.com), so it cannot cover a whole top-level domain.
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const EXTRA_SOURCE = new RegExp(
  `^https://(?:\\*\\.${LABEL}(?:\\.${LABEL})+|${LABEL}(?:\\.${LABEL})*)(?::(\\d{1,5}))?$`,
  "i",
);

function validSource(source: string) {
  const match = EXTRA_SOURCE.exec(source);
  const port = match?.[1];
  return Boolean(match) && (port === undefined || (Number(port) >= 1 && Number(port) <= 65535));
}

/**
 * Parses an operator's space- or comma-separated list of extra origins. Anything but an https
 * origin throws, so a typo cannot widen the policy to a keyword, a scheme or every host.
 */
export function parseContentSecuritySources(setting: string, value: string | undefined) {
  const sources = (value ?? "").split(/[\s,]+/).filter(Boolean);
  const invalid = sources.filter((source) => !validSource(source));
  if (invalid.length > 0) {
    throw new Error(
      `${setting} accepts only https:// origins such as https://cdn.example.com or https://*.example.com. Invalid: ${invalid.join(" ")}`,
    );
  }
  return [...new Set(sources.map((source) => source.toLowerCase()))];
}

export function appContentSecurityPolicy(extensions: ContentSecurityPolicyExtensions = {}) {
  const directives: Record<string, string[]> = {
    ...APP_DIRECTIVES,
    "script-src": ["'self'", ...(extensions.scriptSrc ?? [])],
    "connect-src": ["'self'", ...(extensions.connectSrc ?? [])],
  };
  if (extensions.crisp) {
    for (const [name, sources] of Object.entries(CRISP_DIRECTIVES)) {
      directives[name] = [...new Set([...(directives[name] ?? []), ...sources])];
    }
  }
  return serialize(directives);
}

export const APP_CONTENT_SECURITY_POLICY = appContentSecurityPolicy();

// The shell's meta CSP cannot restrict framing; only the app may embed it.
const HTML_VIEWER_CONTENT_SECURITY_POLICY = serialize({ "frame-ancestors": ["'self'"] });

// Proxied responses keep their own headers; the screen proxy sets its own sandbox policy.
const PASSTHROUGH_PREFIXES = ["/api", "/rpc", "/novnc"];

/** The policy header for a served path, or null when the response must keep its own policy. */
export function contentSecurityPolicyFor(
  pathname: string,
  appPolicy = APP_CONTENT_SECURITY_POLICY,
  screenPolicy?: EmbeddedComputerScreenPolicy,
): string | null {
  if (
    PASSTHROUGH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
  )
    return null;
  if (pathname === HTML_VIEWER_PATH || pathname === MCP_APP_VIEWER_PATH)
    return HTML_VIEWER_CONTENT_SECURITY_POLICY;
  // The nested runtime has an opaque ancestor, which cannot match 'self'. Its sandbox
  // policy still prevents access to the app even when visited directly.
  if (screenPolicy && pathname === COMPUTER_SCREEN_RUNTIME_PATH) return screenPolicy.runtime;
  if (pathname.startsWith(COMPUTER_SCREEN_PREFIX))
    return screenPolicy?.screen ?? "default-src 'none'; sandbox; frame-ancestors 'self'";
  return appPolicy;
}
