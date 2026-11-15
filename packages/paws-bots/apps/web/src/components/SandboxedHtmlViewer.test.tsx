// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { HTML_VIEWER_PATH } from "@rakazo/contracts/content-security-policy";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PREVIEW_CSP, SandboxedHtmlViewer } from "./SandboxedHtmlViewer";

const shell = readFileSync(
  path.join(import.meta.dirname, "../../public", HTML_VIEWER_PATH),
  "utf8",
);

async function render(html: string) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<SandboxedHtmlViewer title="Notes" html={html} />);
  });
  const iframe = container.querySelector("iframe");
  if (!iframe?.contentWindow) throw new Error("viewer frame missing");
  const postMessage = vi.spyOn(iframe.contentWindow, "postMessage").mockImplementation(() => {});
  return {
    iframe,
    postMessage,
    async load() {
      await act(async () => {
        iframe.dispatchEvent(new Event("load"));
      });
    },
    async rerender(next: string) {
      await act(async () => {
        root.render(<SandboxedHtmlViewer title="Notes" html={next} />);
      });
    },
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    },
  };
}

it("loads the shell from the network so it does not inherit the app's CSP", async () => {
  const view = await render("<p>Hello</p>");

  expect(view.iframe.getAttribute("src")).toBe(HTML_VIEWER_PATH);
  expect(view.iframe.hasAttribute("srcdoc")).toBe(false);
  expect(view.iframe.getAttribute("sandbox")).toBe("allow-scripts");
  expect(view.iframe.getAttribute("referrerpolicy")).toBe("no-referrer");

  await view.cleanup();
});

it("loads an embedded shell from its bound gateway without changing the opaque frame", async () => {
  vi.resetModules();
  vi.stubEnv("PAWS_EMBEDDED", "true");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({
    sessionKey: "s".repeat(43), spaceId: "space-a", accountKey: "embedded-viewer-account",
    expiresAt: Date.now() + 60_000, locale: "en", appearance: "light",
  })));
  const container = document.createElement("div");
  document.body.append(container);
  const runtime = await import("../paws/runtime");
  await runtime.connect(container, { runtimeUrl: "https://bots.test/", ticket: "t".repeat(43),
    expiresAt: Date.now() + 60_000, onAuthenticated() {}, onFailure() {} });
  const { SandboxedHtmlViewer: EmbeddedViewer } = await import("./SandboxedHtmlViewer");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<EmbeddedViewer title="Embedded notes" html="<p>Notes</p>" />));
    const frame = container.querySelector("iframe");
    expect(frame?.getAttribute("src")).toBe("https://bots.test/html-viewer.html");
    expect(frame?.hasAttribute("srcdoc")).toBe(false);
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame?.getAttribute("referrerpolicy")).toBe("no-referrer");
  } finally {
    await act(async () => root.unmount());
    runtime.disconnect();
    container.remove();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

it("posts the guarded preview once the shell loads, and again on change or reload", async () => {
  const view = await render('<img src="https://example.invalid/pixel.png">');
  expect(view.postMessage).not.toHaveBeenCalled();

  await view.load();
  const [document, target] = view.postMessage.mock.calls[0] ?? [];
  expect(target).toBe("*");
  expect(document).toContain(
    `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`,
  );
  expect(document).toContain('<meta name="referrer" content="no-referrer">');
  expect(document).toContain("https://example.invalid/pixel.png");

  await view.rerender("<p>Next</p>");
  expect(view.postMessage.mock.lastCall?.[0]).toContain("<p>Next</p>");
  await view.load();
  expect(view.postMessage).toHaveBeenCalledTimes(3);

  await view.cleanup();
});

it("keeps the nested preview opaque and blocks remote images, media and fonts", () => {
  const preview = shell.match(/<iframe id="preview"[^>]*>/)?.[0] ?? "";
  expect(preview).toContain('sandbox="allow-scripts"');
  expect(preview).toContain('referrerpolicy="no-referrer"');
  expect(preview).toContain(`csp="${PREVIEW_CSP}"`);
  expect(PREVIEW_CSP).toContain("img-src data:");
  expect(PREVIEW_CSP).toContain("font-src data:");
  expect(PREVIEW_CSP).not.toMatch(/img-src[^;]*https:/);
  expect(PREVIEW_CSP).not.toMatch(/font-src[^;]*https:/);
  expect(PREVIEW_CSP).toMatch(/media-src data: blob:;/);
  expect(PREVIEW_CSP).not.toMatch(/https?:/);
  // The srcdoc also inherits the shell's own policy, so embedded pictures and media need it there.
  const shellPolicy =
    shell.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)?.[1] ?? "";
  expect(shellPolicy).toContain("img-src data:;");
  expect(shellPolicy).toContain("media-src data: blob:;");
  expect(shellPolicy).not.toMatch(/https?:/);
  expect(shell).not.toContain("allow-same-origin");
});

