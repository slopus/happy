// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import type { ModelCatalogEntry, ModelRoleView as Settings } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Provider rows end with their "Connect" action; models show their name alone. */
const optionName = (entry: Element) => entry.textContent?.replace(/(Connect|Default)$/, "");
const api = vi.hoisted(() => ({ role: vi.fn(), forRole: vi.fn(), setRole: vi.fn() }));
vi.mock("../lib/localized-provider-hint", () => ({
  providerDisplayName: (provider: string, name: string, auth?: string) =>
    provider === "anthropic" && auth === "oauth" ? "Claude subscription" : name,
}));
vi.mock("../lib/space-rpc", () => {
  const client = { models: api };
  return { useSpaceRpc: () => client };
});
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: string[]) =>
      parts.reduce((text, part, i) => text + part + (values[i] ?? ""), ""),
  }),
  Trans: ({ children }: { children?: ReactNode }) => children,
}));

import { ModelRoleSettings } from "./ModelRoleSettings";

const catalog: ModelCatalogEntry[] = [
  {
    provider: "openrouter",
    id: "typesafe/jev-1.14",
    label: "Jev 1.14",
    providerName: "OpenRouter",
    billing: "",
    protocol: "decisions",
  },
  { provider: "openrouter", id: "chat", label: "Chat", providerName: "OpenRouter", billing: "" },
  { provider: "openrouter", id: "mini", label: "Mini", providerName: "OpenRouter", billing: "" },
];
const credentials = [
  {
    id: "key",
    provider: "openrouter",
    label: "OpenRouter",
    isDefault: true,
    hasKey: true,
    modelId: "chat",
  },
];
const jev = { provider: "openrouter", modelId: "typesafe/jev-1.14" };
const chat = { provider: "openrouter", modelId: "chat" };
const mini = { provider: "openrouter", modelId: "mini" };
const deepseek = { id: "deepseek", name: "DeepSeek" };
/** A pick from a connection runs on that connection. */
const pin = <T extends object>(choice: T) => ({ ...choice, credentialId: "key" });
const onConnect = vi.fn();
const onManage = vi.fn();
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let saved: Settings;
let queryClient: QueryClient;
const props = {
  userId: "user",
  spaceId: "space",
  scope: "account" as const,
  credentials,
  title: "Main model",
  defaultLabel: "Deployment default",
  providers: [deepseek],
  providerLabel: (id: string) => (id === "openrouter" ? "OpenRouter" : id),
  onConnect,
  onManage,
};
async function render(extra: Partial<ComponentProps<typeof ModelRoleSettings>> = {}) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <ModelRoleSettings {...props} {...extra} />
      </QueryClientProvider>,
    ),
  );
}
function trigger(label: string) {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}
async function click(element: HTMLElement | null | undefined) {
  if (!element) throw new Error("Missing element");
  await act(async () => element.click());
}
/** Opens a model picker and chooses an option by its visible name. */
async function pick(label: string, option: string) {
  await click(trigger(label));
  const found = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (entry) => optionName(entry) === option,
  );
  if (!found) throw new Error(`Missing option ${option}`);
  await click(found);
}
/** Opens a row's options menu and chooses an item. */
async function menu(name: string, item: string) {
  await click(trigger(`${name} options`));
  const found = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (entry) => entry.textContent === item,
  );
  if (!found) throw new Error(`Missing menu item ${item}`);
  await click(found);
}
const rows = () =>
  [...container.querySelectorAll('[data-testid^="model-role-row-"]')].map(
    (row) => row.querySelector("button")?.textContent,
  );
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  i18n.loadAndActivate({ locale: "en", messages: {} });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = () => undefined;
  saved = { primary: null, backups: [] };
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  onConnect.mockReset();
  onManage.mockReset();
  api.role.mockReset().mockImplementation(async () => saved);
  api.forRole.mockReset().mockResolvedValue(catalog);
  api.setRole
    .mockReset()
    .mockImplementation(async ({ role: _r, expectedUserId: _u, scope: _s, ...patch }) => {
      saved = { ...saved, ...patch };
      return saved;
    });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
