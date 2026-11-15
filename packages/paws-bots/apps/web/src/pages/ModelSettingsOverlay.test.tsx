// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type * as UiWeb from "@rakazo/ui-web";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

type UiWebModule = typeof UiWeb;

/** Provider rows end with their "Connect" action; models show their name alone. */
const optionName = (entry: Element) => entry.textContent?.replace(/Connect$/, "");
const models = vi.hoisted(() => ({
  list: vi.fn(),
  role: vi.fn(),
  forRole: vi.fn(),
  setRole: vi.fn(),
  credentials: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  rename: vi.fn(),
  setDefault: vi.fn(),
  probeOpenAiCompatible: vi.fn(),
  beginOAuth: vi.fn(),
  cancelOAuth: vi.fn(),
  completeOAuth: vi.fn(),
  finishOAuth: vi.fn(),
  submitOAuthCode: vi.fn(),
}));

const autoReview = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("../lib/rpc", () => {
  const rpc = {
    models,
    autoReview,
    bots: { list: vi.fn(async () => []), update: vi.fn() },
    me: vi.fn(),
  };
  return {
    selectedSpaceId: () => "space-1",
    rpc,
    rpcForSpace: () => rpc,
    createSpaceRpc: () => rpc,
  };
});
vi.mock("../lib/localized-provider-hint", () => ({
  localizedProviderHint: () => "API key",
  providerRowHint: () => null,
  providerDisplayName: (_id: string, name: string) => name,
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce(
      (text, part, index) => `${text}${index > 0 ? String(values[index - 1]) : ""}${part}`,
      "",
    );
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children?: ReactNode }) => children,
    Plural: ({ one, other, value }: { one: string; other: string; value: number }) =>
      value === 1 ? one : other,
  };
});
vi.mock("@rakazo/ui-web", async (importOriginal) => {
  const actual = await importOriginal<UiWebModule>();
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    ...actual,
    AlertDialog: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
      open ? <div>{children}</div> : null,
    AlertDialogAction: ({
      children,
      onClick,
      disabled,
    }: {
      children?: ReactNode;
      onClick?: () => void;
      disabled?: boolean;
    }) => (
      <button type="button" disabled={disabled} onClick={onClick}>
        {children}
      </button>
    ),
    AlertDialogCancel: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
      <button type="button" onClick={onClick}>
        {children}
      </button>
    ),
    AlertDialogContent: Pass,
    AlertDialogDescription: Pass,
    AlertDialogFooter: Pass,
    AlertDialogHeader: Pass,
    AlertDialogTitle: Pass,
    Button: ({
      children,
      onClick,
      disabled,
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
      <button type="button" disabled={disabled} onClick={onClick} {...props}>
        {children}
      </button>
    ),
    // Dialogs render inline, and only while open.
    Dialog: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
      open ? <div>{children}</div> : null,
    DialogClose: Pass,
    DialogContent: Pass,
    DialogDescription: ({ children }: { children?: ReactNode }) => (
      <p data-testid="model-description">{children}</p>
    ),
    DialogHeader: Pass,
    DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    ModelThinkingOptions: (props: {
      children?: ReactNode;
      maxTokens?: string;
      maxTokensLabel?: string;
      onMaxTokensChange?: (value: string) => void;
      thinkingLevel?: string | null;
      thinkingLevelLabel?: string;
      thinkingLevelOptions?: { value: string; label: string }[];
      onThinkingLevelChange?: (value: string) => void;
    }) =>
      props.onMaxTokensChange || props.onThinkingLevelChange ? (
        <>
          {props.onMaxTokensChange ? (
            <input
              aria-label={props.maxTokensLabel}
              value={props.maxTokens ?? ""}
              onChange={(event) => props.onMaxTokensChange?.(event.target.value)}
            />
          ) : null}
          {props.onThinkingLevelChange ? (
            <select
              aria-label={props.thinkingLevelLabel}
              value={props.thinkingLevel ?? ""}
              onChange={(event) => props.onThinkingLevelChange?.(event.target.value)}
            >
              {(props.thinkingLevelOptions ?? []).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : null}
          {props.children}
        </>
      ) : null,
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  };
});

import { rpc } from "../lib/rpc";
import { ModelSettingsOverlay } from "./ModelSettingsOverlay";

const STORED_PLACEHOLDER = "Paste a replacement key";
const deepseekEntry = {
  provider: "deepseek",
  providerName: "DeepSeek",
  id: "deepseek-chat",
  label: "DeepSeek Chat",
  billing: "API key",
  auth: "api-key" as const,
  authHint: "API key",
};
const openrouterEntry = {
  provider: "openrouter",
  providerName: "OpenRouter",
  id: "fixture/router-model",
  label: "Router model",
  billing: "API key",
  auth: "api-key" as const,
  authHint: "API key",
};
const compatibleEntry = {
  provider: "openai-compatible",
  providerName: "OpenAI-compatible",
  id: "custom",
  label: "Custom model",
  billing: "Your server",
  auth: "api-key" as const,
  authHint: "Custom server",
  placeholder: true,
  endpointPresets: [{ name: "Ollama Cloud", baseUrl: "https://ollama.com/v1" }],
};
const deepseekCredential = {
  id: "cred-deepseek",
  provider: "deepseek",
  label: "DeepSeek",
  hasKey: true,
  isDefault: true,
  modelId: "deepseek-chat",
};

function account(provider: string, modelId: string) {
  return {
    userId: "user-1",
    email: "ada@example.test",
    name: "Ada",
    spaceId: "space-1",
    isDeploymentOwner: false,
    isAdmin: false,
    needsModel: false,
    defaultProvider: provider,
    defaultModel: modelId,
    hostCredentialProvider: null,
    hostCredentialSource: null,
    computerHost: null,
    canChooseHostComputer: false,
    sandboxProvider: "docker",
    mcpStdioEnabled: false,
    avatarStyle: "organic" as const,
    billingEnabled: false,
    ticketBoardEnabled: false,
    navLinks: [],
    phoneCallsEnabled: false,
  };
}

function buttons(container: HTMLElement, text: string) {
  const found = [...container.querySelectorAll("button")].filter((entry) =>
    entry.textContent?.includes(text),
  );
  if (found.length === 0) throw new Error(`Missing button: ${text}`);
  return found;
}

function keyField(container: HTMLElement) {
  const input = container.querySelector("#model-api-key");
  if (!(input instanceof HTMLInputElement)) throw new Error("Missing API key field");
  return input;
}

function compatibleKeyField(container: HTMLElement) {
  const input = [...container.querySelectorAll("input")].find(
    (entry) => entry.getAttribute("aria-label") === "API key",
  );
  if (!(input instanceof HTMLInputElement)) throw new Error("Missing compatible API key field");
  return input;
}

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(element: Element | null | undefined) {
  if (!(element instanceof HTMLElement)) throw new Error("Missing element");
  await act(async () => element.click());
  await act(async () => {
    await Promise.resolve();
  });
}

function section(role: "main" | "approval" | "computer") {
  const found = document.querySelector(`[data-testid="model-role-${role}"]`);
  if (!found) throw new Error(`Missing ${role} model list`);
  return found;
}

/** Visible names of the open picker's options. */
function pickerOptions() {
  return [...document.querySelectorAll<HTMLElement>('[role="option"]')].map(optionName);
}

async function openPicker(label: string, role: "main" | "computer" = "main") {
  await click(section(role).querySelector(`button[aria-label="${label}"]`));
}

async function choose(option: string) {
  await click(
    [...document.querySelectorAll('[role="option"]')].find((entry) => optionName(entry) === option),
  );
}

/** Picks a model or a not-connected provider from one of the list's pickers. */
async function pick(label: string, option: string, role: "main" | "computer" = "main") {
  await openPicker(label, role);
  await choose(option);
}

/** Opens the connection dialog for the main model's first row through its options menu. */
async function manage() {
  await click(
    section("main").querySelector(
      '[data-testid="model-role-row-1"] button[aria-label$=" options"]',
    ),
  );
  await click(
    [...document.querySelectorAll('[role="menuitem"]')].find((entry) =>
      entry.textContent?.startsWith("Manage "),
    ),
  );
}

function titles(container: HTMLElement) {
  return [...container.querySelectorAll('[data-testid="model-connection-title"]')].map(
    (entry) => entry.textContent,
  );
}

function testQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

async function renderSettings(
  embedded = true,
  queryClient = testQueryClient(),
  scope: "account" | "space" = "account",
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ModelSettingsOverlay embedded={embedded} scope={scope} onClose={() => undefined} />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return {
    container,
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = () => undefined;
  i18n.loadAndActivate({ locale: "en", messages: {} });
  vi.mocked(rpc.me).mockResolvedValue(account("deepseek", "deepseek-chat"));
  models.list.mockResolvedValue([deepseekEntry]);
  models.credentials.mockResolvedValue([]);
  autoReview.get.mockResolvedValue({
    mode: "ask",
    enabled: false,
    skipApprovals: false,
    checkerAvailable: true,
  });
  models.connect.mockResolvedValue({});
  models.disconnect.mockResolvedValue(undefined);
  models.forRole.mockImplementation(() => models.list());
  models.setRole.mockImplementation(
    async ({ role: _role, expectedUserId: _user, ...patch }: Record<string, unknown>) => ({
      primary: null,
      backups: [],
      ...patch,
    }),
  );
  // The main role's first slot is the space default once its provider is connected.
  models.role.mockImplementation(async ({ role }: { role: string }) => {
    if (role !== "main") return { primary: null, backups: [] };
    const [me, credentials] = await Promise.all([rpc.me(), models.credentials()]);
    const connected =
      !me.needsModel &&
      (credentials as { provider: string }[]).some(
        (entry) => entry.provider === me.defaultProvider,
      );
    return {
      primary: connected ? { provider: me.defaultProvider, modelId: me.defaultModel } : null,
      backups: [],
      ...(connected ? { seesImages: true } : {}),
    };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

it("reopens on cached models without a spinner and refreshes them behind it", async () => {
  models.credentials.mockResolvedValue([deepseekCredential]);
  const queryClient = testQueryClient();
  const first = await renderSettings(true, queryClient);
  expect(first.container.querySelector('[data-testid="model-role-row-1"]')).not.toBeNull();
  await first.unmount();

  const hold = new Promise<never>(() => undefined);
  models.list.mockReturnValue(hold);
  models.role.mockReturnValue(hold);
  models.forRole.mockReturnValue(hold);
  const listCalls = models.list.mock.calls.length;
  const roleCalls = models.role.mock.calls.length;
  const view = await renderSettings(true, queryClient);
  try {
    expect(view.container.querySelector('[aria-label="Loading model catalog…"]')).toBeNull();
    expect(view.container.querySelector('[data-testid="model-role-row-1"]')).not.toBeNull();
    expect(models.list.mock.calls.length).toBeGreaterThan(listCalls);
    expect(models.role.mock.calls.length).toBeGreaterThan(roleCalls);
  } finally {
    await view.unmount();
  }
});

it("shows a stored BYOK key when provider settings reopen", async () => {
  models.credentials.mockResolvedValue([deepseekCredential]);

  const view = await renderSettings();
  try {
    expect(view.container.querySelector("#model-api-key")).toBeNull();
    await manage();
    expect(titles(view.container)).toEqual(["DeepSeek"]);
    const input = keyField(view.container);
    expect(input.value).toBe("");
    expect(input.placeholder).toBe(STORED_PLACEHOLDER);
    expect(input.type).toBe("password");
    expect(view.container.textContent).not.toContain("sk-");
    expect(buttons(view.container, "Replace API key")[0]?.disabled).toBe(true);

    await typeInto(input, "sk-replacement-key");
    expect(keyField(view.container).value).toBe("sk-replacement-key");

    await typeInto(keyField(view.container), "");
    expect(keyField(view.container).value).toBe("");
    expect(keyField(view.container).placeholder).toBe(STORED_PLACEHOLDER);

    await typeInto(keyField(view.container), "sk-replacement-key");
    await click(buttons(view.container, "Replace API key")[0]);
    expect(models.connect).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "deepseek", apiKey: "sk-replacement-key" }),
    );
    // A saved connection closes its dialog; reopening shows the stored key again.
    expect(view.container.querySelector("#model-api-key")).toBeNull();
    await manage();
    expect(keyField(view.container).value).toBe("");
    expect(keyField(view.container).placeholder).toBe(STORED_PLACEHOLDER);

    models.credentials.mockResolvedValue([]);
    await click(buttons(view.container, "Disconnect")[0]);
    const confirm = buttons(view.container, "Disconnect");
    await click(confirm[confirm.length - 1]);
    expect(models.disconnect).toHaveBeenCalledWith({
      provider: "deepseek",
      credentialId: "cred-deepseek",
    });
    expect(view.container.querySelector("#model-api-key")).toBeNull();

    await pick("Change Main model", "DeepSeek");
    expect(titles(view.container)).toEqual(["Connect DeepSeek"]);
    expect(keyField(view.container).value).toBe("");
    expect(keyField(view.container).placeholder).toBe("sk-…");
  } finally {
    await view.unmount();
  }
});

it("saves an edited output limit without sending a half-typed replacement key", async () => {
  models.credentials.mockResolvedValue([deepseekCredential]);

  const view = await renderSettings();
  try {
    await manage();
    const limit = view.container.querySelector<HTMLInputElement>(
      'input[aria-label="Maximum output tokens"]',
    );
    if (!limit) throw new Error("Missing output limit field");
    await typeInto(limit, "4096");
    await typeInto(keyField(view.container), "sk-ab");
    await click(buttons(view.container, "Save").find((entry) => entry.textContent === "Save"));
    expect(models.connect).toHaveBeenCalledTimes(1);
    const input = models.connect.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input).toMatchObject({ provider: "deepseek", maxTokens: 4096 });
    expect(input).not.toHaveProperty("apiKey");
    // A limits-only save keeps the dialog and the half-typed key.
    expect(keyField(view.container).value).toBe("sk-ab");
  } finally {
    await view.unmount();
  }
});

it("renaming a connection keeps unsaved form fields", async () => {
  models.credentials.mockResolvedValue([deepseekCredential]);
  models.rename.mockResolvedValue(undefined);

  const view = await renderSettings();
  try {
    await manage();
    const limit = view.container.querySelector<HTMLInputElement>(
      'input[aria-label="Maximum output tokens"]',
    );
    if (!limit) throw new Error("Missing output limit field");
    await typeInto(limit, "8192");
    const nameLabel = [...view.container.querySelectorAll("label")].find(
      (entry) => entry.textContent === "Name",
    );
    const nameInput = nameLabel?.htmlFor
      ? view.container.querySelector<HTMLInputElement>(`#${CSS.escape(nameLabel.htmlFor)}`)
      : null;
    if (!nameInput) throw new Error("Missing connection name field");
    await typeInto(nameInput, "Renamed");
    models.credentials.mockResolvedValue([{ ...deepseekCredential, label: "Renamed" }]);
    const nameForm = nameInput.closest("form");
    const nameSave = nameForm?.querySelector('button[type="submit"]');
    if (!(nameSave instanceof HTMLButtonElement)) throw new Error("Missing name save button");
    await click(nameSave);
    await act(async () => {
      for (let index = 0; index < 5; index += 1) await new Promise((done) => setTimeout(done, 0));
    });
    expect(models.rename).toHaveBeenCalledWith({
      credentialId: "cred-deepseek",
      label: "Renamed",
    });
    expect(titles(view.container)).toEqual(["DeepSeek (Renamed)"]);
    expect(limit.value).toBe("8192");
  } finally {
    await view.unmount();
  }
});

it("leaves the key field empty until a key is saved", async () => {
  const view = await renderSettings();
  try {
    await pick("Change Main model", "DeepSeek");
    const input = keyField(view.container);
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("sk-…");
    expect(view.container.textContent).not.toContain(STORED_PLACEHOLDER);
  } finally {
    await view.unmount();
  }
});

it("labels the empty main slot by what runs there", async () => {
  vi.mocked(rpc.me).mockResolvedValue({
    ...account("deepseek", "deepseek-chat"),
    needsModel: true,
  });
  const view = await renderSettings();
  try {
    expect(section("main").querySelector('[data-testid="model-role-default"]')?.textContent).toBe(
      "Choose a model",
    );
  } finally {
    await view.unmount();
  }

  vi.mocked(rpc.me).mockResolvedValue(account("deepseek", "deepseek-chat"));
  models.credentials.mockResolvedValue([deepseekCredential]);
  const connected = await renderSettings();
  try {
    expect(section("main").querySelector('[data-testid="model-role-default"]')).toBeNull();
    expect(
      section("main").querySelector('[data-testid="model-role-row-1"]')?.textContent,
    ).toContain("DeepSeek Chat");
  } finally {
    await connected.unmount();
  }
});

it("shows the approval model only in Auto", async () => {
  const asking = await renderSettings();
  try {
    expect(asking.container.querySelector('[data-testid="model-role-approval"]')).toBeNull();
  } finally {
    await asking.unmount();
  }
  autoReview.get.mockResolvedValue({
    mode: "auto",
    enabled: true,
    skipApprovals: false,
    checkerAvailable: false,
  });
  const auto = await renderSettings();
  try {
    await vi.waitFor(() =>
      expect(
        section("approval").querySelector('[data-testid="model-role-default"]')?.textContent,
      ).toBe("Choose a model"),
    );
  } finally {
    await auto.unmount();
  }
});

it("keeps the computer-use model out of sight while the main model can see", async () => {
  models.credentials.mockResolvedValue([deepseekCredential]);
  const view = await renderSettings();
  try {
    expect(section("main").textContent).toContain("DeepSeek Chat");
    expect(view.container.querySelector('[data-testid="model-role-computer"]')).toBeNull();
    // Someone who wants screen work on another model asks for it from the main model's menu.
    await click(
      section("main").querySelector(
        '[data-testid="model-role-row-1"] button[aria-label$=" options"]',
      ),
    );
    await click(
      [...document.querySelectorAll('[role="menuitem"]')].find(
        (entry) => entry.textContent === "Computer-use model…",
      ),
    );
    expect(
      section("computer").querySelector('[data-testid="model-role-default"]')?.textContent,
    ).toBe("Same as main model");
  } finally {
    await view.unmount();
  }
});

it("shows the computer-use model when the server could not tell whether the main model sees", async () => {
  models.credentials.mockResolvedValue([deepseekCredential]);
  const role = models.role.getMockImplementation()!;
  models.role.mockImplementation(async (input: { role: string }) => {
    const { seesImages: _unknown, ...view } = (await role(input)) as Record<string, unknown>;
    return view;
  });
  const view = await renderSettings();
  try {
    await vi.waitFor(() =>
      expect(view.container.querySelector('[data-testid="model-role-computer"]')).not.toBeNull(),
    );
  } finally {
    await view.unmount();
  }
});

it("shows the computer-use model when the main model cannot read images", async () => {
  models.credentials.mockResolvedValue([deepseekCredential]);
  // The server says whether the main model reads images, as runs decide it.
  const role = models.role.getMockImplementation()!;
  models.role.mockImplementation(async (input: { role: string }) => ({
    ...(await role(input)),
    ...(input.role === "main" ? { seesImages: false } : {}),
  }));
  const view = await renderSettings();
  try {
    await vi.waitFor(() =>
      expect(
        section("computer").querySelector('[data-testid="model-role-default"]')?.textContent,
      ).toBe("Choose a model that can see the screen"),
    );
  } finally {
    await view.unmount();
  }
});

it("connects a provider from Add fallback without replacing the main model, then picks its model", async () => {
  models.list.mockResolvedValue([deepseekEntry, openrouterEntry]);
  models.credentials.mockResolvedValue([deepseekCredential]);
  const view = await renderSettings();
  try {
    await openPicker("Add fallback");
    expect(pickerOptions()).toContain("OpenRouter");
    await choose("OpenRouter");
    expect(titles(view.container)).toEqual(["Connect OpenRouter"]);
    await typeInto(keyField(view.container), "sk-fixture-router");
    models.credentials.mockResolvedValue([
      deepseekCredential,
      {
        id: "cred-openrouter",
        provider: "openrouter",
        label: "OpenRouter",
        hasKey: true,
        isDefault: false,
        modelId: openrouterEntry.id,
      },
    ]);
    await click(buttons(view.container, "Connect API key")[0]);
    expect(models.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openrouter",
        apiKey: "sk-fixture-router",
        modelId: openrouterEntry.id,
        makeDefault: false,
      }),
    );
    // The key belongs to the provider; its models are then chosen in the reopened picker.
    expect(titles(view.container)).toEqual([]);
    expect(models.setRole).not.toHaveBeenCalled();
    expect(pickerOptions()).toEqual([openrouterEntry.label]);
    await choose(openrouterEntry.label);
    expect(models.setRole).toHaveBeenCalledTimes(1);
    // The unchanged main model is left out, so the save cannot rewrite it.
    const [saved] = vi.mocked(models.setRole).mock.calls[0]!;
    expect(saved).toMatchObject({
      role: "main",
      backups: [
        { provider: "openrouter", modelId: openrouterEntry.id, credentialId: "cred-openrouter" },
      ],
    });
    expect(saved).not.toHaveProperty("primary");
  } finally {
    await view.unmount();
  }
});

