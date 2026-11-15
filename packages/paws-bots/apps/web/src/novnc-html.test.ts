import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  collectNovncHtml,
  injectNovncStorageShim,
  isNovncExtensionError,
  isNovncPage,
  MAX_NOVNC_HTML_BYTES,
  NOVNC_EXTENSION_ERROR,
  novncPageRequestHeaders,
  rewrittenNovncHeaders,
  shouldInjectNovncStorageShim,
} from "./novnc-html.js";

const html = { "content-type": "text/html; charset=utf-8" };

describe("noVNC storage shim gate", () => {
  it("matches noVNC pages on any provider path", () => {
    expect(isNovncPage("/vnc.html")).toBe(true);
    expect(isNovncPage("/vnc_lite.html?autoconnect=true")).toBe(true);
    expect(isNovncPage("/proxy/6080/embed.html")).toBe(true);
    expect(isNovncPage("/core/rfb.js")).toBe(false);
    expect(isNovncPage("/index.html")).toBe(false);
    expect(isNovncPage("/websockify")).toBe(false);
  });

  it("injects into noVNC HTML", () => {
    expect(shouldInjectNovncStorageShim(html, "/vnc.html")).toBe(true);
    expect(
      shouldInjectNovncStorageShim({ "content-type": "application/xhtml+xml" }, "/vnc.html"),
    ).toBe(true);
  });

  it("skips non-HTML responses", () => {
    expect(shouldInjectNovncStorageShim({ "content-type": "text/javascript" }, "/vnc.html")).toBe(
      false,
    );
    expect(shouldInjectNovncStorageShim({}, "/vnc.html")).toBe(false);
  });

  it("skips HTML that is not a noVNC page", () => {
    expect(shouldInjectNovncStorageShim(html, "/index.html")).toBe(false);
  });

  it("injects into HTML marked identity encoded", () => {
    expect(
      shouldInjectNovncStorageShim({ ...html, "content-encoding": "identity" }, "/vnc.html"),
    ).toBe(true);
  });

  it("skips compressed HTML it cannot rewrite", () => {
    expect(shouldInjectNovncStorageShim({ ...html, "content-encoding": "gzip" }, "/vnc.html")).toBe(
      false,
    );
  });

  it("puts the shim before the first script", () => {
    const headed = injectNovncStorageShim("<html><head><title>x</title>");
    expect(headed).toMatch(/^<html><head><style>[^<]*<\/style><script>/);
    expect(headed.indexOf("localStorage")).toBeLessThan(headed.indexOf("<title>"));
    const bare = injectNovncStorageShim('<!doctype html><script src="app.js"></script>');
    expect(bare.indexOf("localStorage")).toBeLessThan(bare.indexOf('src="app.js"'));
  });

  it("hides noVNC's status bar, and its side panel while the screen is view only", () => {
    const view = injectNovncStorageShim("<head>", { viewOnly: true });
    const control = injectNovncStorageShim("<head>");
    expect(view).toContain("#noVNC_status{display:none!important}");
    expect(view).toContain("#noVNC_control_bar_anchor{display:none!important}");
    expect(control).toContain("#noVNC_status{display:none!important}");
    expect(control).not.toContain("noVNC_control_bar_anchor");
  });

  function runShim() {
    const script = injectNovncStorageShim("<head>").match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
    const listeners: ((event: unknown) => void)[] = [];
    const window = {
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        if (type === "error") listeners.push(listener);
      },
      parent: { postMessage() {} },
    } as unknown as { localStorage: Storage; sessionStorage: Storage };
    const document = {
      documentElement: { classList: { contains: () => false }, getAttribute: () => null },
      readyState: "loading",
      getElementById: () => null,
      querySelector: () => null,
      addEventListener() {},
    };
    new Function("window", "document", script)(window, document);
    return { window, listeners };
  }

  it("hides WebCodecs from the page so noVNC's H.264 probe cannot stall startup", () => {
    const script = injectNovncStorageShim("<head>").match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
    const window: Record<string, unknown> = {
      addEventListener() {},
      parent: { postMessage() {} },
    };
    Object.defineProperty(window, "VideoDecoder", { configurable: true, value: class {} });
    const document = {
      documentElement: { classList: { contains: () => false }, getAttribute: () => null },
      readyState: "loading",
      getElementById: () => null,
      querySelector: () => null,
      addEventListener() {},
    };
    new Function("window", "document", script)(window, document);
    expect("VideoDecoder" in window).toBe(false);
  });

  it("keeps values for the life of the page in both storages", () => {
    const { window } = runShim();
    for (const storage of [window.localStorage, window.sessionStorage]) {
      storage.setItem("setting", "value");
      expect(storage.getItem("setting")).toBe("value");
      storage.removeItem("setting");
      expect(storage.getItem("setting")).toBeNull();
      storage.setItem("other", 1 as unknown as string);
      storage.clear();
      expect(storage.getItem("other")).toBeNull();
    }
    window.localStorage.setItem("only", "local");
    expect(window.sessionStorage.getItem("only")).toBeNull();
  });

  it("keeps extension script errors away from noVNC's error page", () => {
    const { listeners } = runShim();
    expect(listeners).toHaveLength(1);
    const stopped = (filename: string) => {
      let stop = false;
      listeners[0]?.({ filename, stopImmediatePropagation: () => (stop = true) });
      return stop;
    };
    expect(stopped("chrome-extension://abc/content.js")).toBe(true);
    expect(stopped("moz-extension://abc/content.js")).toBe(true);
    expect(stopped("https://screen.example/core/rfb.js")).toBe(false);
    expect(stopped("")).toBe(false);
    expect(injectNovncStorageShim("<head>")).toContain(NOVNC_EXTENSION_ERROR.source);
  });

  it("treats extension URLs as frame errors and leaves page errors alone", () => {
    expect(isNovncExtensionError("chrome-extension://abc")).toBe(true);
    expect(isNovncExtensionError("moz-extension://abc")).toBe(true);
    expect(isNovncExtensionError("")).toBe(false);
    expect(isNovncExtensionError("https://screens.example/vnc.html")).toBe(false);
  });
});

