// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useRedrawAtMidnight } from "./use-redraw-at-midnight";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.useRealTimers();
});

it("redraws once at each local midnight and not before", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 1, 23, 58));
  let renders = 0;
  function Probe() {
    useRedrawAtMidnight();
    renders += 1;
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Probe)));
  const initial = renders;

  await act(async () => vi.advanceTimersByTime(60_000));
  expect(renders).toBe(initial);
  await act(async () => vi.advanceTimersByTime(60_000));
  expect(renders).toBe(initial + 1);
  await act(async () => vi.advanceTimersByTime(24 * 60 * 60_000));
  expect(renders).toBe(initial + 2);

  await act(async () => root.unmount());
  expect(vi.getTimerCount()).toBe(0);
});