it("connects the main model from the empty default row as the space default", async () => {
  vi.mocked(rpc.me).mockResolvedValue({
    ...account("deepseek", "deepseek-chat"),
    needsModel: true,
  });
  const view = await renderSettings();
  try {
    await pick("Change Main model", "DeepSeek");
    expect(titles(view.container)).toEqual(["Connect DeepSeek"]);
    await typeInto(keyField(view.container), "sk-fixture-deepseek");
    const loads = models.role.mock.calls.length;
    await click(buttons(view.container, "Connect API key")[0]);
    expect(models.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "deepseek",
        apiKey: "sk-fixture-deepseek",
        makeDefault: true,
        scope: "account",
      }),
    );
    // The connection already made it the main model, so the list reloads instead of writing.
    expect(models.setRole).not.toHaveBeenCalled();
    expect(models.role.mock.calls.length).toBeGreaterThan(loads);
    expect(titles(view.container)).toEqual([]);
  } finally {
    await view.unmount();
  }
});

it("shows a Space only its own role lists and makes a new connection its main model there", async () => {
  vi.mocked(rpc.me).mockResolvedValue({
    ...account("deepseek", "deepseek-chat"),
    needsModel: true,
  });
  const view = await renderSettings(true, testQueryClient(), "space");
  try {
    expect(view.container.querySelector('[data-testid="model-role-main"]')).not.toBeNull();
    // Connections are the account's, so a Space does not list or add them.
    expect(view.container.querySelector('[data-testid="model-providers"]')).toBeNull();
    expect(models.role).toHaveBeenCalledWith(
      expect.objectContaining({ role: "main", scope: "space" }),
      expect.anything(),
    );
    await pick("Change Main model", "DeepSeek");
    await typeInto(keyField(view.container), "sk-fixture-deepseek");
    await click(buttons(view.container, "Connect API key")[0]);
    expect(models.connect).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "deepseek", makeDefault: true, scope: "space" }),
    );
  } finally {
    await view.unmount();
  }
});

