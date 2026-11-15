// @vitest-environment jsdom
import { passkeyOfferDismissedKey } from "@rakazo/core";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authClient } from "../lib/auth";
import type * as Passkeys from "../lib/passkeys";
import { passkeysChanged, usePasskeysSupported } from "../lib/passkeys";
import { PasskeyOffer } from "./PasskeyOffer";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
}));
vi.mock("../lib/auth", () => ({
  authClient: {
    useSession: vi.fn(),
    passkey: { listUserPasskeys: vi.fn(), addPasskey: vi.fn() },
  },
}));
vi.mock("../lib/passkeys", async (importActual) => ({
  ...(await importActual<typeof Passkeys>()),
  usePasskeysSupported: vi.fn(),
}));

const created = new Date("2026-10-21T10:00:00Z");
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function signedIn(sessionCreatedAt: Date) {
  vi.mocked(authClient.useSession).mockReturnValue({
    data: {
      user: { id: "user-1", createdAt: created },
      session: { createdAt: sessionCreatedAt },
    },
  } as unknown as ReturnType<typeof authClient.useSession>);
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  vi.mocked(usePasskeysSupported).mockReturnValue(true);
  signedIn(new Date(created.getTime() + 1_000));
  vi.mocked(authClient.passkey.listUserPasskeys).mockResolvedValue({
    data: [],
    error: null,
  } as never);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function render() {
  await act(async () => root.render(<PasskeyOffer />));
}

function offer() {
  return host.querySelector('[data-testid="passkey-offer"]');
}

it("offers a passkey on a new account's first session", async () => {
  await render();
  expect(offer()?.textContent).toContain("Add a passkey for faster sign-in?");
});

it("stays hidden when the browser cannot use passkeys", async () => {
  vi.mocked(usePasskeysSupported).mockReturnValue(false);
  await render();
  expect(offer()).toBeNull();
  expect(authClient.passkey.listUserPasskeys).not.toHaveBeenCalled();
});

it("stays hidden for later sessions without asking for passkeys", async () => {
  signedIn(new Date(created.getTime() + 2 * 60 * 60_000));
  await render();
  expect(offer()).toBeNull();
  expect(authClient.passkey.listUserPasskeys).not.toHaveBeenCalled();
});

it("stays hidden once the account has a passkey", async () => {
  vi.mocked(authClient.passkey.listUserPasskeys).mockResolvedValue({
    data: [{ id: "passkey-1" }],
    error: null,
  } as never);
  await render();
  expect(offer()).toBeNull();
});

it("remembers a dismissal", async () => {
  await render();
  const dismiss = host.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]');
  await act(async () => dismiss?.click());
  expect(offer()).toBeNull();
  expect(window.localStorage.getItem(passkeyOfferDismissedKey("user-1"))).not.toBeNull();

  await act(async () => root.unmount());
  root = createRoot(host);
  await render();
  expect(offer()).toBeNull();
});

it("closes for good after adding a passkey", async () => {
  vi.mocked(authClient.passkey.addPasskey).mockResolvedValue({
    data: { id: "passkey-1" },
    error: null,
  } as never);
  await render();
  const add = Array.from(host.querySelectorAll("button")).find(
    (button) => button.textContent === "Add passkey",
  );
  await act(async () => add?.click());
  expect(authClient.passkey.addPasskey).toHaveBeenCalled();
  expect(offer()).toBeNull();
  expect(window.localStorage.getItem(passkeyOfferDismissedKey("user-1"))).not.toBeNull();
});

it("keeps the offer without an error when the user closes the dialog", async () => {
  vi.mocked(authClient.passkey.addPasskey).mockResolvedValue({
    data: null,
    error: { code: "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY", message: "NotAllowedError" },
  } as never);
  await render();
  const add = Array.from(host.querySelectorAll("button")).find(
    (button) => button.textContent === "Add passkey",
  );
  await act(async () => add?.click());
  expect(offer()).not.toBeNull();
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("closes when a passkey is added elsewhere on the page", async () => {
  await render();
  expect(offer()).not.toBeNull();
  vi.mocked(authClient.passkey.listUserPasskeys).mockResolvedValue({
    data: [{ id: "passkey-1" }],
    error: null,
  } as never);
  await act(async () => passkeysChanged());
  expect(offer()).toBeNull();
});
