// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
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
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
}));

import { QueryUserProvider } from "../lib/query";
import { TrustedLinkSitesSettings } from "./TrustedLinkSitesSettings";

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

async function render() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <QueryUserProvider value="user-1">
          <TrustedLinkSitesSettings />
        </QueryUserProvider>
      </QueryClientProvider>,
    );
  });
  return {
    container,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it("lists trusted sites and removes one", async () => {
  rpcMock.trustedLinkSites.list.mockResolvedValue(["alice.github.io", "example.com"]);
  rpcMock.trustedLinkSites.remove.mockResolvedValue({ ok: true });
  const view = await render();
  const rows = () =>
    [...view.container.querySelectorAll("[data-testid='trusted-link-sites'] span")].map(
      (row) => row.textContent,
    );
  await vi.waitFor(() => expect(rows()).toEqual(["alice.github.io", "example.com"]));
  expect(view.container.textContent).toContain("Trusted sites");

  const removes = [...view.container.querySelectorAll("button")];
  expect(removes.map((button) => button.getAttribute("aria-label"))).toEqual([
    "Remove alice.github.io",
    "Remove example.com",
  ]);
  expect(removes.map((button) => button.textContent)).toEqual(["Remove", "Remove"]);
  const remove = removes[1];
  await act(async () => remove?.click());
  expect(rpcMock.trustedLinkSites.remove).toHaveBeenCalledWith({ site: "example.com" });
  await vi.waitFor(() => expect(rows()).toEqual(["alice.github.io"]));
  await view.cleanup();
});

it("shows nothing while no site is trusted", async () => {
  rpcMock.trustedLinkSites.list.mockResolvedValue([]);
  const view = await render();
  await vi.waitFor(() => expect(rpcMock.trustedLinkSites.list).toHaveBeenCalled());
  expect(view.container.innerHTML).toBe("");
  await view.cleanup();
});
