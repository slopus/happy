// @vitest-environment jsdom

import { ChatMarkdown } from "@rakazo/chat-ui/web";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const rpcMock = vi.hoisted(() => ({
  trustedLinkSites: { list: vi.fn(), trust: vi.fn(), remove: vi.fn() },
}));
vi.mock("../lib/rpc", () => ({
  rpc: rpcMock,
  rpcForSpace: () => rpcMock,
  createSpaceRpc: () => rpcMock,
  selectedSpaceId: () => null,
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    String.raw({ raw: parts }, ...values);
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

import { QueryUserProvider } from "../lib/query";
import { MarkdownLinkPrompt } from "./markdown-link-prompt";

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function render(userId: string | null) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <QueryUserProvider value={userId}>
          <MarkdownLinkPrompt>
            <ChatMarkdown>
              {"[Docs](https://docs.example.test/a) [Blog](https://blog.example.test/b)"}
            </ChatMarkdown>
          </MarkdownLinkPrompt>
        </QueryUserProvider>
      </QueryClientProvider>,
    );
  });
  const links = () => [...container.querySelectorAll("a")];
  const button = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("[role='alertdialog'] button")].find(
      (element) => element.textContent === name,
    );
  return {
    links,
    button,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it("trusts a site from the prompt, then opens its links directly", async () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  rpcMock.trustedLinkSites.list.mockResolvedValue([]);
  rpcMock.trustedLinkSites.trust.mockResolvedValue({ site: "example.test" });
  const view = await render("user-1");
  await vi.waitFor(() => expect(rpcMock.trustedLinkSites.list).toHaveBeenCalled());

  await act(async () => view.links()[0]?.click());
  await act(async () => view.button("Always open example.test")?.click());
  expect(open).toHaveBeenCalledWith("https://docs.example.test/a", "_blank", "noopener,noreferrer");
  expect(rpcMock.trustedLinkSites.trust).toHaveBeenCalledWith({
    url: "https://docs.example.test/a",
  });

  // Another page of the same site now skips the prompt.
  let prevented: boolean | undefined;
  const record = (event: MouseEvent) => {
    prevented = event.defaultPrevented;
    event.preventDefault();
  };
  document.addEventListener("click", record);
  // Query updates reach components on a timer; let the saved site land.
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  await act(async () => view.links()[1]?.click());
  expect(prevented).toBe(false);
  expect(document.querySelector("[role='alertdialog']")).toBeNull();
  document.removeEventListener("click", record);
  await view.cleanup();
});

it("asks without the third button before sign-in", async () => {
  const view = await render(null);
  await act(async () => view.links()[0]?.click());
  expect(view.button("Open")).toBeDefined();
  expect(document.querySelectorAll("[role='alertdialog'] button")).toHaveLength(2);
  expect(rpcMock.trustedLinkSites.list).not.toHaveBeenCalled();
  await act(async () => view.button("Cancel")?.click());
  await view.cleanup();
});
