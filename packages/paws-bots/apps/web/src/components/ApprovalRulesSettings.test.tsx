// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";

const rpcMock = vi.hoisted(() => ({
  approvalRules: { list: vi.fn(), set: vi.fn(), remove: vi.fn() },
  autoReview: { get: vi.fn(), set: vi.fn() },
  spendingLimit: { get: vi.fn(), set: vi.fn(), payments: vi.fn() },
}));
vi.mock("../lib/rpc", () => ({
  rpc: rpcMock,
  rpcForSpace: () => rpcMock,
  createSpaceRpc: () => rpcMock,
  selectedSpaceId: () => null,
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce(
      (text, part, index) => text + part + (index < values.length ? values[index] : ""),
      "",
    );
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
// Menus and popovers render open and inline, so a test clicks straight through them.
vi.mock("@rakazo/ui-web", async () => {
  const { createContext, useContext } = await import("react");
  const Group = createContext<{ value: string[]; onValueChange: (value: string[]) => void }>({
    value: [],
    onValueChange: () => undefined,
  });
  const Plain = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const Trigger = ({
    render,
    children,
    ...props
  }: ComponentProps<"button"> & { render?: ReactElement<{ disabled?: boolean }> }) => (
    <button type="button" disabled={render?.props.disabled} {...props}>
      {children}
    </button>
  );
  return {
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
    ToggleGroup: ({
      value,
      onValueChange,
      children,
      spacing: _spacing,
      ...props
    }: Omit<ComponentProps<"div">, "onChange"> & {
      value: string[];
      onValueChange: (value: string[]) => void;
      spacing?: number;
      disabled?: boolean;
    }) => (
      <Group.Provider value={{ value, onValueChange }}>
        <div {...props}>{children}</div>
      </Group.Provider>
    ),
    ToggleGroupItem: ({ value, children }: { value: string; children?: ReactNode }) => {
      const group = useContext(Group);
      return (
        <button
          type="button"
          aria-pressed={group.value.includes(value)}
          onClick={() => group.onValueChange([value])}
        >
          {children}
        </button>
      );
    },
    Popover: Plain,
    PopoverTrigger: Trigger,
    PopoverContent: Plain,
    Command: Plain,
    CommandList: Plain,
    CommandGroup: ({ heading, children }: { heading?: string; children?: ReactNode }) => (
      <div data-heading={heading}>{children}</div>
    ),
    CommandItem: ({ onSelect, children }: { onSelect: () => void; children?: ReactNode }) => (
      <button type="button" data-picker-item onClick={onSelect}>
        {children}
      </button>
    ),
    ListSearchInput: ({
      query,
      setQuery,
      label,
    }: {
      query: string;
      setQuery: (query: string) => void;
      label: string;
    }) => <input aria-label={label} value={query} onChange={(e) => setQuery(e.target.value)} />,
  };
});

import { ApprovalRulesSettings } from "./ApprovalRulesSettings";

const settings = { mode: "ask", enabled: false, skipApprovals: false, checkerAvailable: true };

beforeEach(() => {
  vi.resetAllMocks();
  // Nothing to pay with yet, so the spending limit stays out of the way.
  rpcMock.spendingLimit.get.mockResolvedValue({ limit: null, spent: 0, shown: false });
});

async function render(scope: "account" | "space" = "account") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ApprovalRulesSettings scope={scope} />
      </QueryClientProvider>,
    );
  });
  return { container, root, client };
}

const button = (container: HTMLElement, name: string, within = "") =>
  [...container.querySelectorAll<HTMLButtonElement>(`${within} button`)].find(
    (candidate) => candidate.textContent === name || candidate.getAttribute("aria-label") === name,
  );

const group = (effect: string) => `[data-testid="approval-rules-${effect}"]`;
const pickerItems = (container: HTMLElement) =>
  [...container.querySelectorAll("[data-picker-item]")].map((item) => item.textContent);