describe("noVNC page caching", () => {
  it("drops validators so the upstream sends the full page", () => {
    expect(
      novncPageRequestHeaders({
        accept: "text/html",
        "accept-encoding": "gzip, br",
        "if-modified-since": "Wed, 21 Oct 2026 01:05:20 GMT",
        "if-none-match": '"abc"',
      }),
    ).toEqual({ accept: "text/html", "accept-encoding": "identity" });
  });

  it("marks the rewritten page as never stored", () => {
    expect(
      rewrittenNovncHeaders({
        ...html,
        "content-length": "10",
        etag: '"abc"',
        "last-modified": "Wed, 21 Oct 2026 01:05:20 GMT",
        expires: "Thu, 22 Oct 2026 01:05:20 GMT",
        "cache-control": "max-age=3600",
      }),
    ).toEqual({ ...html, "cache-control": "no-store, no-transform" });
  });
});

describe("noVNC HTML read", () => {
  it("returns a document that ends", async () => {
    const html = await collectNovncHtml(Readable.from([Buffer.from("<html></html>")]), 1024);
    expect(html).toBe("<html></html>");
  });

  it("rejects a document over the size cap", async () => {
    const stream = Readable.from([Buffer.alloc(MAX_NOVNC_HTML_BYTES + 1)]);
    await expect(collectNovncHtml(stream, MAX_NOVNC_HTML_BYTES)).rejects.toThrow(/exceeds/);
  });

  it("rejects an upstream abort that never ends", async () => {
    const stream = new Readable({ read() {} });
    const pending = collectNovncHtml(stream, 1024);
    stream.emit("aborted");
    await expect(pending).rejects.toThrow(/aborted/);
  });

  it("rejects an upstream close that never ends", async () => {
    const stream = new Readable({ read() {} });
    const pending = collectNovncHtml(stream, 1024);
    stream.emit("close");
    await expect(pending).rejects.toThrow(/closed/);
  });
});

