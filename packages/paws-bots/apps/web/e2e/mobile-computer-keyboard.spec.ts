import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

const computerRoot = path.resolve(import.meta.dirname, "../../../infra/sandboxes/computer");

async function openComputerEmbed(
  page: Page,
  options: { touch?: boolean; clipboardText?: string | null; viewOnly?: boolean } = {},
) {
  const touch = options.touch ?? true;
  const assets = new Map([
    ["/embed.html", await readFile(path.join(computerRoot, "embed.html"), "utf8")],
    [
      "/clipboard-bridge.js",
      await readFile(path.join(computerRoot, "clipboard-bridge.js"), "utf8"),
    ],
    ["/mobile-keyboard.js", await readFile(path.join(computerRoot, "mobile-keyboard.js"), "utf8")],
    [
      "/core/rfb.js",
      `export default class RFB extends EventTarget {
        constructor() {
          super();
          this.viewOnly = false;
          this.focusOnClick = true;
          globalThis.__rfbKeys = [];
          globalThis.__rfbClipboard = [];
        }
        sendKey(...args) { globalThis.__rfbKeys.push(args); }
        clipboardPasteFrom(text) { globalThis.__rfbClipboard.push(text); }
      }`,
    ],
    [
      "/core/input/keyboard.js",
      `export default class Keyboard {
        constructor() { this.onkeyevent = null; }
        grab() {}
        ungrab() {}
      }`,
    ],
    ["/core/input/keysym.js", "export default { XK_BackSpace: 0xff08 };"],
    ["/core/input/keysymdef.js", "export default { lookup: (codePoint) => codePoint };"],
  ]);

  await page.addInitScript(
    ({ touch: isTouch, clipboardText }) => {
      Object.defineProperty(navigator, "maxTouchPoints", {
        configurable: true,
        value: isTouch ? 1 : 0,
      });
      if (clipboardText !== undefined) {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            readText: async () => {
              if (clipboardText === null) throw new Error("denied");
              return clipboardText;
            },
          },
        });
      }
      const viewport = new EventTarget();
      Object.defineProperties(viewport, {
        height: { configurable: true, value: 420 },
        offsetTop: { configurable: true, value: 12 },
      });
      Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    },
    { touch, clipboardText: options.clipboardText },
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("http://keyboard.test/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const body = assets.get(pathname);
    if (body == null) return route.fulfill({ status: 404, body: "Not found" });
    return route.fulfill({
      contentType: pathname.endsWith(".html") ? "text/html" : "text/javascript",
      body,
    });
  });
  await page.goto(`http://keyboard.test/embed.html${options.viewOnly ? "?view_only=true" : ""}`);
}