it("renders only string messages from the embedding app", () => {
  const script = shell.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("shell script missing");
  const run = (embedded: boolean) => {
    const preview = { srcdoc: "" };
    const self = {};
    const parent = embedded ? {} : self;
    let listener: ((event: { source: unknown; data: unknown }) => void) | undefined;
    new Function("addEventListener", "parent", "window", "document", script)(
      (_type: string, handler: typeof listener) => {
        listener = handler;
      },
      parent,
      self,
      { getElementById: () => preview },
    );
    return {
      preview,
      parent,
      send: (source: unknown, data: unknown) => listener?.({ source, data }),
    };
  };

  const shellFrame = run(true);
  shellFrame.send({}, "<p>from another frame</p>");
  shellFrame.send(shellFrame.parent, { html: "<p>object</p>" });
  expect(shellFrame.preview.srcdoc).toBe("");
  shellFrame.send(shellFrame.parent, "<p>Hello</p>");
  // The gesture guard goes first, ahead of anything the page runs.
  expect(shellFrame.preview.srcdoc).toMatch(
    /^<script>[^<]*rakazo-page:gesture[^<]*<\/script><p>Hello<\/p>$/,
  );

  const topLevel = run(false);
  topLevel.send(topLevel.parent, "<p>Opened directly</p>");
  expect(topLevel.preview.srcdoc).toBe("");
});

it("vouches for one click or key the guard saw, never a forged, stale or inactive one", () => {
  const script = shell.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("shell script missing");
  const preview = { srcdoc: "", contentWindow: {} };
  const posted: { type?: string; gesture?: unknown }[] = [];
  const parent = { postMessage: (message: (typeof posted)[number]) => posted.push(message) };
  const activation = { isActive: true };
  vi.stubGlobal("navigator", { userActivation: activation });
  const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  let listener: ((event: { source: unknown; data: unknown }) => void) | undefined;
  new Function("addEventListener", "parent", "window", "document", script)(
    (_type: string, handler: typeof listener) => {
      listener = handler;
    },
    parent,
    {},
    { getElementById: () => preview },
  );
  listener?.({ source: parent, data: "<p>Page</p>" });
  const key = /key = "([^"]+)"/.exec(preview.srcdoc)?.[1];
  const page = (data: object) => listener?.({ source: preview.contentWindow, data });
  const gesture = (value = key) => page({ type: "rakazo-page:gesture", key: value });
  const copy = (id: string) => page({ type: "rakazo-page:copy", id, text: id });

  copy("on load");
  gesture("forged");
  copy("forged");
  gesture();
  copy("first");
  copy("same click");
  page({ type: "rakazo-page:height", height: 300 });
  gesture();
  copy("next click");
  now.mockReturnValue(1_001_001);
  copy("a second later");
  // A gesture while the shell is not active counts for nothing.
  activation.isActive = false;
  gesture();
  copy("inactive");
  activation.isActive = true;
  copy("after an inactive gesture");
  gesture();
  copy("fresh click");

  expect(posted.map((message) => message.gesture)).toEqual([
    null,
    null,
    `${key}:1`,
    `${key}:1`,
    undefined,
    `${key}:2`,
    null,
    null,
    null,
    `${key}:3`,
  ]);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("lets the shell load the nested srcdoc preview and rejects http(s) navigations", () => {
  const policy = shellContentSecurityPolicy(shell);
  const sources = operativeFrameSources(policy);

  expect(policy).toContain("child-src 'none'");
  expect(frameSourceAllows(sources, "about:srcdoc")).toBe(true);
  expect(frameSourceAllows(sources, "https://example.invalid/nav")).toBe(false);
  expect(frameSourceAllows(sources, "http://example.invalid/nav")).toBe(false);
});

function shellContentSecurityPolicy(html: string): string {
  const match = html.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/);
  if (!match?.[1]) throw new Error("shell CSP missing");
  return match[1];
}

function directiveSources(policy: string, name: string): string[] | undefined {
  for (const part of policy.split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens[0] !== name) continue;
    return tokens.slice(1);
  }
  return undefined;
}

function operativeFrameSources(policy: string): string[] {
  return (
    directiveSources(policy, "frame-src") ??
    directiveSources(policy, "child-src") ??
    directiveSources(policy, "default-src") ?? ["'none'"]
  );
}

function frameSourceAllows(sources: string[], rawUrl: string): boolean {
  if (sources.length === 0 || sources.includes("'none'")) return false;
  const url = new URL(rawUrl);
  return sources.some((source) => sourceAllows(source, url));
}

function sourceAllows(source: string, url: URL): boolean {
  if (source === "*") {
    return (
      url.protocol === "http:" ||
      url.protocol === "https:" ||
      url.protocol === "ws:" ||
      url.protocol === "wss:"
    );
  }
  if (source.startsWith("'")) return false;
  if (/^[a-z][a-z0-9+.-]*:$/i.test(source)) return url.protocol === source;
  if (source.startsWith("http://") || source.startsWith("https://")) {
    const allowed = new URL(source);
    return url.protocol === allowed.protocol && url.hostname === allowed.hostname;
  }
  return false;
}
