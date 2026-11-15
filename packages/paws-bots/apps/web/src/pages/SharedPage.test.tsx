// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SharedPagePage } from "./SharedPage";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../lib/pages", () => ({
  usePageDocument: () => ({ document: null, failed: false, retry: () => undefined }),
}));
vi.mock("../components/pages/PublicPageShell", () => ({
  PublicPageShell: ({ title }: { title: string }) => createElement("h1", {}, title),
}));

async function settle() {
  for (let tick = 0; tick < 10; tick++) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it("keeps the page being read when a background refresh fails", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient();
  const token = "a".repeat(43);
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ title: "Plan", code: "" })));
  await act(async () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          MemoryRouter,
          { initialEntries: [`/p/plan-${token}`] },
          createElement(
            Routes,
            {},
            createElement(Route, { path: "/p/:slugToken", element: createElement(SharedPagePage) }),
          ),
        ),
      ),
    ),
  );
  await settle();
  expect(container.querySelector("h1")?.textContent).toBe("Plan");

  fetch.mockResolvedValueOnce(new Response("", { status: 503 }));
  await act(async () => {
    await client.refetchQueries().catch(() => undefined);
  });
  await settle();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(container.querySelector("h1")?.textContent).toBe("Plan");
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
