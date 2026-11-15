// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RakazoDesktop } from "./desktop";
import { useDesktopBadge } from "./use-desktop-badge";

let root: Root;
const set = vi.fn(async () => true);
function Harness({ count, signedIn = true }: { count: number; signedIn?: boolean }) {
  useDesktopBadge(signedIn ? count : 0);
  return null;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  set.mockReset().mockResolvedValue(true);
  window.rakazoDesktop = { badge: { set } } as unknown as RakazoDesktop;
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root.unmount());
  delete window.rakazoDesktop;
  vi.unstubAllGlobals();
});

it("deduplicates counts and clears when the last chat is read", () => {
  for (const count of [2, 2, 1, 0, 0]) act(() => root.render(<Harness count={count} />));
  expect(set.mock.calls).toEqual([[2], [1], [0]]);
  act(() => root.render(null));
  expect(set.mock.calls).toEqual([[2], [1], [0]]);
});

it("clears on sign-out even if roster data remains", () => {
  act(() => root.render(<Harness count={3} />));
  act(() => root.render(<Harness count={3} signedIn={false} />));
  expect(set.mock.calls).toEqual([[3], [0]]);
});

it("clears on unmount and tolerates rejected IPC calls", async () => {
  set.mockRejectedValue(new Error("Window closed"));
  await act(async () => root.render(<Harness count={4} />));
  await act(async () => root.render(null));
  expect(set.mock.calls).toEqual([[4], [0]]);
});

it.each([undefined, {} as RakazoDesktop])(
  "does nothing without the optional badge bridge (%s)",
  (bridge) => {
    window.rakazoDesktop = bridge;
    act(() => root.render(<Harness count={2} />));
    act(() => root.render(<Harness count={0} />));
    act(() => root.render(null));
    expect(set).not.toHaveBeenCalled();
  },
);
