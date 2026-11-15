// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IntegrationSetup } from "./IntegrationSetup";

const api = vi.hoisted(() => ({ capabilities: { catalogSearch: vi.fn() } }));

vi.mock("../../lib/rpc", () => ({ rpc: api }));
vi.mock("../../lib/mcp-connect", () => ({ connectMcpOauth: vi.fn() }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, i) => text + (i ? String(values[i - 1]) : "") + part, ""),
  }),
}));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.capabilities.catalogSearch.mockReset().mockResolvedValue({ enabled: true, results: [] });
  host = document.createElement("div");
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it("does not search on open without a query", async () => {
  await act(async () =>
    root.render(
      <StrictMode>
        <IntegrationSetup />
      </StrictMode>,
    ),
  );
  expect(host.querySelector("input")?.value).toBe("");
  expect(host.textContent).not.toContain("No remote MCP servers found");
  expect(api.capabilities.catalogSearch).not.toHaveBeenCalled();
});

it("searches the public catalog once for a query it opens with", async () => {
  await act(async () =>
    root.render(
      <StrictMode>
        <IntegrationSetup initialQuery="canva" />
      </StrictMode>,
    ),
  );
  await vi.waitFor(() => expect(host.textContent).toContain("No remote MCP servers found"));
  expect(host.querySelector("input")?.value).toBe("canva");
  expect(api.capabilities.catalogSearch.mock.calls).toEqual([
    [{ query: "canva", usePublicCatalog: true }],
  ]);
});