it("shows Cloudflare account and gateway fields for a new and a saved connection", async () => {
  const entry = {
    provider: "cloudflare-ai-gateway",
    providerName: "Cloudflare AI Gateway",
    id: "workers-ai/@cf/meta/llama-3.1-8b-instruct",
    label: "Llama",
    billing: "API key",
    auth: "api-key" as const,
    authHint: "API key",
    routingFields: ["accountId" as const, "gatewayId" as const],
  };
  vi.mocked(rpc.me).mockResolvedValue(account(entry.provider, entry.id));
  models.list.mockResolvedValue([entry]);
  models.credentials.mockResolvedValue([]);

  const fresh = await renderSettings();
  try {
    await pick("Change Main model", "Cloudflare AI Gateway");
    const accountId = fresh.container.querySelector("#model-account-id");
    const gatewayId = fresh.container.querySelector("#model-gateway-id");
    expect(accountId).toBeInstanceOf(HTMLInputElement);
    expect(gatewayId).toBeInstanceOf(HTMLInputElement);
    expect((accountId as HTMLInputElement).value).toBe("");
    expect((gatewayId as HTMLInputElement).value).toBe("");
    expect(fresh.container.textContent).toContain("Account ID");
    expect(fresh.container.textContent).toContain("Gateway ID");
  } finally {
    await fresh.unmount();
  }

  models.credentials.mockResolvedValue([
    {
      id: "cred-cf",
      provider: entry.provider,
      label: "Cloudflare AI Gateway",
      hasKey: true,
      isDefault: true,
      accountId: "acct1234",
      gatewayId: "gateway-1",
      modelId: entry.id,
    },
  ]);
  const saved = await renderSettings();
  try {
    await manage();
    expect((saved.container.querySelector("#model-account-id") as HTMLInputElement).value).toBe(
      "acct1234",
    );
    expect((saved.container.querySelector("#model-gateway-id") as HTMLInputElement).value).toBe(
      "gateway-1",
    );
  } finally {
    await saved.unmount();
  }
});

