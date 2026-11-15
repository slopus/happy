// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as CallSessionModule from "./call-session";
import { SIGNED_IN_USER_KEY } from "./call-session";
import {
  composerDraftBindingsKey,
  hasUnsentComposerDraft,
  readComposerDraft,
  writeComposerDraft,
} from "./composer-draft";
import { COMPOSER_ENTER_TO_SEND_STORAGE_KEY } from "./composer-enter-to-send-pref";
import { selectedSpaceId, selectSpace } from "./rpc";
import { LOG_OUT_FAILED_KEY, signOut, syncLogOutFailure, useSignOut } from "./sign-out";

const { requestSignOut, endCallBeforeSignOut } = vi.hoisted(() => ({
  requestSignOut: vi.fn(),
  endCallBeforeSignOut: vi.fn(async () => undefined),
}));

vi.mock("@lingui/core/macro", () => ({ t: (parts: TemplateStringsArray) => parts.join("") }));
vi.mock("./auth", () => ({ authClient: { signOut: requestSignOut } }));
vi.mock("./call-session", async (importOriginal) => ({
  ...(await importOriginal<typeof CallSessionModule>()),
  endCallBeforeSignOut,
}));

const location = { assign: vi.fn(), reload: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("location", location);
  requestSignOut.mockResolvedValue({ data: { success: true }, error: null });
  localStorage.setItem(SIGNED_IN_USER_KEY, "user-1");
  selectSpace("space-1");
  writeComposerDraft("bot:bot-1", "unsent thought");
  localStorage.setItem(composerDraftBindingsKey("bot:bot-1"), "{}");
  localStorage.setItem(COMPOSER_ENTER_TO_SEND_STORAGE_KEY, "false");
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

function mountSignOut(destination: string, onError: (message: string) => void = () => undefined) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const controls: { current?: ReturnType<typeof useSignOut> } = {};
  function Harness() {
    controls.current = useSignOut(destination, onError);
    const { signingOut, logOut } = controls.current;
    return <button type="button" disabled={signingOut} onClick={() => void logOut()} />;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<Harness />));
  return {
    container,
    logOut: () => controls.current!.logOut(),
    unmount: () => act(() => root.unmount()),
  };
}

describe("signOut", () => {
  it("ends the call first, then leaves for the destination signed out", async () => {
    await signOut("/sign-in");
    expect(endCallBeforeSignOut.mock.invocationCallOrder[0]).toBeLessThan(
      requestSignOut.mock.invocationCallOrder[0] ?? 0,
    );
    expect(location.assign).toHaveBeenCalledWith("/sign-in");
    expect(location.reload).not.toHaveBeenCalled();
    // Other tabs reload when the signed-in user is cleared.
    expect(localStorage.getItem(SIGNED_IN_USER_KEY)).toBeNull();
    expect(selectedSpaceId()).toBeNull();
  });

  it("leaves no saved draft for whoever uses this browser next", async () => {
    await signOut("/sign-in");
    expect(readComposerDraft("bot:bot-1")).toBe("");
    expect(localStorage.getItem(composerDraftBindingsKey("bot:bot-1"))).toBeNull();
    expect(hasUnsentComposerDraft()).toBe(false);
    expect(localStorage.getItem(COMPOSER_ENTER_TO_SEND_STORAGE_KEY)).toBe("false");
  });

  it.each([
    ["an error result", () => requestSignOut.mockResolvedValue({ error: { status: 500 } })],
    ["a rejected request", () => requestSignOut.mockRejectedValue(new Error("Network"))],
  ])("reloads the page after %s", async (_name, fail) => {
    fail();
    await signOut("/");
    expect(location.reload).toHaveBeenCalledOnce();
    expect(location.assign).not.toHaveBeenCalled();
    expect(localStorage.getItem(SIGNED_IN_USER_KEY)).toBe("user-1");
    expect(readComposerDraft("bot:bot-1")).toBe("unsent thought");
    expect(localStorage.getItem(composerDraftBindingsKey("bot:bot-1"))).toBe("{}");
  });

  it("says the sign-out failed when the reloaded page is still signed in", async () => {
    requestSignOut.mockResolvedValue({ error: { status: 500 } });
    await signOut("/sign-in");
    expect(location.reload).toHaveBeenCalledOnce();
    // The reloaded page resolves its session as still signed in.
    syncLogOutFailure(true);
    expect(sessionStorage.getItem(LOG_OUT_FAILED_KEY)).toBeNull();
    const onError = vi.fn();
    const view = mountSignOut("/sign-in", onError);
    expect(onError).toHaveBeenCalledExactlyOnceWith("Could not log out. Try again.");
    view.unmount();
    // Reported once: a later sign-out control starts clean.
    const later = vi.fn();
    mountSignOut("/sign-in", later).unmount();
    expect(later).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "clears saved drafts after a failed sign-out only when signed out (signedIn=%s)",
    (signedIn) => {
      sessionStorage.setItem(LOG_OUT_FAILED_KEY, "1");
      syncLogOutFailure(signedIn);
      expect(sessionStorage.getItem(LOG_OUT_FAILED_KEY)).toBeNull();
      expect(readComposerDraft("bot:bot-1")).toBe(signedIn ? "unsent thought" : "");
      expect(localStorage.getItem(composerDraftBindingsKey("bot:bot-1"))).toBe(
        signedIn ? "{}" : null,
      );
      expect(hasUnsentComposerDraft()).toBe(signedIn);
      expect(localStorage.getItem(COMPOSER_ENTER_TO_SEND_STORAGE_KEY)).toBe("false");
      // Consume any failure message before the next test.
      mountSignOut("/sign-in").unmount();
    },
  );

  it("says nothing when the reloaded page is signed out", async () => {
    requestSignOut.mockRejectedValue(new Error("Network"));
    await signOut("/sign-in");
    syncLogOutFailure(false);
    expect(sessionStorage.getItem(LOG_OUT_FAILED_KEY)).toBeNull();
    // Signing in again later in this tab must not show a stale failure.
    syncLogOutFailure(true);
    const onError = vi.fn();
    mountSignOut("/sign-in", onError).unmount();
    expect(onError).not.toHaveBeenCalled();
  });
});

it("blocks re-entry and stays busy until the page is left", async () => {
  const view = mountSignOut("/sign-in");
  try {
    await act(async () => {
      await Promise.all([view.logOut(), view.logOut()]);
    });
    expect(requestSignOut).toHaveBeenCalledOnce();
    expect(location.assign).toHaveBeenCalledWith("/sign-in");
    expect(view.container.querySelector("button")?.disabled).toBe(true);
  } finally {
    view.unmount();
  }
});
