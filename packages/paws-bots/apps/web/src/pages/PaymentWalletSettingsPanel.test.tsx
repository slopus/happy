// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const paymentWallet = vi.hoisted(() => ({
  status: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
}));
const api = vi.hoisted(() => ({ paymentWallet }));
vi.mock("../lib/rpc", () => ({
  rpc: api,
  rpcForSpace: () => api,
  createSpaceRpc: () => api,
  selectedSpaceId: () => null,
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce(
      (text, part, index) => `${text}${index > 0 ? String(values[index - 1]) : ""}${part}`,
      "",
    );
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children?: ReactNode }) => children,
  };
});
vi.mock("@rakazo/ui-web", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const ButtonLike = ({
    children,
    onClick,
    disabled,
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
  return {
    Button: ButtonLike,
    AlertDialog: ({ children }: { children?: ReactNode }) => (
      <div role="alertdialog">{children}</div>
    ),
    AlertDialogAction: ButtonLike,
    AlertDialogCancel: ButtonLike,
    AlertDialogContent: Pass,
    AlertDialogFooter: Pass,
    AlertDialogHeader: Pass,
    AlertDialogTitle: Pass,
  };
});

import { PaymentWalletSettingsPanel } from "./PaymentWalletSettingsPanel";

const connecting = {
  status: "connecting" as const,
  verificationUrl: "https://wallet.example.test/connect/abc",
  userCode: "WXYZ-1234",
  expiresAt: "2026-10-27T12:15:00.000Z",
};
const connected = { status: "connected" as const, connectedAt: "2026-10-27T12:01:00.000Z" };
const disconnected = { status: "disconnected" as const };

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
let open: MockInstance<typeof window.open>;

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  open = vi.spyOn(window, "open").mockReturnValue(null);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <PaymentWalletSettingsPanel provider={{ id: "link", name: "Link" }} />
      </QueryClientProvider>,
    ),
  );
  await act(async () => vi.advanceTimersByTimeAsync(0));
}

function button(label: string) {
  const match = [...container.querySelectorAll("button")].filter(
    (item) => item.textContent === label,
  );
  const last = match.at(-1);
  if (!last) throw new Error(`Missing ${label}`);
  return last;
}

/** One poll interval. */
async function poll() {
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
}

/** Query results reach React on a real-timer tick, so wait for the screen to show them. */
function settled(check: () => void) {
  return act(async () => vi.waitFor(check));
}

function code() {
  return container.querySelector('[data-testid="payment-wallet-code"]')?.textContent ?? null;
}

it("connects, shows the code until the provider finishes, then disconnects after confirming", async () => {
  paymentWallet.status.mockResolvedValue(disconnected);
  paymentWallet.connect.mockResolvedValue(connecting);
  await render();
  expect(container.textContent).toContain("Link");

  await act(async () => button("Connect").click());
  expect(paymentWallet.connect).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledWith(connecting.verificationUrl, "_blank", "noopener,noreferrer");
  expect(code()).toBe("WXYZ-1234");

  // Still waiting on the provider: the code stays and the page can be reopened.
  paymentWallet.status.mockResolvedValue(connecting);
  await poll();
  expect(code()).toBe("WXYZ-1234");
  await act(async () => button("Open").click());
  expect(open).toHaveBeenCalledTimes(2);

  paymentWallet.status.mockResolvedValue(connected);
  await poll();
  await settled(() => expect(code()).toBeNull());
  expect(button("Disconnect")).toBeTruthy();

  // Connected: no more polling.
  const reads = paymentWallet.status.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(paymentWallet.status).toHaveBeenCalledTimes(reads);

  paymentWallet.disconnect.mockResolvedValue(disconnected);
  await act(async () => button("Disconnect").click());
  expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain(
    "Disconnect Link?",
  );
  expect(paymentWallet.disconnect).not.toHaveBeenCalled();
  await act(async () => button("Disconnect").click());
  expect(paymentWallet.disconnect).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  expect(button("Connect")).toBeTruthy();
});

it("cancels a sign-in by disconnecting", async () => {
  paymentWallet.status.mockResolvedValue(connecting);
  paymentWallet.disconnect.mockResolvedValue(disconnected);
  await render();
  expect(code()).toBe("WXYZ-1234");

  await act(async () => button("Cancel").click());
  expect(paymentWallet.disconnect).toHaveBeenCalledTimes(1);
  expect(code()).toBeNull();
  expect(button("Connect")).toBeTruthy();
});

it("returns to Connect when the provider denies or the code expires", async () => {
  paymentWallet.status.mockResolvedValue(connecting);
  await render();
  paymentWallet.status.mockResolvedValue(disconnected);
  await poll();
  await settled(() => expect(code()).toBeNull());
  expect(button("Connect")).toBeTruthy();
});

it("says so when connecting fails", async () => {
  paymentWallet.status.mockResolvedValue(disconnected);
  paymentWallet.connect.mockRejectedValue(new Error("boom"));
  await render();
  await act(async () => button("Connect").click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBeTruthy();
  expect(open).not.toHaveBeenCalled();
});
