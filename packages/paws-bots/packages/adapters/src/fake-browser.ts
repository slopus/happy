import type {
  AdapterContext,
  BrowserActRequest,
  BrowserActResult,
  BrowserNavigateRequest,
  BrowserNavigateResult,
  BrowserProvider,
  BrowserSnapshotRequest,
  BrowserSnapshotResult,
  ComputerRef,
} from "@rakazo/adapter-kit";
import { PageBrowserSessionStore, pageBrowserSessionKey } from "./page-browser-session.js";
import { fetchSafeWebText } from "./web-ssrf.js";

export interface FakeBrowserProviderOptions {
  /** Inject HTML for a URL without hitting the network (offline tests). */
  pages?: Record<string, { title?: string; html: string }>;
  fetch?: typeof globalThis.fetch;
}

/**
 * In-process page browser for offline tests and keyless core. Not a hosted
 * browser vendor: sessions are keyed by computer id so tools stay computer-scoped.
 */
export class FakeBrowserProvider implements BrowserProvider {
  readonly sessions = new PageBrowserSessionStore();
  private readonly pages: Record<string, { title?: string; html: string }>;
  private readonly fetchImpl?: typeof globalThis.fetch;
  navigateError?: Error;
  snapshotError?: Error;
  actError?: Error;
  /** When set, every method returns computer_act fallback (fallback-path tests). */
  forceFallback?: string;

  constructor(options: FakeBrowserProviderOptions = {}) {
    this.pages = options.pages ?? {};
    this.fetchImpl = options.fetch;
  }

  describe() {
    return {
      id: "fake",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        page: true,
        refs: true,
        keyless: true,
      },
    };
  }

  async navigate(
    computer: ComputerRef,
    request: BrowserNavigateRequest,
    context: AdapterContext,
  ): Promise<BrowserNavigateResult> {
    if (this.forceFallback) {
      return {
        url: request.url,
        title: "",
        fallback: "computer_act",
        error: this.forceFallback,
      };
    }
    if (this.navigateError) throw this.navigateError;
    const url = request.url.trim();
    if (!url) {
      return { url: "", title: "", fallback: "computer_act", error: "url is required" };
    }
    const session = this.sessions.get(pageBrowserSessionKey(computer, context));
    const seeded = this.pages[url] ?? this.pages[stripHash(url)];
    if (seeded) {
      const html = seeded.title ? ensureTitle(seeded.html, seeded.title) : seeded.html;
      return session.load(url, html);
    }
    try {
      const { url: finalUrl, body } = await fetchSafeWebText(url, {
        fetch: this.fetchImpl,
        signal: request.signal ?? context.signal,
      });
      return session.load(finalUrl, body);
    } catch (error) {
      return {
        url,
        title: "",
        fallback: "computer_act",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async snapshot(
    computer: ComputerRef,
    _request: BrowserSnapshotRequest,
    context: AdapterContext,
  ): Promise<BrowserSnapshotResult> {
    if (this.forceFallback) {
      return {
        url: "",
        title: "",
        tree: "",
        elements: [],
        fallback: "computer_act",
        error: this.forceFallback,
      };
    }
    if (this.snapshotError) throw this.snapshotError;
    return this.sessions.get(pageBrowserSessionKey(computer, context)).snapshot();
  }

  async act(
    computer: ComputerRef,
    request: BrowserActRequest,
    context: AdapterContext,
  ): Promise<BrowserActResult> {
    if (this.forceFallback) {
      return {
        ok: false,
        completed: 0,
        url: "",
        title: "",
        fallback: "computer_act",
        error: this.forceFallback,
      };
    }
    if (this.actError) throw this.actError;
    if (!request.actions?.length) {
      return {
        ok: false,
        completed: 0,
        url: this.sessions.get(pageBrowserSessionKey(computer, context)).url,
        title: this.sessions.get(pageBrowserSessionKey(computer, context)).title,
        error: "actions is required",
        fallback: "computer_act",
      };
    }
    return this.sessions.get(pageBrowserSessionKey(computer, context)).act(request.actions);
  }
}

function stripHash(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return url;
  }
}

function ensureTitle(html: string, title: string): string {
  if (/<title[\s>]/i.test(html)) {
    return html.replace(/<title[^>]*>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`);
  }
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1><title>${escapeHtml(title)}</title>`);
  }
  return `<!doctype html><html><head><title>${escapeHtml(title)}</title></head><body>${html}</body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