describe("shared role editor", () => {
  it("selects an approval model through an existing connection and removes it back to the default", async () => {
    await render({ modelRole: "approval", title: "Approval model" });
    expect(container.querySelector('[data-testid="model-role-default"]')?.textContent).toContain(
      "Deployment default",
    );
    await pick("Change Approval model", "Jev 1.14");
    expect(api.setRole).toHaveBeenLastCalledWith(
      expect.objectContaining({
        role: "approval",
        expectedUserId: "user",
        primary: pin(jev),
        backups: [],
      }),
      { context: { spaceId: "space" } },
    );
    expect(rows()).toEqual(["Jev 1.14OpenRouter"]);
    await menu("Jev 1.14", "Remove");
    expect(saved.primary).toBeNull();
    expect(container.querySelector('[data-testid="model-role-default"]')).not.toBeNull();
  });
  it("reopens on the cached list without a spinner while it refreshes", async () => {
    saved = { primary: chat, backups: [mini] };
    await render();
    expect(rows()).toEqual(["ChatOpenRouter", "MiniOpenRouter"]);
    await act(async () => root.unmount());
    root = createRoot(container);
    const hold = new Promise<never>(() => undefined);
    api.role.mockReturnValue(hold);
    api.forRole.mockReturnValue(hold);
    const loads = api.role.mock.calls.length;
    await render();
    expect(container.querySelector('[aria-label="Loading model catalog…"]')).toBeNull();
    expect(rows()).toEqual(["ChatOpenRouter", "MiniOpenRouter"]);
    expect(api.role.mock.calls.length).toBe(loads + 1);
  });
  it("uses the same add, order and remove controls for main and approval fallbacks", async () => {
    await render();
    await pick("Add fallback", "Chat");
    await pick("Add fallback", "Jev 1.14");
    expect(saved.backups).toEqual([pin(chat), pin(jev)]);
    await menu("Jev 1.14", "Move up");
    expect(saved.backups).toEqual([pin(jev), pin(chat)]);
    await menu("Chat", "Remove");
    expect(saved).toEqual({ primary: null, backups: [pin(jev)] });
    expect(api.setRole).toHaveBeenLastCalledWith(
      expect.objectContaining({ role: "main" }),
      expect.anything(),
    );
  });
  it("promotes a fallback with Move up by saving the primary and fallbacks together", async () => {
    saved = { primary: chat, backups: [jev, mini] };
    await render();
    await menu("Jev 1.14", "Move up");
    expect(api.setRole).toHaveBeenCalledTimes(1);
    expect(api.setRole).toHaveBeenLastCalledWith(
      expect.objectContaining({ primary: jev, backups: [chat, mini] }),
      expect.anything(),
    );
    expect(rows().map((row) => row?.replace(/OpenRouter$/, ""))).toEqual([
      "Jev 1.14",
      "Chat",
      "Mini",
    ]);
  });
  it("promotes the first fallback when the primary is removed", async () => {
    saved = { primary: chat, backups: [jev, mini] };
    await render();
    await menu("Chat", "Remove");
    expect(api.setRole).toHaveBeenLastCalledWith(
      expect.objectContaining({ primary: jev, backups: [mini] }),
      expect.anything(),
    );
  });
  it("lets any fallback lead the main model, including a deployment-managed one", async () => {
    const managed = { provider: "anthropic", modelId: "claude" };
    api.forRole.mockResolvedValue([
      ...catalog,
      { provider: "anthropic", id: "claude", label: "Claude", billing: "", managed: true },
    ]);
    saved = { primary: chat, backups: [managed, mini] };
    await render();
    await menu("Claude", "Move up");
    expect(api.setRole).toHaveBeenLastCalledWith(
      expect.objectContaining({ primary: managed, backups: [chat, mini] }),
      expect.anything(),
    );
  });
  it("names the deployment's model and resets to it, keeping the fallbacks", async () => {
    saved = { primary: jev, backups: [mini], deploymentPrimary: chat };
    await render({ modelRole: "approval", title: "Approval model" });
    await pick("Change Jev 1.14", "Chat");
    expect(saved).toMatchObject({ primary: null, backups: [mini] });
    expect(container.querySelector('[data-testid="model-role-default"]')?.textContent).toBe(
      "1ChatOpenRouter",
    );
  });
  it("leaves a model where the loaded list has it when it is picked again", async () => {
    saved = { primary: chat, backups: [jev] };
    await render();
    await click(trigger("Add fallback"));
    // A reload is still in flight when Mini is picked; it brings Mini in as the main model.
    let finish = () => {};
    api.role.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ primary: pin(mini), backups: [chat, jev] });
        }),
    );
    await render({ credentials: [...credentials] });
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (entry) => optionName(entry) === "Mini",
    );
    expect(option).toBeDefined();
    await act(async () => option?.click());
    await act(async () => finish());
    // Mini stays the main model and is not added a second time as a fallback.
    for (const [patch] of api.setRole.mock.calls) {
      expect(patch.primary?.modelId ?? "mini").toBe("mini");
      expect(
        patch.backups?.filter((entry: { modelId: string }) => entry.modelId === "mini") ?? [],
      ).toHaveLength(0);
    }
  });
  it("replaces a fallback in place without duplicating it", async () => {
    saved = { primary: chat, backups: [jev] };
    await render();
    await pick("Change Jev 1.14", "Mini");
    expect(saved).toEqual({ primary: chat, backups: [pin(mini)] });
  });
  it("hands a not-connected provider to the connect flow and reopens its models once connected", async () => {
    saved = { primary: chat, backups: [] };
    await render();
    await pick("Add fallback", "DeepSeek");
    expect(onConnect).toHaveBeenCalledWith(
      deepseek,
      expect.objectContaining({ makeDefault: false }),
    );
    const intent = onConnect.mock.lastCall?.[1];
    await act(async () => intent.onConnected({ provider: "openrouter", modelId: "mini" }));
    expect(api.setRole).not.toHaveBeenCalled();
    const search = document.querySelector<HTMLInputElement>('input[aria-label="Search models"]');
    expect(search?.value).toBe("OpenRouter");
  });
  it("does not reopen a picker after its model is replaced following a connection", async () => {
    saved = { primary: chat, backups: [] };
    await render();
    await pick("Change Chat", "DeepSeek");
    await act(async () =>
      onConnect.mock.lastCall?.[1].onConnected({ provider: "openrouter", modelId: "chat" }),
    );
    const search = () =>
      document.querySelector<HTMLInputElement>('input[aria-label="Search models"]');
    expect(search()?.value).toBe("OpenRouter");
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (entry) => optionName(entry) === "Mini",
    );
    await click(option);
    expect(saved.primary).toEqual(expect.objectContaining(mini));
    expect(search()).toBeNull();
  });
  it("makes only the main role's first slot the space default on connect", async () => {
    await render();
    await pick("Change Main model", "DeepSeek");
    expect(onConnect).toHaveBeenLastCalledWith(
      deepseek,
      expect.objectContaining({ makeDefault: true }),
    );
    // The connection itself sets the main model, so the list only reloads and reopens.
    await act(async () =>
      onConnect.mock.lastCall?.[1].onConnected({ provider: "deepseek", modelId: "deepseek-chat" }),
    );
    expect(api.setRole).not.toHaveBeenCalled();
    expect(api.role).toHaveBeenCalledTimes(2);

    await act(async () => root.unmount());
    root = createRoot(container);
    await render({ modelRole: "approval", title: "Approval model" });
    await pick("Change Approval model", "DeepSeek");
    expect(onConnect).toHaveBeenLastCalledWith(
      deepseek,
      expect.objectContaining({ makeDefault: false }),
    );
    await act(async () =>
      onConnect.mock.lastCall?.[1].onConnected({ provider: "deepseek", modelId: "deepseek-chat" }),
    );
    expect(api.setRole).not.toHaveBeenCalled();
    expect(
      document.querySelector<HTMLInputElement>('input[aria-label="Search models"]')?.value,
    ).toBe("deepseek");
  });
  it("manages a connected row's provider and shows thinking only on the main primary", async () => {
    api.forRole.mockResolvedValue(
      catalog.map((entry) =>
        entry.id === "chat" ? { ...entry, thinkingLevels: ["off", "low", "high"] } : entry,
      ),
    );
    saved = { primary: { ...chat, thinkingLevel: "high" }, backups: [jev] };
    await render({ thinking: true });
    expect(container.textContent).toContain("Thinking: High");
    await menu("Chat", "Manage OpenRouter");
    expect(onManage).toHaveBeenCalledWith("openrouter", "key");
    await click(trigger("Jev 1.14 options"));
    expect(
      [...document.querySelectorAll('[role="menuitem"]')].map((entry) => entry.textContent),
    ).not.toContain("Thinking");
  });
  it("saves the main model's thinking with its list", async () => {
    api.forRole.mockResolvedValue(
      catalog.map((entry) =>
        entry.id === "chat" ? { ...entry, thinkingLevels: ["off", "low", "high"] } : entry,
      ),
    );
    saved = { primary: { ...chat, thinkingLevel: "high" }, backups: [jev] };
    await render({ thinking: true });
    await menu("Chat", "Thinking");
    await click(
      [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
        (entry) => entry.textContent === "Low",
      ),
    );
    expect(api.setRole).toHaveBeenLastCalledWith(
      {
        role: "main",
        expectedUserId: "user",
        scope: "account",
        primary: { ...chat, thinkingLevel: "low" },
      },
      expect.anything(),
    );
  });
  it("does not replace unseen settings after a failed load and retries", async () => {
    api.role.mockRejectedValueOnce(new Error("offline"));
    await render({ modelRole: "approval", title: "Approval model" });
    expect(trigger("Change Approval model")?.disabled).toBe(true);
    expect(trigger("Add fallback")?.disabled).toBe(true);
    expect(api.setRole).not.toHaveBeenCalled();
    const retry = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry",
    );
    await click(retry);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(trigger("Change Approval model")?.disabled).toBe(false);
  });
  it("retains confirmed settings when a save fails", async () => {
    saved = { primary: null, backups: [chat] };
    api.setRole.mockRejectedValueOnce(new Error("save failed"));
    await render();
    await menu("Chat", "Remove");
    expect(rows()).toEqual(["ChatOpenRouter"]);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("save failed");
  });
});

