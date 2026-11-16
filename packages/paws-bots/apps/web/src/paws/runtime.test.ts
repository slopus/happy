// @vitest-environment jsdom
import { expect, it, vi } from "vitest";

it("does not own host keyboard input while the retained workspace is hidden", async () => {
  vi.stubEnv("PAWS_EMBEDDED", "true");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({
    sessionKey: "s".repeat(43), spaceId: "space-a", accountKey: "keyboard-fixture-account",
    expiresAt: Date.now() + 60_000, locale: "en", appearance: "light",
  })));
  const runtime = await import("./runtime");
  const host = document.createElement("div"); document.body.append(host);
  try {
    await runtime.connect(host, { runtimeUrl: "https://bots.test/", ticket: "t".repeat(43), expiresAt: Date.now() + 60_000, onAuthenticated() {}, onFailure() {} });
    const event = { target: document.body, composedPath: () => [document.body] } as unknown as KeyboardEvent;
    expect(runtime.ownsHostKeyboard(event)).toBe(true);
    host.dataset.pawsActive = "false";
    expect(runtime.ownsHostKeyboard(event)).toBe(false);
    host.dataset.pawsActive = "true";
    expect(runtime.ownsHostKeyboard(event)).toBe(true);
  } finally {
    runtime.disconnect(); host.remove(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  }
});
