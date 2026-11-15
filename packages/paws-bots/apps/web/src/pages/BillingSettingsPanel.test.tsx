// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.flatMap((part, index) => [part, values[index] ?? ""]).join("");
  return {
    useLingui: () => ({ t, i18n: { locale: "en" } }),
    Trans: ({ children }: { children?: ReactNode }) => children,
    Plural: ({ value, one, other }: { value: number; one: string; other: string }) => (
      <>{value === 1 ? one : other}</>
    ),
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

import { createSpaceRpc } from "../lib/rpc";
import { BillingSettingsPanel } from "./BillingSettingsPanel";

/** A trialing own-key plan whose trial can be ended from the panel. */
const status = {
  funding: "byok",
  state: "trialing",
  canManage: true,
  creditPurchasesEnabled: true,
  byokPriceCents: 2000,
  balanceUsd: 0,
  monthlyAmountCents: null,
  computerHoursLeft: 2,
  cancelAtPeriodEnd: false,
  trialAvailable: false,
};

const requests: Array<{ url: string; spaceId: string | null }> = [];

beforeEach(() => {
  localStorage.setItem("rakazo:space-id", "space-a");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request, init?: RequestInit) => {
      requests.push({
        url: request.url,
        spaceId: new Headers(init?.headers ?? request.headers).get("x-rakazo-space-id"),
      });
      return Response.json({
        json: request.url.endsWith("/billing/endTrial") ? {} : status,
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  requests.length = 0;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

function button(container: HTMLElement, label: string) {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  expect(found, `button ${label}`).toBeDefined();
  return found!;
}

it("sends the panel's confirmations to the space it opened for", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<BillingSettingsPanel client={createSpaceRpc("space-a")} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  // The panel loaded this organization's status.
  expect(requests[0]).toMatchObject({
    url: expect.stringContaining("/billing/status"),
    spaceId: "space-a",
  });

  // Another tab selects another organization while this panel stays open.
  localStorage.setItem("rakazo:space-id", "space-b");
  act(() => {
    window.dispatchEvent(new StorageEvent("storage", { key: "rakazo:space-id" }));
  });

  await act(async () => {
    button(container, "Start plan now").click();
  });
  // The confirmation quotes the price the panel loaded, not the new organization's.
  expect(container.textContent).toMatch(/charged \$20(\.00)? today/);
  await act(async () => {
    button(container, "Start plan").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const endTrial = requests.find(({ url }) => url.endsWith("/billing/endTrial"));
  expect(endTrial).toMatchObject({ spaceId: "space-a" });
  act(() => root.unmount());
  container.remove();
});

it("acts on the window's space when another tab switched before the panel opened", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // This window shows space-a; another tab selected space-b before Billing opened here.
  const client = createSpaceRpc("space-a");
  localStorage.setItem("rakazo:space-id", "space-b");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<BillingSettingsPanel client={client} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(requests[0]).toMatchObject({
    url: expect.stringContaining("/billing/status"),
    spaceId: "space-a",
  });

  await act(async () => {
    button(container, "Start plan now").click();
  });
  await act(async () => {
    button(container, "Start plan").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const endTrial = requests.find(({ url }) => url.endsWith("/billing/endTrial"));
  expect(endTrial).toMatchObject({ spaceId: "space-a" });
  act(() => root.unmount());
  container.remove();
});