describe("noVNC frame state report", () => {
  function page(
    options: {
      readyState?: string;
      canvas?: boolean;
      statusBar?: boolean;
      nativeApp?: boolean;
    } = {},
  ) {
    const posted: unknown[] = [];
    const nativePosted: unknown[] = [];
    const canvas = {
      focused: 0,
      focus() {
        this.focused += 1;
      },
    };
    const windowListeners: Record<string, (event: unknown) => void> = {};
    const classes = new Set<string>();
    const statusClasses = new Set<string>();
    const attributes = new Map<string, string>();
    let observer: (() => void) | undefined;
    const status = {
      classList: { contains: (name: string) => statusClasses.has(name) },
      textContent: "",
    };
    const root = {
      classList: { contains: (name: string) => classes.has(name) },
      getAttribute: (name: string) => attributes.get(name) ?? null,
    };
    const listeners: Record<string, () => void> = {};
    const document = {
      documentElement: root,
      readyState: options.readyState ?? "complete",
      getElementById: (id: string) =>
        id === "noVNC_status" && options.statusBar !== false ? status : null,
      querySelector: (selector: string) =>
        selector.split(", ")[0] === "#screen canvas" && options.canvas ? canvas : null,
      addEventListener: (type: string, listener: () => void) => {
        listeners[type] = listener;
      },
    };
    const window = {
      parent: { postMessage: (data: unknown) => posted.push(data) },
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        windowListeners[type] = listener;
      },
      ...(options.nativeApp
        ? { ReactNativeWebView: { postMessage: (data: unknown) => nativePosted.push(data) } }
        : {}),
    };
    class MutationObserver {
      constructor(callback: () => void) {
        observer = callback;
      }
      observe() {}
    }
    const script = injectNovncStorageShim("<head>").match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
    new Function("window", "document", "MutationObserver", "Object", script)(
      window,
      document,
      MutationObserver,
      Object,
    );
    return {
      posted,
      nativePosted,
      canvas,
      parent: window.parent,
      windowListeners,
      classes,
      statusClasses,
      attributes,
      status,
      listeners,
      mutate: () => observer?.(),
    };
  }

  it("posts loading at once, then follows noVNC's connection classes", () => {
    const p = page();
    expect(p.posted).toEqual([{ rakazoScreen: "loading" }]);
    p.classes.add("noVNC_connecting");
    p.mutate();
    p.mutate();
    p.classes.delete("noVNC_connecting");
    p.classes.add("noVNC_connected");
    p.mutate();
    p.classes.clear();
    p.mutate();
    expect(p.posted).toEqual([
      { rakazoScreen: "loading" },
      { rakazoScreen: "connecting" },
      { rakazoScreen: "connected" },
      { rakazoScreen: "disconnected" },
    ]);
  });

  it("tells the mobile app's WebView only the state word, never the page's text", () => {
    const p = page({ nativeApp: true });
    p.classes.add("noVNC_connected");
    p.mutate();
    p.classes.clear();
    p.statusClasses.add("noVNC_open");
    p.statusClasses.add("noVNC_status_error");
    p.status.textContent = "Failed to connect to wss://screen.example/websockify?token=secret";
    p.mutate();
    expect(p.nativePosted).toEqual([
      '{"rakazoScreen":"loading"}',
      '{"rakazoScreen":"connected"}',
      '{"rakazoScreen":"failed"}',
    ]);
    expect(page().nativePosted).toEqual([]);
  });

  it("gives the screen the keyboard back only when the app itself asks", () => {
    const p = page({ canvas: true });
    const message = p.windowListeners.message!;
    message({ source: {}, data: { rakazoScreenFocus: true } });
    message({ source: p.parent, data: { rakazoScreenFocus: "yes" } });
    message({ source: p.parent, data: null });
    message({ source: p.parent, data: { rakazoScreenFocus: true, extra: "x" } });
    expect(p.canvas.focused).toBe(0);
    message({ source: p.parent, data: { rakazoScreenFocus: true } });
    expect(p.canvas.focused).toBe(1);
  });

  it("reports noVNC's status bar error with its text", () => {
    const p = page();
    p.classes.add("noVNC_connecting");
    p.mutate();
    p.classes.clear();
    p.statusClasses.add("noVNC_open");
    p.statusClasses.add("noVNC_status_error");
    p.status.textContent = "Failed to connect to server";
    p.mutate();
    expect(p.posted.at(-1)).toEqual({
      rakazoScreen: "failed",
      detail: "Failed to connect to server",
    });
  });

  it("reports the embed page's failure attribute, with or without a reason", () => {
    const p = page();
    p.attributes.set("data-rakazo-screen-error", "");
    p.mutate();
    expect(p.posted.at(-1)).toEqual({ rakazoScreen: "failed" });
    const reasoned = page();
    reasoned.attributes.set("data-rakazo-screen-error", "Authentication failure");
    reasoned.mutate();
    expect(reasoned.posted.at(-1)).toEqual({
      rakazoScreen: "failed",
      detail: "Authentication failure",
    });
  });

  it("reports an empty embed failure without a status bar", () => {
    const p = page({ canvas: true, statusBar: false });
    expect(p.posted.at(-1)).toEqual({ rakazoScreen: "connecting" });
    p.attributes.set("data-rakazo-screen-error", "");
    p.mutate();
    expect(p.posted.at(-1)).toEqual({ rakazoScreen: "failed" });
  });

  it("treats a Rakazo embed page that built its viewer as connecting", () => {
    const p = page({ canvas: true });
    p.mutate();
    expect(p.posted).toEqual([{ rakazoScreen: "loading" }, { rakazoScreen: "connecting" }]);
  });

  it("stays quiet about a page that has not started connecting", () => {
    const p = page({ readyState: "loading" });
    expect(p.posted).toEqual([{ rakazoScreen: "loading" }]);
    p.listeners.DOMContentLoaded?.();
    p.mutate();
    expect(p.posted).toEqual([{ rakazoScreen: "loading" }]);
  });
});
