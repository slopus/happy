// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { spaceSettings, rpcForSpace, panels } = vi.hoisted(() => {
  const spaceSettings = { overrides: vi.fn(), setOverride: vi.fn() };
  return {
    spaceSettings,
    // The other namespaces are only refreshed after a change.
    rpcForSpace: vi.fn((_spaceId: string) => ({
      spaceSettings,
      models: {},
      me: vi.fn(),
      voice: {},
      approvalRules: {},
      autoReview: {},
      vault: {},
    })),
    panels: [] as string[],
  };
});

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`),
  }),
}));
vi.mock("@rakazo/ui-web", () => {
  const Button = ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  );
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  // Base UI's cancel closes through the dialog's onOpenChange.
  let close = () => {};
  return {
    Button,
    AlertDialog: ({
      children,
      onOpenChange,
    }: {
      children?: ReactNode;
      onOpenChange: (open: boolean) => void;
    }) => {
      close = () => onOpenChange(false);
      return <div data-testid="confirm-dialog">{children}</div>;
    },
    AlertDialogAction: Button,
    AlertDialogCancel: (props: ComponentProps<"button">) => (
      <button type="button" {...props} onClick={() => close()} />
    ),
    AlertDialogContent: Box,
    AlertDialogDescription: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
    AlertDialogFooter: Box,
    AlertDialogHeader: Box,
    AlertDialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  };
});
vi.mock("../lib/rpc", () => ({
  rpc: { spaceSettings },
  rpcForSpace,
  createSpaceRpc: () => ({ spaceSettings }),
  selectedSpaceId: () => "selected",
}));
vi.mock("./ModelSettingsOverlay", () => ({
  ModelSettingsOverlay: ({ scope }: { scope: string }) => {
    panels.push(`models:${scope}`);
    return <div data-testid="models-panel" />;
  },
}));
vi.mock("./VoiceSettingsOverlay", () => ({
  VoiceSettingsOverlay: ({ scope }: { scope: string }) => {
    panels.push(`voice:${scope}`);
    return <div data-testid="voice-panel" />;
  },
}));
vi.mock("../components/ApprovalRulesSettings", () => ({
  ApprovalRulesSettings: ({ scope }: { scope: string }) => {
    panels.push(`confirmations:${scope}`);
    return <div data-testid="confirmations-panel" />;
  },
}));
vi.mock("../components/VaultSettings", () => ({
  VaultSettings: ({
    scope,
    onBusyChange,
  }: {
    scope: string;
    onBusyChange: (busy: boolean) => void;
  }) => {
    panels.push(`credentials:${scope}`);
    return (
      <div data-testid="credentials-panel">
        <button type="button" aria-label="Start saving" onClick={() => onBusyChange(true)} />
        <button type="button" aria-label="Finish saving" onClick={() => onBusyChange(false)} />
      </div>
    );
  },
}));

import { QueryUserProvider } from "../lib/query";
import { SpaceRpcProvider } from "../lib/space-rpc";
import { SpaceSettingOverrides } from "./SpaceSettingOverrides";

let container: HTMLDivElement;
let root: Root;

async function render(children: ReactNode = <SpaceSettingOverrides onClose={() => undefined} />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <QueryUserProvider value="user">
          <SpaceRpcProvider spaceId="space-a">{children}</SpaceRpcProvider>
        </QueryUserProvider>
      </QueryClientProvider>,
    );
  });
}

function button(label: string) {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

async function click(label: string) {
  const target = button(label);
  if (!target) throw new Error(`Missing ${label}`);
  await act(async () => target.click());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  panels.length = 0;
  spaceSettings.overrides.mockReset();
  spaceSettings.setOverride.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("follows the account until a setting is customized, then edits the Space's own copy", async () => {
  spaceSettings.overrides.mockResolvedValue([]);
  spaceSettings.setOverride.mockImplementation(
    async ({ setting, enabled }: { setting: string; enabled: boolean }) =>
      enabled ? [setting] : [],
  );
  await render();
  await vi.waitFor(() => expect(button("Customize Models")).not.toBeNull());
  expect(button("Customize Voice")?.textContent).toBe("Customize");
  expect(button("Customize Approvals")).not.toBeNull();
  expect(button("Customize Vault")).not.toBeNull();
  expect(container.textContent?.match(/Your defaults/g)).toHaveLength(4);
  expect(panels).toEqual([]);
  // The calls go to the space these settings are bound to, not the selected one.
  expect(rpcForSpace).toHaveBeenCalledWith("space-a");

  await click("Customize Voice");
  expect(spaceSettings.setOverride).toHaveBeenLastCalledWith({ setting: "voice", enabled: true });
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="voice-panel"]')).not.toBeNull(),
  );
  expect(new Set(panels)).toEqual(new Set(["voice:space"]));
  expect(button("Use defaults for Voice")?.textContent).toBe("Use defaults");
  expect(container.textContent?.match(/Your defaults/g)).toHaveLength(3);

  await click("Use defaults for Voice");
  expect(spaceSettings.setOverride).toHaveBeenLastCalledWith({ setting: "voice", enabled: false });
  await vi.waitFor(() => expect(container.querySelector('[data-testid="voice-panel"]')).toBeNull());
  expect(button("Customize Voice")).not.toBeNull();
});

it("opens the panels a Space already customizes", async () => {
  spaceSettings.overrides.mockResolvedValue(["models", "confirmations"]);
  await render();
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="models-panel"]')).not.toBeNull(),
  );
  expect(container.querySelector('[data-testid="confirmations-panel"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="voice-panel"]')).toBeNull();
  expect(new Set(panels)).toEqual(new Set(["models:space", "confirmations:space"]));
});

it("asks before going back to the defaults deletes the Space's own vault", async () => {
  spaceSettings.overrides.mockResolvedValue(["credentials"]);
  spaceSettings.setOverride.mockResolvedValue([]);
  await render();
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="credentials-panel"]')).not.toBeNull(),
  );
  expect(new Set(panels)).toEqual(new Set(["credentials:space"]));
  const dialog = () => container.querySelector('[data-testid="confirm-dialog"]');

  // A credential still saving would land in the vault being deleted, so the reset waits for it.
  await click("Start saving");
  expect(button("Use defaults for Vault")?.disabled).toBe(true);
  await click("Finish saving");
  expect(button("Use defaults for Vault")?.disabled).toBe(false);

  await click("Use defaults for Vault");
  expect(spaceSettings.setOverride).not.toHaveBeenCalled();
  expect(dialog()?.textContent).toContain("Delete this Space's credentials?");
  const cancel = [...(dialog()?.querySelectorAll("button") ?? [])].find(
    (item) => item.textContent === "Cancel",
  );
  await act(async () => cancel?.click());
  expect(dialog()).toBeNull();
  expect(spaceSettings.setOverride).not.toHaveBeenCalled();

  await click("Use defaults for Vault");
  const confirm = [...(dialog()?.querySelectorAll("button") ?? [])].find(
    (item) => item.textContent === "Delete",
  );
  await act(async () => confirm?.click());
  expect(spaceSettings.setOverride).toHaveBeenCalledWith({
    setting: "credentials",
    enabled: false,
  });
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="credentials-panel"]')).toBeNull(),
  );
  expect(dialog()).toBeNull();
  expect(button("Customize Vault")).not.toBeNull();
});

it("keeps the row as it was when customizing fails", async () => {
  spaceSettings.overrides.mockResolvedValue([]);
  spaceSettings.setOverride.mockRejectedValue(new Error("Space is unavailable"));
  await render();
  await vi.waitFor(() => expect(button("Customize Models")).not.toBeNull());
  await click("Customize Models");
  await vi.waitFor(() => expect(container.textContent).toContain("Space is unavailable"));
  expect(button("Customize Models")).not.toBeNull();
  expect(panels).toEqual([]);
});
