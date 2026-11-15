// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PageView } from "./PageView";

const frame = vi.hoisted(() => ({ drawn: undefined as (() => void) | undefined }));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ i18n: { locale: "en" }, t: String.raw }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./PageFrame", () => ({
  PageFrame: ({ onHeight }: { onHeight: () => void }) => {
    frame.drawn = onHeight;
    return <iframe title="page" />;
  },
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function mount(props: {
  document: string;
  onOpenChange?: (open: boolean) => void;
  compact?: boolean;
  onRename?: (title: string) => void;
}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  const render = (next: typeof props) =>
    act(async () =>
      root.render(
        <PageView
          open
          onOpenChange={next.onOpenChange ?? (() => {})}
          compact={next.compact}
          onRename={next.onRename}
          title="Plan"
          document={next.document}
          share={<button type="button">Share</button>}
        />,
      ),
    );
  return { render, unmount: () => act(() => root.unmount()) };
}

it("waits for an updated page to draw, and offers a retry when it never does", async () => {
  vi.useFakeTimers();
  const view = mount({ document: "<p>v1</p>" });
  await view.render({ document: "<p>v1</p>" });
  await act(async () => frame.drawn?.());
  expect(document.body.textContent).not.toContain("This page couldn't load");

  await view.render({ document: "<p>v2</p>" });
  await act(async () => vi.advanceTimersByTime(16_000));
  expect(document.body.textContent).toContain("This page couldn't load");
  await view.unmount();
});

it("closes on Escape unless the key landed in a popup", async () => {
  const onOpenChange = vi.fn();
  const view = mount({ document: "<p>v1</p>", onOpenChange });
  await view.render({ document: "<p>v1</p>", onOpenChange });
  // A menu elsewhere in the app, open but not where the key went.
  const menu = document.body.appendChild(document.createElement("div"));
  menu.dataset.slot = "dropdown-menu-content";
  const press = (target: Element) =>
    act(async () => {
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
  await press(document.querySelector('[data-testid="page-view"]')!);
  expect(onOpenChange).toHaveBeenLastCalledWith(false);

  onOpenChange.mockClear();
  const item = menu.appendChild(document.createElement("button"));
  await press(item);
  expect(onOpenChange).not.toHaveBeenCalled();
  await view.unmount();
});

it("keeps its controls clickable over the window's drag areas in the desktop app", async () => {
  const view = mount({ document: "<p>v1</p>" });
  await view.render({ document: "<p>v1</p>" });
  // Electron applies drag areas through anything drawn on top, so the page opts out of them and
  // drags the window only by the strip above it.
  const page = document.querySelector('[data-testid="page-view"]')!;
  expect(page.className).toContain("app-no-drag");
  const close = document.querySelector('[aria-label="Close page"]')!;
  expect(close.className).toContain("app-no-drag");
  const titlePill = [...document.querySelectorAll("button")].find((b) => b.textContent === "Plan");
  expect(titlePill?.className).toContain("app-no-drag");
  expect(page.querySelectorAll(".app-drag")).toHaveLength(1);
  await view.unmount();
  document.body.replaceChildren();

  // A touch screen gets the larger controls and still a strip to drag a frameless window by.
  const touch = mount({ document: "<p>v1</p>", compact: true });
  await touch.render({ document: "<p>v1</p>", compact: true });
  expect(document.querySelectorAll(".app-drag")).toHaveLength(1);
  expect(document.querySelector('[aria-label="Close page"]')!.className).toContain("app-no-drag");
  await touch.unmount();
});

it("starts its top row below the macOS window controls in the desktop app", async () => {
  window.rakazoDesktop = { platform: "darwin" } as never;
  const mac = mount({ document: "<p>v1</p>" });
  await mac.render({ document: "<p>v1</p>" });
  const close = document.querySelector<HTMLElement>('[aria-label="Close page"]')!;
  expect(close.className).toContain("top-[42px]");
  // 72px traffic-light strip plus the 11px browser inset.
  expect(close.style.left).toBe("83px");
  expect(document.querySelector(".app-drag")!.className).toContain("h-[70px]");
  await mac.unmount();
  document.body.replaceChildren();
  delete window.rakazoDesktop;
  vi.unstubAllGlobals();

  const browser = mount({ document: "<p>v1</p>" });
  await browser.render({ document: "<p>v1</p>" });
  const browserClose = document.querySelector<HTMLElement>('[aria-label="Close page"]')!;
  expect(browserClose.className).toContain("top-[6px]");
  expect(browserClose.style.left).toBe("11px");
  await browser.unmount();
});

it.each([
  { key: "Enter", isComposing: true },
  { key: "Escape", isComposing: true },
  { key: "Enter", keyCode: 229 },
  { key: "Escape", keyCode: 229 },
])("keeps title editing open during IME composition (%o)", async (keyboard) => {
  const onRename = vi.fn();
  const onOpenChange = vi.fn();
  const props = { document: "<p>v1</p>", onRename, onOpenChange };
  const view = mount(props);
  await view.render(props);
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[title="Rename"]')!.click();
  });
  const input = document.querySelector<HTMLInputElement>('[aria-label="Page title"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "计划");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...keyboard }));
  });
  expect(document.querySelector('[aria-label="Page title"]')).toBe(input);
  expect(input.value).toBe("计划");
  expect(onRename).not.toHaveBeenCalled();
  expect(onOpenChange).not.toHaveBeenCalled();
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: keyboard.key }));
  });
  expect(document.querySelector('[aria-label="Page title"]')).toBeNull();
  if (keyboard.key === "Enter") expect(onRename).toHaveBeenCalledWith("计划");
  else expect(onRename).not.toHaveBeenCalled();
  expect(onOpenChange).not.toHaveBeenCalled();
  await view.unmount();
});