test("touch users can open and dismiss the remote computer keyboard", async ({
  page,
}, testInfo) => {
  await openComputerEmbed(page);
  const keyboardButton = page.getByRole("button", { name: "Show keyboard" });
  const trackpadButton = page.getByRole("button", { name: "Use trackpad" });
  const pasteButton = page.getByRole("button", { name: "Paste" });
  const keyboardInput = page.getByRole("textbox", { name: "Remote computer keyboard input" });
  const keyboardField = page.locator("#mobile-keyboard-input");
  await expect(keyboardButton).toBeVisible();
  await expect(trackpadButton).toBeVisible();
  await expect(pasteButton).toBeVisible();
  await expect(page.getByRole("button", { name: "Escape" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ctrl" })).toBeVisible();
  await expect(keyboardInput).toHaveCount(0);

  await trackpadButton.click();
  await expect(page.getByRole("button", { name: "Use direct touch" })).toBeVisible();

  await keyboardButton.click();
  await expect(page.getByRole("button", { name: "Hide keyboard" })).toBeVisible();
  await expect(keyboardInput).toBeFocused();
  await expect(page.locator("html")).toHaveClass(/mobile-keyboard-open/);
  await expect(page.locator("#screen")).toHaveCSS("height", "420px");
  await expect
    .poll(() =>
      page.evaluate(() => ({
        height: document.documentElement.style.getPropertyValue("--mobile-visual-height"),
        top: document.documentElement.style.getPropertyValue("--mobile-visual-top"),
      })),
    )
    .toEqual({ height: "420px", top: "12px" });
  await keyboardInput.pressSequentially("mobile typing");
  const forwardedKeysyms = await page.evaluate(() =>
    Reflect.get(globalThis, "__rfbKeys").map(([keysym]: [number]) => keysym),
  );
  expect(forwardedKeysyms).toEqual(
    Array.from("mobile typing", (character) => character.codePointAt(0)),
  );
  await page.evaluate(() => {
    Reflect.set(globalThis, "__rfbKeys", []);
  });
  await page.getByRole("button", { name: "Escape" }).click();
  await page.getByRole("button", { name: "Tab" }).click();
  await page.getByRole("button", { name: "Left" }).click();
  await page.getByRole("button", { name: "Ctrl" }).click();
  await expect(page.getByRole("button", { name: "Ctrl" })).toHaveAttribute("aria-pressed", "true");
  await keyboardInput.pressSequentially("c");
  await expect
    .poll(() => page.evaluate(() => Reflect.get(globalThis, "__rfbKeys")))
    .toEqual([
      [0xff1b, "Escape"],
      [0xff09, "Tab"],
      [0xff51, "ArrowLeft"],
      [0xffe3, "ControlLeft", true],
      [99, undefined, true],
      [99, undefined, false],
      [0xffe3, "ControlLeft", false],
    ]);
  await page.getByRole("button", { name: "Ctrl" }).click();
  await expect(page.getByRole("button", { name: "Ctrl" })).toHaveAttribute("aria-pressed", "true");
  await captureScreenshot(page, testInfo, "mobile-computer-keyboard-open");

  await page.getByRole("button", { name: "Hide keyboard" }).click();
  await expect(keyboardButton).toBeVisible();
  await expect(keyboardField).not.toBeFocused();
  await expect(keyboardField).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator("html")).not.toHaveClass(/mobile-keyboard-open/);
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.documentElement.style.getPropertyValue("--mobile-visual-height"),
      ),
    )
    .toBe("");
});

test("touch users can paste clipboard text without a keyboard chord", async ({
  page,
}, testInfo) => {
  await openComputerEmbed(page, { clipboardText: "from-phone" });
  const pasteButton = page.getByRole("button", { name: "Paste" });
  await expect(pasteButton).toBeVisible();
  await captureScreenshot(page, testInfo, "mobile-computer-paste");
  await pasteButton.click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(globalThis, "__rfbClipboard")))
    .toEqual(["from-phone"]);
  await expect(page.locator("#mobile-keyboard-input")).not.toBeFocused();
});

test("Paste focuses the keyboard when the clipboard API is denied", async ({ page }) => {
  await openComputerEmbed(page, { clipboardText: null });
  await page.getByRole("button", { name: "Paste" }).click();
  const keyboardInput = page.getByRole("textbox", { name: "Remote computer keyboard input" });
  await expect(keyboardInput).toBeFocused();
  await expect
    .poll(() =>
      keyboardInput.evaluate((element) => {
        const input = element as HTMLTextAreaElement;
        return (
          input.value.length > 0 &&
          input.selectionStart === input.value.length &&
          input.selectionEnd === input.value.length
        );
      }),
    )
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => Reflect.get(globalThis, "__rfbClipboard")))
    .toEqual([]);
});

test("desktop embed hides touch computer chrome", async ({ page }) => {
  await openComputerEmbed(page, { touch: false });
  await expect(page.getByRole("button", { name: "Paste" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show keyboard" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Use trackpad" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Escape" })).toHaveCount(0);
});

test("view-only previews expose no keyboard or touch controls", async ({ page }) => {
  await openComputerEmbed(page, { viewOnly: true });
  for (const name of ["Show keyboard", "Paste", "Use trackpad", "Escape", "Ctrl"]) {
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  }
  await expect(page.getByRole("textbox", { name: "Remote computer keyboard input" })).toHaveCount(
    0,
  );
  expect(await page.evaluate(() => Reflect.get(globalThis, "__rfbKeys"))).toEqual([]);
});
