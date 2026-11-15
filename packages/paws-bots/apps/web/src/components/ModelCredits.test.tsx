// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const billing = vi.hoisted(() => ({
  checkout: vi.fn(),
  selectFunding: vi.fn(),
  purchaseCredits: vi.fn(),
}));
const accountMenuDisabled: Array<boolean> = vi.hoisted(() => []);

vi.mock("../lib/rpc", () => ({
  rpc: { billing },
  rpcForSpace: () => ({ billing }),
  createSpaceRpc: () => ({ billing }),
  selectedSpaceId: () => null,
  clearSpaceSelection: () => undefined,
}));
vi.mock("./AccountMenu", () => ({
  AccountMenu: ({ disabled }: { disabled?: boolean }) => {
    accountMenuDisabled.push(Boolean(disabled));
    return <div data-testid="account-menu" />;
  },
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
    Skeleton: (props: ComponentProps<"div">) => <div {...props} />,
    Card: Container,
    CardContent: Container,
    CardFooter: Container,
    CardHeader: Container,
    AlertDialog: Container,
    AlertDialogAction: Button,
    AlertDialogCancel: Button,
    AlertDialogContent: Container,
    AlertDialogDescription: Container,
    AlertDialogFooter: Container,
    AlertDialogHeader: Container,
    AlertDialogTitle: Container,
    Dialog: Container,
    DialogContent: Container,
    DialogDescription: Container,
    DialogHeader: Container,
    DialogTitle: Container,
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

import { CreditChoice } from "./ModelCredits";

const status = {
  canManage: true,
  creditPurchasesEnabled: true,
  byokPriceCents: 1000,
  byokFreeUntil: "2030-01-15T12:00:00.000Z",
  trialAvailable: false,
  trialDays: 7,
};

const assign = vi.fn();

function buttonByLabel(container: HTMLElement, label: string) {
  const found = container.querySelector(`button[aria-label="${label}"]`);
  expect(found, `button ${label}`).toBeDefined();
  return found as HTMLButtonElement;
}

const tierStatus = {
  ...status,
  byokFreeUntil: null,
  trialAvailable: true,
  planLayout: "tiers",
  byokTiers: [
    ["standard", "Standard", 1500, 14400, "standard", 25],
    ["pro", "Pro", 4900, 46800, "large", 100],
    ["max", "Max", 9900, 94800, "xlarge", 200],
  ].map(([tier, name, monthlyPriceCents, annualPriceCents, computerSize, computerHours]) => ({
    tier,
    name,
    monthlyPriceCents,
    annualPriceCents,
    computerSize,
    computerHours,
  })),
};

async function renderChoice(choice: object = status) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<CreditChoice status={choice as never} client={{ billing } as never} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { container, root };
}

async function settle(action: () => void) {
  await act(async () => {
    action();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.stubGlobal("location", { assign });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  accountMenuDisabled.length = 0;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

it.each([
  {
    name: "own key",
    label: "Subscribe with your own AI",
    open: () => billing.checkout.mockResolvedValue({ url: "https://checkout.example/plan" }),
    url: "https://checkout.example/plan",
  },
  {
    name: "credits",
    label: "Subscribe to credits",
    open: () =>
      billing.purchaseCredits.mockResolvedValue({ url: "https://checkout.example/credits" }),
    url: "https://checkout.example/credits",
  },
])(
  "re-enables the $name choice after the payment page opens outside",
  async ({ label, open, url }) => {
    open();
    const { container, root } = await renderChoice();
    const choice = buttonByLabel(container, label);
    expect(choice.disabled).toBe(false);

    // The desktop shell cancels the navigation and opens the system browser, so the
    // page stays exactly as it was.
    await settle(() => choice.click());

    expect(assign).toHaveBeenCalledWith(url);
    expect(buttonByLabel(container, label).disabled).toBe(false);
    expect(buttonByLabel(container, "Subscribe to credits").disabled).toBe(false);
    expect(buttonByLabel(container, "Subscribe with your own AI").disabled).toBe(false);
    expect(accountMenuDisabled.at(-1)).toBe(false);
    act(() => root.unmount());
    container.remove();
  },
);

it("starts the trial of the tier picked from the tiers layout", async () => {
  billing.selectFunding.mockResolvedValue({ ok: true, url: "https://checkout.example/pro" });
  const { container, root } = await renderChoice(tierStatus);
  expect(container.textContent).toContain("$49");
  await settle(() => buttonByLabel(container, "Start Pro trial").click());
  expect(billing.selectFunding).toHaveBeenCalledWith({
    funding: "byok",
    tier: "pro",
    interval: "month",
  });
  expect(assign).toHaveBeenCalledWith("https://checkout.example/pro");
  expect(buttonByLabel(container, "Subscribe to credits").disabled).toBe(false);
  act(() => root.unmount());
  container.remove();
});
