// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readBotsSidebarWidth } from "../../lib/bots-sidebar-pref";
import { useSidebarResize } from "./use-sidebar-resize";

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let current: ReturnType<typeof useSidebarResize>;
const commitCollapsed = vi.fn();

function Harness({ userId = "user" }: { userId?: string }) {
  const [collapsed, setCollapsed] = useState(false);
  current = useSidebarResize({
    userId,
    collapsed,
    onCollapsedChange: (value) => {
      commitCollapsed(value);
      setCollapsed(value);
    },
    onPreviewCollapsedChange: setCollapsed,
  });
  return <hr {...current.handleProps} aria-label="Resize bots" data-collapsed={collapsed} />;
}

beforeEach(async () => {
  localStorage.clear();
  commitCollapsed.mockClear();
  vi.stubGlobal("innerWidth", 1200);
  host = document.createElement("div");
  root = createRoot(host);
  await act(async () => root.render(<Harness />));
  const handle = host.querySelector("hr")!;
  handle.setPointerCapture = vi.fn();
  handle.hasPointerCapture = vi.fn(() => true);
  handle.releasePointerCapture = vi.fn();
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.documentElement.dir = "";
  vi.unstubAllGlobals();
});

async function pointer(type: string, x: number) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, button: 0 });
  Object.defineProperty(event, "pointerId", { value: 1 });
  await act(async () => host.querySelector("hr")!.dispatchEvent(event));
}
async function key(value: string) {
  await act(async () =>
    host
      .querySelector("hr")!
      .dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: value })),
  );
}

it("previews every drag position, commits an expanded width, and remembers it through mini mode", async () => {
  await pointer("pointerdown", 316);
  await pointer("pointermove", 400);
  expect(current.width).toBe(400);
  expect(current.resizing).toBe(true);
  expect(readBotsSidebarWidth("user")).toBe(316);
  await pointer("pointerup", 400);
  expect(current.resizing).toBe(false);
  expect(readBotsSidebarWidth("user")).toBe(400);
  await key("Home");
  expect(current.width).toBe(72);
  await key("Enter");
  expect(current.width).toBe(400);
});

it("snaps a narrow drag to mini and expands a mini drag to the expanded minimum", async () => {
  await pointer("pointerdown", 316);
  await pointer("pointermove", 130);
  expect(current.width).toBe(72);
  expect(host.querySelector("hr")?.getAttribute("data-collapsed")).toBe("true");
  await pointer("pointerup", 130);
  expect(current.width).toBe(72);
  await pointer("pointerdown", 72);
  await pointer("pointermove", 180);
  await pointer("pointerup", 180);
  expect(current.width).toBe(240);
});

it("cancels a drag without changing its saved width", async () => {
  await pointer("pointerdown", 316);
  await pointer("pointermove", 450);
  await pointer("pointercancel", 450);
  expect(current.width).toBe(316);
  expect(readBotsSidebarWidth("user")).toBe(316);
  expect(current.resizing).toBe(false);
});

it("resizes pointer and keyboard gestures in the visual direction for RTL", async () => {
  document.documentElement.dir = "rtl";
  await key("ArrowLeft");
  expect(current.width).toBe(348);
  await pointer("pointerdown", 852);
  await pointer("pointermove", 800);
  await pointer("pointerup", 800);
  expect(current.width).toBe(400);
  await key("ArrowRight");
  expect(current.width).toBe(368);
  await key("Home");
  await key("ArrowLeft");
  expect(current.width).toBe(240);
  await key("ArrowRight");
  expect(current.width).toBe(72);
});

it("limits the sidebar on viewport resize without discarding the preferred width", async () => {
  await key("End");
  expect(current.width).toBe(480);
  vi.stubGlobal("innerWidth", 768);
  await act(async () => window.dispatchEvent(new Event("resize")));
  expect(current.width).toBe(448);
  expect(readBotsSidebarWidth("user")).toBe(480);
  vi.stubGlobal("innerWidth", 1200);
  await act(async () => window.dispatchEvent(new Event("resize")));
  expect(current.width).toBe(480);
  await act(async () => root.render(<Harness userId="another-user" />));
  expect(current.width).toBe(316);
});

it("does not treat a drag back to its starting point as a toggle", async () => {
  await pointer("pointerdown", 316);
  await pointer("pointermove", 400);
  await pointer("pointermove", 316);
  await pointer("pointerup", 316);
  expect(current.width).toBe(316);
  expect(host.querySelector("hr")?.getAttribute("data-collapsed")).toBe("false");
});

it.each(["ltr", "rtl"])("snaps layout and width together while held (%s)", async (dir) => {
  document.documentElement.dir = dir;
  const physicalX = (x: number) => (dir === "rtl" ? 1200 - x : x);
  await key("Home");
  commitCollapsed.mockClear();
  await pointer("pointerdown", physicalX(72));
  for (const [x, expectedWidth, expectedMini] of [
    [120, 72, true],
    [180, 240, false],
    [165, 240, false],
    [140, 72, true],
    [165, 72, true],
    [260, 260, false],
  ] as const) {
    await pointer("pointermove", physicalX(x));
    expect(current.width).toBe(expectedWidth);
    expect(host.querySelector("hr")?.getAttribute("data-collapsed")).toBe(String(expectedMini));
    expect(commitCollapsed).not.toHaveBeenCalled();
    expect(readBotsSidebarWidth("user")).toBe(316);
  }
  await pointer("pointerup", physicalX(260));
  expect(commitCollapsed).toHaveBeenLastCalledWith(false);
  expect(readBotsSidebarWidth("user")).toBe(260);
});

it("restores the starting mode and width when a snap is cancelled or capture is lost", async () => {
  await pointer("pointerdown", 316);
  await pointer("pointermove", 120);
  expect(current.width).toBe(72);
  await pointer("pointercancel", 120);
  expect(current.width).toBe(316);
  expect(host.querySelector("hr")?.getAttribute("data-collapsed")).toBe("false");
  expect(commitCollapsed).not.toHaveBeenCalled();
  await key("Home");
  commitCollapsed.mockClear();
  await pointer("pointerdown", 72);
  await pointer("pointermove", 300);
  expect(current.width).toBe(300);
  await pointer("lostpointercapture", 300);
  expect(current.width).toBe(72);
  expect(host.querySelector("hr")?.getAttribute("data-collapsed")).toBe("true");
  expect(commitCollapsed).not.toHaveBeenCalled();
  expect(readBotsSidebarWidth("user")).toBe(316);
});