it("shows a stored OpenAI-compatible key and stays empty when none is saved", async () => {
  vi.mocked(rpc.me).mockResolvedValue(account("openai-compatible", "deepseek-chat"));
  models.list.mockResolvedValue([compatibleEntry]);
  models.credentials.mockResolvedValue([
    {
      id: "cred-compatible",
      provider: "openai-compatible",
      label: "DeepSeek",
      hasKey: true,
      isDefault: true,
      baseUrl: "https://api.deepseek.com/v1",
      modelId: "deepseek-chat",
    },
  ]);

  const stored = await renderSettings();
  try {
    await manage();
    const input = compatibleKeyField(stored.container);
    expect(input.value).toBe("");
    expect(input.placeholder).toBe(STORED_PLACEHOLDER);
  } finally {
    await stored.unmount();
  }

  models.credentials.mockResolvedValue([
    {
      id: "cred-compatible",
      provider: "openai-compatible",
      label: "Local",
      hasKey: false,
      isDefault: true,
      baseUrl: "http://127.0.0.1:8000/v1",
      modelId: "local-model",
    },
  ]);
  const empty = await renderSettings();
  try {
    await manage();
    const input = compatibleKeyField(empty.container);
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("Optional");
  } finally {
    await empty.unmount();
  }
});

/**
 * Accessible name per accname: aria-labelledby wins, and a labelling element's
 * text includes the control's own aria-label when the control sits inside it.
 */
function accessibleName(element: Element) {
  const ids = element.getAttribute("aria-labelledby")?.split(/\s+/) ?? [];
  if (!ids.length) return element.getAttribute("aria-label") ?? "";
  return ids
    .map((id) => {
      const label = document.getElementById(id);
      if (!label) return "";
      const own = label.contains(element) ? element.getAttribute("aria-label") : null;
      return [label.textContent, own].filter(Boolean).join(" ");
    })
    .join(" ");
}

/** The checkbox whose accessible name is exactly `id`. */
function modelCheckbox(container: HTMLElement, id: string) {
  const found = [...container.querySelectorAll("[role='checkbox']")].find(
    (entry) => accessibleName(entry) === id,
  );
  if (!(found instanceof HTMLElement)) throw new Error(`Missing model checkbox: ${id}`);
  return {
    element: found,
    get checked() {
      return found.getAttribute("aria-checked") === "true";
    },
    get disabled() {
      return found.getAttribute("aria-disabled") === "true" || found.hasAttribute("data-disabled");
    },
    click: () => found.click(),
  };
}

