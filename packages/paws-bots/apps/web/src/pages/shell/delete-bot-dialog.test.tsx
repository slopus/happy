// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type { Bot } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({
  bots: {
    removePreview:
      vi.fn<(input: { botId: string }) => Promise<Array<{ id: string; name: string }>>>(),
    remove:
      vi.fn<(input: { botId: string; deleteMemories: boolean }) => Promise<{ ok: boolean }>>(),
  },
}));

vi.mock("../../lib/rpc", () => ({
  rpc,
  rpcForSpace: () => rpc,
  createSpaceRpc: () => rpc,
  selectedSpaceId: () => null,
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children: ReactNode }) => children,
    Plural: ({ value, one, other }: { value: number; one: ReactNode; other: ReactNode }) =>
      value === 1 ? one : other,
  };
});

import { DeleteBotDialog } from "./dialogs";

const baseDescription =
  "Its conversation, files, and routines will be permanently deleted. Bots it created stay in your list.";

const bot: Pick<Bot, "id" | "name"> = { id: "bot-1", name: "Ada" };

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

function dialogText() {
  return document.querySelector("[role='alertdialog']")?.textContent ?? "";
}

function deleteButton() {
  const found = [...document.querySelectorAll("button")].find(
    (element) => element.textContent === "Delete",
  );
  if (!(found instanceof HTMLButtonElement)) throw new Error("No Delete button");
  return found;
}

function isDisabled(button: HTMLButtonElement) {
  return button.disabled || button.getAttribute("aria-disabled") === "true";
}

function previewQuery() {
  const found = queryClient.getQueryCache().findAll({
    predicate: (query) => JSON.stringify(query.queryKey).includes("removePreview"),
  });
  if (found.length !== 1) throw new Error(`Expected one preview query, found ${found.length}`);
  return found[0];
}

beforeEach(() => {
  i18n.load("en", {});
  i18n.activate("en");
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  rpc.bots.removePreview.mockReset();
  rpc.bots.remove.mockReset();
  rpc.bots.remove.mockResolvedValue({ ok: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  // The dialog itself turns retry off. A client default of false would hide that.
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  container.remove();
});

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderDialog() {
  const onConfirm = async (deleteMemories: boolean) => {
    await rpc.bots.remove({ botId: bot.id, deleteMemories });
  };
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <DeleteBotDialog bot={bot} onCancel={() => undefined} onConfirm={onConfirm} />
      </QueryClientProvider>,
    );
  });
  await flush();
}

describe("DeleteBotDialog", () => {
  it("delete-bot-warns-dissolved-groups", async () => {
    let resolvePreview: (groups: Array<{ id: string; name: string }>) => void = () => undefined;
    rpc.bots.removePreview.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePreview = resolve;
        }),
    );
    await renderDialog();

    expect(isDisabled(deleteButton())).toBe(true);
    expect(dialogText()).toContain(baseDescription);
    expect(dialogText()).toContain("Delete Ada?");
    expect(dialogText()).not.toContain("Alpha");
    expect(dialogText()).not.toContain("fewer than two");
    expect(rpc.bots.remove).not.toHaveBeenCalled();

    await act(async () => {
      resolvePreview([{ id: "g1", name: "Alpha" }]);
      await vi.waitFor(() => expect(dialogText()).toContain("Alpha"));
    });

    expect(dialogText()).toContain("its messages, files, and pages");
    expect(dialogText()).toContain("Keep memories");
    expect(dialogText()).toContain("Delete memories too");
    expect(isDisabled(deleteButton())).toBe(false);
    expect(rpc.bots.remove).not.toHaveBeenCalled();
    expect(rpc.bots.removePreview.mock.calls[0]?.[0]).toEqual({ botId: "bot-1" });

    await act(async () => {
      deleteButton().click();
    });
    await vi.waitFor(() => expect(rpc.bots.remove).toHaveBeenCalledTimes(1));
    expect(rpc.bots.remove.mock.calls[0]?.[0]).toEqual({ botId: "bot-1", deleteMemories: false });
  });

  it("delete-bot-warns-dissolved-groups names every removed group", async () => {
    rpc.bots.removePreview.mockResolvedValue([
      { id: "g1", name: "Alpha" },
      { id: "g2", name: "Beta" },
    ]);
    await renderDialog();
    await vi.waitFor(() => expect(dialogText()).toContain("Beta"));
    expect(dialogText()).toContain("their messages, files, and pages");
    expect(rpc.bots.remove).not.toHaveBeenCalled();
  });

  it("delete-bot-warns-dissolved-groups leaves today's description when no group is removed", async () => {
    rpc.bots.removePreview.mockResolvedValue([]);
    await renderDialog();
    await vi.waitFor(() => {
      expect(dialogText()).toContain(baseDescription);
      expect(isDisabled(deleteButton())).toBe(false);
    });
    expect(dialogText()).not.toContain("deleted too");
    expect(dialogText()).not.toContain("fewer than two");
    expect(rpc.bots.remove).not.toHaveBeenCalled();
  });

  it("delete-bot-warns-dissolved-groups warns in general when the preview fails", async () => {
    rpc.bots.removePreview.mockRejectedValue(new Error("offline"));
    await renderDialog();
    await vi.waitFor(() => expect(dialogText()).toContain("fewer than two bots"));
    expect(previewQuery()?.options.retry).toBe(false);
    expect(rpc.bots.removePreview).toHaveBeenCalledTimes(1);
    expect(dialogText()).toContain("messages, files, and pages");
    expect(dialogText()).toContain(baseDescription);
    expect(isDisabled(deleteButton())).toBe(false);
    expect(rpc.bots.remove).not.toHaveBeenCalled();
    await act(async () => {
      deleteButton().click();
    });
    await vi.waitFor(() => expect(rpc.bots.remove).toHaveBeenCalledTimes(1));
  });
});
