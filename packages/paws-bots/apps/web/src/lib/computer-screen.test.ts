import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bootComputerOnce,
  createScreenRefocus,
  embeddableScreenUrl,
  isProxiedScreenUrl,
  loadComputerScreen,
  probeScreen,
  probeScreenStatus,
  sameEmbeddedComputerScreen,
  screenFrameError,
  screenFrameMessage,
  screenFrameStarted,
  screenIframeSandbox,
} from "./computer-screen";

describe("computer screen requests", () => {
  it("shows connection failures and lets a successful retry clear them", async () => {
    const commit = vi.fn();
    const options = {
      isCurrent: () => true,
      commit,
      fallbackError: "Could not connect",
    };
    await loadComputerScreen({
      ...options,
      load: async () => {
        throw new Error("Control stream failed to start");
      },
    });
    expect(commit).toHaveBeenLastCalledWith({
      url: null,
      error: "Control stream failed to start",
    });

    await expect(
      loadComputerScreen({
        ...options,
        load: async () => ({ url: "https://screen.example/vnc.html" }),
      }),
    ).resolves.toBe("https://screen.example/vnc.html");
    expect(commit).toHaveBeenLastCalledWith({
      url: "https://screen.example/vnc.html",
      error: null,
    });
  });

  it.each(["success", "failure"])(
    "ignores a stale %s after a newer screen failure",
    async (outcome) => {
      let finish!: (screen: { url: string | null }) => void;
      let fail!: (error: Error) => void;
      const deferred = new Promise<{ url: string | null }>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
      let current = 1;
      const commit = vi.fn();
      const stale = loadComputerScreen({
        load: () => deferred,
        isCurrent: () => current === 1,
        commit,
        fallbackError: "Could not connect",
      });
      current = 2;
      await loadComputerScreen({
        load: async () => {
          throw new Error("Latest connection failed");
        },
        isCurrent: () => current === 2,
        commit,
        fallbackError: "Could not connect",
      });
      if (outcome === "success") finish({ url: "https://stale.example/vnc.html" });
      else fail(new Error("Stale connection failed"));
      await expect(stale).resolves.toBeNull();
      expect(commit).toHaveBeenCalledExactlyOnceWith({
        url: null,
        error: "Latest connection failed",
      });
    },
  );

  it("uses the visible fallback for errors without a message", async () => {
    const commit = vi.fn();
    await loadComputerScreen({
      load: async () => Promise.reject(null),
      isCurrent: () => true,
      commit,
      fallbackError: "Could not connect",
    });
    expect(commit).toHaveBeenCalledExactlyOnceWith({ url: null, error: "Could not connect" });
  });
});

describe("sameEmbeddedComputerScreen", () => {
  const screen = (code: string, viewOnly = "true", desktop = "ecd-1") =>
    `embedded-screen://desktop?desktop_id=${desktop}&region_id=cn-hangzhou&auth_code=${code}&view_only=${viewOnly}`;

  it("keeps a connected embedded screen when only its login code changes", () => {
    expect(sameEmbeddedComputerScreen(screen("a"), screen("b"))).toBe(true);
    expect(sameEmbeddedComputerScreen(screen("a"), screen("b", "false"))).toBe(false);
    expect(sameEmbeddedComputerScreen(screen("a"), screen("b", "true", "ecd-2"))).toBe(false);
    expect(sameEmbeddedComputerScreen(null, screen("b"))).toBe(false);
    expect(
      sameEmbeddedComputerScreen("http://127.0.0.1:5173/novnc/a", "http://127.0.0.1:5173/novnc/a"),
    ).toBe(false);
  });
});