const compatibleCredential = {
  id: "cred-compatible",
  provider: "openai-compatible",
  label: "Local",
  hasKey: false,
  isDefault: true,
  baseUrl: "http://127.0.0.1:8000/v1",
  modelId: "model-a",
  enabledModelIds: ["model-a"],
};

/** Renders a saved compatible connection as the main model and opens its dialog. */
async function renderCompatible(credential: object = compatibleCredential) {
  vi.mocked(rpc.me).mockResolvedValue(account("openai-compatible", "model-a"));
  models.list.mockResolvedValue([compatibleEntry]);
  models.credentials.mockResolvedValue([credential]);
  const view = await renderSettings();
  await manage();
  return view;
}

async function renderCompatibleWithProbe(probed: string[]) {
  models.probeOpenAiCompatible.mockResolvedValue({ models: probed });
  const view = await renderCompatible();
  await click(buttons(view.container, "Find models")[0]);
  return view;
}

it("sends the ticked models other than the default when an OpenAI-compatible endpoint saves", async () => {
  const view = await renderCompatibleWithProbe(["model-a", "model-b", "model-c"]);
  try {
    expect(modelCheckbox(view.container, "model-b").checked).toBe(false);
    await act(async () => {
      modelCheckbox(view.container, "model-b").click();
    });
    expect(modelCheckbox(view.container, "model-b").checked).toBe(true);
    await click(buttons(view.container, "Save")[0]);
    expect(models.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai-compatible",
        modelId: "model-a",
        enabledModelIds: ["model-b"],
      }),
    );
  } finally {
    await view.unmount();
  }
});

it("keeps the default model checked and disabled", async () => {
  const view = await renderCompatibleWithProbe(["model-a", "model-b"]);
  try {
    const defaultBox = modelCheckbox(view.container, "model-a");
    expect(defaultBox.checked).toBe(true);
    expect(defaultBox.disabled).toBe(true);
    await act(async () => {
      defaultBox.click();
    });
    expect(modelCheckbox(view.container, "model-a").checked).toBe(true);
    expect(modelCheckbox(view.container, "model-b").disabled).toBe(false);
  } finally {
    await view.unmount();
  }
});

it("filters the models a probe found and keeps a hidden tick", async () => {
  const probed = Array.from({ length: 12 }, (_, index) => `model-${index + 1}`);
  const view = await renderCompatibleWithProbe(probed);
  try {
    const rowNames = () =>
      [
        ...(view.container
          .querySelector('[data-testid="compatible-model-rows"]')
          ?.querySelectorAll("[role='checkbox']") ?? []),
      ].map(accessibleName);
    const search = view.container.querySelector("input[aria-label='Search models']");
    if (!(search instanceof HTMLInputElement)) throw new Error("Missing model search");
    expect(rowNames()).toHaveLength(13);
    await act(async () => {
      modelCheckbox(view.container, "model-7").click();
    });
    await typeInto(search, "model-1");
    expect(rowNames()).toEqual(["model-1", "model-10", "model-11", "model-12"]);
    await typeInto(search, "");
    expect(modelCheckbox(view.container, "model-7").checked).toBe(true);
  } finally {
    await view.unmount();
  }
});

it("lists saved models as checked rows before the server is probed", async () => {
  const view = await renderCompatible({
    ...compatibleCredential,
    enabledModelIds: ["model-a", "model-b"],
  });
  try {
    expect(modelCheckbox(view.container, "model-b").checked).toBe(true);
    const select = view.container.querySelector("select[aria-label='Models from server']");
    expect([...(select?.querySelectorAll("option") ?? [])].map((entry) => entry.value)).toEqual([
      "model-a",
      "model-b",
      "",
    ]);
  } finally {
    await view.unmount();
  }
});

it("offers a saved compatible model in the main picker and uses it", async () => {
  vi.mocked(rpc.me).mockResolvedValue(account("openai-compatible", "model-a"));
  models.list.mockResolvedValue([compatibleEntry]);
  models.credentials.mockResolvedValue([
    { ...compatibleCredential, enabledModelIds: ["model-a", "model-b"] },
  ]);
  const view = await renderSettings();
  try {
    await openPicker("Change model-a");
    expect(pickerOptions()).toEqual(expect.arrayContaining(["model-a", "model-b"]));
    await choose("model-b");
    expect(models.setRole).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "main",
        primary: {
          provider: "openai-compatible",
          modelId: "model-b",
          credentialId: "cred-compatible",
        },
        backups: [],
      }),
      expect.anything(),
    );
  } finally {
    await view.unmount();
  }
});

it("names each model checkbox by its id alone", async () => {
  const view = await renderCompatibleWithProbe(["model-a", "model-b"]);
  try {
    const names = [...view.container.querySelectorAll("[role='checkbox']")].map(accessibleName);
    expect(names).toEqual(["model-a", "model-b"]);
  } finally {
    await view.unmount();
  }
});

it("lists not-connected providers by name alone", async () => {
  models.list.mockResolvedValue([deepseekEntry, compatibleEntry]);
  const view = await renderSettings();
  try {
    await openPicker("Change Main model");
    expect(pickerOptions()).toEqual(["DeepSeek", "Ollama Cloud", "OpenAI-compatible"]);
    expect(document.querySelectorAll("[cmdk-group-heading]")).toHaveLength(0);
  } finally {
    await view.unmount();
  }
});

it("keeps a saved model listed, unticked, after a refused save", async () => {
  models.connect.mockRejectedValue(new Error("In use by Helper"));
  const view = await renderCompatible({
    ...compatibleCredential,
    enabledModelIds: ["model-a", "model-b"],
  });
  try {
    await act(async () => {
      modelCheckbox(view.container, "model-b").click();
    });
    await click(buttons(view.container, "Save")[0]);
    expect(models.connect).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "model-a", enabledModelIds: [] }),
    );
    expect(view.container.textContent).toContain("In use by Helper");
    expect(modelCheckbox(view.container, "model-b").checked).toBe(false);
  } finally {
    await view.unmount();
  }
});

function baseUrlField(container: HTMLElement) {
  const input = container.querySelector("#model-base-url");
  if (!(input instanceof HTMLInputElement)) throw new Error("Missing server URL field");
  return input;
}

it("drops the saved ticks and rows when the server URL changes, and restores them on the saved URL", async () => {
  const view = await renderCompatible({
    ...compatibleCredential,
    enabledModelIds: ["model-a", "model-b"],
  });
  try {
    await typeInto(baseUrlField(view.container), "http://other.test/v1");
    expect(() => modelCheckbox(view.container, "model-b")).toThrow();
    await typeInto(baseUrlField(view.container), compatibleCredential.baseUrl);
    expect(modelCheckbox(view.container, "model-b").checked).toBe(true);
    await typeInto(baseUrlField(view.container), "http://other.test/v1");
    await click(buttons(view.container, "Save")[0]);
    expect(models.connect).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "http://other.test/v1", enabledModelIds: [] }),
    );
  } finally {
    await view.unmount();
  }
});

