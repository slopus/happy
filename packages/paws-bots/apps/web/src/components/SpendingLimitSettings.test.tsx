// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";

const rpcMock = vi.hoisted(() => ({
  spendingLimit: { get: vi.fn(), set: vi.fn(), payments: vi.fn() },
}));
vi.mock("../lib/rpc", () => ({
  rpc: rpcMock,
  rpcForSpace: () => rpcMock,
  createSpaceRpc: () => rpcMock,
  selectedSpaceId: () => null,
}));
vi.mock("../lib/relative-time", () => ({ formatRelativeTime: () => "2h ago" }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce(
      (text, part, index) => text + part + (index < values.length ? values[index] : ""),
      "",
    );
  return {
    useLingui: () => ({ t, i18n: { locale: "en-US" } }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock("@rakazo/ui-web", async () => {
  const { createContext, useContext } = await import("react");
  type Choice = {
    value: string;
    onValueChange: (value: string) => void;
    items: Array<{ value: string; label: string }>;
  };
  const Choices = createContext<Choice | null>(null);
  return {
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
    // A plain select stands in for the menu, with the trigger's name.
    Select: ({ children, ...choice }: Choice & { children: ReactNode }) => (
      <Choices.Provider value={choice}>{children}</Choices.Provider>
    ),
    SelectTrigger: ({ "aria-label": label }: { "aria-label": string }) => {
      const choice = useContext(Choices)!;
      return (
        <select
          aria-label={label}
          value={choice.value}
          onChange={(event) => choice.onValueChange(event.target.value)}
        >
          {choice.items.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      );
    },
    SelectValue: () => null,
    SelectContent: () => null,
    SelectGroup: () => null,
    SelectItem: () => null,
  };
});

import { SpendingLimitSettings } from "./SpendingLimitSettings";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  rpcMock.spendingLimit.payments.mockResolvedValue([]);
});

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <SpendingLimitSettings />
      </QueryClientProvider>,
    );
  });
  return container;
}

const button = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === name,
  )!;

function type(input: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype =
    input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(
    new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
  );
}

it("stays hidden until the user has a way to pay", async () => {
  rpcMock.spendingLimit.get.mockResolvedValue({ limit: null, spent: 0, shown: false });
  const container = await render();
  await vi.waitFor(() => expect(rpcMock.spendingLimit.get).toHaveBeenCalled());
  expect(container.textContent).toBe("");
});

it("sets a limit with an amount, currency and reset", async () => {
  rpcMock.spendingLimit.get.mockResolvedValue({ limit: null, spent: 0, shown: true });
  const limit = { amount: 25_050, currency: "eur", period: "week" };
  rpcMock.spendingLimit.set.mockResolvedValue({ limit, spent: 1_000, shown: true });
  const container = await render();
  await vi.waitFor(() => expect(container.textContent).toContain("Spending limitNone"));
  await act(async () => button(container, "Set").click());
  const save = button(container, "Save");
  expect(save.disabled).toBe(true);
  await act(async () => {
    type(container.querySelector<HTMLInputElement>('input[aria-label="Amount"]')!, "250.50");
    type(container.querySelector<HTMLSelectElement>('select[aria-label="Currency"]')!, "eur");
    type(container.querySelector<HTMLSelectElement>('select[aria-label="Resets"]')!, "week");
  });
  await act(async () => button(container, "Save").click());
  expect(rpcMock.spendingLimit.set).toHaveBeenCalledWith({ limit });
  expect(container.textContent).toContain("€250.50 a week");
  expect(container.textContent).toContain("€10.00 spent this week");
});

it("removes a limit, and keeps the form when a save fails", async () => {
  const limit = { amount: 20_000, currency: "usd", period: "month" };
  rpcMock.spendingLimit.get.mockResolvedValue({ limit, spent: 2_340, shown: true });
  const container = await render();
  await vi.waitFor(() => expect(container.textContent).toContain("$200.00 a month"));
  expect(container.textContent).toContain("$23.40 spent this month");
  await act(async () => button(container, "Edit").click());
  rpcMock.spendingLimit.set.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  await act(async () => button(container, "Remove").click());
  expect(container.textContent).toContain("Could not reach the server");
  expect(container.querySelector('input[aria-label="Amount"]')).not.toBeNull();
  rpcMock.spendingLimit.set.mockResolvedValue({ limit: null, spent: 0, shown: true });
  await act(async () => button(container, "Remove").click());
  expect(rpcMock.spendingLimit.set).toHaveBeenLastCalledWith({ limit: null });
  expect(container.textContent).toContain("Spending limitNone");
});

it("lists the latest payments, and the rest on request", async () => {
  rpcMock.spendingLimit.get.mockResolvedValue({ limit: null, spent: 0, shown: true });
  rpcMock.spendingLimit.payments.mockResolvedValue(
    Array.from({ length: 7 }, (_, index) => ({
      id: `payment-${index}`,
      site: `shop${index}.example.test`,
      amount: 1_250 + index,
      currency: "usd",
      botName: index === 0 ? "Shopper" : null,
      createdAt: "2026-11-05T09:30:00.000Z",
    })),
  );
  const container = await render();
  await vi.waitFor(() => expect(container.textContent).toContain("Recent payments"));
  const rows = () => [...container.querySelectorAll("[data-testid=spending-payments] li")];
  expect(rows()).toHaveLength(5);
  expect(rows()[0]!.textContent).toBe("shop0.example.testShopper · 2h ago$12.50");
  expect(rows()[1]!.textContent).toBe("shop1.example.test2h ago$12.51");
  await act(async () => button(container, "Show all").click());
  expect(rows()).toHaveLength(7);
  expect(button(container, "Show all")).toBeUndefined();
});
