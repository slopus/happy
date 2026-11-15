// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const { bots, client, toast } = vi.hoisted(() => {
  const bots = { list: vi.fn(), update: vi.fn() };
  const toast = Object.assign(vi.fn(), { error: vi.fn(), dismiss: vi.fn() });
  return { bots, client: { bots }, toast };
});

vi.mock("../../lib/space-rpc", () => ({ useSpaceRpc: () => client }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    String.raw({ raw: parts }, ...values);
  return { useLingui: () => ({ t }) };
});
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _v,
    size: _s,
    ...props
  }: ComponentProps<"button"> & Record<string, unknown>) => <button type="button" {...props} />,
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: ({
    render: _render,
    children,
    ...props
  }: ComponentProps<"button"> & { render?: unknown }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  toast,
}));

import { SpaceBotsModelButton } from "./space-bots-model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const list = [
  { id: "b1", name: "Archie", modelProvider: "anthropic", modelId: "claude-sonnet-5-5" },
  { id: "b2", name: "Scout", modelProvider: null, modelId: null },
  { id: "b3", name: "Inbox", modelProvider: "anthropic", modelId: "claude-opus-5-5" },
];
const following = list.map((bot) => ({ ...bot, modelProvider: null, modelId: null }));

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

function button(label: string) {
  return [...document.body.querySelectorAll("button")].find((node) => node.textContent === label);
}

async function render(mainModelKey = "s:a:one") {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<SpaceBotsModelButton mainModelKey={mainModelKey} />);
  });
  return {
    host,
    rerender: (key: string) =>
      act(async () => {
        root.render(<SpaceBotsModelButton mainModelKey={key} />);
      }),
    unmount: () => act(() => root.unmount()),
  };
}

it("stays out of sight when every bot follows the main model", async () => {
  bots.list.mockResolvedValue([list[1]]);
  const { host, unmount } = await render();
  expect(host.textContent).toBe("");
  unmount();
});

it("lists the bots behind a count and moves them all onto the main model", async () => {
  bots.list.mockResolvedValueOnce(list).mockResolvedValue(following);
  bots.update.mockResolvedValue({});
  const { host, unmount } = await render();
  const trigger = host.querySelector('[data-testid="space-bots-model"]');
  expect(trigger?.getAttribute("aria-label")).toBe("Bots with their own model");
  expect(trigger?.textContent).toBe("2");
  expect(host.textContent).toContain("Archie");
  expect(host.textContent).toContain("Inbox");
  await act(async () => {
    button("Use main model")!.click();
  });
  expect(bots.update).toHaveBeenCalledTimes(2);
  expect(bots.update).toHaveBeenCalledWith({
    botId: "b1",
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
  });
  expect(bots.update).toHaveBeenCalledWith(expect.objectContaining({ botId: "b3" }));
  expect(host.textContent).toBe("");
  expect(toast).not.toHaveBeenCalled();
  unmount();
});

it("asks only when the main model changes and some bots would not follow", async () => {
  bots.list.mockResolvedValue(list);
  const { rerender, unmount } = await render();
  expect(toast).not.toHaveBeenCalled();
  await rerender("s:a:two");
  expect(toast).toHaveBeenCalledWith(
    "Archie, Inbox keep their own model",
    expect.objectContaining({ action: expect.objectContaining({ label: "Use main model" }) }),
  );
  bots.update.mockResolvedValue({});
  const action = toast.mock.calls[0]![1].action as { onClick: () => void };
  await act(async () => action.onClick());
  expect(bots.update).toHaveBeenCalledTimes(2);
  // Leaving this Space's settings takes its notice with it.
  await unmount();
  expect(toast.dismiss).toHaveBeenCalledWith("space-bots-model");
});

it("still names the bots when the list fails right after the main model changes", async () => {
  bots.list.mockResolvedValueOnce(list).mockRejectedValue(new Error("offline"));
  const { rerender, unmount } = await render();
  await rerender("s:a:two");
  expect(toast).toHaveBeenCalledWith("Archie, Inbox keep their own model", expect.anything());
  unmount();
});

it("drops switched bots even when the refresh after the switch fails", async () => {
  bots.list.mockResolvedValueOnce(list).mockRejectedValue(new Error("offline"));
  bots.update.mockResolvedValue({});
  const { host, unmount } = await render();
  await act(async () => {
    button("Use main model")!.click();
  });
  expect(host.textContent).toBe("");
  unmount();
});

it("ignores a bot list that a newer one replaced", async () => {
  let finishFirst: (value: typeof list) => void = () => {};
  bots.list
    .mockImplementationOnce(() => new Promise((resolve) => (finishFirst = resolve)))
    .mockResolvedValue(following);
  const { host, rerender, unmount } = await render();
  await rerender("s:a:two");
  await act(async () => finishFirst(list));
  expect(host.textContent).toBe("");
  expect(toast).not.toHaveBeenCalled();
  unmount();
});

it("names the bots that did not switch", async () => {
  bots.list.mockResolvedValue(list);
  bots.update.mockImplementation(async ({ botId }: { botId: string }) => {
    if (botId === "b3") throw new Error("forbidden");
    return {};
  });
  const { unmount } = await render();
  await act(async () => {
    button("Use main model")!.click();
  });
  expect(toast.error).toHaveBeenCalledWith("Could not switch Inbox. Try again.");
  unmount();
});