it("probes with the editing credential id without sending saved header values", async () => {
  const view = await renderCompatibleWithProbe(["model-a"]);
  try {
    expect(models.probeOpenAiCompatible).toHaveBeenCalledWith({
      baseUrl: compatibleCredential.baseUrl,
      apiKey: undefined,
      headers: undefined,
      apiProtocol: "chat-completions",
      credentialId: compatibleCredential.id,
    });
  } finally {
    await view.unmount();
  }
});

function protocolField(container: HTMLElement) {
  const select = container.querySelector('select[aria-label="Protocol"]');
  if (!(select instanceof HTMLSelectElement)) throw new Error("Missing protocol select");
  return select;
}

async function chooseProtocol(container: HTMLElement, value: string) {
  await selectValue(protocolField(container), value);
}

async function selectValue(select: HTMLSelectElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    setter?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function effortField(container: HTMLElement) {
  const select = container.querySelector('select[aria-label="Reasoning effort"]');
  if (!(select instanceof HTMLSelectElement)) throw new Error("Missing effort select");
  return select;
}

it("offers the three wire protocols only on a custom endpoint, keeping the saved choice", async () => {
  const view = await renderCompatible({
    ...compatibleCredential,
    apiProtocol: "anthropic-messages",
  });
  try {
    const select = protocolField(view.container);
    expect([...select.options].map((option) => option.value)).toEqual([
      "chat-completions",
      "responses",
      "anthropic-messages",
    ]);
    expect(select.value).toBe("anthropic-messages");
    await chooseProtocol(view.container, "responses");
    await click(buttons(view.container, "Save")[0]);
    expect(models.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({ apiProtocol: "responses" }),
    );
  } finally {
    await view.unmount();
  }

  // A catalog provider's connection has no protocol choice.
  vi.mocked(rpc.me).mockResolvedValue(account("deepseek", "deepseek-chat"));
  models.list.mockResolvedValue([deepseekEntry]);
  models.credentials.mockResolvedValue([deepseekCredential]);
  const catalog = await renderSettings();
  try {
    await manage();
    expect(catalog.container.querySelector('select[aria-label="Protocol"]')).toBeNull();
  } finally {
    await catalog.unmount();
  }
});

it("keeps the chosen protocol when the endpoint changes and probes with it", async () => {
  models.probeOpenAiCompatible.mockResolvedValue({ models: ["model-a"] });
  const view = await renderCompatible({
    ...compatibleCredential,
    apiProtocol: "anthropic-messages",
  });
  try {
    await typeInto(baseUrlField(view.container), "http://127.0.0.1:9000/v1");
    expect(protocolField(view.container).value).toBe("anthropic-messages");
    await click(buttons(view.container, "Find models")[0]);
    expect(models.probeOpenAiCompatible).toHaveBeenLastCalledWith(
      expect.objectContaining({ apiProtocol: "anthropic-messages" }),
    );
  } finally {
    await view.unmount();
  }
});

it("clamps a staged effort when the protocol switch drops the level", async () => {
  const view = await renderCompatible({
    ...compatibleCredential,
    reasoning: true,
    thinkingLevel: "max",
  });
  try {
    expect(effortField(view.container).value).toBe("max");
    await chooseProtocol(view.container, "anthropic-messages");
    expect(effortField(view.container).value).toBe("high");
    await click(buttons(view.container, "Save")[0]);
    expect(models.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({ apiProtocol: "anthropic-messages", thinkingLevel: "high" }),
    );
  } finally {
    await view.unmount();
  }
});

it("shows saved header names only, preserves untouched headers and explicitly clears removed headers", async () => {
  const view = await renderCompatible({ ...compatibleCredential, headerNames: ["x-session"] });
  try {
    const name = view.container.querySelector(
      'input[aria-label="Header name"]',
    ) as HTMLInputElement;
    const value = view.container.querySelector(
      'input[aria-label="Header value"]',
    ) as HTMLInputElement;
    expect(name.value).toBe("x-session");
    expect(value.type).toBe("password");
    expect(value.placeholder).toBe("••••••••");
    expect(value.value).toBe("");
    await click(buttons(view.container, "Save")[0]);
    expect(models.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({ headers: undefined }),
    );
    await manage();
    await click(view.container.querySelector('button[aria-label="Remove header"]'));
    await click(buttons(view.container, "Save")[0]);
    expect(models.connect).toHaveBeenLastCalledWith(expect.objectContaining({ headers: {} }));
  } finally {
    await view.unmount();
  }
});

it.each([" http://127.0.0.1:8000/v1 ", "http://127.0.0.1:8000/v1/", "http://127.0.0.1:8000"])(
  "preserves saved header rows at the equivalent endpoint %s",
  async (endpoint) => {
    const view = await renderCompatible({
      ...compatibleCredential,
      headerNames: ["x-session", "x-route"],
    });
    try {
      await typeInto(baseUrlField(view.container), endpoint);
      const names = view.container.querySelectorAll<HTMLInputElement>(
        'input[aria-label="Header name"]',
      );
      const values = view.container.querySelectorAll<HTMLInputElement>(
        'input[aria-label="Header value"]',
      );
      expect([...names].map((input) => input.value)).toEqual(["x-session", "x-route"]);
      expect([...values].map((input) => input.placeholder)).toEqual(["••••••••", "••••••••"]);
      expect([...values].map((input) => input.value)).toEqual(["", ""]);
      await typeInto(values[0]!, "fake-session-secret");
      // Editing one saved header must retain the other row and require its value too.
      expect(buttons(view.container, "Save")[0]?.disabled).toBe(true);
      await typeInto(values[1]!, "fake-routing-secret");
      await click(buttons(view.container, "Save")[0]);
      expect(models.connect).toHaveBeenLastCalledWith(
        expect.objectContaining({
          headers: { "x-session": "fake-session-secret", "x-route": "fake-routing-secret" },
        }),
      );
    } finally {
      await view.unmount();
    }
  },
);

it("does not inherit saved header rows or placeholders at another origin", async () => {
  const view = await renderCompatible({ ...compatibleCredential, headerNames: ["x-session"] });
  try {
    await typeInto(baseUrlField(view.container), "http://other.test/v1");
    expect(view.container.querySelector('input[aria-label="Header name"]')).toBeNull();
    await click(buttons(view.container, "Add header")[0]);
    await typeInto(
      view.container.querySelector<HTMLInputElement>('input[aria-label="Header name"]')!,
      "x-session",
    );
    const value = view.container.querySelector<HTMLInputElement>(
      'input[aria-label="Header value"]',
    )!;
    expect(value.placeholder).toBe("");
  } finally {
    await view.unmount();
  }
});

it("disables Save for invalid custom header names", async () => {
  const view = await renderCompatibleWithProbe(["model-a"]);
  try {
    await click(buttons(view.container, "Add header")[0]);
    const name = view.container.querySelector(
      'input[aria-label="Header name"]',
    ) as HTMLInputElement;
    const value = view.container.querySelector(
      'input[aria-label="Header value"]',
    ) as HTMLInputElement;
    await typeInto(name, "Authorization");
    await typeInto(value, "long-session-secret");
    expect(buttons(view.container, "Save")[0]?.disabled).toBe(true);
    await typeInto(name, "bad name");
    expect(buttons(view.container, "Save")[0]?.disabled).toBe(true);
  } finally {
    await view.unmount();
  }
});

it("opens the Ollama preset with a required key and saves a compatible connection", async () => {
  HTMLElement.prototype.scrollTo = vi.fn();
  models.list.mockResolvedValue([compatibleEntry]);
  models.credentials.mockResolvedValue([]);
  models.probeOpenAiCompatible.mockResolvedValue({ models: ["fixture-model"] });
  const view = await renderSettings(false);
  try {
    await pick("Change Main model", "Ollama Cloud");
    expect(titles(view.container)).toContain("Connect Ollama Cloud");
    expect(baseUrlField(view.container).value).toBe("https://ollama.com/v1");
    expect(
      [...view.container.querySelectorAll("button")].filter(
        (row) => row.textContent === "Setup help",
      ),
    ).toHaveLength(0);
    expect(
      [...view.container.querySelectorAll("button")].filter((row) => row.textContent === "API key"),
    ).toHaveLength(0);
    const key = view.container.querySelector('input[aria-label="API key"]') as HTMLInputElement;
    expect(key.required).toBe(true);
    await typeInto(key, "fake-fixture-key");
    await click(buttons(view.container, "Find models")[0]);
    expect(models.probeOpenAiCompatible).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "https://ollama.com/v1", apiKey: "fake-fixture-key" }),
    );
    await click(buttons(view.container, "Save")[0]);
    expect(models.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai-compatible",
        baseUrl: "https://ollama.com/v1",
        apiKey: "fake-fixture-key",
        modelId: "fixture-model",
        makeDefault: true,
      }),
    );
  } finally {
    await view.unmount();
  }
});

