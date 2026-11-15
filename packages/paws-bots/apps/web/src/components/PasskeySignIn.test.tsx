// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authClient } from "../lib/auth";
import type * as Passkeys from "../lib/passkeys";
import { cancelPasskeyRequest } from "../lib/passkeys";
import { PasskeySignIn } from "./PasskeySignIn";

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
vi.mock("../lib/auth", () => ({ authClient: { signIn: { passkey: vi.fn() } } }));
vi.mock("../lib/passkeys", async (importActual) => ({
  ...(await importActual<typeof Passkeys>()),
  usePasskeysSupported: () => true,
  conditionalPasskeyAvailable: vi.fn(async () => true),
  cancelPasskeyRequest: vi.fn(),
}));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => host.remove());

it("cancels pending autofill when the form goes away", async () => {
  const onSignedIn = vi.fn();
  // Autofill waits until the person picks a passkey, which here never happens.
  vi.mocked(authClient.signIn.passkey).mockReturnValue(new Promise(() => undefined) as never);
  await act(async () =>
    root.render(<PasskeySignIn onSignedIn={onSignedIn} onError={() => undefined} />),
  );
  expect(authClient.signIn.passkey).toHaveBeenCalledWith({ autoFill: true });
  expect(cancelPasskeyRequest).not.toHaveBeenCalled();

  await act(async () => root.unmount());
  expect(cancelPasskeyRequest).toHaveBeenCalledOnce();
  expect(onSignedIn).not.toHaveBeenCalled();
});
