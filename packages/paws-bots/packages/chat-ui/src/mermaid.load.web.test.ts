// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const mermaid = {
  initialize: vi.fn(),
  parse: vi.fn(async () => true),
  render: vi.fn(async () => ({ svg: "<svg/>" })),
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  vi.resetAllMocks();
  mermaid.parse.mockResolvedValue(true);
  mermaid.render.mockResolvedValue({ svg: "<svg/>" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock("mermaid");
});

describe("Mermaid render timeout", () => {
  it("times out a hung load and lets the next diagram load and render", async () => {
    const loadGate = deferred();
    const loadStarted = deferred();
    vi.doMock("mermaid", async () => {
      loadStarted.resolve();
      await loadGate.promise;
      return { default: mermaid };
    });
    const { renderMermaidSvg, MERMAID_RENDER_TIMEOUT_MS } = await import("./mermaid.web");
    const stuck = renderMermaidSvg("graph LR; A-->B", "dark");
    await loadStarted.promise;
    await vi.advanceTimersByTimeAsync(MERMAID_RENDER_TIMEOUT_MS);
    await expect(stuck).resolves.toBeNull();
    expect(mermaid.render).not.toHaveBeenCalled();

    loadGate.resolve();
    await expect(renderMermaidSvg("graph LR; B-->C", "dark")).resolves.toBe("<svg/>");
    // The timed-out source is retried too, rather than remembered as invalid.
    await expect(renderMermaidSvg("graph LR; A-->B", "dark")).resolves.toBe("<svg/>");
    expect(mermaid.render).toHaveBeenCalledTimes(2);
  });
});
