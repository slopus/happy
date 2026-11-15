// @vitest-environment jsdom

import type { ScratchpadItem } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const rpcMock = vi.hoisted(() => ({
  scratchpad: { list: vi.fn(), create: vi.fn(), remove: vi.fn() },
}));
vi.mock("../lib/rpc", () => ({
  rpc: rpcMock,
  rpcForSpace: () => rpcMock,
  createSpaceRpc: () => rpcMock,
  selectedSpaceId: () => null,
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { rpc } from "../lib/rpc";
import { ScratchpadSection } from "./ScratchpadSection";

let queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

afterEach(() => {
  queryClient.clear();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  rpcMock.scratchpad.list.mockReset().mockResolvedValue([]);
  rpcMock.scratchpad.create.mockReset();
  rpcMock.scratchpad.remove.mockReset();
});

async function mount(root: Root, botId: string) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <ScratchpadSection botId={botId} />
      </QueryClientProvider>,
    ),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

function workItem(id: string, title: string): ScratchpadItem {
  return {
    id,
    botId: "bot-fixture",
    title,
    notes: "",
    status: "open",
    createdAt: "",
    updatedAt: "",
  };
}

it("hides the entire empty section", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await mount(root, "bot-fixture");
    expect(container.querySelector('[data-testid="bot-scratchpad"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("renders open and parked work without status chrome and removes a wrapped item", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const title =
    "Review the proposed settings and document the remaining decisions before the next design review";
  const item = {
    id: "work-fixture",
    botId: "bot-fixture",
    title,
    notes: "Compare both themes",
    status: "parked" as const,
    createdAt: "",
    updatedAt: "",
  };
  vi.mocked(rpc.scratchpad.list).mockResolvedValueOnce([item]).mockResolvedValueOnce([]);
  vi.mocked(rpc.scratchpad.remove).mockResolvedValue({ ok: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await mount(root, "bot-fixture");
    expect(container.querySelector('[aria-label="New open-work item"]')).toBeNull();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Add open work"]')!.click(),
    );
    expect(container.querySelector('[aria-label="New open-work item"]')).not.toBeNull();
    expect(container.textContent).toContain(title);
    expect(container.textContent).toContain("Compare both themes");
    expect(container.textContent).not.toContain("parked");
    expect(container.querySelector('[aria-label="Park"]')).toBeNull();
    expect(container.querySelector('[aria-label="Reopen"]')).toBeNull();
    expect(container.querySelector('[aria-label="Complete"]')).not.toBeNull();
    const remove = container.querySelector<HTMLButtonElement>('[aria-label="Remove"]')!;
    expect(remove).not.toBeNull();
    await act(async () => remove.click());
    expect(rpc.scratchpad.remove).toHaveBeenCalledWith({ itemId: item.id });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(container.textContent).not.toContain(title);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("shows only the first five items until Show more", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(rpc.scratchpad.list).mockResolvedValueOnce(
    Array.from({ length: 7 }, (_, i) => ({
      id: `item-${i}`,
      botId: "fixture",
      title: `Task ${i}`,
      notes: "",
      status: "open",
      createdAt: "",
      updatedAt: "",
    })),
  );
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await mount(root, "fixture");
    expect(host.querySelectorAll('[role="checkbox"]')).toHaveLength(5);
    expect(host.textContent).not.toContain("Task 6");
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((node) => node.textContent === "Show more")!
        .click(),
    );
    expect(host.querySelectorAll('[role="checkbox"]')).toHaveLength(7);
    expect(host.textContent).toContain("Task 6");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("reopens on the cached list and refreshes it in the background", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  rpcMock.scratchpad.list.mockResolvedValueOnce([workItem("a", "Cached task")]);
  const host = document.createElement("div");
  let root = createRoot(host);
  try {
    await mount(root, "bot-fixture");
    await act(async () => root.unmount());

    let resolveRead: (items: ScratchpadItem[]) => void = () => undefined;
    rpcMock.scratchpad.list.mockImplementationOnce(
      () => new Promise((resolve) => (resolveRead = resolve)),
    );
    root = createRoot(host);
    await mount(root, "bot-fixture");
    expect(host.textContent).toContain("Cached task");
    expect(rpcMock.scratchpad.list).toHaveBeenCalledTimes(2);
    await act(async () => resolveRead([workItem("b", "Fresh task")]));
    await vi.waitFor(() => expect(host.textContent).toContain("Fresh task"));
    expect(host.textContent).not.toContain("Cached task");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("keeps an added item when an older background read lands after it", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const existing = workItem("a", "Existing task");
  const added = workItem("b", "Added task");
  rpcMock.scratchpad.list.mockResolvedValueOnce([existing]);
  const host = document.createElement("div");
  let root = createRoot(host);
  try {
    await mount(root, "bot-fixture");
    await act(async () => root.unmount());

    let resolveOlderRead: (items: ScratchpadItem[]) => void = () => undefined;
    rpcMock.scratchpad.list
      .mockImplementationOnce(() => new Promise((resolve) => (resolveOlderRead = resolve)))
      .mockResolvedValueOnce([added, existing]);
    rpcMock.scratchpad.create.mockResolvedValue(added);
    root = createRoot(host);
    await mount(root, "bot-fixture");
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="Add open work"]')!.click(),
    );
    const input = host.querySelector<HTMLInputElement>('[aria-label="New open-work item"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        input,
        added.title,
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.form!.requestSubmit());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(host.textContent).toContain("Added task");
    await act(async () => {
      resolveOlderRead([existing]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain("Added task");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
