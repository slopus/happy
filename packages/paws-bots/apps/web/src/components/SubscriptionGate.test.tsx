// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ me: vi.fn(), status: vi.fn() }));
const space = vi.hoisted(() => ({ selected: null as string | null, reads: [] as unknown[] }));
vi.mock("../lib/rpc", () => ({
  rpc: { me: api.me, billing: { status: api.status } },
  createSpaceRpc: (spaceId: string | null) => ({
    spaceId,
    me: api.me,
    billing: {
      status: (...args: unknown[]) => {
        space.reads.push(spaceId);
        return api.status(...args);
      },
    },
  }),
  selectedSpaceId: () => space.selected,
  SPACE_SELECTED_EVENT: "rakazo:space-selected",
}));
vi.mock("../lib/bootstrap", () => ({ peekInitialBootstrap: () => undefined }));
vi.mock("../pages/Paywall", () => ({
  PaywallPage: ({ client }: { client?: { spaceId?: string | null } }) => (
    <div>{client?.spaceId ? `paywall ${client.spaceId}` : "paywall"}</div>
  ),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Fresh module per test: the capability lookup is cached for the page's lifetime. */
async function renderGate(billing: boolean, initialEntries = ["/"]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        billing,
        passwordAuth: true,
        sso: null,
        passwordReset: false,
        resetUrl: null,
      }),
    ),
  );
  vi.resetModules();
  const { SubscriptionGate } = await import("./SubscriptionGate");
  const { MemoryRouter } = await import("react-router-dom");
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={initialEntries}>
        <SubscriptionGate fallback={<div>loading</div>}>
          <div>app</div>
        </SubscriptionGate>
      </MemoryRouter>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { container, root };
}

afterEach(() => {
  space.selected = null;
  space.reads.length = 0;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("opens without waiting on me or billing when the deployment does not bill", async () => {
  const { container, root } = await renderGate(false);
  expect(container.textContent).toBe("app");
  expect(api.me).not.toHaveBeenCalled();
  expect(api.status).not.toHaveBeenCalled();
  act(() => root.unmount());
});

it("skips the billing request for users billing does not apply to", async () => {
  api.me.mockResolvedValue({ billingEnabled: false });
  const { container, root } = await renderGate(true);
  expect(container.textContent).toBe("app");
  expect(api.status).not.toHaveBeenCalled();
  act(() => root.unmount());
});

it("shows the paywall without access and opens once a recheck finds access", async () => {
  api.me.mockResolvedValue({ billingEnabled: true });
  api.status.mockResolvedValue({ access: false });
  const { container, root } = await renderGate(true);
  expect(container.textContent).toBe("paywall");

  api.status.mockResolvedValue({ access: true });
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(container.textContent).toBe("app");
  act(() => root.unmount());
});

it("reloads billing for a newly selected Space", async () => {
  api.me.mockResolvedValue({ billingEnabled: true });
  api.status.mockResolvedValue({ access: false });
  const { container, root } = await renderGate(true);
  expect(container.textContent).toBe("paywall");

  api.status.mockResolvedValue({ access: true });
  await act(async () => {
    window.dispatchEvent(new Event("rakazo:space-selected"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(container.textContent).toBe("app");
  act(() => root.unmount());
});

it("keeps checking billing after a newly selected Space's read fails", async () => {
  api.me.mockResolvedValue({ billingEnabled: true });
  api.status.mockResolvedValue({ access: false });
  const { container, root } = await renderGate(true);
  expect(container.textContent).toBe("paywall");

  api.status.mockRejectedValueOnce(new Error("offline"));
  await act(async () => {
    window.dispatchEvent(new Event("rakazo:space-selected"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(container.textContent).toBe("app");

  api.status.mockResolvedValue({ access: false });
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(container.textContent).toBe("paywall");
  act(() => root.unmount());
});

it("hands the plan choice the client of the space its prices were read for", async () => {
  space.selected = "space-a";
  api.me.mockResolvedValue({ billingEnabled: true });
  api.status.mockResolvedValue({ access: false });
  const { container, root } = await renderGate(true);

  // Another tab selects another organization; this window still shows the first one's prices.
  space.selected = "space-b";
  expect(container.textContent).toBe("paywall space-a");

  // Coming back to this tab rechecks this tab's organization, not the other tab's choice.
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(space.reads.at(-1)).toBe("space-a");
  expect(container.textContent).toBe("paywall space-a");

  // Selecting another organization in this tab moves billing with it.
  await act(async () => {
    window.dispatchEvent(new Event("rakazo:space-selected"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(container.textContent).toBe("paywall space-b");
  act(() => root.unmount());
});

it("keeps the plans dialog over the open app on this tab's organization", async () => {
  space.selected = "space-a";
  api.me.mockResolvedValue({ billingEnabled: true });
  api.status.mockResolvedValue({ access: true });
  const { root } = await renderGate(true, ["/?plans"]);
  expect(document.body.textContent).toContain("paywall space-a");

  // Another tab selects another organization; this tab regains focus.
  space.selected = "space-b";
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(space.reads.at(-1)).toBe("space-a");
  expect(document.body.textContent).toContain("paywall space-a");
  expect(document.body.textContent).not.toContain("paywall space-b");
  act(() => root.unmount());
});

it("pins billing to the space the account opened in when nothing is selected yet", async () => {
  // A fresh sign-in: no saved selection, so the server picked space-a for this window.
  space.selected = null;
  api.me.mockResolvedValue({ billingEnabled: true, spaceId: "space-a" });
  api.status.mockResolvedValue({ access: false });
  const { container, root } = await renderGate(true);
  expect(space.reads).toEqual(["space-a"]);
  expect(container.textContent).toBe("paywall space-a");

  // Another tab deletes that organization; a recheck still names it, so the server rejects it
  // instead of answering for another organization.
  api.status.mockRejectedValue(new Error("Space unavailable"));
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(space.reads).toEqual(["space-a", "space-a"]);
  expect(container.textContent).toBe("paywall space-a");
  act(() => root.unmount());
});
