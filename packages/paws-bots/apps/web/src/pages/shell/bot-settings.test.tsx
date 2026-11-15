// @vitest-environment jsdom

import type { Bot } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/rpc", () => {
  const rpc = {
    voice: { voices: vi.fn(async () => []) },
    models: {
      credentials: vi.fn(async () => []),
      list: vi.fn(async () => []),
    },
    me: vi.fn(async () => ({})),
    // This server receives no email, so the panel offers no address.
    bots: { emailAddress: vi.fn(async () => null) },
  };
  return {
    rpc,
    rpcForSpace: () => rpc,
    createSpaceRpc: () => rpc,
    selectedSpaceId: () => null,
  };
});
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => ({
  SectionHeading: ({ variant, ...props }: ComponentProps<"h3"> & { variant?: string }) => (
    <h3 data-variant={variant} {...props} />
  ),
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: ComponentProps<"button"> & {
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange?.(!checked)}
      {...props}
    />
  ),
  Toggle: ({
    pressed: _pressed,
    onPressedChange: _onPressedChange,
    ...props
  }: ComponentProps<"button"> & {
    pressed?: boolean;
    onPressedChange?: (pressed: boolean) => void;
    variant?: string;
  }) => <button type="button" {...props} />,
  Tabs: ({
    value: _value,
    onValueChange: _onValueChange,
    ...props
  }: ComponentProps<"div"> & { value?: string; onValueChange?: (value: string) => void }) => (
    <div {...props} />
  ),
  TabsList: (props: ComponentProps<"div">) => <div role="tablist" {...props} />,
  TabsTrigger: ({ value: _value, ...props }: ComponentProps<"button"> & { value: string }) => (
    <button type="button" role="tab" {...props} />
  ),
  TabsContent: ({ value: _value, ...props }: ComponentProps<"div"> & { value: string }) => (
    <div {...props} />
  ),
}));
vi.mock("../ScratchpadSection", () => ({ ScratchpadSection: () => null }));
vi.mock("../KnowledgeSection", () => ({ KnowledgeSection: () => null }));
vi.mock("./avatar-studio-popover", () => ({ AvatarStudioPopover: () => null }));

import { BotSettings } from "./bot-panel";

const bot = {
  id: "bot-1",
  spaceId: "space-1",
  name: "Ada",
  title: "Helper",
  description: "Helps",
  instructions: "Helps",
  color: "ink",
  notifyOnFinish: true,
  pinned: false,
  sectionId: null,
  archivedAt: null,
  unread: false,
  parentBotId: null,
  memoryScope: null,
  threadId: "thread-1",
  preview: "",
  status: "idle",
  computerMode: "dedicated",
  updatedAt: "2026-09-01T00:00:00.000Z",
  createdAt: "2026-09-01T00:00:00.000Z",
  voiceId: null,
  autoSpeak: false,
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
  teamChatAmbientEnabled: false,
  teamChatRules: "",
  disabledBuiltinTools: ["remember"],
  webhookConfigured: false,
  spawnKey: null,
} as Bot;

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  queryClient.clear();
  container.remove();
});

type SavePatch = {
  disabledBuiltinTools?: string[];
  name?: string;
  title?: string;
  fleetManagement?: boolean;
};

function setField(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function submitToolName(input: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

async function renderSettings(onSave: (patch: SavePatch) => Promise<void>, currentBot = bot) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <BotSettings
          focusModel={1}
          bot={currentBot}
          memoryProviderConfigured={false}
          onSave={onSave}
          onExport={async () => undefined}
          onClear={() => undefined}
        />
      </QueryClientProvider>,
    );
  });
  await flush();
}

