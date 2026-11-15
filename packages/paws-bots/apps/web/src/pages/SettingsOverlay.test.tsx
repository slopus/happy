// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
    i18n: { locale: "en" },
  }),
}));

vi.mock("@rakazo/ui-web", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  Dialog: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogClose: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogContent: ({
    children,
    showCloseButton: _showCloseButton,
    initialFocus: _initialFocus,
    ...props
  }: { children?: ReactNode; showCloseButton?: boolean; initialFocus?: unknown } & Omit<
    React.ComponentProps<"div">,
    "children"
  >) => <div {...props}>{children}</div>,
  DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
}));

vi.mock("./AccountSettingsOverlay", () => ({
  ComputerSettingsPanel: () => null,
  GeneralSettingsPanels: () => null,
  UpdatesSettingsPanel: () => null,
  UsageSettingsPanel: () => null,
}));
const { memoryConfigs, memoryConfigChange, providerConfig, updaterStatus } = vi.hoisted(() => ({
  memoryConfigs: [] as unknown[],
  memoryConfigChange: { current: (_config: unknown) => {} },
  providerConfig: vi.fn(async (_spaceId: string): Promise<unknown> => null),
  updaterStatus: vi.fn(async (): Promise<unknown> => ({ installKind: "compose" })),
}));
vi.mock("../lib/rpc", () => ({
  rpc: { updater: { status: updaterStatus } },
  createSpaceRpc: () => ({ memory: { providerConfig: () => providerConfig("") } }),
  selectedSpaceId: () => null,
  rpcForSpace: (spaceId: string) => ({
    memory: { providerConfig: () => providerConfig(spaceId) },
  }),
}));
vi.mock("./BillingSettingsPanel", () => ({ BillingSettingsPanel: () => null }));
vi.mock("./PaymentWalletSettingsPanel", () => ({ PaymentWalletSettingsPanel: () => null }));
vi.mock("./MemorySettingsOverlay", () => ({
  MemorySettingsOverlay: ({
    config,
    onConfigChange,
  }: {
    config: unknown;
    onConfigChange: (config: unknown) => void;
  }) => {
    memoryConfigs.push(config);
    memoryConfigChange.current = onConfigChange;
    return null;
  },
}));
vi.mock("./SpaceSettingsPanel", () => ({
  SpaceSettingsPanel: ({
    space,
    onDelete,
  }: {
    space: { name: string };
    onDelete: () => Promise<void>;
  }) => (
    <button type="button" data-testid="space-settings" onClick={() => void onDelete()}>
      {space.name}
    </button>
  ),
}));
const { scopes, recordScope } = vi.hoisted(() => {
  const scopes: string[] = [];
  return {
    scopes,
    recordScope:
      (name: string) =>
      ({ scope }: { scope: string }) => {
        scopes.push(`${name}:${scope}`);
        return null;
      },
  };
});
vi.mock("./ModelSettingsOverlay", () => ({ ModelSettingsOverlay: recordScope("models") }));
vi.mock("./VoiceSettingsOverlay", () => ({ VoiceSettingsOverlay: recordScope("voice") }));
vi.mock("../components/ApprovalRulesSettings", () => ({
  ApprovalRulesSettings: recordScope("confirmations"),
}));
vi.mock("../components/VaultSettings", () => ({ VaultSettings: recordScope("vault") }));
vi.mock("../components/ComputersUnavailableHint", () => ({
  computersAreUnavailable: () => false,
}));

import { SettingsOverlay } from "./SettingsOverlay";

const acme = { id: "space-a", name: "Acme" };
const spaces = [acme, { id: "space-b", name: "Beta" }];

async function render(props: Partial<React.ComponentProps<typeof SettingsOverlay>>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rerender = async (next: Partial<React.ComponentProps<typeof SettingsOverlay>>) => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SettingsOverlay
            name="Jamie"
            onUsageOpen={() => undefined}
            timezone={null}
            onTimezoneChange={async () => undefined}
            memoryConfig={null}
            onMemoryConfigChange={() => undefined}
            onClose={() => undefined}
            section="general"
            onSectionChange={() => undefined}
            shellRpc={{} as never}
            {...next}
          />
        </QueryClientProvider>,
      );
    });
  };
  await rerender(props);
  return {
    container,
    rerender,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}

function button(container: HTMLElement, label: string) {
  const match = [...container.querySelectorAll("button")].find(
    (item) => item.getAttribute("aria-label") === label,
  );
  if (!match) throw new Error(`Missing ${label}`);
  return match;
}

it("lists the spaces under General and opens the one picked", async () => {
  const onOpenSpace = vi.fn();
  const { container, cleanup } = await render({ spaces, onOpenSpace });
  try {
    const list = container.querySelector('[data-testid="settings-spaces"]');
    expect(list?.textContent).toContain("Acme");
    expect(list?.textContent).toContain("Beta");
    await act(async () => button(container, "Manage Beta").click());
    expect(onOpenSpace).toHaveBeenCalledWith("space-b");
    // Spaces live under General, not in the nav.
    expect(container.querySelector('[data-testid="settings-nav-space"]')).toBeNull();
  } finally {
    await cleanup();
  }
});

it("lists no spaces when there is only one", async () => {
  const { container, cleanup } = await render({ spaces: [acme], onOpenSpace: vi.fn() });
  try {
    expect(container.querySelector('[data-testid="settings-spaces"]')).toBeNull();
  } finally {
    await cleanup();
  }
});

