// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCopyText, writeClipboard } from "./copy-text";

/** Clipboard writes the test settles by hand, so results can arrive out of click order. */
function manualClipboard() {
  const writes: Array<{ resolve: () => void; reject: () => void }> = [];
  return {
    writes,
    writeText: (_text: string) =>
      new Promise<void>((resolve, reject) => {
        writes.push({ resolve, reject });
      }),
  };
}

function CopyProbe() {
  const [copied, copy, failed, , failedText] = useCopyText();
  return (
    <>
      <button type="button" onClick={() => copy("text")}>
        copy
      </button>
      <span data-copied={String(copied)} data-failed={String(failed)} data-text={failedText} />
    </>
  );
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<CopyProbe />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Reflect.deleteProperty(document, "execCommand");
  Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(globalThis, "rakazoDesktop");
});

it("keeps the newer copy's success when an older copy fails after it", async () => {
  const clipboard = manualClipboard();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: clipboard.writeText },
    configurable: true,
  });
  // The selection fallback also fails, so the older attempt really resolves as a failure.
  document.execCommand = vi.fn(() => false);
  const button = container.querySelector<HTMLButtonElement>("button");
  const status = () => container.querySelector<HTMLElement>("span");

  await act(async () => button?.click());
  await act(async () => button?.click());
  const [first, second] = clipboard.writes;
  await act(async () => second?.resolve());
  await act(async () => first?.reject());

  expect(clipboard.writes).toHaveLength(2);
  expect(status()?.dataset.copied).toBe("true");
  expect(status()?.dataset.failed).toBe("false");
  expect(status()?.dataset.text).toBe("");
});

it("drops the earlier confirmation while a newer copy is still pending", async () => {
  const clipboard = manualClipboard();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: clipboard.writeText },
    configurable: true,
  });
  const button = container.querySelector<HTMLButtonElement>("button");
  const status = () => container.querySelector<HTMLElement>("span");

  await act(async () => button?.click());
  await act(async () => clipboard.writes[0]?.resolve());
  expect(status()?.dataset.copied).toBe("true");

  await act(async () => button?.click());
  expect(status()?.dataset.copied).toBe("false");
});

it("does not let a superseded copy fall back to selection over the newer text", async () => {
  const clipboard = manualClipboard();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: clipboard.writeText },
    configurable: true,
  });
  const execCommand = vi.fn(() => true);
  document.execCommand = execCommand;
  const button = container.querySelector<HTMLButtonElement>("button");

  await act(async () => button?.click());
  await act(async () => button?.click());
  const [first, second] = clipboard.writes;
  await act(async () => second?.resolve());
  await act(async () => first?.reject());

  expect(execCommand).not.toHaveBeenCalled();
  expect(container.querySelector<HTMLElement>("span")?.dataset.copied).toBe("true");
});

function desktopClipboard(writeText = vi.fn(async () => true)) {
  Object.defineProperty(globalThis, "rakazoDesktop", {
    configurable: true,
    value: { clipboard: { writeText } },
  });
  return writeText;
}

it("keeps the web API first even when the desktop bridge exists", async () => {
  const native = desktopClipboard();
  const web = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: web } });
  expect(await writeClipboard("web")).toBe(true);
  expect(web).toHaveBeenCalledWith("web");
  expect(native).not.toHaveBeenCalled();
});

it.each(["absent", "rejected", "throws"])(
  "uses the desktop bridge when the web API is %s",
  async (mode) => {
    const native = desktopClipboard();
    if (mode !== "absent")
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: () => {
            if (mode === "throws") throw new Error("unavailable");
            return Promise.reject(new Error("Document is not focused"));
          },
        },
      });
    document.execCommand = vi.fn(() => false);
    expect(await writeClipboard("desktop")).toBe(true);
    expect(native).toHaveBeenCalledWith("desktop");
    expect(document.execCommand).not.toHaveBeenCalled();
  },
);

it.each(["refused", "rejected"])("tries selection when the bridge is %s", async (mode) => {
  desktopClipboard(
    vi.fn(async () => {
      if (mode === "rejected") throw new Error("disconnected");
      return false;
    }),
  );
  document.execCommand = vi.fn(() => false);
  expect(await writeClipboard("text")).toBe(false);
  expect(document.execCommand).toHaveBeenCalledWith("copy");
});

it("does not send a superseded write to the desktop bridge", async () => {
  const native = desktopClipboard();
  expect(await writeClipboard("old", () => false)).toBe(false);
  expect(native).not.toHaveBeenCalled();
});

it("keeps the selection fallback for browsers without the Clipboard API", async () => {
  document.execCommand = vi.fn(() => true);
  expect(await writeClipboard("browser")).toBe(true);
  expect(document.execCommand).toHaveBeenCalledWith("copy");
});
