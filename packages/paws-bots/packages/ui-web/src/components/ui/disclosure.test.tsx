// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Disclosure } from "./disclosure";

it("keeps child state and effects alive while folding and reopening", async () => {
  const mounted = vi.fn();
  const cleanup = vi.fn();
  function Content() {
    useEffect(() => {
      mounted();
      return cleanup;
    }, []);
    return <input aria-label="Draft" defaultValue="Original" />;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  const onOpenChange = vi.fn();
  await act(async () => {
    root.render(
      <Disclosure summary="Advanced" defaultOpen onOpenChange={onOpenChange}>
        <Content />
      </Disclosure>,
    );
  });
  const trigger = container.querySelector("button")!;
  const input = container.querySelector("input")!;
  input.value = "Unsaved edit";
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  await act(async () => trigger.click());
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(cleanup).not.toHaveBeenCalled();
  await act(async () => trigger.click());
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(container.querySelector("input")).toBe(input);
  expect(input.value).toBe("Unsaved edit");
  expect(mounted).toHaveBeenCalledTimes(1);
  expect(onOpenChange.mock.calls.map(([open]) => open)).toEqual([false, true]);
  await act(async () => root.unmount());
  expect(cleanup).toHaveBeenCalledTimes(1);
});

it("reveals collapsed content when browser Find matches it", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const onOpenChange = vi.fn();
  await act(async () => {
    root.render(
      <Disclosure summary="Advanced" onOpenChange={onOpenChange}>
        <p>Searchable content</p>
      </Disclosure>,
    );
  });
  const trigger = container.querySelector("button")!;
  const panel = container.querySelector('[data-slot="collapsible-content"]')!;
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(panel.getAttribute("hidden")).toBe("until-found");
  await act(async () => panel.dispatchEvent(new Event("beforematch")));
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(onOpenChange.mock.calls.map(([open]) => open)).toEqual([true]);
  await act(async () => root.unmount());
});
