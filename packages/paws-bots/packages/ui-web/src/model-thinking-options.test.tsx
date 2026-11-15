// @vitest-environment jsdom

import { MAX_MODEL_CONTEXT_WINDOW, MAX_MODEL_MAX_TOKENS } from "@rakazo/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ModelThinkingOptions } from "./model-thinking-options.js";

const mounted: Array<() => void> = [];

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  vi.unstubAllGlobals();
});

it("bounds the limit inputs by the limits the server accepts", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <ModelThinkingOptions
        advancedLabel="Advanced"
        maxTokens="393216"
        onMaxTokensChange={() => {}}
        maxTokensLabel="Max output tokens"
        contextWindow="2000000"
        onContextWindowChange={() => {}}
        contextWindowLabel="Context limit"
      />,
    ),
  );
  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });

  const maxTokens = container.querySelector<HTMLInputElement>(
    'input[aria-label="Max output tokens"]',
  );
  const contextWindow = container.querySelector<HTMLInputElement>(
    'input[aria-label="Context limit"]',
  );
  expect(maxTokens?.max).toBe(String(MAX_MODEL_MAX_TOKENS));
  expect(contextWindow?.max).toBe(String(MAX_MODEL_CONTEXT_WINDOW));
});
