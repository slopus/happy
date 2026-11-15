import { describe, expect, it } from "vitest";
import { reconcileThreadScrollState } from "./thread-scroll.js";

describe("thread scroll state publication", () => {
  const states = [
    { detached: false, unread: false },
    { detached: false, unread: true },
    { detached: true, unread: false },
    { detached: true, unread: true },
  ];

  for (const previous of states) {
    for (const next of states) {
      it(`preserves identity only for unchanged booleans: ${JSON.stringify(previous)} → ${JSON.stringify(next)}`, () => {
        const snapshot = Object.freeze({ ...next });
        const unchanged = previous.detached === next.detached && previous.unread === next.unread;
        expect(reconcileThreadScrollState(previous, snapshot)).toBe(
          unchanged ? previous : snapshot,
        );
        expect(snapshot).toEqual(next);
      });
    }
  }
});
