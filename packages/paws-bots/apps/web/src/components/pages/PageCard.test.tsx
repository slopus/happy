// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PageCard } from "./PageCard";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("runs a page from when its card nears view until newer previews push it out", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const observers: { margin: string; root: unknown; report: (inView: boolean) => void }[] = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(
        callback: (entries: { isIntersecting: boolean }[]) => void,
        options: { root: unknown; rootMargin: string },
      ) {
        observers.push({
          margin: options.rootMargin,
          root: options.root,
          report: (inView) => act(() => callback([{ isIntersecting: inView }])),
        });
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: (entries: { contentRect: object }[]) => void) {}
      observe() {
        this.callback([{ contentRect: { width: 400, height: 210 } }]);
      }
      disconnect() {}
    },
  );
  const chat = document.body.appendChild(document.createElement("div"));
  chat.style.overflowY = "auto";
  const root = createRoot(chat.appendChild(document.createElement("div")));
  // One more card than the previews kept running.
  const titles = Array.from({ length: 25 }, (_, index) => `Board ${index}`);
  await act(async () =>
    root.render(
      titles.map((title) => (
        <PageCard key={title} title={title} document="<p>x</p>" onOpen={() => {}} />
      )),
    ),
  );
  const cards = () => [...chat.querySelectorAll('[data-testid="page-card"]')];
  const live = () => cards().map((card) => card.querySelector("iframe") !== null);
  const placeholder = (index: number) =>
    cards()[index]!.querySelector(".motion-safe\\:animate-pulse");
  const draw = (index: number) =>
    act(() => {
      const source = cards()[index]!.querySelector("iframe")!.contentWindow;
      window.dispatchEvent(
        new MessageEvent("message", { data: { type: "rakazo-page:height", height: 300 }, source }),
      );
    });
  expect(observers.map((observer) => [observer.root, observer.margin])).toEqual(
    titles.map(() => [chat, "400px 0px"]),
  );
  expect(live().some(Boolean)).toBe(false);

  observers[0]!.report(true);
  draw(0);
  expect(placeholder(0)).toBeNull();
  // Out of view but within the live set: still drawn, so scrolling back shows no placeholder.
  observers[0]!.report(false);
  for (let index = 1; index < 24; index++) {
    observers[index]!.report(true);
    observers[index]!.report(false);
  }
  expect(live()).toEqual(titles.map((_, index) => index < 24));
  expect(placeholder(0)).toBeNull();
  // Card 1 is back in view, so the next preview drops the least recently seen, card 0.
  observers[1]!.report(true);
  observers[24]!.report(true);
  expect(live()[0]).toBe(false);
  expect(placeholder(0)).not.toBeNull();
  expect(live().slice(1)).toEqual(titles.slice(1).map(() => true));
  // Previews still near view stay even past the limit.
  for (let index = 2; index < 24; index++) observers[index]!.report(true);
  observers[0]!.report(true);
  expect(live()).toEqual(titles.map(() => true));
  act(() => root.unmount());
});

it("stops pulsing once its page can't be read", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const none = class {
    observe() {}
    disconnect() {}
  };
  vi.stubGlobal("IntersectionObserver", none);
  vi.stubGlobal("ResizeObserver", none);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  const pulsing = () => document.body.querySelectorAll(".motion-safe\\:animate-pulse").length;
  await act(async () => root.render(<PageCard title="Plan" document={null} onOpen={() => {}} />));
  expect(pulsing()).toBe(1);
  await act(async () =>
    root.render(<PageCard title="Plan" document={null} failed onOpen={() => {}} />),
  );
  expect(pulsing()).toBe(0);
  expect(document.body.textContent).toContain("Plan");
  // A preview that cannot load says so rather than leaving a still outline.
  expect(document.body.textContent).toContain("This page couldn't load");
  act(() => root.unmount());
});
