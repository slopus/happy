// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PublicPageShell } from "./PublicPageShell";

const copy = vi.hoisted(() => ({ failed: false }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: String.raw }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../lib/copy-text", () => ({ useCopyText: () => [false, () => {}, copy.failed] }));
vi.mock("./PageFrame", () => ({
  PageFrame: ({ onHeight }: { onHeight: (height: number) => void }) => {
    useEffect(() => onHeight(2100), [onHeight]);
    return <div data-testid="page-document" />;
  },
}));

afterEach(() => {
  copy.failed = false;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it.each([false, true])(
  "keeps shared-page scrolling separate from chrome (copy failure: %s)",
  async (failed) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    copy.failed = failed;
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () =>
      root.render(<PublicPageShell title="Guide" document="<h2>Details</h2>" />),
    );
    const frame = document.querySelector('[data-testid="page-document"]')!;
    const scroll = frame.closest(".overflow-auto");
    expect(scroll).not.toBeNull();
    expect(scroll?.contains(document.querySelector("header"))).toBe(false);
    expect(scroll?.classList.contains("min-h-32")).toBe(true);
    expect(scroll?.classList.contains("print:overflow-visible")).toBe(true);
    expect((frame.parentElement as HTMLElement).style.height).toBe("2100px");
    const shell = document.querySelector("[data-page-print]")!;
    expect(shell.classList.contains("h-full")).toBe(true);
    expect(shell.classList.contains("print:h-auto")).toBe(true);
    if (failed) {
      const fallback = document.querySelector('input[aria-label="Page link"]');
      expect(fallback).not.toBeNull();
      expect(scroll?.contains(fallback)).toBe(false);
    }
    await act(async () => root.unmount());
  },
);
