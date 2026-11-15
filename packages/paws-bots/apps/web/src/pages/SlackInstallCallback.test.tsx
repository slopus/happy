// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

const complete = vi.hoisted(() => vi.fn());

vi.mock("../lib/rpc", () => ({ rpc: { messaging: { installations: { complete } } } }));
vi.mock("../components/PageLoading", () => ({ PageLoading: () => <div>Loading</div> }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: (props: ComponentProps<"button">) => <button type="button" {...props} />,
}));

import { SlackInstallCallbackPage } from "./SlackInstallCallback";

afterEach(() => {
  document.body.innerHTML = "";
  complete.mockReset();
});

async function render(url: string) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/messaging/slack/callback" element={<SlackInstallCallbackPage />} />
          <Route path="/app" element={<div>App</div>} />
        </Routes>
      </MemoryRouter>,
    );
  });
  return container;
}

it("finishes the install as the signed-in user and opens messaging settings", async () => {
  complete.mockResolvedValue({ ok: true });
  const container = await render("/messaging/slack/callback?state=fake-state&code=fake-code");
  expect(complete).toHaveBeenCalledTimes(1);
  expect(complete).toHaveBeenCalledWith({ state: "fake-state", code: "fake-code" });
  expect(container.textContent).toBe("App");
});

it("shows a failure when the install cannot be finished", async () => {
  complete.mockRejectedValue(new Error("rejected"));
  const container = await render("/messaging/slack/callback?state=fake-state&code=fake-code");
  expect(container.textContent).toContain("Could not connect");
});

it("does not call the API when Slack returns without a code", async () => {
  const container = await render("/messaging/slack/callback?error=access_denied&state=fake-state");
  expect(complete).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Could not connect");
});