it("names rows and menus by their connection", async () => {
  api.forRole.mockResolvedValue([
    {
      provider: "anthropic",
      id: "claude",
      label: "Claude",
      providerName: "Anthropic",
      billing: "",
    },
  ]);
  saved = { primary: null, backups: [{ provider: "anthropic", modelId: "claude" }] };
  await render({
    modelRole: "approval",
    title: "Approval model",
    providerLabel: (id) => (id === "anthropic" ? "Claude subscription" : id),
    credentials: [
      {
        id: "subscription",
        provider: "anthropic",
        label: "Anthropic",
        isDefault: true,
        hasKey: true,
        authKind: "oauth",
        modelId: "claude",
      },
    ],
  });
  expect(rows()).toEqual(["ClaudeClaude subscription"]);
  await click(trigger("Claude options"));
  expect(
    [...document.querySelectorAll('[role="menuitem"]')].map((entry) => entry.textContent),
  ).toContain("Manage Claude subscription");
});

it("groups models by connection and runs the same model on either account", async () => {
  const work = {
    id: "work",
    provider: "openrouter",
    label: "Work",
    isDefault: false,
    hasKey: true,
  };
  saved = { primary: pin(chat), backups: [] };
  await render({ credentials: [...credentials, work] });
  expect(rows()).toEqual(["ChatOpenRouter"]);
  await click(trigger("Add fallback"));
  expect(
    [...document.querySelectorAll("[cmdk-group-heading]")].map((entry) => entry.textContent),
  ).toEqual(["OpenRouter", "OpenRouter (Work)"]);
  const workChat = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (entry) =>
      optionName(entry) === "Chat" &&
      entry.closest("[cmdk-group]")?.textContent?.startsWith("OpenRouter (Work)"),
  );
  await click(workChat);
  expect(saved).toEqual({
    primary: pin(chat),
    backups: [{ ...chat, credentialId: "work" }],
  });
  expect(rows()).toEqual(["ChatOpenRouter", "ChatOpenRouter (Work)"]);
  await menu("Chat", "Manage OpenRouter");
  expect(onManage).toHaveBeenLastCalledWith("openrouter", "key");
});

