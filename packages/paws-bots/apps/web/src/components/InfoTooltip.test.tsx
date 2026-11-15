// @vitest-environment jsdom

import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InfoTooltip } from "./InfoTooltip";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));

let container: HTMLDivElement;
let root: Root;
let trigger: HTMLButtonElement;
const explanation = "Get notified when this Bot finishes or needs input";
const tooltip = () => document.querySelector('[data-slot="tooltip-content"]');
const description = () => document.getElementById(trigger.getAttribute("aria-describedby") ?? "");

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<InfoTooltip label="Notifications">{explanation}</InfoTooltip>);
  });
  trigger = container.querySelector("button") as HTMLButtonElement;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function expectOpen() {
  await vi.waitFor(() => expect(tooltip()?.textContent).toContain(explanation));
  expect(description()?.textContent).toBe(explanation);
  expect(trigger.getAttribute("aria-describedby")?.split(" ")).toEqual([description()?.id]);
  expect(tooltip()?.getAttribute("aria-hidden")).toBe("true");
  expect(tooltip()?.getAttribute("role")).toBe("presentation");
}

async function press(detail = 0) {
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, detail }));
  });
}

describe("InfoTooltip", () => {
  it("has an accessible name and a decorative help icon", () => {
    expect(trigger.type).toBe("button");
    expect(trigger.getAttribute("aria-label")).toBe("About Notifications");
    expect(trigger.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(tooltip()).toBeNull();
  });

  it("keeps its description available before opening and after closing", async () => {
    const initialDescription = description();
    expect(initialDescription?.textContent).toBe(explanation);
    expect(initialDescription?.classList.contains("sr-only")).toBe(true);
    expect(initialDescription?.closest('[aria-hidden="true"], [hidden]')).toBeNull();
    expect(tooltip()).toBeNull();

    await press();
    await expectOpen();
    expect(description()).toBe(initialDescription);
    await press();
    await vi.waitFor(() => expect(tooltip()).toBeNull());
    expect(description()).toBe(initialDescription);
    expect(description()?.textContent).toBe(explanation);
    expect(description()?.classList.contains("sr-only")).toBe(true);
    expect(description()?.closest('[aria-hidden="true"], [hidden]')).toBeNull();
  });

  it("opens on hover", async () => {
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
      trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await expectOpen();
  });

  it("pins clicked help through pointer leave and dismisses on an outside press", async () => {
    await press();
    await expectOpen();
    await act(async () => {
      trigger.dispatchEvent(
        new MouseEvent("mouseleave", { bubbles: false, relatedTarget: document.body }),
      );
      trigger.dispatchEvent(
        new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }),
      );
    });
    await expectOpen();
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await vi.waitFor(() => expect(tooltip()).toBeNull());
  });

  it("opens on keyboard focus and closes with Escape", async () => {
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      trigger.focus();
    });
    await expectOpen();
    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await vi.waitFor(() => expect(tooltip()).toBeNull());
  });

  it("toggles on click and touch without focus closing the first tap", async () => {
    await act(async () => {
      trigger.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      trigger.focus();
    });
    await press(1);
    await expectOpen();
    await act(async () => {
      trigger.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    await press(1);
    await vi.waitFor(() => expect(tooltip()).toBeNull());
    await press();
    await expectOpen();
    await press();
    await vi.waitFor(() => expect(tooltip()).toBeNull());
  });
});