describe("BotSettings help", () => {
  it("shows the management subtitle without changing the management switch", async () => {
    const onSave = vi.fn<(patch: SavePatch) => Promise<void>>(async () => undefined);
    await renderSettings(onSave, { ...bot, fleetManagement: false });
    const label = [...container.querySelectorAll("label")].find(
      (entry) => entry.textContent === "Manage other bots",
    );
    const toggle = document.getElementById(label?.htmlFor ?? "");
    const speechToggle = container.querySelector<HTMLButtonElement>('[id$="-auto-speak"]');
    const speechRow = speechToggle?.closest("label");
    expect(speechRow?.htmlFor).toBe(speechToggle?.id);
    expect(speechRow?.firstElementChild?.textContent).toBe("Read replies aloud");
    expect(speechRow?.lastElementChild).toBe(speechToggle);
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    expect(container.querySelector('[aria-label="About Manage other bots"]')).toBeNull();
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    expect(onSave).not.toHaveBeenCalled();
    await act(async () => toggle?.click());
    expect(onSave).toHaveBeenCalledWith({ fleetManagement: true });
  });
});

describe("BotSettings disabled tools", () => {
  it("omits the disabled-tool list from an unrelated save", async () => {
    const onSave = vi.fn<(patch: SavePatch) => Promise<void>>(async () => undefined);
    await renderSettings(onSave);

    const save = [...container.querySelectorAll("button")].find(
      (button) => button.getAttribute("role") === "switch" && button.id.endsWith("-notify-finish"),
    );
    if (!save) throw new Error("Missing save button");
    await act(async () => {
      save.click();
    });
    await flush();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("disabledBuiltinTools");
  });

  it("sends the disabled-tool list when that list changes", async () => {
    const onSave = vi.fn<(patch: SavePatch) => Promise<void>>(async () => undefined);
    await renderSettings(onSave);

    const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Enable Remember"]');
    if (!toggle) throw new Error("Missing tool toggle");
    await act(async () => {
      toggle.click();
    });
    await flush();

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ disabledBuiltinTools: [] }));
  });

  it("uses a refreshed server list for the next addition and removal", async () => {
    const onSave = vi.fn<(patch: SavePatch) => Promise<void>>(async () => undefined);
    await renderSettings(onSave);
    await renderSettings(onSave, { ...bot, disabledBuiltinTools: ["web_fetch"] });
    expect(container.querySelector('[id$="-disabled-remember"]')).toBeNull();
    const input = container.querySelector<HTMLSelectElement>('[id$="-disabled-tools"]')!;
    await submitToolName(input, "web_search");
    expect(onSave.mock.calls[0]?.[0].disabledBuiltinTools).toEqual(["web_fetch", "web_search"]);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[id$="-disabled-web_fetch"]')!.click();
    });
    expect(onSave.mock.calls[1]?.[0].disabledBuiltinTools).toEqual(["web_search"]);
  });

  it.each([false, true])(
    "rebases a refresh during an in-flight save (reject: %s)",
    async (reject) => {
      let release: (() => void) | undefined;
      const onSave = vi
        .fn<(patch: SavePatch) => Promise<void>>()
        .mockImplementationOnce(async () => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          if (reject) throw new Error("Network failed");
        })
        .mockResolvedValue(undefined);
      await renderSettings(onSave);
      const input = container.querySelector<HTMLSelectElement>('[id$="-disabled-tools"]')!;
      await submitToolName(input, "web_search");
      await renderSettings(onSave, { ...bot, disabledBuiltinTools: ["web_fetch"] });
      await act(async () => {
        release?.();
      });
      await flush();
      expect(container.querySelector('[id$="-disabled-remember"]')).toBeNull();
      expect(container.querySelector('[id$="-disabled-web_fetch"]')).not.toBeNull();
      if (reject) {
        expect(container.querySelector('[id$="-disabled-web_search"]')).toBeNull();
        await submitToolName(input, "web_search");
      }
      expect(onSave.mock.calls[1]?.[0].disabledBuiltinTools).toEqual(["web_fetch", "web_search"]);
      expect(container.querySelector('[id$="-disabled-web_search"]')).not.toBeNull();
    },
  );

  it("rebases queued edits and a removal on a refresh during a save", async () => {
    let release: (() => void) | undefined;
    const onSave = vi
      .fn<(patch: SavePatch) => Promise<void>>()
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      })
      .mockResolvedValue(undefined);
    await renderSettings(onSave);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[id$="-disabled-remember"]')!.click();
    });
    const input = container.querySelector<HTMLSelectElement>('[id$="-disabled-tools"]')!;
    await submitToolName(input, "web_search");
    await renderSettings(onSave, { ...bot, disabledBuiltinTools: ["remember", "web_fetch"] });
    await act(async () => {
      release?.();
    });
    await flush();
    expect(onSave.mock.calls.map(([patch]) => patch.disabledBuiltinTools)).toEqual([
      [],
      ["web_fetch"],
      ["web_fetch", "web_search"],
    ]);
    expect(container.querySelector('[id$="-disabled-remember"]')).toBeNull();
    expect(container.querySelector('[id$="-disabled-web_fetch"]')).not.toBeNull();
    expect(container.querySelector('[id$="-disabled-web_search"]')).not.toBeNull();
  });

  it("reconciles a fresh server list even when it matches the opening value", async () => {
    const onSave = vi.fn<(patch: SavePatch) => Promise<void>>(async () => undefined);
    await renderSettings(onSave);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[id$="-disabled-remember"]')!.click();
    });
    expect(container.querySelector('[id$="-disabled-remember"]')).toBeNull();
    await renderSettings(onSave, { ...bot, disabledBuiltinTools: ["remember"] });
    expect(container.querySelector('[id$="-disabled-remember"]')).not.toBeNull();
    const input = container.querySelector<HTMLSelectElement>('[id$="-disabled-tools"]')!;
    await submitToolName(input, "web_search");
    expect(onSave.mock.calls[1]?.[0].disabledBuiltinTools).toEqual(["remember", "web_search"]);
  });

  it("drops a failed disable so the same name can be saved again", async () => {
    let fail = true;
    const onSave = vi.fn<(patch: SavePatch) => Promise<void>>(async () => {
      if (fail) throw new Error("Network failed");
    });
    await renderSettings(onSave);

    const input = container.querySelector<HTMLSelectElement>('[id$="-disabled-tools"]');
    if (!input) throw new Error("Missing tool field");
    await submitToolName(input, "web_search");

    expect(container.textContent).toContain("Network failed");
    expect(container.textContent).toContain("Remember");
    expect(container.querySelector('[id$="-disabled-web_search"]')).toBeNull();

    fail = false;
    await submitToolName(input, "web_search");

    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ disabledBuiltinTools: ["remember", "web_search"] }),
    );
    expect(container.querySelector('[id$="-disabled-web_search"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Network failed");
  });

  it("restores a tool when turning it back on fails", async () => {
    const onSave = vi.fn<(patch: SavePatch) => Promise<void>>(async () => {
      throw new Error("Network failed");
    });
    await renderSettings(onSave);

    const toggle = container.querySelector<HTMLButtonElement>('[id$="-disabled-remember"]');
    if (!toggle) throw new Error("Missing tool toggle");
    await act(async () => {
      toggle.click();
    });
    await flush();

    expect(container.textContent).toContain("Network failed");
    expect(container.querySelector('[id$="-disabled-remember"]')).not.toBeNull();
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ disabledBuiltinTools: [] }));
  });

  it("keeps a newer disable when an earlier save fails", async () => {
    let releaseFirst: (() => void) | undefined;
    const onSave = vi.fn<(patch: SavePatch) => Promise<void>>(async (patch) => {
      const tools = patch.disabledBuiltinTools ?? [];
      if (tools.includes("web_search") && !tools.includes("web_fetch")) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        throw new Error("Network failed");
      }
    });
    await renderSettings(onSave);

    const input = container.querySelector<HTMLSelectElement>('[id$="-disabled-tools"]');
    if (!input) throw new Error("Missing tool field");
    await submitToolName(input, "web_search");
    expect(releaseFirst).toBeTypeOf("function");
    await submitToolName(input, "web_fetch");

    expect(container.querySelector('[id$="-disabled-web_search"]')).not.toBeNull();
    expect(container.querySelector('[id$="-disabled-web_fetch"]')).not.toBeNull();

    await act(async () => {
      releaseFirst?.();
    });
    await flush();
    await flush();

    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        disabledBuiltinTools: ["remember", "web_search", "web_fetch"],
      }),
    );
    expect(container.querySelector('[id$="-disabled-web_search"]')).not.toBeNull();
    expect(container.querySelector('[id$="-disabled-web_fetch"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Network failed");
  });

  it("returns to the last saved list when a later disable also fails", async () => {
    let releaseFirst: (() => void) | undefined;
    const onSave = vi.fn<(patch: SavePatch) => Promise<void>>(async (patch) => {
      const tools = patch.disabledBuiltinTools ?? [];
      if (tools.includes("web_search") && !tools.includes("web_fetch")) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      throw new Error("Network failed");
    });
    await renderSettings(onSave);

    const input = container.querySelector<HTMLSelectElement>('[id$="-disabled-tools"]');
    if (!input) throw new Error("Missing tool field");
    await submitToolName(input, "web_search");
    await submitToolName(input, "web_fetch");
    await act(async () => {
      releaseFirst?.();
    });
    await flush();
    await flush();

    expect(container.textContent).toContain("Network failed");
    expect(container.querySelector('[id$="-disabled-remember"]')).not.toBeNull();
    expect(container.querySelector('[id$="-disabled-web_search"]')).toBeNull();
    expect(container.querySelector('[id$="-disabled-web_fetch"]')).toBeNull();
  });

  it("offers only known tools and excludes tools already disabled", async () => {
    await renderSettings(vi.fn(async () => undefined));
    const picker = container.querySelector<HTMLSelectElement>('[id$="-disabled-tools"]')!;
    expect([...picker.options].map((option) => option.value)).toContain("web_search");
    expect([...picker.options].find((option) => option.value === "web_search")?.textContent).toBe(
      "Web search",
    );
    expect([...picker.options].map((option) => option.value)).not.toContain("remember");
    await submitToolName(picker, "web_search");
    expect([...picker.options].map((option) => option.value)).not.toContain("web_search");
  });
});