describe("embedded frame isolation", () => {
  it("sandboxes the vendor page without same-origin access and uses frame state probing", () => {
    vi.stubGlobal("window", { location: { href: "https://app.example/chat" } });
    const url = embeddableScreenUrl(
      "embedded-screen://desktop?auth_code=fake-once&desktop_id=ecd-fake",
    );
    expect(screenIframeSandbox(url)).toBe("allow-scripts allow-pointer-lock");
    expect(isProxiedScreenUrl(url)).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe("embeddableScreenUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hides a local screen whose port does not match the page", () => {
    vi.stubGlobal("window", { location: { href: "http://localhost:5173/" } });
    expect(embeddableScreenUrl("http://127.0.0.1:6080/vnc.html")).toBeNull();
    expect(embeddableScreenUrl("http://localhost:6080/vnc.html")).toBeNull();
  });

  it("draws an embedded desktop in the page that carries its Web SDK", () => {
    vi.stubGlobal("window", { location: { href: "http://localhost:5173/chat" } });
    expect(
      embeddableScreenUrl(
        "embedded-screen://desktop?desktop_id=ecd-1&auth_code=once&view_only=true",
      ),
    ).toBe(
      "http://localhost:5173/computer-screen/screen.html#desktop_id=ecd-1&auth_code=once&view_only=true",
    );
  });

  it("serves the screen proxy from the page origin", () => {
    vi.stubGlobal("window", { location: { href: "http://localhost:5173/chat" } });
    expect(embeddableScreenUrl("http://127.0.0.1:5173/novnc/session/view/1.x/vnc.html?a=1")).toBe(
      "http://localhost:5173/novnc/session/view/1.x/vnc.html?a=1",
    );
  });

  it("keeps a non-local screen even when the port differs", () => {
    vi.stubGlobal("window", { location: { href: "http://localhost:5173/" } });
    expect(embeddableScreenUrl("https://screen.example:6080/vnc.html")).toBe(
      "https://screen.example:6080/vnc.html",
    );
  });
});

describe("screenIframeSandbox", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("allows scripts and pointer lock only for /novnc/ paths", () => {
    vi.stubGlobal("window", { location: { href: "http://localhost:5173/" } });
    expect(screenIframeSandbox("http://127.0.0.1:5173/novnc/vnc.html")).toBe(
      "allow-scripts allow-pointer-lock",
    );
    expect(screenIframeSandbox("http://127.0.0.1:5173/vnc.html")).toBeUndefined();
  });
});

function pendingBoot() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("computer boot ownership", () => {
  it("starts B independently and refuses a second A after switching A to B to A", async () => {
    const inFlight = new Map<string, symbol>();
    const a = pendingBoot();
    const b = pendingBoot();
    const duplicate = vi.fn();
    const first = bootComputerOnce(inFlight, "a", () => a.promise);
    const second = bootComputerOnce(inFlight, "b", () => b.promise);
    await bootComputerOnce(inFlight, "a", duplicate);
    expect(duplicate).not.toHaveBeenCalled();
    b.resolve();
    await second;
    expect(inFlight.has("a")).toBe(true);
    a.resolve();
    await first;
    await bootComputerOnce(inFlight, "a", duplicate);
    expect(duplicate).toHaveBeenCalledOnce();
    expect(inFlight.size).toBe(0);
  });

  it("lets takeover proceed while a boot request is in flight", async () => {
    const inFlight = new Map<string, symbol>();
    const boot = pendingBoot();
    const first = bootComputerOnce(inFlight, "a", () => boot.promise);
    const duplicateBoot = vi.fn();
    const takeover = vi.fn();
    await bootComputerOnce(inFlight, "a", duplicateBoot);
    await takeover();
    expect(duplicateBoot).not.toHaveBeenCalled();
    expect(takeover).toHaveBeenCalledOnce();
    expect(inFlight.has("a")).toBe(true);
    boot.resolve();
    await first;
  });

  it("allows a retry after failure", async () => {
    const inFlight = new Map<string, symbol>();
    const a = pendingBoot();
    const first = bootComputerOnce(inFlight, "a", () => a.promise);
    const rejected = expect(first).rejects.toThrow("Boot failed");
    a.reject(new Error("Boot failed"));
    await rejected;
    const retry = vi.fn();
    await bootComputerOnce(inFlight, "a", retry);
    expect(retry).toHaveBeenCalledOnce();
  });

  it("does not release a replacement owner's marker when an older request finishes", async () => {
    const inFlight = new Map<string, symbol>();
    const a = pendingBoot();
    const first = bootComputerOnce(inFlight, "a", () => a.promise);
    const replacement = Symbol("replacement");
    inFlight.set("a", replacement);
    a.resolve();
    await first;
    expect(inFlight.get("a")).toBe(replacement);
  });
});

describe("screen frame reports", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts only known states and bounds the detail", () => {
    expect(screenFrameMessage({ rakazoScreen: "connected" })).toEqual({
      rakazoScreen: "connected",
    });
    expect(screenFrameMessage({ rakazoScreen: "failed", detail: "  Failed to connect  " })).toEqual(
      { rakazoScreen: "failed", detail: "Failed to connect" },
    );
    expect(
      screenFrameMessage({ rakazoScreen: "failed", detail: "x".repeat(300) })?.detail,
    ).toHaveLength(200);
    expect(screenFrameMessage({ rakazoScreen: "failed", detail: 5 })).toEqual({
      rakazoScreen: "failed",
    });
    expect(screenFrameMessage({ rakazoScreen: "exploded" })).toBeNull();
    expect(screenFrameMessage("connected")).toBeNull();
    expect(screenFrameMessage(null)).toBeNull();
  });

  it("counts only reports past loading as a started page", () => {
    expect(screenFrameStarted({ rakazoScreen: "loading" })).toBe(false);
    expect(screenFrameStarted({ rakazoScreen: "connecting" })).toBe(true);
    expect(screenFrameStarted({ rakazoScreen: "connected" })).toBe(true);
    expect(screenFrameStarted({ rakazoScreen: "failed" })).toBe(true);
  });

  it("turns failures into the error to show and keeps progress silent", () => {
    expect(screenFrameError({ rakazoScreen: "loading" }, "fallback")).toBeNull();
    expect(screenFrameError({ rakazoScreen: "connecting" }, "fallback")).toBeNull();
    expect(screenFrameError({ rakazoScreen: "connected" }, "fallback")).toBeNull();
    expect(screenFrameError({ rakazoScreen: "failed", detail: "Refused" }, "fallback")).toBe(
      "fallback",
    );
    expect(screenFrameError({ rakazoScreen: "failed" }, "fallback")).toBe("fallback");
    expect(screenFrameError({ rakazoScreen: "disconnected" }, "fallback")).toBe(
      "The screen connection closed.",
    );
  });

  it("only treats the proxy's own pages as reporting frames", () => {
    vi.stubGlobal("window", { location: { href: "http://localhost:5173/" } });
    expect(isProxiedScreenUrl("http://127.0.0.1:5173/novnc/session/view/1.t/vnc.html")).toBe(true);
    expect(isProxiedScreenUrl("https://screen.example/vnc.html")).toBe(false);
    expect(isProxiedScreenUrl(null)).toBe(false);
  });
});

