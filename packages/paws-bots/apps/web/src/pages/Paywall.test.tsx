// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const selected = vi.hoisted(() => ({
  checkout: vi.fn(),
  portal: vi.fn(),
  selectFunding: vi.fn(),
  purchaseCredits: vi.fn(),
}));

// The global client follows the space another tab selected last.
vi.mock("../lib/rpc", () => ({
  rpc: { billing: selected },
  clearSpaceSelection: () => undefined,
}));
vi.mock("../components/AccountMenu", () => ({ AccountMenu: () => null }));
vi.mock("./Auth", () => ({
  submitClass: "",
  AuthFrame: ({
    children,
    onSubmit,
  }: {
    children?: ReactNode;
    onSubmit: (event: { preventDefault: () => void }) => void;
  }) => <form onSubmit={(event) => onSubmit(event)}>{children}</form>,
}));
vi.mock("@lingui/react/macro", () => {
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.flatMap((part, index) => [part, values[index] ?? ""]).join("");
  return {
    useLingui: () => ({ t, i18n: { locale: "en" } }),
    Trans: ({ children }: { children?: ReactNode }) => children,
  };
});
vi.mock("@rakazo/ui-web", () => {
  const Button = ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  );
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button,
    Card: Container,
    CardContent: Container,
    CardFooter: Container,
    CardHeader: Container,
    Select: Container,
    SelectContent: Container,
    SelectGroup: Container,
    SelectItem: Container,
    SelectTrigger: Container,
    SelectValue: Container,
    ToggleGroup: Container,
    ToggleGroupItem: Button,
  };
});

import type { RpcClient } from "../lib/rpc";
import { PaywallPage } from "./Paywall";

const pinned = {
  checkout: vi.fn(async () => ({ url: "https://checkout.example/plan" })),
  portal: vi.fn(async () => ({ url: "https://portal.example/" })),
  selectFunding: vi.fn(async () => ({ url: "https://checkout.example/funding" })),
  purchaseCredits: vi.fn(async () => ({ url: "https://checkout.example/credits" })),
};
// The client of the space whose status (and prices) the page shows.
const client = { billing: pinned } as unknown as RpcClient;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("location", { assign: vi.fn() });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

async function renderPaywall(status: Record<string, unknown>) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<PaywallPage status={status as never} client={client} />);
  });
  return {
    container,
    click: async (selector: string) => {
      await act(async () => {
        (container.querySelector(selector) as HTMLElement).click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

it.each([
  {
    name: "own key",
    label: "Subscribe with your own AI",
    status: { byokFreeUntil: null },
    call: pinned.selectFunding,
  },
  {
    name: "own key with a free period",
    label: "Subscribe with your own AI",
    status: { byokFreeUntil: "2030-01-15T12:00:00.000Z" },
    call: pinned.checkout,
  },
  {
    name: "credits",
    label: "Subscribe to credits",
    status: { byokFreeUntil: null },
    call: pinned.purchaseCredits,
  },
])("sends the $name plan choice to the space whose prices it shows", async (variant) => {
  const page = await renderPaywall({
    funding: null,
    canManage: true,
    creditPurchasesEnabled: true,
    byokPriceCents: 1000,
    trialAvailable: false,
    trialDays: 7,
    ...variant.status,
  });
  await page.click(`button[aria-label="${variant.label}"]`);
  expect(variant.call).toHaveBeenCalledTimes(1);
  expect(Object.values(selected).every((call) => call.mock.calls.length === 0)).toBe(true);
  page.cleanup();
});

it.each([
  { name: "checkout", state: "canceled", hasCustomer: false, call: pinned.checkout },
  { name: "portal", state: "unpaid", hasCustomer: true, call: pinned.portal },
])("sends the required paywall's $name to the space whose status it shows", async (variant) => {
  const page = await renderPaywall({
    canManage: true,
    hasCustomer: variant.hasCustomer,
    state: variant.state,
    trialAvailable: false,
    trialDays: 7,
  });
  await page.click(variant.name === "checkout" ? 'button[type="submit"]' : 'button[type="button"]');
  expect(variant.call).toHaveBeenCalledTimes(1);
  expect(Object.values(selected).every((call) => call.mock.calls.length === 0)).toBe(true);
  page.cleanup();
});