it("omits projected identity values on unrelated saves but commits explicit inline edits", async () => {
  const onSave = vi.fn<(patch: SavePatch) => Promise<void>>(async () => undefined);
  await renderSettings(onSave, { ...bot, name: "Бот" });
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[id$="-notify-finish"]')!.click(),
  );
  expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("name");
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Edit name"]')!.click(),
  );
  const input = container.querySelector<HTMLInputElement>('[aria-label="Name"]')!;
  await act(async () => setField(input, "SupportBot2026"));
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  expect(onSave.mock.calls[1]?.[0]).toMatchObject({ name: "SupportBot2026" });
});

it("uses section headings without repeating notification or model row labels", async () => {
  await renderSettings(vi.fn(async () => undefined));
  const heading = [...container.querySelectorAll("h3")].find(
    (node) => node.textContent === "Notifications",
  );
  expect(heading).toBeDefined();
  expect(heading?.dataset.variant).toBe("label");
  const notification = container.querySelector('label[id$="-notify-finish-label"]');
  expect(notification?.textContent?.trim()).toBe("When it finishes or needs input");
  const model = container.querySelector('label[for$="-model"]');
  expect(model?.className).toBe("sr-only");
});

it("treats cross-space communication as on unless turned off", async () => {
  const onSave = vi.fn<(patch: SavePatch) => Promise<void>>(async () => undefined);
  await renderSettings(onSave);
  const toggle = container.querySelector<HTMLButtonElement>('[id$="-cross-space"]');
  expect(toggle?.getAttribute("aria-checked")).toBe("true");
  await act(async () => toggle?.click());
  await flush();
  expect(onSave).toHaveBeenCalledWith({ crossSpaceCommunication: false });
});

it("defaults daily check-ins on and saves the opt-out", async () => {
  const onSave = vi.fn<(patch: SavePatch) => Promise<void>>(async () => undefined);
  await renderSettings(onSave);
  const toggle = container.querySelector<HTMLButtonElement>('[id$="-daily-check-ins"]');
  expect(toggle?.getAttribute("aria-checked")).toBe("true");
  expect(container.querySelector('label[for$="-daily-check-ins"]')?.textContent?.trim()).toBe(
    "Daily check-ins on unfinished work",
  );
  await act(async () => toggle?.click());
  await flush();
  expect(onSave).toHaveBeenCalledWith({ dailyCheckIns: false });
});