describe("probeScreen", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const url = "http://127.0.0.1:5173/novnc/session/view/1.t/vnc.html";
  const response = (status: number, body = "", type = "basic") =>
    ({ ok: status >= 200 && status < 300, status, type, text: async () => body }) as Response;

  it("is silent for a page the proxy serves", async () => {
    const fetchImpl = vi.fn(async () => response(200, "<html>"));
    await expect(probeScreen(url, "fallback", fetchImpl)).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledWith(url, {
      credentials: "omit",
      cache: "no-store",
      redirect: "manual",
    });
  });

  it("reports the proxy's reason for a refused or failed page", async () => {
    await expect(
      probeScreen(url, "fallback", async () =>
        response(403, "Invalid or expired screen capability"),
      ),
    ).resolves.toBe("The screen link expired.");
    await expect(
      probeScreen(url, "fallback", async () =>
        response(502, "Screen unavailable (upstream_timeout)"),
      ),
    ).resolves.toBe("The screen did not respond.");
  });

  it("reads an access check that couldn't reach the API as a connection problem", async () => {
    await expect(
      probeScreen(url, "fallback", async () => response(503, "Screen unavailable")),
    ).resolves.toBe("fallback");
    await expect(probeScreen(url, "fallback", async () => response(503))).resolves.toBe("fallback");
  });

  it("never shows untrusted plain text", async () => {
    await expect(
      probeScreen(url, "fallback", async () => response(500, "private token")),
    ).resolves.toBe("fallback");
  });

  it("never shows an upstream HTML error page as the reason", async () => {
    await expect(
      probeScreen(url, "fallback", async () =>
        response(502, "<!DOCTYPE html><html><body><h1>Bad gateway</h1></body></html>"),
      ),
    ).resolves.toBe("fallback");
    const html = {
      ...response(500, "Bad gateway"),
      headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
    } as Response;
    await expect(probeScreen(url, "fallback", async () => html)).resolves.toBe("fallback");
  });

  it("falls back when the page cannot be fetched or would leave the app", async () => {
    await expect(
      probeScreen(url, "fallback", async () => {
        throw new TypeError("Failed to fetch");
      }),
    ).resolves.toBe("fallback");
    await expect(
      probeScreen(url, "fallback", async () => response(0, "", "opaqueredirect")),
    ).resolves.toBe("fallback");
  });

  it("sends the session cookie only for a same-origin http(s) screen", async () => {
    vi.stubGlobal("window", { location: { href: "http://127.0.0.1:5173/chat" } });
    const sameOrigin = vi.fn(async () => response(200, "<html>"));
    await expect(probeScreen(url, "fallback", sameOrigin)).resolves.toBeNull();
    expect(sameOrigin).toHaveBeenCalledWith(url, {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "manual",
    });

    const relative = vi.fn(async () => response(200, "<html>"));
    await probeScreen("/novnc/session/view/1.t/vnc.html", "fallback", relative);
    expect(relative).toHaveBeenCalledWith(
      "/novnc/session/view/1.t/vnc.html",
      expect.objectContaining({ credentials: "same-origin" }),
    );

    const crossOrigin = vi.fn(async () => response(200, "<html>"));
    await probeScreen("https://screen.example/vnc.html", "fallback", crossOrigin);
    expect(crossOrigin).toHaveBeenCalledWith(
      "https://screen.example/vnc.html",
      expect.objectContaining({ credentials: "omit" }),
    );

    const otherPort = vi.fn(async () => response(200, "<html>"));
    await probeScreen("http://127.0.0.1:6080/novnc/vnc.html", "fallback", otherPort);
    expect(otherPort).toHaveBeenCalledWith(
      "http://127.0.0.1:6080/novnc/vnc.html",
      expect.objectContaining({ credentials: "omit" }),
    );
  });

  it("keeps cookies off non-http screen schemes, including an embedded login URL", async () => {
    vi.stubGlobal("window", { location: { href: "https://app.example/chat" } });
    const embeddedScreen = vi.fn(async () => response(200));
    await probeScreen(
      "embedded-screen://desktop?desktop_id=ecd-1&auth_code=once",
      "fallback",
      embeddedScreen,
    );
    expect(embeddedScreen).toHaveBeenCalledWith(
      "embedded-screen://desktop?desktop_id=ecd-1&auth_code=once",
      expect.objectContaining({ credentials: "omit" }),
    );
    const otherScheme = vi.fn(async () => response(200));
    await probeScreen("crypto:screen", "fallback", otherScheme);
    expect(otherScheme).toHaveBeenCalledWith(
      "crypto:screen",
      expect.objectContaining({ credentials: "omit" }),
    );

    const page = vi.fn(async () => response(200, "<html>"));
    const screenPage =
      "https://app.example/computer-screen/screen.html#desktop_id=ecd-1&auth_code=once";
    await expect(probeScreen(screenPage, "fallback", page)).resolves.toBeNull();
    expect(page).toHaveBeenCalledWith(
      screenPage,
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("still treats an opaque redirect as leaving the app when the cookie was sent", async () => {
    vi.stubGlobal("window", { location: { href: "http://127.0.0.1:5173/chat" } });
    const fetchImpl = vi.fn(async () => response(0, "", "opaqueredirect"));
    await expect(probeScreen(url, "fallback", fetchImpl)).resolves.toBe("fallback");
    expect(fetchImpl).toHaveBeenCalledWith(
      url,
      expect.objectContaining({ credentials: "same-origin", redirect: "manual" }),
    );
  });
});

describe("probeScreenStatus", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const url = "http://127.0.0.1:5173/novnc/session/control/1.t/vnc.html";

  it("returns only the status and drops the body unread", async () => {
    const cancel = vi.fn(async () => undefined);
    const text = vi.fn(async () => "Invalid or expired screen capability");
    const fetchImpl = vi.fn(
      async () => ({ status: 403, type: "basic", body: { cancel }, text }) as unknown as Response,
    );
    await expect(probeScreenStatus(url, fetchImpl)).resolves.toBe(403);
    expect(text).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledWith(url, {
      credentials: "omit",
      cache: "no-store",
      redirect: "manual",
    });
  });

  it("gives the request the wait's abort signal, so a stalled probe can be dropped", async () => {
    const stop = new AbortController();
    const fetchImpl = vi.fn(async () => ({ status: 204, type: "basic" }) as unknown as Response);
    await probeScreenStatus(url, fetchImpl, stop.signal);
    expect(fetchImpl).toHaveBeenCalledWith(url, expect.objectContaining({ signal: stop.signal }));
  });

  it("says when the page couldn't be asked or would leave the app", async () => {
    await expect(
      probeScreenStatus(url, async () => {
        throw new TypeError("Failed to fetch");
      }),
    ).resolves.toBeNull();
    await expect(
      probeScreenStatus(url, async () => ({ status: 0, type: "opaqueredirect" }) as Response),
    ).resolves.toBe(0);
  });

  it("includes the session cookie for a same-origin probe and withholds it elsewhere", async () => {
    vi.stubGlobal("window", { location: { href: "http://127.0.0.1:5173/chat" } });
    const sameOrigin = vi.fn(async () => ({ status: 204, type: "basic" }) as Response);
    await expect(probeScreenStatus(url, sameOrigin)).resolves.toBe(204);
    expect(sameOrigin).toHaveBeenCalledWith(url, {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "manual",
      signal: undefined,
    });
    const crossOrigin = vi.fn(async () => ({ status: 204, type: "basic" }) as Response);
    await probeScreenStatus("https://screen.example/novnc/x", crossOrigin);
    expect(crossOrigin).toHaveBeenCalledWith(
      "https://screen.example/novnc/x",
      expect.objectContaining({ credentials: "omit" }),
    );
    const embeddedScreen = vi.fn(async () => ({ status: 204, type: "basic" }) as Response);
    await probeScreenStatus("embedded-screen://desktop?auth_code=once", embeddedScreen);
    expect(embeddedScreen).toHaveBeenCalledWith(
      "embedded-screen://desktop?auth_code=once",
      expect.objectContaining({ credentials: "omit" }),
    );
  });
});

describe("giving a reconnected screen the keyboard back", () => {
  const frame = { name: "frame" } as unknown as Element;
  const body = { name: "body" } as unknown as Element;
  const chatBox = { name: "chat box" } as unknown as Element;

  it("refocuses once, when the screen had the keyboard and nothing else took it", () => {
    const refocus = createScreenRefocus();
    refocus.dropped(true);
    expect(refocus.connected(body, frame, body)).toBe(true);
    expect(refocus.connected(body, frame, body)).toBe(false);
    refocus.dropped(true);
    expect(refocus.connected(null, frame, body)).toBe(true);
  });

  it("leaves the keyboard where the user put it during the wait", () => {
    const refocus = createScreenRefocus();
    refocus.dropped(true);
    expect(refocus.connected(chatBox, frame, body)).toBe(false);
    refocus.dropped(true);
    refocus.forget();
    expect(refocus.connected(body, frame, body)).toBe(false);
  });

  it("doesn't refocus a screen that didn't have the keyboard, or that a page says connected", () => {
    const refocus = createScreenRefocus();
    expect(refocus.connected(body, frame, body)).toBe(false);
    refocus.dropped(false);
    expect(refocus.connected(body, frame, body)).toBe(false);
  });
});
