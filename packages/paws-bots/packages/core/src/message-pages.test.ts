import { describe, expect, it } from "vitest";
import {
  appendNewerThreadPage,
  forwardProbeAfterPage,
  leaveThreadWindow,
  openThreadWindow,
  prependThreadHistoryPage,
  threadWindowMessages,
  upsertMessageById,
} from "./message-pages.js";

type Message = { id: string; seq?: number };

const range = (from: number, to: number): Message[] =>
  Array.from({ length: to - from + 1 }, (_, index) => ({
    id: `m${from + index}`,
    seq: from + index,
  }));
const page = (from: number, to: number) => ({
  threadId: "thread",
  messages: range(from, to),
  olderCursor: from > 0 ? from : null,
});
const ids = (messages: readonly Message[]) => messages.map((message) => message.id);
// The latest page plus a reply streaming in.
const latest = () => ({
  ...page(200, 299),
  cursor: 7,
  messages: [...range(200, 299), { id: "progress:run" }],
});

describe("thread windows", () => {
  it("opens an older page without showing the gap to the latest messages", () => {
    const opened = openThreadWindow(latest(), page(25, 124));

    expect(opened.newerCursor).toBe(124);
    expect(opened.snapshot.cursor).toBe(7);
    expect(opened.snapshot.olderCursor).toBe(25);
    expect(ids(threadWindowMessages(opened.snapshot.messages, opened.newerCursor))).toEqual(
      ids(range(25, 124)),
    );
  });

  it("joins a page that reaches the latest messages right away", () => {
    const opened = openThreadWindow(latest(), page(150, 249));

    expect(opened.newerCursor).toBeNull();
    expect(ids(threadWindowMessages(opened.snapshot.messages, opened.newerCursor))).toEqual([
      ...ids(range(150, 299)),
      "progress:run",
    ]);
  });

  it("pages forward to the latest messages without gaps, duplicates or early live rows", () => {
    let window = openThreadWindow(latest(), page(25, 124));
    // A message created live while reading older history, before any forward page.
    window = {
      ...window,
      snapshot: {
        ...window.snapshot,
        messages: upsertMessageById(window.snapshot.messages, { id: "live" }),
      },
    };
    expect(ids(threadWindowMessages(window.snapshot.messages, window.newerCursor))).not.toContain(
      "live",
    );

    // Pages come back centered on the requested seq, so each overlaps the last one.
    window = appendNewerThreadPage(window.snapshot, window.newerCursor!, page(75, 174));
    expect(window.newerCursor).toBe(174);
    expect(ids(threadWindowMessages(window.snapshot.messages, window.newerCursor))).toEqual(
      ids(range(25, 174)),
    );

    window = appendNewerThreadPage(window.snapshot, window.newerCursor!, page(125, 224));
    expect(window.newerCursor).toBeNull();
    expect(ids(threadWindowMessages(window.snapshot.messages, window.newerCursor))).toEqual([
      ...ids(range(25, 299)),
      "progress:run",
      "live",
    ]);
  });

  it("keeps the cursor when a forward page adds nothing past an unscanned gap", () => {
    const opened = openThreadWindow(latest(), page(25, 124));
    const next = appendNewerThreadPage(opened.snapshot, 124, page(74, 124), 174);

    expect(next.newerCursor).toBe(124);
    expect(next.snapshot).toBe(opened.snapshot);
    expect(ids(threadWindowMessages(next.snapshot.messages, next.newerCursor))).toEqual(
      ids(range(25, 124)),
    );
  });

  it("skips filtered seqs inside a page that still overlaps the cursor", () => {
    const opened = openThreadWindow(latest(), page(25, 124));
    const next = appendNewerThreadPage(opened.snapshot, 124, {
      threadId: "thread",
      messages: [...range(100, 124), ...range(126, 140)],
      olderCursor: 100,
    });

    expect(next.newerCursor).toBe(140);
    expect(ids(threadWindowMessages(next.snapshot.messages, next.newerCursor))).toEqual([
      ...ids(range(25, 124)),
      ...ids(range(126, 140)),
    ]);
  });

  it("does not skip a gap to a page that starts past the cursor", () => {
    const opened = openThreadWindow(latest(), page(25, 124));
    const next = appendNewerThreadPage(opened.snapshot, 124, page(180, 190));

    expect(next.newerCursor).toBe(124);
    expect(ids(threadWindowMessages(next.snapshot.messages, next.newerCursor))).toEqual(
      ids(range(25, 124)),
    );
  });

  it("moves the probe from cursor progress when the next page omits coverage", () => {
    const first = forwardProbeAfterPage({
      probe: 125,
      newerCursor: 124,
      nextCursor: 124,
      reportedCoverage: 140,
    });
    expect(first).toEqual({ probe: 141, coverage: 140, stalled: false });

    const second = forwardProbeAfterPage({
      probe: first.probe!,
      newerCursor: 124,
      nextCursor: 160,
      reportedCoverage: null,
      carriedCoverage: first.coverage,
    });
    expect(second).toEqual({ probe: 161, stalled: false });
  });

  it("joins once coverage reaches the latest snapshot, hidden rows included", () => {
    const opened = openThreadWindow(latest(), page(25, 124));
    const next = appendNewerThreadPage(opened.snapshot, 124, page(74, 124), 299);

    expect(next.newerCursor).toBeNull();
    expect(ids(threadWindowMessages(next.snapshot.messages, next.newerCursor))).toEqual([
      ...ids(range(25, 124)),
      ...ids(range(200, 299)),
      "progress:run",
    ]);
  });

  it("ignores a forward page from another thread", () => {
    const opened = openThreadWindow(latest(), page(25, 124));
    const next = appendNewerThreadPage(opened.snapshot, 124, {
      ...page(125, 224),
      threadId: "cleared",
    });

    expect(next).toEqual({ snapshot: opened.snapshot, newerCursor: 124 });
  });

  it("leaves the window for the latest messages and pages older history back in", () => {
    const opened = openThreadWindow(latest(), page(25, 124));
    const left = leaveThreadWindow(opened.snapshot, opened.newerCursor);

    expect(ids(left.messages)).toEqual([...ids(range(200, 299)), "progress:run"]);
    expect(left.olderCursor).toBe(200);
    expect(ids(prependThreadHistoryPage(left, page(100, 199))!.messages).slice(0, 101)).toEqual(
      ids(range(100, 200)),
    );
    expect(leaveThreadWindow(left, null)).toBe(left);
  });
});
