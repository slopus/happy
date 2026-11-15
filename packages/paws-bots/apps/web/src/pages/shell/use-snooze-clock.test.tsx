// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useSnoozeClock } from "./use-snooze-clock";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.useRealTimers();
});

it("moves to a wake that passed before the roster brought it in", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-07T12:00:00Z"));
  let seen = 0;
  function Probe({ snoozedUntil }: { snoozedUntil: string | null }) {
    seen = useSnoozeClock([{ snoozedUntil }]);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Probe, { snoozedUntil: null })));
  const start = seen;

  // Five minutes on, a refresh brings a snooze that ended a minute ago.
  vi.setSystemTime(new Date("2026-11-07T12:05:00Z"));
  await act(async () =>
    root.render(createElement(Probe, { snoozedUntil: "2026-11-07T12:04:00.000Z" })),
  );
  await act(async () => vi.advanceTimersByTime(0));

  expect(seen).toBeGreaterThan(Date.parse("2026-11-07T12:04:00.000Z"));
  expect(seen).toBeGreaterThan(start);
  await act(async () => root.unmount());
});
