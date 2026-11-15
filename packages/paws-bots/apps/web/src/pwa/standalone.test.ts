// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { lockStandaloneZoom } from "./standalone.js";

const VIEWPORT = "width=device-width, initial-scale=1.0, viewport-fit=cover";

/** A fresh document per case, so gesture listeners never carry over between cases. */
function host(options: { standalone?: boolean; displayMode?: boolean }) {
  const doc = document.implementation.createHTMLDocument();
  doc.head.innerHTML = `<meta name="viewport" content="${VIEWPORT}" />`;
  return {
    document: doc,
    navigator: { standalone: options.standalone } as Navigator & { standalone?: boolean },
    matchMedia: (() => ({
      matches: options.displayMode ?? false,
    })) as unknown as Window["matchMedia"],
  };
}

function locked(doc: Document) {
  const pinch = new Event("gesturestart", { cancelable: true });
  doc.dispatchEvent(pinch);
  return {
    viewport: doc.querySelector('meta[name="viewport"]')?.getAttribute("content"),
    touchAction: doc.documentElement.style.touchAction,
    pinchCancelled: pinch.defaultPrevented,
  };
}

describe("lockStandaloneZoom", () => {
  it("keeps zoom in a browser tab", () => {
    const target = host({});
    lockStandaloneZoom(target);
    expect(locked(target.document)).toEqual({
      viewport: VIEWPORT,
      touchAction: "",
      pinchCancelled: false,
    });
  });

  it.each([
    ["iOS", { standalone: true }],
    ["display-mode standalone", { displayMode: true }],
  ])("locks zoom in the installed app (%s)", (_name, options) => {
    const target = host(options);
    lockStandaloneZoom(target);
    expect(locked(target.document)).toEqual({
      viewport: `${VIEWPORT}, maximum-scale=1, user-scalable=no`,
      touchAction: "manipulation",
      pinchCancelled: true,
    });
  });
});
