// @vitest-environment jsdom

import type { McpServerHealth } from "@rakazo/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The macros compile away in the app build; tests run the source, so expand them by hand.
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: unknown }) => children,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
    (value === 1 ? one : other).replace("#", String(value)),
}));
vi.mock("../lib/relative-time", () => ({ formatRelativeTime: () => "5m ago" }));

import { McpServerHealthLine } from "./McpServerHealthLine";

const base: McpServerHealth = {
  status: "unknown",
  message: null,
  toolCount: null,
  checkedAt: null,
};
const render = (health: Partial<McpServerHealth>) =>
  renderToStaticMarkup(<McpServerHealthLine health={{ ...base, ...health }} />);

describe("McpServerHealthLine", () => {
  it("shows nothing when the server works", () => {
    expect(render({ status: "ok", toolCount: 12 })).toBe("");
  });

  it("says a test is checking the connection until the server reports installing", () => {
    const checking = (health: Partial<McpServerHealth>) =>
      renderToStaticMarkup(<McpServerHealthLine health={{ ...base, ...health }} checking />);
    for (const status of ["unknown", "ok", "error"] as const) {
      const html = checking({ status, toolCount: 3, message: "boom" });
      expect(html).toContain('data-status="checking"');
      expect(html).toContain("Checking connection…");
      expect(html).not.toContain("boom");
    }
    expect(checking({ status: "installing" })).toContain('data-status="installing"');
  });

  it("shows a spinner while installing", () => {
    const html = render({ status: "installing" });
    expect(html).toContain('data-status="installing"');
    expect(html).toContain("animate-spin");
    expect(html).toContain("Installing…");
  });

  it("puts the failure log in a collapsed, left-to-right, scrollable block", () => {
    const html = render({ status: "error", message: "npm ERR! 404\n  at <script>" });
    expect(html).toContain("Not working");
    expect(html).toContain('data-testid="mcp-health-details"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/<pre dir="ltr"[^>]*max-h-40[^>]*overflow-auto/);
    // Raw log text is escaped, never interpreted as markup.
    expect(html).toContain("&lt;script&gt;");
  });

  it("omits the details disclosure when there is no message", () => {
    expect(render({ status: "error" })).not.toContain('data-testid="mcp-health-details"');
  });

  it("says so when the server was never checked", () => {
    expect(render({ status: "unknown" })).toContain("Not checked yet");
  });
});