it("offers a saved Ollama connection's models without the Ollama preset", async () => {
  models.list.mockResolvedValue([compatibleEntry]);
  models.credentials.mockResolvedValue([
    {
      id: "fixture",
      label: "OpenAI-compatible",
      provider: "openai-compatible",
      modelId: "fixture-model",
      baseUrl: "https://ollama.com/",
      endpointName: "Ollama Cloud",
      hasKey: true,
    },
  ]);
  const view = await renderSettings(false);
  try {
    await openPicker("Change Main model");
    expect(pickerOptions()).toEqual(["fixture-model"]);
  } finally {
    await view.unmount();
  }
});

it("keeps the Ollama preset to connect beside a saved local connection", async () => {
  models.list.mockResolvedValue([compatibleEntry]);
  models.credentials.mockResolvedValue([
    {
      id: "fixture",
      label: "OpenAI-compatible",
      provider: "openai-compatible",
      modelId: "fixture-model",
      baseUrl: "http://127.0.0.1:8000/v1",
      hasKey: false,
    },
  ]);
  const view = await renderSettings(false);
  try {
    await openPicker("Add fallback");
    expect(pickerOptions()).toEqual(["fixture-model", "Ollama Cloud"]);
    await choose("Ollama Cloud");
    expect(baseUrlField(view.container).value).toBe("https://ollama.com/v1");
  } finally {
    await view.unmount();
  }
});

it("keeps setup help and API key collapsible for generic compatible servers", async () => {
  models.list.mockResolvedValue([compatibleEntry]);
  models.credentials.mockResolvedValue([]);
  const view = await renderSettings(false);
  try {
    await pick("Change Main model", "OpenAI-compatible");
    for (const name of ["Setup help", "API key"]) {
      const row = buttons(view.container, name)[0]!;
      expect(row.getAttribute("aria-expanded")).toBe("false");
      expect(row.querySelector("svg")).not.toBeNull();
      await act(async () => row.click());
      expect(row.getAttribute("aria-expanded")).toBe("true");
    }
  } finally {
    await view.unmount();
  }
});

it.each(["https://ollama.com", "https://ollama.com/v1/"])(
  "keeps Save enabled with a saved Ollama key at %s",
  async (baseUrl) => {
    vi.mocked(rpc.me).mockResolvedValue(account("openai-compatible", "fixture-model"));
    models.list.mockResolvedValue([compatibleEntry]);
    models.credentials.mockResolvedValue([
      {
        id: "fixture",
        label: "OpenAI-compatible",
        provider: "openai-compatible",
        modelId: "fixture-model",
        baseUrl: "https://ollama.com/v1",
        endpointName: "Ollama Cloud",
        hasKey: true,
      },
    ]);
    const view = await renderSettings(false);
    try {
      await manage();
      expect(titles(view.container)).toContain("Ollama Cloud");
      await typeInto(baseUrlField(view.container), baseUrl);
      expect(buttons(view.container, "Save")[0]?.disabled).toBe(false);
      await typeInto(baseUrlField(view.container), "https://other.test/v1");
      await typeInto(baseUrlField(view.container), "https://ollama.com/v1/");
      expect(buttons(view.container, "Save")[0]?.disabled).toBe(false);
    } finally {
      await view.unmount();
    }
  },
);

it.each([undefined, "api_key", "oauth"])(
  "only enables subscription connection checks for saved OAuth credentials (%s)",
  async (authKind) => {
    vi.mocked(rpc.me).mockResolvedValue(account("openai-codex", "fixture-model"));
    models.list.mockResolvedValue([
      {
        provider: "openai-codex",
        providerName: "ChatGPT",
        id: "fixture-model",
        label: "Fixture model",
        billing: "Subscription",
        auth: "oauth",
        signIn: "device-code",
        oauthLabel: "Sign in with ChatGPT",
      },
    ]);
    models.credentials.mockResolvedValue(
      authKind
        ? [
            {
              id: "fixture",
              label: "ChatGPT",
              provider: "openai-codex",
              modelId: "fixture-model",
              authKind,
            },
          ]
        : [],
    );
    const view = await renderSettings();
    try {
      if (authKind) await manage();
      else await pick("Change Main model", "ChatGPT");
      expect(buttons(view.container, "Test connection")[0]?.disabled).toBe(authKind !== "oauth");
      expect(view.container.textContent).not.toContain("Test sign-in");
    } finally {
      await view.unmount();
    }
  },
);

it("tests the selected subscription connection when another connection has the same model", async () => {
  vi.mocked(rpc.me).mockResolvedValue(account("anthropic", "claude-fixture"));
  models.list.mockResolvedValue([
    {
      provider: "anthropic",
      providerName: "Anthropic",
      id: "claude-fixture",
      label: "Claude fixture",
      billing: "",
      signIn: "auth-url",
    },
  ]);
  models.credentials.mockResolvedValue([
    {
      id: "api",
      label: "API",
      provider: "anthropic",
      modelId: "claude-fixture",
      authKind: "api_key",
    },
    {
      id: "oauth",
      label: "Subscription",
      provider: "anthropic",
      modelId: "claude-fixture",
      authKind: "oauth",
    },
  ]);
  models.role.mockImplementation(async ({ role }: { role: string }) => ({
    primary:
      role === "main"
        ? { provider: "anthropic", modelId: "claude-fixture", credentialId: "oauth" }
        : null,
    backups: [],
  }));
  const view = await renderSettings();
  try {
    await manage();
    await click(buttons(view.container, "Test connection")[0]);
    expect(view.container.textContent).toContain("A subscription credential is stored securely.");
  } finally {
    await view.unmount();
  }
});

