// @vitest-environment jsdom

import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatMarkdown } from "./markdown.web";

// jsdom cannot lay out SVG, so Mermaid itself is replaced. The browser spec draws real diagrams.
const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  parse: vi.fn(async (source: string) => !source.includes("BROKEN")),
  render: vi.fn(async (_id: string, source: string) => ({
    svg: `<svg width="100%" viewBox="0 0 120 40"><text>${source}</text></svg>`,
  })),
}));
vi.mock("mermaid", () => ({ default: mermaid }));

let container: HTMLDivElement;
let root: Root;
let sourceCount = 0;

/** A diagram no earlier test drew, so the render cache cannot answer for it. */
function freshDiagram() {
  sourceCount += 1;
  return `graph LR\n  A${sourceCount} --> B${sourceCount}`;
}

async function render(markdown: string, streaming = false) {
  await act(async () => {
    root.render(<ChatMarkdown streaming={streaming}>{markdown}</ChatMarkdown>);
  });
  // Mermaid loads and draws asynchronously.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  delete document.documentElement.dataset.theme;
  vi.clearAllMocks();
});

describe("web markdown diagrams", () => {
  it("draws a mermaid fence as an image where the code block was", async () => {
    const source = freshDiagram();
    await render(`Before\n\n\`\`\`mermaid\n${source}\n\`\`\`\n\nAfter`);

    const figure = container.querySelector('[data-testid="chat-diagram"]');
    const image = figure?.querySelector("img");
    expect(image?.getAttribute("src")).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    expect(image?.getAttribute("width")).toBe("120");
    expect(image?.getAttribute("alt")).toBe("Diagram");
    expect(container.querySelector("pre")).toBeNull();
    expect(container.textContent).toMatch(/Before[\s\S]*After/);
    expect(mermaid.render).toHaveBeenCalledWith(expect.stringMatching(/^rk-mermaid-/), source);
  });

  it("draws a diagram repeated in one message once", async () => {
    const fence = `\`\`\`mermaid\n${freshDiagram()}\n\`\`\``;
    await render(`${fence}\n\n${fence}`);
    expect(container.querySelectorAll('[data-testid="chat-diagram"] img')).toHaveLength(2);
    expect(mermaid.render).toHaveBeenCalledTimes(1);
  });

  it("configures Mermaid strictly, in the page's theme", async () => {
    document.documentElement.dataset.theme = "light";
    await render(`\`\`\`mermaid\n${freshDiagram()}\n\`\`\``);
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: "strict", htmlLabels: false, darkMode: false }),
    );
  });

  it("keeps the code block when Mermaid cannot parse the source", async () => {
    await render("```mermaid\ngraph LR\n  BROKEN -->\n```");
    expect(container.querySelector('[data-testid="chat-diagram"]')).toBeNull();
    expect(container.querySelector("pre")?.textContent).toContain("BROKEN -->");
    expect(mermaid.render).not.toHaveBeenCalled();
  });

  it("keeps the code block when Mermaid fails to load or draw", async () => {
    mermaid.render.mockRejectedValueOnce(new Error("layout failed"));
    await render(`\`\`\`mermaid\n${freshDiagram()}\n\`\`\``);
    expect(container.querySelector('[data-testid="chat-diagram"]')).toBeNull();
    expect(container.querySelector("pre")?.textContent).toContain("graph LR");
  });

  it("shows a fence still being streamed as code, and draws it once it closes", async () => {
    const source = freshDiagram();
    await render(`Drafting\n\n\`\`\`mermaid\n${source}`, true);
    expect(container.querySelector('[data-testid="chat-diagram"]')).toBeNull();
    expect(container.querySelector("pre")?.textContent).toContain(source);
    expect(mermaid.parse).not.toHaveBeenCalled();

    await render(`Drafting\n\n\`\`\`mermaid\n${source}\n\`\`\`\n\nmore`, true);
    expect(container.querySelector('[data-testid="chat-diagram"] img')).not.toBeNull();
  });

  it.each([
    ["blockquote", "> ", "> "],
    ["nested blockquote", "> > ", "> > "],
    ["list", "- ", "  "],
    ["quoted list", "> - ", ">   "],
  ])("waits for a streaming fence inside a %s to close", async (_name, first, rest) => {
    const source = freshDiagram();
    const open = `${first}\`\`\`mermaid\n${source
      .split("\n")
      .map((line) => rest + line)
      .join("\n")}`;
    await render(open, true);
    expect(container.querySelector("pre")?.textContent).toContain(source);
    expect(mermaid.parse).not.toHaveBeenCalled();

    await render(`${open}\n${rest}\`\`\`\n\nMore`, true);
    expect(container.querySelector('[data-testid="chat-diagram"] img')).not.toBeNull();
    expect(mermaid.render).toHaveBeenCalledTimes(1);
  });

  it("leaves other fences and empty mermaid fences as code", async () => {
    await render("```ts\nconst a = 1;\n```\n\n```mermaid\n\n```");
    expect(container.querySelectorAll("pre")).toHaveLength(2);
    expect(mermaid.parse).not.toHaveBeenCalled();
  });

  it("redraws in the new palette when the theme changes", async () => {
    await render(`\`\`\`mermaid\n${freshDiagram()}\n\`\`\``);
    expect(mermaid.initialize).toHaveBeenLastCalledWith(
      expect.objectContaining({ darkMode: true }),
    );
    await act(async () => {
      document.documentElement.dataset.theme = "light";
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mermaid.initialize).toHaveBeenLastCalledWith(
      expect.objectContaining({ darkMode: false }),
    );
    expect(container.querySelector('[data-testid="chat-diagram"] img')).not.toBeNull();
  });
});
