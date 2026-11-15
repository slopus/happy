// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authClient } from "../lib/auth";
import type * as Passkeys from "../lib/passkeys";
import { PasskeySettings } from "./PasskeySettings";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => {
  const Plain = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    AlertDialog: Plain,
    AlertDialogAction: Plain,
    AlertDialogCancel: Plain,
    AlertDialogContent: Plain,
    AlertDialogDescription: Plain,
    AlertDialogFooter: Plain,
    AlertDialogHeader: Plain,
    AlertDialogTitle: Plain,
  };
});
vi.mock("../lib/auth", () => ({
  authClient: {
    passkey: {
      listUserPasskeys: vi.fn(),
      addPasskey: vi.fn(),
      updatePasskey: vi.fn(),
      deletePasskey: vi.fn(),
    },
  },
}));
vi.mock("../lib/passkeys", async (importActual) => ({
  ...(await importActual<typeof Passkeys>()),
  usePasskeysSupported: () => true,
}));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

function buttonNamed(label: string) {
  return [...host.querySelectorAll("button")].find((button) => button.textContent === label);
}

it("reports a failed load with a retry instead of an empty list", async () => {
  vi.mocked(authClient.passkey.listUserPasskeys)
    .mockResolvedValueOnce({ data: null, error: { status: 500 } } as never)
    .mockResolvedValueOnce({
      data: [{ id: "passkey-1", name: "Laptop", createdAt: new Date().toISOString() }],
      error: null,
    } as never);
  await act(async () => root.render(<PasskeySettings />));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not load");

  await act(async () => buttonNamed("Retry")?.click());
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.querySelector("li")?.textContent).toContain("Laptop");
});

it("reloads after adding a passkey", async () => {
  vi.mocked(authClient.passkey.listUserPasskeys)
    .mockResolvedValueOnce({ data: [], error: null } as never)
    .mockResolvedValueOnce({
      data: [{ id: "passkey-1", name: null, createdAt: new Date().toISOString() }],
      error: null,
    } as never);
  vi.mocked(authClient.passkey.addPasskey).mockResolvedValue({
    data: { id: "passkey-1" },
    error: null,
  } as never);
  await act(async () => root.render(<PasskeySettings />));
  expect(host.querySelectorAll("li")).toHaveLength(0);
  await act(async () => buttonNamed("Add passkey")?.click());
  expect(host.querySelectorAll("li")).toHaveLength(1);
});

it.each([{ isComposing: true }, { keyCode: 229 }])(
  "keeps a passkey rename open on the Escape that ends an IME composition (%o)",
  async (composition) => {
    vi.mocked(authClient.passkey.listUserPasskeys).mockResolvedValue({
      data: [{ id: "passkey-1", name: "Laptop", createdAt: new Date().toISOString() }],
      error: null,
    } as never);
    await act(async () => root.render(<PasskeySettings />));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Rename"]')?.click());
    const pressEscape = (init: KeyboardEventInit) =>
      act(async () => {
        host
          .querySelector("input")
          ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, ...init }));
      });
    const onWindowKey = vi.fn();
    window.addEventListener("keydown", onWindowKey);
    await pressEscape(composition);
    window.removeEventListener("keydown", onWindowKey);
    expect(host.querySelector("input")?.value).toBe("Laptop");
    // A composing Escape must not reach page-level Escape listeners such as the reply chip.
    expect(onWindowKey).not.toHaveBeenCalled();
    await pressEscape({});
    expect(host.querySelector("input")).toBeNull();
  },
);