it("folds the key form behind Or paste an API key once a subscription is signed in", async () => {
  vi.mocked(rpc.me).mockResolvedValue(account("anthropic", "claude-fixture"));
  models.list.mockResolvedValue([
    {
      provider: "anthropic",
      providerName: "Anthropic",
      id: "claude-fixture",
      label: "Claude fixture",
      billing: "",
      signIn: "auth-url",
    },
  ]);
  models.credentials.mockResolvedValue([
    {
      id: "fixture",
      label: "Anthropic",
      provider: "anthropic",
      modelId: "claude-fixture",
      hasKey: false,
      authKind: "oauth",
    },
  ]);
  const view = await renderSettings();
  try {
    await manage();
    expect(view.container.querySelector("#model-api-key")).toBeNull();
    await click(buttons(view.container, "Or paste an API key")[0]);
    expect(keyField(view.container)).toBeTruthy();
    expect(buttons(view.container, "Connect API key")).toHaveLength(1);
    expect(view.container.textContent).not.toContain("Replace API key");
  } finally {
    await view.unmount();
  }
});

function providersSection() {
  const found = document.querySelector('[data-testid="model-providers"]');
  if (!found) throw new Error("Missing Providers section");
  return found as HTMLElement;
}

/** Opens a connection's page from the Providers list. */
async function openProvider(name: string) {
  await click(
    [...providersSection().querySelectorAll("button")].find((entry) => entry.textContent === name),
  );
}

const workCredential = {
  ...deepseekCredential,
  id: "cred-deepseek-work",
  label: "Work",
  isDefault: false,
};

it("lists every connection under Providers and adds another for a connected provider", async () => {
  models.credentials.mockResolvedValue([deepseekCredential, workCredential]);
  const view = await renderSettings();
  try {
    expect(
      [...providersSection().querySelectorAll('[data-testid^="model-provider-"]')].map(
        (row) => row.textContent,
      ),
    ).toEqual(["DeepSeek", "DeepSeek (Work)"]);
    await click(buttons(providersSection() as HTMLElement, "Add provider")[0]);
    expect(pickerOptions()).toContain("DeepSeek");
    await choose("DeepSeek");
    expect(titles(view.container)).toEqual(["Connect DeepSeek"]);
    expect(keyField(view.container).placeholder).toBe("sk-…");
    await typeInto(keyField(view.container), "sk-fixture-personal");
    await click(buttons(view.container, "Connect API key")[0]);
    expect(models.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "deepseek",
        apiKey: "sk-fixture-personal",
        credentialId: null,
        makeDefault: false,
      }),
    );
    expect(models.setRole).not.toHaveBeenCalled();
    expect(titles(view.container)).toEqual([]);
  } finally {
    await view.unmount();
  }
});

it("replaces one connection's key and disconnects only that connection", async () => {
  models.credentials.mockResolvedValue([deepseekCredential, workCredential]);
  const view = await renderSettings();
  try {
    await openProvider("DeepSeek (Work)");
    expect(titles(view.container)).toEqual(["DeepSeek (Work)"]);
    await typeInto(keyField(view.container), "sk-fixture-rotated");
    await click(buttons(view.container, "Replace API key")[0]);
    expect(models.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "deepseek",
        apiKey: "sk-fixture-rotated",
        credentialId: "cred-deepseek-work",
      }),
    );

    await openProvider("DeepSeek (Work)");
    await click(buttons(view.container, "Disconnect")[0]);
    const confirm = buttons(view.container, "Disconnect");
    await click(confirm[confirm.length - 1]);
    expect(models.disconnect).toHaveBeenCalledWith({
      provider: "deepseek",
      credentialId: "cred-deepseek-work",
    });
  } finally {
    await view.unmount();
  }
});

it("keeps another connection's form when an earlier save finishes", async () => {
  models.list.mockResolvedValue([deepseekEntry, openrouterEntry]);
  models.credentials.mockResolvedValue([deepseekCredential]);
  let finishSave!: (value: unknown) => void;
  models.connect.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishSave = resolve;
      }),
  );
  const view = await renderSettings();
  try {
    await openPicker("Add fallback");
    await choose("OpenRouter");
    await typeInto(keyField(view.container), "sk-fixture-router");
    await click(buttons(view.container, "Connect API key")[0]);
    // Fields wait for the save, so it cannot overwrite edits made meanwhile.
    expect(keyField(view.container).closest("fieldset")?.disabled).toBe(true);
    // The main model's connection opens while the first key still saves.
    await manage();
    expect(titles(view.container)).toEqual(["DeepSeek"]);
    await act(async () => {
      finishSave({ ...deepseekCredential, id: "cred-openrouter", provider: "openrouter" });
    });
    expect(titles(view.container)).toEqual(["DeepSeek"]);
    // The finished save's slot picker does not take over.
    expect(pickerOptions()).toEqual([]);
  } finally {
    await view.unmount();
  }
});

it("renames a connection", async () => {
  models.rename.mockResolvedValue({ ok: true });
  models.credentials.mockResolvedValue([deepseekCredential, workCredential]);
  const view = await renderSettings();
  try {
    await openProvider("DeepSeek (Work)");
    const input = view.container.querySelector<HTMLInputElement>("input[maxlength]");
    if (!input) throw new Error("Missing name field");
    expect(input.value).toBe("Work");
    await typeInto(input, "Client work");
    await act(async () => {
      input.form?.requestSubmit();
    });
    expect(models.rename).toHaveBeenCalledWith({
      credentialId: "cred-deepseek-work",
      label: "Client work",
    });
  } finally {
    await view.unmount();
  }
});

it("shows what a disconnect left, not a read sent before it", async () => {
  models.credentials.mockResolvedValue([deepseekCredential, workCredential]);
  const queryClient = testQueryClient();
  const first = await renderSettings(true, queryClient);
  await first.unmount();

  // The revisit's background read still lists Work when the disconnect lands.
  let releaseStale: () => void = () => undefined;
  models.credentials
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseStale = () => resolve([deepseekCredential, workCredential]);
        }),
    )
    .mockResolvedValue([deepseekCredential]);
  const providerNames = () =>
    [...providersSection().querySelectorAll("button")].map((entry) => entry.textContent);
  const view = await renderSettings(true, queryClient);
  try {
    expect(providerNames()).toContain("DeepSeek (Work)");
    await openProvider("DeepSeek (Work)");
    await click(buttons(view.container, "Disconnect")[0]);
    const confirm = buttons(view.container, "Disconnect");
    await click(confirm[confirm.length - 1]);
    await act(async () => releaseStale());
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(providerNames()).not.toContain("DeepSeek (Work)");
  } finally {
    await view.unmount();
  }
});
