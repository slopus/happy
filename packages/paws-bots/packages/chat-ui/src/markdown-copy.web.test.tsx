// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatMarkdown } from "./markdown.web";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Reflect.deleteProperty(navigator, "clipboard");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  container.remove();
  Reflect.deleteProperty(document, "execCommand");
  vi.unstubAllGlobals();
});

const examples = [
  ["Copy code", "```ts\nconst a = 1;\n```", "const a = 1;"],
  ["Copy rows", "| Item | Qty |\n| --- | --- |\n| apple | 2 |", "Item\tQty\napple\t2"],
];
it.each(examples)("%s falls back without the Clipboard API", async (label, markdown, text) => {
  const execCommand = vi.fn(() => {
    expect(document.querySelector("textarea")?.value).toBe(text);
    return true;
  });
  document.execCommand = execCommand;
  await act(async () => root.render(<ChatMarkdown>{markdown}</ChatMarkdown>));
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  await act(async () => button?.click());
  expect(execCommand).toHaveBeenCalledWith("copy");
  expect(button?.getAttribute("aria-label")).toBe("Copied");
});
it.each(examples)("%s offers manual copying when copying fails", async (label, markdown, text) => {
  document.execCommand = vi.fn(() => false);
  await act(async () => root.render(<ChatMarkdown>{markdown}</ChatMarkdown>));
  await act(async () =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)?.click(),
  );
  const field = document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea');
  expect(field?.value).toBe(text);
  await vi.waitFor(() => expect(field?.selectionEnd).toBe(text.length));
  expect(field?.selectionStart).toBe(0);
});

it("Copy rows offers the text from the click when the table changes before the failure", async () => {
  let fail: () => void = () => undefined;
  Object.defineProperty(navigator, "clipboard", {
    value: {
      writeText: () =>
        new Promise<void>((_, reject) => {
          fail = () => reject();
        }),
    },
    configurable: true,
  });
  document.execCommand = vi.fn(() => false);
  await act(async () => root.render(<ChatMarkdown>{"| Item |\n| --- |\n| apple |"}</ChatMarkdown>));
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Copy rows"]')?.click(),
  );
  // Streaming updates the table while the copy is still in flight.
  await act(async () =>
    root.render(<ChatMarkdown>{"| Item |\n| --- |\n| avocado |"}</ChatMarkdown>),
  );
  await act(async () => fail());
  const field = document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea');
  expect(field?.value).toBe("Item\napple");
});

it("Copy rows starts no feedback timers when the copy settles after the table is gone", async () => {
  let succeed: () => void = () => undefined;
  Object.defineProperty(navigator, "clipboard", {
    value: {
      writeText: () =>
        new Promise<void>((resolve) => {
          succeed = resolve;
        }),
    },
    configurable: true,
  });
  await act(async () => root.render(<ChatMarkdown>{"| Item |\n| --- |\n| apple |"}</ChatMarkdown>));
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Copy rows"]')?.click(),
  );
  // The chat is left while the clipboard request is still pending.
  act(() => root.unmount());
  root = createRoot(container);
  const setTimeout = vi.spyOn(window, "setTimeout");

  await act(async () => succeed());

  expect(setTimeout).not.toHaveBeenCalled();
  setTimeout.mockRestore();
});

it("Copy rows drops an earlier Copied confirmation when the next copy fails", async () => {
  // The confirmation must not expire on a slow worker between the two clicks.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error());
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  document.execCommand = vi.fn(() => false);
  await act(async () => root.render(<ChatMarkdown>{"| Item |\n| --- |\n| apple |"}</ChatMarkdown>));
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Copy rows"]')?.click(),
  );
  expect(container.querySelector('button[aria-label="Copied"]')).not.toBeNull();

  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Copied"]')?.click(),
  );

  expect(document.querySelector('[role="dialog"] textarea')).not.toBeNull();
  expect(container.querySelector('button[aria-label="Copied"]')).toBeNull();
});