it("reads and saves a Space's own list without mixing it with the account's", async () => {
  const lists: Record<string, Settings> = {
    account: { primary: pin(chat), backups: [] },
    space: { primary: pin(mini), backups: [] },
  };
  api.role.mockImplementation(async ({ scope }: { scope: string }) => lists[scope]);
  api.setRole.mockImplementation(
    async ({ role: _r, expectedUserId: _u, scope, ...patch }: Record<string, unknown>) => {
      lists[scope as string] = { ...lists[scope as string]!, ...patch };
      return lists[scope as string];
    },
  );
  await render({ scope: "space" });
  await vi.waitFor(() => expect(rows()).toEqual(["MiniOpenRouter"]));
  expect(api.role).toHaveBeenLastCalledWith(
    { role: "main", expectedUserId: "user", scope: "space" },
    { context: { spaceId: "space" } },
  );
  // Which models a role can use does not depend on whose list it is.
  expect(api.forRole).toHaveBeenLastCalledWith(
    { role: "main", expectedUserId: "user" },
    { context: { spaceId: "space" } },
  );
  await pick("Add fallback", "Jev 1.14");
  expect(api.setRole).toHaveBeenLastCalledWith(
    expect.objectContaining({ scope: "space", backups: [pin(jev)] }),
    { context: { spaceId: "space" } },
  );
  expect(lists.account).toEqual({ primary: pin(chat), backups: [] });

  await render({ scope: "account" });
  await vi.waitFor(() => expect(rows()).toEqual(["ChatOpenRouter"]));
});