it("sets the mode, says what it does, and lists Auto only when an approval model is there", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  rpcMock.approvalRules.list.mockResolvedValue([]);
  rpcMock.autoReview.get.mockResolvedValue({ ...settings, checkerAvailable: false });
  rpcMock.autoReview.set.mockResolvedValue({ ...settings, mode: "never", skipApprovals: true });
  const { container, root } = await render();
  try {
    await vi.waitFor(() =>
      expect(button(container, "Ask")?.getAttribute("aria-pressed")).toBe("true"),
    );
    expect(container.textContent).toContain(
      "Asks before sending, spending or changing anything in your apps.",
    );
    expect(button(container, "Auto")).toBeUndefined();
    await act(async () => button(container, "Never ask")?.click());
    expect(rpcMock.autoReview.set).toHaveBeenLastCalledWith({ scope: "account", mode: "never" });
    await vi.waitFor(() =>
      expect(button(container, "Never ask")?.getAttribute("aria-pressed")).toBe("true"),
    );
    expect(container.textContent).toContain(
      "Asks only before purchases and the first use of your computer. Only Block rules apply.",
    );
    // No rules yet, so no rule groups.
    expect(container.querySelector('[data-testid^="approval-rules-"]')).toBeNull();
    await act(async () => root.unmount());
  } finally {
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("moves an allowed tool to Blocked, then removes it", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const allowed = {
    id: "rule-1",
    effect: "always_allow",
    matchKind: "tool",
    matchValue: "GMAIL_SEND_EMAIL",
    createdAt: "2026-10-25T00:00:00.000Z",
  };
  rpcMock.approvalRules.list.mockResolvedValue([allowed]);
  rpcMock.approvalRules.set.mockResolvedValue({ ...allowed, id: "rule-2", effect: "deny" });
  rpcMock.approvalRules.remove.mockResolvedValue({ ok: true });
  rpcMock.autoReview.get.mockResolvedValue(settings);
  const { container, root } = await render();
  try {
    await vi.waitFor(() =>
      expect(container.querySelector(group("always_allow"))?.textContent).toContain(
        "Gmail send email",
      ),
    );
    expect(button(container, "Allow", group("always_allow"))?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    await act(async () => button(container, "Block", group("always_allow"))?.click());
    expect(rpcMock.approvalRules.set).toHaveBeenLastCalledWith({
      scope: "account",
      effect: "deny",
      matchKind: "tool",
      matchValue: "GMAIL_SEND_EMAIL",
    });
    await vi.waitFor(() => expect(container.querySelector(group("always_allow"))).toBeNull());
    expect(container.querySelector(group("deny"))?.textContent).toContain("Gmail send email");
    await act(async () => button(container, "Remove Gmail send email", group("deny"))?.click());
    expect(rpcMock.approvalRules.remove).toHaveBeenLastCalledWith({
      scope: "account",
      id: "rule-2",
    });
    await vi.waitFor(() => expect(container.querySelector(group("deny"))).toBeNull());
    await act(async () => root.unmount());
  } finally {
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("grays out allow and ask rules in Never ask, where only blocks apply", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  rpcMock.approvalRules.list.mockResolvedValue([
    { id: "a", effect: "always_allow", matchKind: "tool", matchValue: "send_email" },
    { id: "b", effect: "require_approval", matchKind: "tool", matchValue: "write_file" },
    { id: "c", effect: "deny", matchKind: "tool", matchValue: "shell" },
  ]);
  rpcMock.autoReview.get.mockResolvedValue({ ...settings, mode: "never", skipApprovals: true });
  const { container, root } = await render();
  try {
    await vi.waitFor(() => expect(container.querySelector(group("deny"))).not.toBeNull());
    const unused = (effect: string) =>
      container.querySelector(group(effect))!.parentElement!.hasAttribute("data-unused");
    expect([unused("always_allow"), unused("require_approval"), unused("deny")]).toEqual([
      true,
      true,
      false,
    ]);
    expect(container.textContent).toContain("Only Block rules apply.");
    await act(async () => root.unmount());
  } finally {
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("offers Ask and Block, not Allow, for a tool a person approves every time", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  rpcMock.approvalRules.list.mockResolvedValue([
    { id: "s", effect: "require_approval", matchKind: "tool", matchValue: "create_space" },
  ]);
  rpcMock.autoReview.get.mockResolvedValue(settings);
  const { container, root } = await render();
  try {
    await vi.waitFor(() =>
      expect(button(container, "Ask", group("require_approval"))).toBeDefined(),
    );
    expect(button(container, "Block", group("require_approval"))).toBeDefined();
    expect(button(container, "Allow", group("require_approval"))).toBeUndefined();
    await act(async () => root.unmount());
  } finally {
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("groups older category rules by what they do and only offers to remove them", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  rpcMock.approvalRules.list.mockResolvedValue([
    { id: "rule-1", effect: "require_approval", matchKind: "tool", matchValue: "send_email" },
    { id: "rule-2", effect: "require_approval", matchKind: "category", matchValue: "email" },
    { id: "rule-3", effect: "always_allow", matchKind: "category", matchValue: "purchase" },
  ]);
  rpcMock.autoReview.get.mockResolvedValue(settings);
  const { container, root } = await render();
  try {
    await vi.waitFor(() =>
      expect(container.querySelector(group("require_approval"))?.textContent).toContain(
        "Send email",
      ),
    );
    expect(container.querySelector(group("require_approval"))?.textContent).toContain("Email");
    expect(container.querySelector(group("always_allow"))?.textContent).toContain("Purchase");
    const allowed = container.querySelector(group("always_allow"))!;
    expect(allowed.querySelector("[aria-pressed]")).toBeNull();
    expect(button(container, "Remove Purchase", group("always_allow"))).toBeDefined();
    await act(async () => root.unmount());
  } finally {
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("keeps a saved mode when the revisit's older background read lands after it", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  rpcMock.approvalRules.list.mockResolvedValue([]);
  rpcMock.autoReview.get.mockResolvedValueOnce(settings);
  rpcMock.autoReview.set.mockResolvedValue({ ...settings, mode: "never", skipApprovals: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const mount = async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ApprovalRulesSettings scope="account" />
        </QueryClientProvider>,
      );
    });
    return root;
  };
  const neverAsk = () => button(container, "Never ask");
  try {
    const first = await mount();
    await vi.waitFor(() =>
      expect(button(container, "Ask")?.getAttribute("aria-pressed")).toBe("true"),
    );
    await act(async () => first.unmount());

    let resolveRead: (value: typeof settings) => void = () => undefined;
    rpcMock.autoReview.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    const second = await mount();
    // Cached, so the mode can change while the refresh is out.
    expect(rpcMock.autoReview.get).toHaveBeenCalledTimes(2);
    await act(async () => neverAsk()?.click());
    await vi.waitFor(() => expect(neverAsk()?.getAttribute("aria-pressed")).toBe("true"));
    await act(async () => resolveRead(settings));
    // Query updates reach components on a timer; let any late write land.
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(neverAsk()?.getAttribute("aria-pressed")).toBe("true");
    await act(async () => second.unmount());
  } finally {
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("reads and writes a Space's own approvals apart from the account's", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const rule = {
    id: "rule-1",
    effect: "always_allow",
    matchKind: "tool",
    matchValue: "send_email",
  };
  rpcMock.approvalRules.list.mockImplementation(async ({ scope }: { scope: string }) =>
    scope === "space" ? [rule] : [],
  );
  rpcMock.approvalRules.remove.mockResolvedValue({ ok: true });
  rpcMock.autoReview.get.mockResolvedValue(settings);
  rpcMock.autoReview.set.mockResolvedValue({ ...settings, mode: "auto", enabled: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const show = (scope: "account" | "space") =>
    act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ApprovalRulesSettings scope={scope} />
        </QueryClientProvider>,
      );
    });
  try {
    await show("space");
    await vi.waitFor(() => expect(button(container, "Remove Send email")).toBeDefined());
    expect(rpcMock.autoReview.get).toHaveBeenCalledWith({ scope: "space" }, expect.anything());
    await act(async () => button(container, "Auto")?.click());
    expect(rpcMock.autoReview.set).toHaveBeenLastCalledWith({ scope: "space", mode: "auto" });
    await act(async () => button(container, "Remove Send email")?.click());
    expect(rpcMock.approvalRules.remove).toHaveBeenLastCalledWith({
      scope: "space",
      id: "rule-1",
    });

    await show("account");
    await vi.waitFor(() =>
      expect(rpcMock.approvalRules.list).toHaveBeenCalledWith(
        { scope: "account" },
        expect.anything(),
      ),
    );
    await vi.waitFor(() => expect(button(container, "Remove Send email")).toBeUndefined());
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("adds a tool from the searchable picker, which leaves out tools that have a rule", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  rpcMock.approvalRules.list.mockResolvedValue([
    { id: "blocked", effect: "deny", matchKind: "tool", matchValue: "write_file" },
  ]);
  rpcMock.autoReview.get.mockResolvedValue(settings);
  rpcMock.approvalRules.set.mockResolvedValue({
    id: "new",
    effect: "require_approval",
    matchKind: "tool",
    matchValue: "shell",
  });
  const { container, root } = await render("space");
  try {
    await vi.waitFor(() => expect(button(container, "Add rule")!.disabled).toBe(false));
    expect(pickerItems(container)).not.toContain("Write file");
    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search tools"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        search,
        "shel",
      );
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(pickerItems(container)).toEqual(["Shell", "User computer shell"]);
    await act(async () => button(container, "Shell")!.click());
    expect(rpcMock.approvalRules.set).toHaveBeenCalledWith({
      scope: "space",
      effect: "require_approval",
      matchKind: "tool",
      matchValue: "shell",
    });
    await vi.waitFor(() =>
      expect(container.querySelector(group("require_approval"))?.textContent).toContain("Shell"),
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("shows why adding a rule failed", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  rpcMock.approvalRules.list.mockResolvedValue([]);
  rpcMock.autoReview.get.mockResolvedValue(settings);
  rpcMock.approvalRules.set.mockRejectedValue(new Error("Could not save"));
  const { container, root } = await render();
  try {
    await vi.waitFor(() => expect(button(container, "Add rule")!.disabled).toBe(false));
    await act(async () => button(container, "Shell")!.click());
    await vi.waitFor(() => expect(container.textContent).toContain("Could not save"));
    expect(container.querySelector('[data-testid^="approval-rules-"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