it("titles a space's page with its name and leads back to General", async () => {
  const onDeleteSpace = vi.fn(async () => undefined);
  const onSectionChange = vi.fn();
  const { container, cleanup } = await render({
    space: { ...acme, canDelete: true },
    spaces,
    onDeleteSpace,
    onSectionChange,
    section: "space",
  });
  try {
    expect(container.querySelector("h2")?.textContent).toBe("Acme");
    expect(
      container.querySelector('[data-testid="settings-nav-general"]')?.getAttribute("aria-current"),
    ).toBe("page");
    const panel = container.querySelector<HTMLButtonElement>('[data-testid="space-settings"]');
    await act(async () => panel?.click());
    expect(onDeleteSpace).toHaveBeenCalledWith("space-a");
    await act(async () => button(container, "Back").click());
    expect(onSectionChange).toHaveBeenCalledWith("general");
  } finally {
    await cleanup();
  }
});

it("reports a section picked in the nav so the shell can keep it in the URL", async () => {
  const onSectionChange = vi.fn();
  const { container, cleanup } = await render({ onSectionChange });
  try {
    const usage = container.querySelector<HTMLButtonElement>('[data-testid="settings-nav-usage"]');
    if (!usage) throw new Error("Missing Usage nav item");
    await act(async () => usage.click());
    expect(onSectionChange).toHaveBeenCalledWith("usage");
  } finally {
    await cleanup();
  }
});

it("opens a linked billing section once billing turns out to be on", async () => {
  const { container, rerender, cleanup } = await render({
    section: "billing",
    billingEnabled: false,
  });
  const shown = () =>
    container.querySelector("[data-settings-section]")?.getAttribute("data-settings-section");
  try {
    expect(shown()).toBe("general");
    await rerender({ section: "billing", billingEnabled: true });
    expect(shown()).toBe("billing");
  } finally {
    await cleanup();
  }
});

it("edits the account's models, voice, confirmations, and vault", async () => {
  scopes.length = 0;
  const props = { space: acme, spaces };
  const { container, rerender, cleanup } = await render({ ...props, section: "models" });
  try {
    for (const section of ["models", "voice", "confirmations", "vault"] as const) {
      await rerender({ ...props, section });
    }
    const vaultNav = container.querySelector('[data-testid="settings-nav-vault"]');
    expect(vaultNav?.textContent).toBe("Vault");
    expect(vaultNav?.getAttribute("aria-current")).toBe("page");
    expect(container.querySelector("h2")?.textContent).toBe("Vault");
    expect(new Set(scopes)).toEqual(
      new Set(["models:account", "voice:account", "confirmations:account", "vault:account"]),
    );
  } finally {
    await cleanup();
  }
});

it("edits the memory of the space the app is showing, even after another space's page", async () => {
  memoryConfigs.length = 0;
  providerConfig.mockReset();
  const shown = {
    provider: "mem0",
    settings: {},
    defaultMemoryScope: "shared" as const,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const onMemoryConfigChange = vi.fn();
  const { cleanup } = await render({
    space: spaces[1],
    spaces,
    section: "memory",
    memoryConfig: shown,
    onMemoryConfigChange,
  });
  try {
    expect(memoryConfigs.at(-1)).toBe(shown);
    await act(async () => memoryConfigChange.current(null));
    expect(onMemoryConfigChange).toHaveBeenCalledWith(null);
    expect(providerConfig).not.toHaveBeenCalled();
  } finally {
    await cleanup();
  }
});

const updatesNav = (container: HTMLElement) =>
  container.querySelector('[data-testid="settings-nav-updates"]');

it("hides server updates and never requests server authority", async () => {
  const { container, cleanup } = await render({});
  try {
    expect(updatesNav(container)).toBeNull();
    expect(updaterStatus).not.toHaveBeenCalled();
  } finally {
    await cleanup();
  }
});

it("shows Updates in the desktop app", async () => {
  vi.stubGlobal("rakazoDesktop", { update: {} });
  const { container, cleanup } = await render({});
  try {
    expect(updatesNav(container)).not.toBeNull();
  } finally {
    await cleanup();
  }
});

it("offers Wallet only when the deployment has a wallet provider", async () => {
  const { container, rerender, cleanup } = await render({ section: "wallet" });
  const shown = () =>
    container.querySelector("[data-settings-section]")?.getAttribute("data-settings-section");
  try {
    expect(container.querySelector('[data-testid="settings-nav-wallet"]')).toBeNull();
    expect(shown()).toBe("general");
    await rerender({ section: "wallet", paymentWalletProvider: { id: "link", name: "Link" } });
    expect(container.querySelector('[data-testid="settings-nav-wallet"]')).not.toBeNull();
    expect(shown()).toBe("wallet");
  } finally {
    await cleanup();
  }
});

it("says what a page is for only where its name does not", async () => {
  const general = await render({ section: "general" });
  try {
    expect(general.container.querySelector("h2 + p")).toBeNull();
  } finally {
    await general.cleanup();
  }
  const voice = await render({ section: "voice" });
  try {
    expect(voice.container.querySelector("h2 + p")?.textContent).toBe(
      "Calls, dictation, and replies read aloud.",
    );
  } finally {
    await voice.cleanup();
  }
});
