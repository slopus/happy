// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type { BotSecretMetadata, SettingsScope } from "@rakazo/contracts";
import { encodeCardSecret, encodeLoginSecret, noneSkipped } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const vault = vi.hoisted(() => ({
  list: vi.fn(),
  put: vi.fn(),
  remove: vi.fn(),
  reveal: vi.fn(),
  activity: vi.fn(),
  import: vi.fn(),
}));
// No bot has an email address unless a test gives it one.
const bots = vi.hoisted(() => ({
  emailAddresses: vi.fn(async (): Promise<unknown> => null),
  list: vi.fn(),
  listArchived: vi.fn(),
}));
const spaces = vi.hoisted(() => ({ list: vi.fn() }));
const spaceSettings = vi.hoisted(() => ({ overrides: vi.fn() }));

// The dialog itself is tested on its own; here it is a pair of buttons that settle it.
vi.mock("./ConfirmIdentityDialog", async () => {
  const { useState } = await import("react");
  const { runWithIdentityConfirmation } = await import("@rakazo/contracts");
  return {
    useIdentityConfirmation: () => {
      const [settle, setSettle] = useState<((confirmed: boolean) => void) | null>(null);
      const done = (confirmed: boolean) => {
        settle?.(confirmed);
        setSettle(null);
      };
      return {
        withIdentityConfirmation: <T,>(action: () => Promise<T>) =>
          runWithIdentityConfirmation(
            action,
            () => new Promise<boolean>((resolve) => setSettle(() => resolve)),
          ),
        identityDialog: settle ? (
          <div data-testid="identity-dialog">
            <button type="button" data-testid="identity-confirm" onClick={() => done(true)} />
            <button type="button" data-testid="identity-cancel" onClick={() => done(false)} />
          </div>
        ) : null,
      };
    },
  };
});

vi.mock("../lib/rpc", () => ({
  rpc: { vault, bots, spaces, spaceSettings },
  rpcForSpace: () => ({ vault, bots, spaces, spaceSettings }),
  createSpaceRpc: () => ({ vault, bots, spaces, spaceSettings }),
  selectedSpaceId: () => null,
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

import { REVEAL_MS, VaultSettings } from "./VaultSettings";

// RFC 6238's test key, written in pieces so it never reads as a saved secret.
const TEST_KEY = ("GEZDGNBV" + "GY3TQOJQ").repeat(2);

const FAKE_VALUE = "fake-value-SENTINEL-1";
const stamp = "2026-09-01T00:00:00.000Z";
const item = (row: Partial<BotSecretMetadata> & Pick<BotSecretMetadata, "name" | "auth">) =>
  ({
    origin: "",
    title: row.name,
    note: "",
    createdAt: stamp,
    updatedAt: stamp,
    ...row,
  }) as BotSecretMetadata;
const rows: BotSecretMetadata[] = [
  item({
    name: "github",
    title: "github.com",
    origin: "https://github.com",
    auth: { type: "login" },
    preview: { username: "octo@example.com" },
  }),
  item({
    name: "visa",
    title: "Visa ·· 4242",
    note: "For travel",
    auth: { type: "card" },
    preview: {
      card: { brand: "Visa", last4: "4242", expMonth: 8, expYear: 2030, billing: "home" },
    },
  }),
  item({
    name: "home",
    title: "Home",
    auth: { type: "contact" },
    preview: {
      contact: { name: "Alex Rivera", city: "Springfield", phone: "+1 555 0100" },
    } as BotSecretMetadata["preview"],
  }),
  item({
    name: "custom",
    title: "svc.example.com",
    origin: "https://svc.example.com",
    auth: { type: "header", name: "X-Api-Key" },
  }),
  item({ name: "deploy-token", auth: { type: "command" } }),
];

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(scope: SettingsScope = "account") {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <VaultSettings scope={scope} />
      </QueryClientProvider>,
    );
  });
  await flush();
}

function find<T extends HTMLElement = HTMLElement>(testId: string): T | null {
  return document.querySelector<T>(`[data-testid="${testId}"]`);
}

function byTestId<T extends HTMLElement = HTMLElement>(testId: string): T {
  const found = find<T>(testId);
  if (!found) throw new Error(`Missing element: ${testId}`);
  return found;
}

async function click(target: string | HTMLElement) {
  await act(async () => {
    (typeof target === "string" ? byTestId(target) : target).click();
  });
  await flush();
}

function rowNamed(name: string) {
  return document.querySelector<HTMLElement>(
    `[data-testid="vault-credential-row"][data-name="${name}"]`,
  )!;
}

function editor() {
  return find("vault-editor");
}

function detail() {
  return find("vault-item-detail");
}

/** The editor's field labelled `label`, found through its label as a person would. */
function field(label: string, within: HTMLElement | null = editor()) {
  const labelled = [...(within?.querySelectorAll("label") ?? [])].find(
    (item) => item.textContent === label,
  );
  if (!labelled) throw new Error(`Missing field: ${label}`);
  return document.getElementById(labelled.htmlFor) as HTMLInputElement | HTMLSelectElement;
}

async function type(target: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype =
    target instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(target, value);
    target.dispatchEvent(
      new Event(target instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
    );
  });
}

function buttonIn(within: HTMLElement | null, name: string) {
  return [...(within?.querySelectorAll("button") ?? [])].find((item) => item.textContent === name);
}

/** Opens New and picks a kind from its menu. */
async function startNew(kind: string) {
  await click("vault-new");
  await click(`vault-new-${kind}`);
  expect(editor()).not.toBeNull();
}

beforeEach(() => {
  // The vault text both apps share is translated at run time, so it needs a locale.
  i18n.load("en", {});
  i18n.activate("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vault.list.mockReset().mockResolvedValue(rows);
  vault.put.mockReset().mockResolvedValue(rows[0]);
  vault.remove.mockReset().mockResolvedValue({ ok: true });
  vault.reveal.mockReset();
  vault.activity.mockReset().mockResolvedValue([]);
  spaces.list.mockReset().mockResolvedValue({ spaces: [{ id: "space-1", name: "Home" }] });
  spaceSettings.overrides.mockReset().mockResolvedValue([]);
  bots.list.mockReset().mockResolvedValue([
    { id: "bot-1", name: "Ada", color: "#F97316" },
    { id: "bot-2", name: "Grace", color: "#6366F1" },
  ]);
  bots.listArchived.mockReset().mockResolvedValue([]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("an item's uses", () => {
  it.each(["detail", "history"])("offers retry after an activity failure in %s", async (view) => {
    const use = { at: new Date().toISOString(), botName: "Research bot", chat: null, site: null };
    vault.activity.mockResolvedValue([use]);
    await render();
    await click(rowNamed("github"));
    if (view === "history") await click("vault-item-activity");
    vault.activity.mockRejectedValue(new Error("unavailable"));
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    await flush();
    const failure = container.querySelector('[role="alert"]') as HTMLElement;
    expect(failure.textContent).toContain("Could not load activity");
    vault.activity.mockResolvedValue([use]);
    await click(buttonIn(failure, "Retry")!);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("Research bot");
  });

  it("shows the latest use only once there is one, and opens the list on its own page", async () => {
    const at = new Date(Date.now() - 2 * 3600_000).toISOString();
    const use = { at, botName: "Research bot", chat: null };
    vault.activity.mockImplementation(async ({ name }: { name: string }) =>
      name === "github"
        ? [
            { ...use, site: "https://github.com" },
            { ...use, botName: "Helper", site: null },
          ]
        : [],
    );
    await render();
    await click(rowNamed("visa"));
    expect(find("vault-item-activity")).toBeNull();
    await click("vault-back");
    await click(rowNamed("github"));
    expect(vault.activity).toHaveBeenLastCalledWith(
      { scope: "account", name: "github" },
      expect.anything(),
    );
    expect(byTestId("vault-item-activity").textContent).toBe("Used 2h ago by Research bot");
    await click("vault-item-activity");
    // The list replaces the item, and Back returns to it.
    expect(detail()).toBeNull();
    expect(byTestId("vault-item-uses").querySelector("h3")?.textContent).toBe("github.com");
    expect(byTestId("vault-item-uses").textContent).toContain("Activity");
    expect(
      [...document.querySelectorAll('[data-testid="vault-item-use"]')].map(
        (row) => row.textContent,
      ),
    ).toEqual(["Research botgithub.com2h ago", "Helper2h ago"]);
    await click("vault-back");
    expect(find("vault-item-uses")).toBeNull();
    expect(byTestId("vault-item-activity").textContent).toBe("Used 2h ago by Research bot");
  });

  it("doesn't show a removed item's uses on a new item saved under its name", async () => {
    const use = { at: new Date().toISOString(), botName: "Research bot", chat: null, site: null };
    // As in the app, a read stays fresh for 30 seconds.
    queryClient.setDefaultOptions({ queries: { retry: false, staleTime: 30_000 } });
    vault.activity.mockResolvedValueOnce([use]).mockResolvedValue([]);
    await render();
    await click(rowNamed("deploy-token"));
    expect(byTestId("vault-item-activity").textContent).toContain("Research bot");
    await click("vault-item-remove");
    await click("vault-item-remove-confirm");
    await startNew("variable");
    await type(field("Variable name"), "DEPLOY_TOKEN");
    await type(field("Value"), FAKE_VALUE);
    await click(buttonIn(editor(), "Save")!);
    await click(rowNamed("deploy-token"));
    expect(detail()).not.toBeNull();
    expect(find("vault-item-activity")).toBeNull();
  });
});

describe("an item bots may not use", () => {
  it("shows Block on the item, and saves a change with the item only when it changed", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    const custom = { ...rows[3]!, policy: "off" } as const;
    vault.list.mockResolvedValue([...rows.slice(0, 3), custom, rows[4]]);
    vault.put.mockResolvedValue(custom);
    await render();
    await click(rowNamed("custom"));
    expect(byTestId("vault-item-access-detail").textContent).toBe("BotsBlock");
    await click("vault-item-edit");
    const access = byTestId("vault-item-access");
    expect(
      [...access.querySelectorAll("button[aria-pressed]")].map((b) => [
        b.textContent,
        b.getAttribute("aria-pressed"),
      ]),
    ).toEqual([
      ["Allow", "false"],
      ["Block", "true"],
    ]);
    await click("vault-editor-save");
    expect(vault.put.mock.lastCall?.[0]).not.toHaveProperty("policy");
    // Saving returns to the item.
    await click("vault-item-edit");
    await click(buttonIn(byTestId("vault-item-access"), "Allow")!);
    await click("vault-editor-save");
    expect(vault.put.mock.lastCall?.[0]).toMatchObject({
      destination: { name: "custom" },
      policy: "allow",
    });
    // A contact isn't secret, so it has no choice.
    await click("vault-back");
    await click(rowNamed("home"));
    await click("vault-item-edit");
    expect(find("vault-item-access")).toBeNull();
  });
});

describe("an item for chosen bots", () => {
  const menuItem = (name: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find(
      (item) => item.textContent === name,
    );
  async function openPicker() {
    const trigger = [...byTestId("vault-item-access").querySelectorAll("button")].find(
      (button) => !button.hasAttribute("aria-pressed"),
    )!;
    await click(trigger);
  }

  it("names the chosen bots, and offers no choice while one of them isn't shown", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    const custom = { ...rows[3]!, allBots: false, botIds: ["bot-unlisted", "bot-1"] };
    vault.list.mockResolvedValue([...rows.slice(0, 3), custom, rows[4]]);
    vault.put.mockResolvedValue(custom);
    await render();
    await click(rowNamed("custom"));
    await vi.waitFor(() =>
      expect(byTestId("vault-item-access-detail").textContent).toBe("BotsAda"),
    );
    // A chosen bot no list names can't be unticked or kept knowingly, so none is offered, and a
    // save sends nothing about the bots: the choice is never widened or trimmed unseen.
    await click("vault-item-edit");
    expect(find("agent-access")).toBeNull();
    await type(field("Value"), FAKE_VALUE);
    await click("vault-editor-save");
    expect(vault.put).toHaveBeenCalledOnce();
    expect(vault.put.mock.lastCall?.[0]).not.toHaveProperty("allBots");
    expect(vault.put.mock.lastCall?.[0]).not.toHaveProperty("botIds");
  });

  it("says an account item's other Spaces choose their own bots, and offers none from a Space with its own vault", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    const otherSpaces =
      "This limits only this Space's bots. Your other Spaces choose for their own.";
    const custom = { ...rows[3]!, allBots: false, botIds: ["bot-1"] };
    vault.list.mockResolvedValue([...rows.slice(0, 3), custom, rows[4]]);
    spaces.list.mockResolvedValue({
      spaces: [
        { id: "space-1", name: "Home" },
        { id: "space-2", name: "Work" },
      ],
    });
    await render();
    await click(rowNamed("custom"));
    await click("vault-item-edit");
    await vi.waitFor(() =>
      expect(byTestId("vault-item-access").textContent).toContain(otherSpaces),
    );
    await click(buttonIn(byTestId("vault-item-access"), "Block")!);
    expect(byTestId("vault-item-access").textContent).not.toContain(otherSpaces);
    // Seen from a Space with its own vault, the account item says why no bots can be chosen.
    await act(async () => root.unmount());
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    spaceSettings.overrides.mockResolvedValue(["credentials"]);
    await render();
    await click(rowNamed("custom"));
    // Its details don't present the choice saved for it as this Space's either.
    await vi.waitFor(() =>
      expect(byTestId("vault-item-access-detail").textContent).toBe(
        "BotsThis Space keeps its own vault, so its bots can't use account items.",
      ),
    );
    await click("vault-item-edit");
    await vi.waitFor(() =>
      expect(byTestId("vault-item-access").textContent).toContain(
        "This Space keeps its own vault, so its bots can't use account items.",
      ),
    );
    expect(find("agent-access")).toBeNull();
    await click("vault-editor-save");
    expect(vault.put.mock.lastCall?.[0]).not.toHaveProperty("botIds");
  });

  it("offers no bots for an account item until it knows whether this Space keeps its own vault", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    spaceSettings.overrides.mockReturnValue(new Promise(() => {}));
    const custom = { ...rows[3]!, allBots: false, botIds: ["bot-1"] };
    vault.list.mockResolvedValue([...rows.slice(0, 3), custom, rows[4]]);
    await render();
    await click(rowNamed("custom"));
    await click("vault-item-edit");
    expect(editor()).not.toBeNull();
    expect(find("agent-access")).toBeNull();
    await click("vault-editor-save");
    expect(vault.put.mock.lastCall?.[0]).not.toHaveProperty("allBots");
    expect(vault.put.mock.lastCall?.[0]).not.toHaveProperty("botIds");
  });

  it("offers the bots once it knows, in an editor opened before, keeping what was changed", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    let loaded: (value: string[]) => void = () => {};
    spaceSettings.overrides.mockReturnValue(new Promise((resolve) => (loaded = resolve)));
    const custom = { ...rows[3]!, allBots: false, botIds: ["bot-1"] };
    vault.list.mockResolvedValue([...rows.slice(0, 3), custom, rows[4]]);
    vault.put.mockResolvedValue(custom);
    await render();
    await click(rowNamed("custom"));
    await click("vault-item-edit");
    await click(buttonIn(byTestId("vault-item-access"), "Block")!);
    expect(find("agent-access")).toBeNull();
    await act(async () => loaded([]));
    await flush();
    // Blocked, the bots aren't offered; allowed again, they are, as saved.
    expect(find("agent-access")).toBeNull();
    await click(buttonIn(byTestId("vault-item-access"), "Allow")!);
    await openPicker();
    await act(async () => menuItem("Grace")!.click());
    await click("vault-editor-save");
    expect(vault.put.mock.lastCall?.[0]).toMatchObject({ allBots: false });
    expect(vault.put.mock.lastCall?.[0].botIds.sort()).toEqual(["bot-1", "bot-2"]);
  });

  it("names an archived chosen bot once it knows, in an editor opened before, so it can be let go of", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    let loaded: (value: string[]) => void = () => {};
    spaceSettings.overrides.mockReturnValue(new Promise((resolve) => (loaded = resolve)));
    bots.list.mockResolvedValue([{ id: "bot-1", name: "Ada", color: "#F97316" }]);
    bots.listArchived.mockResolvedValue([
      { id: "bot-old", name: "Old", color: "#6366F1", archivedAt: "2026-10-01T00:00:00.000Z" },
    ]);
    const custom = { ...rows[3]!, allBots: false, botIds: ["bot-old", "bot-1"] };
    vault.list.mockResolvedValue([...rows.slice(0, 3), custom, rows[4]]);
    vault.put.mockResolvedValue(custom);
    await render();
    await click(rowNamed("custom"));
    await click("vault-item-edit");
    expect(find("agent-access")).toBeNull();
    await act(async () => loaded([]));
    await flush();
    await openPicker();
    await act(async () => menuItem("Old · Archived")!.click());
    await click("vault-editor-save");
    expect(vault.put.mock.lastCall?.[0]).toMatchObject({ allBots: false, botIds: ["bot-1"] });
  });

  it("offers a new item's bots once it knows, in an editor opened before", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    let loaded: (value: string[]) => void = () => {};
    spaceSettings.overrides.mockReturnValue(new Promise((resolve) => (loaded = resolve)));
    vault.list.mockResolvedValue([{ ...rows[2]!, allBots: true, botIds: [] }]);
    await render();
    await startNew("api_key");
    expect(find("agent-access")).toBeNull();
    await act(async () => loaded([]));
    await flush();
    await vi.waitFor(() => expect(find("agent-access")).not.toBeNull());
  });

  it("keeps the choice open with one bot: none, that bot, and every bot again", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    bots.list.mockResolvedValue([{ id: "bot-1", name: "Ada", color: "#F97316" }]);
    const home = { ...rows[2]!, allBots: true, botIds: [] };
    vault.list.mockResolvedValue([home]);
    vault.put.mockResolvedValue(home);
    await render();
    await click(rowNamed("home"));
    await click("vault-item-edit");
    await openPicker();
    await act(async () => menuItem("All bots")!.click());
    // The list after saving holds the sole bot chosen, as a later edit would.
    vault.list.mockResolvedValue([{ ...home, allBots: false, botIds: ["bot-1"] }]);
    await click("vault-editor-save");
    expect(vault.put.mock.lastCall?.[0]).toMatchObject({ allBots: false, botIds: [] });
    // Chosen, the sole bot can be let go of for every bot again.
    await click("vault-item-edit");
    await openPicker();
    await act(async () => menuItem("All bots")!.click());
    await click("vault-editor-save");
    expect(vault.put.mock.lastCall?.[0]).toMatchObject({ allBots: true });
  });

  it("shows an archived bot that is still chosen, so it can be let go of", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    const archivedAt = "2026-10-01T00:00:00.000Z";
    // As the server lists them: archived bots only in their own list.
    bots.list.mockResolvedValue([{ id: "bot-1", name: "Ada", color: "#F97316" }]);
    bots.listArchived.mockResolvedValue([
      { id: "bot-old", name: "Old", color: "#6366F1", archivedAt },
      { id: "bot-gone", name: "Gone", color: "#6366F1", archivedAt },
    ]);
    const custom = { ...rows[3]!, allBots: false, botIds: ["bot-old", "bot-1"] };
    vault.list.mockResolvedValue([...rows.slice(0, 3), custom, rows[4]]);
    vault.put.mockResolvedValue(custom);
    await render();
    await click(rowNamed("custom"));
    await vi.waitFor(() =>
      expect(byTestId("vault-item-access-detail").textContent).toBe("BotsAda, Old · Archived"),
    );
    await click("vault-item-edit");
    await openPicker();
    // Restoring the bot would bring its choice back, so the owner can untick it; one not chosen
    // isn't offered.
    expect(menuItem("Gone · Archived")).toBeUndefined();
    await act(async () => menuItem("Old · Archived")!.click());
    await click("vault-editor-save");
    expect(vault.put.mock.lastCall?.[0]).toMatchObject({ allBots: false, botIds: ["bot-1"] });
  });

  it("never calls an item limited to an archived bot usable by no bots while archived bots load", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    let loaded: (value: unknown[]) => void = () => {};
    bots.list.mockResolvedValue([{ id: "bot-1", name: "Ada", color: "#F97316" }]);
    bots.listArchived.mockReturnValue(new Promise((resolve) => (loaded = resolve)));
    const custom = { ...rows[3]!, allBots: false, botIds: ["bot-old"] };
    vault.list.mockResolvedValue([...rows.slice(0, 3), custom, rows[4]]);
    await render();
    await click(rowNamed("custom"));
    expect(find("vault-item-access-detail")).toBeNull();
    await click("vault-item-edit");
    expect(find("agent-access")).toBeNull();
    await act(async () =>
      loaded([
        { id: "bot-old", name: "Old", color: "#6366F1", archivedAt: "2026-10-01T00:00:00.000Z" },
      ]),
    );
    await flush();
    expect(byTestId("agent-access").textContent).not.toContain("No bots");
  });

  it("never calls an item limited to an archived bot usable by no bots when archived bots can't be read", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    bots.list.mockResolvedValue([{ id: "bot-1", name: "Ada", color: "#F97316" }]);
    bots.listArchived.mockRejectedValue(new Error("offline"));
    const custom = { ...rows[3]!, allBots: false, botIds: ["bot-old"] };
    vault.list.mockResolvedValue([...rows.slice(0, 3), custom, rows[4]]);
    vault.put.mockResolvedValue(custom);
    await render();
    await click(rowNamed("custom"));
    expect(byTestId("vault-item-access-detail").textContent).toBe(
      "BotsCould not load bots. Reload to try again.",
    );
    await click("vault-item-edit");
    expect(editor()?.textContent).not.toContain("No bots");
    await type(field("Value"), FAKE_VALUE);
    await click("vault-editor-save");
    expect(vault.put).toHaveBeenCalledOnce();
    // Nothing about its bots is sent, so the archived one stays chosen.
    expect(vault.put.mock.lastCall?.[0]).not.toHaveProperty("botIds");
    expect(vault.put.mock.lastCall?.[0]).not.toHaveProperty("allBots");
  });

  it("shows what a save changed about the bots even when the list can't be read again", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    const blocked = { ...rows[3]!, policy: "off" as const, allBots: true, botIds: [] };
    vault.list.mockResolvedValue([...rows.slice(0, 3), blocked, rows[4]]);
    vault.put.mockResolvedValue({ ...blocked, policy: "allow" });
    await render();
    await click(rowNamed("custom"));
    expect(byTestId("vault-item-access-detail").textContent).toBe("BotsBlock");
    await click("vault-item-edit");
    await click(buttonIn(byTestId("vault-item-access"), "Allow")!);
    vault.list.mockRejectedValue(new Error("offline"));
    await click("vault-editor-save");
    expect(vault.put.mock.lastCall?.[0]).toMatchObject({ policy: "allow" });
    expect(editor()).toBeNull();
    // Bots may use it now, so it must not still read as blocked.
    expect(find("vault-item-access-detail")?.textContent ?? "").not.toContain("Block");
  });

  it("offers every bot of a shared Space, one another member made too", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    // Ada is this member's bot; Grace was made by another member of the Space.
    const home = { ...rows[2]!, allBots: true, botIds: [] };
    vault.list.mockResolvedValue([home]);
    vault.put.mockResolvedValue(home);
    await render();
    await click(rowNamed("home"));
    await click("vault-item-edit");
    await openPicker();
    await act(async () => menuItem("Ada")!.click());
    await click("vault-editor-save");
    expect(vault.put.mock.lastCall?.[0]).toMatchObject({ allBots: false, botIds: ["bot-2"] });
  });

  it("limits a contact to no bots, and says when the server saved it for every bot", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    vault.list.mockResolvedValue(rows.map((row) => ({ ...row, allBots: true, botIds: [] })));
    // An older server saves the item and drops the bots chosen for it.
    vault.put.mockResolvedValue(rows[2]);
    await render();
    await startNew("contact");
    await type(field("Label"), "Office");
    await type(field("Address"), "1 Main St");
    await openPicker();
    await act(async () => menuItem("All bots")!.click());
    await click("vault-editor-save");
    expect(vault.put.mock.lastCall?.[0]).toMatchObject({ allBots: false, botIds: [] });
    expect(detail()?.textContent).toContain(
      "Saved, but this server can't limit an item to chosen bots.",
    );
  });

  it("offers no choice of bots once the saved items show the server can't keep one", async () => {
    await render();
    await startNew("contact");
    expect(find("vault-item-access")).toBeNull();
    expect(bots.list).not.toHaveBeenCalled();
  });
});

describe("a login that asks first", () => {
  const pressed = () =>
    [...byTestId("vault-item-access").querySelectorAll("button[aria-pressed]")].map((b) => [
      b.textContent,
      b.getAttribute("aria-pressed"),
    ]);

  it("offers Ask first for a login only, and says when the server didn't keep it", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    const asking = { ...rows[0]!, policy: "ask", allBots: true, botIds: [] } as const;
    vault.list.mockResolvedValue([
      asking,
      ...rows.slice(1).map((row) => ({ ...row, allBots: true })),
    ]);
    vault.put.mockResolvedValue(asking);
    vault.reveal.mockResolvedValue({
      fields: [{ label: "Email", value: "octo@example.com", hidden: false }],
    });
    await render();
    await click(rowNamed("github"));
    expect(byTestId("vault-item-access-detail").textContent).toBe("BotsAsk first");
    await click("vault-item-edit");
    expect(pressed()).toEqual([
      ["Allow", "false"],
      ["Ask first", "true"],
      ["Block", "false"],
    ]);
    await click(buttonIn(byTestId("vault-item-access"), "Allow")!);
    await click("vault-editor-save");
    expect(vault.put.mock.lastCall?.[0]).toMatchObject({ policy: "allow" });
    // An API key can't ask first.
    await click("vault-back");
    await click(rowNamed("custom"));
    await click("vault-item-edit");
    expect(pressed().map(([label]) => label)).toEqual(["Allow", "Block"]);
    // A server from before Ask first drops it: the item is saved without it, and opens saying so.
    await click("vault-back");
    await click("vault-back");
    vault.put.mockResolvedValue({ ...rows[0]!, policy: undefined });
    await startNew("login");
    await type(field("Site"), "https://github.com");
    for (const input of editor()!.querySelectorAll<HTMLInputElement>(
      '[data-testid="login-field"] input:not([aria-label="Label"])',
    ))
      await type(input, FAKE_VALUE);
    await click(buttonIn(byTestId("vault-item-access"), "Ask first")!);
    await click("vault-editor-save");
    expect(vault.put.mock.lastCall?.[0]).toMatchObject({ policy: "ask" });
    expect(detail()?.textContent).toContain("Saved, but this server can't ask you first.");
  });

  it("shows both Ask first and the bots it is limited to", async () => {
    vault.list.mockResolvedValue([
      { ...rows[0]!, policy: "ask", allBots: false, botIds: ["bot-1"] },
    ]);
    await render();
    await click(rowNamed("github"));
    await vi.waitFor(() =>
      expect(byTestId("vault-item-access-detail").textContent).toBe("BotsAsk first · Ada"),
    );
  });

  it("says the bots can't be read, never every bot, when the list fails", async () => {
    bots.list.mockRejectedValue(new Error("offline"));
    vault.list.mockResolvedValue([{ ...rows[0]!, allBots: false, botIds: ["bot-1"] }]);
    await render();
    await click(rowNamed("github"));
    await vi.waitFor(() =>
      expect(byTestId("vault-item-access-detail").textContent).toBe(
        "BotsCould not load bots. Reload to try again.",
      ),
    );
  });

  it("never says No bots while the bots are still loading", async () => {
    let loaded!: (list: unknown[]) => void;
    bots.list.mockReturnValue(new Promise((resolve) => (loaded = resolve)));
    vault.list.mockResolvedValue([{ ...rows[0]!, allBots: false, botIds: ["bot-1"] }]);
    await render();
    await click(rowNamed("github"));
    expect(find("vault-item-access-detail")).toBeNull();
    await act(async () => loaded([{ id: "bot-1", name: "Ada", color: "#F97316" }]));
    await vi.waitFor(() =>
      expect(byTestId("vault-item-access-detail").textContent).toBe("BotsAda"),
    );
  });

  it("offers Ask first for the first login of an empty vault", async () => {
    vault.list.mockResolvedValue([]);
    await render();
    await startNew("login");
    expect(buttonIn(byTestId("vault-item-access"), "Ask first")).toBeDefined();
  });
});

describe("an older server", () => {
  it("finishes a new item's save and says the Block it dropped didn't apply", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    // A server from before Block lists and saves items without it.
    vault.put.mockResolvedValue(rows[3]);
    await render();
    await startNew("api_key");
    await type(field("Site"), "https://svc.example.com");
    await type(field("Value"), FAKE_VALUE);
    await click(buttonIn(byTestId("vault-item-access"), "Block")!);
    await click("vault-editor-save");
    expect(vault.put).toHaveBeenCalledOnce();
    expect(vault.put.mock.lastCall?.[0]).toMatchObject({ policy: "off" });
    // The new item is saved: the form gives way to it, saying the Block didn't apply.
    expect(editor()).toBeNull();
    expect(detail()?.textContent).toContain("Saved, but this server can't block bots yet.");
  });

  it("opens the saved item saying the Block didn't apply, even when the list can't be read again", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    const added = { ...rows[3]!, name: "custom-2", title: "new.example.com" };
    vault.put.mockResolvedValue(added);
    await render();
    await startNew("api_key");
    await type(field("Site"), "https://new.example.com");
    await type(field("Value"), FAKE_VALUE);
    await click(buttonIn(byTestId("vault-item-access"), "Block")!);
    vault.list.mockRejectedValue(new Error("offline"));
    await click("vault-editor-save");
    expect(vault.put).toHaveBeenCalledOnce();
    expect(editor()).toBeNull();
    expect(detail()?.textContent).toContain("new.example.com");
    expect(detail()?.textContent).toContain("Saved, but this server can't block bots yet.");
  });

  it("opens a new login saying its other sites and key weren't kept, even when the list can't be read again", async () => {
    // Saved where the list can't show it yet: only what the save returned can open it.
    const added = { ...rows[0]!, name: "work", title: "work.example.com", preview: {} };
    vault.put.mockResolvedValue(added);
    await render();
    await startNew("login");
    await type(field("Site"), "https://work.example.com");
    const values = editor()!.querySelectorAll<HTMLInputElement>(
      '[data-testid="login-field"] input:not([aria-label="Label"])',
    );
    await type(values[0]!, "ada@example.com");
    await type(values[1]!, FAKE_VALUE);
    await click(buttonIn(editor(), "Add an authenticator key")!);
    await type(field("Authenticator key"), TEST_KEY);
    await click(buttonIn(editor(), "Add other sites")!);
    await type(field("Also on"), "https://www.work.example.com");
    vault.list.mockRejectedValue(new Error("offline"));
    await click(buttonIn(editor(), "Save")!);
    expect(vault.put).toHaveBeenCalledOnce();
    expect(editor()).toBeNull();
    expect(detail()?.textContent).toContain("work.example.com");
    expect(detail()?.textContent).toContain(
      "Saved, but this server fills logins only on their own site. Saved, but this server can't keep authenticator keys yet.",
    );
  });

  it("says a login's other sites and authenticator key weren't kept when the saved login has neither", async () => {
    vault.put.mockResolvedValue(rows[0]);
    await render();
    await startNew("login");
    await type(field("Site"), "https://github.com");
    const values = editor()!.querySelectorAll<HTMLInputElement>(
      '[data-testid="login-field"] input:not([aria-label="Label"])',
    );
    await type(values[0]!, "octo@example.com");
    await type(values[1]!, FAKE_VALUE);
    await click(buttonIn(editor(), "Add an authenticator key")!);
    await type(field("Authenticator key"), TEST_KEY);
    await click(buttonIn(editor(), "Add other sites")!);
    await type(field("Also on"), "https://www.github.com");
    await click(buttonIn(editor(), "Save")!);
    expect(detail()?.textContent).toContain(
      "Saved, but this server fills logins only on their own site. Saved, but this server can't keep authenticator keys yet.",
    );
  });

  it("says nothing of the key when the saved login's preview couldn't be read", async () => {
    // A server that keeps keys, whose read of the saved value failed for now: no preview at all.
    vault.put.mockResolvedValue({ ...rows[0], preview: undefined });
    await render();
    await startNew("login");
    await type(field("Site"), "https://github.com");
    const values = editor()!.querySelectorAll<HTMLInputElement>(
      '[data-testid="login-field"] input:not([aria-label="Label"])',
    );
    await type(values[0]!, "octo@example.com");
    await type(values[1]!, FAKE_VALUE);
    await click(buttonIn(editor(), "Add an authenticator key")!);
    await type(field("Authenticator key"), TEST_KEY);
    await click(buttonIn(editor(), "Save")!);
    expect(editor()).toBeNull();
    expect(document.body.textContent).not.toContain("can't keep authenticator keys");
  });

  it("says why a key or another site can't be saved, before anything is cleared", async () => {
    await render();
    await startNew("login");
    await type(field("Site"), "https://github.com");
    const values = editor()!.querySelectorAll<HTMLInputElement>(
      '[data-testid="login-field"] input:not([aria-label="Label"])',
    );
    await type(values[0]!, "octo@example.com");
    await type(values[1]!, FAKE_VALUE);
    await click(buttonIn(editor(), "Add an authenticator key")!);
    // Unreadable, or a readable link too long to save: both said, both keep Save off.
    for (const key of ["not a key", `otpauth://totp/${"a".repeat(1100)}?secret=${TEST_KEY}`]) {
      await type(field("Authenticator key"), key);
      expect(editor()?.textContent).toContain("This authenticator key can't be read.");
      expect(buttonIn(editor(), "Save")!.disabled).toBe(true);
    }
    await type(field("Authenticator key"), "");
    await click(buttonIn(editor(), "Add other sites")!);
    // Plain HTTP, a wildcard no page's address can match, and a host no login may be saved for.
    for (const site of [
      "http://www.github.com",
      "https://*.github.com",
      "https://169.254.169.254",
    ]) {
      await type(field("Also on"), site);
      expect(editor()?.textContent).toContain(
        "Enter each site as an HTTPS address a login can be saved for.",
      );
      expect(buttonIn(editor(), "Save")!.disabled).toBe(true);
    }
    const many = Array.from({ length: 11 }, (_, index) => `https://s${index}.github.com`);
    await type(field("Also on"), many.join(", "));
    expect(editor()?.textContent).toContain("Up to 10 sites.");
    expect(buttonIn(editor(), "Save")!.disabled).toBe(true);
    expect(values[1]!.value).toBe(FAKE_VALUE);
    await type(field("Also on"), "https://www.github.com");
    expect(editor()?.textContent).not.toContain(
      "Enter each site as an HTTPS address a login can be saved for.",
    );
    expect(buttonIn(editor(), "Save")!.disabled).toBe(false);
  });

  it("keeps a typed authenticator key when the save fails", async () => {
    vault.put.mockRejectedValueOnce(new Error("offline"));
    await render();
    await startNew("login");
    await type(field("Site"), "https://github.com");
    const values = editor()!.querySelectorAll<HTMLInputElement>(
      '[data-testid="login-field"] input:not([aria-label="Label"])',
    );
    await type(values[1]!, FAKE_VALUE);
    await click(buttonIn(editor(), "Add an authenticator key")!);
    await type(field("Authenticator key"), TEST_KEY);
    await click(buttonIn(editor(), "Save")!);
    expect(editor()).not.toBeNull();
    expect((field("Authenticator key") as HTMLInputElement).value).toBe(TEST_KEY);
  });
});

describe("VaultSettings list", () => {
  it("shows each item's title and what tells it apart, never a value", async () => {
    await render();
    expect(
      [...document.querySelectorAll('[data-testid="vault-credential-row"]')].map(
        (row) => row.textContent,
      ),
    ).toEqual([
      "Ggithub.comocto@example.com",
      "Visa ·· 4242Expires 08/30 · For travel",
      "HomeAlex Rivera · Springfield",
      "svc.example.comAPI key",
      "deploy-token$DEPLOY_TOKEN",
    ]);
    expect(document.body.innerHTML).not.toContain(FAKE_VALUE);
    expect(vault.list.mock.calls[0]?.[0]).toEqual({ scope: "account" });
  });

  it("shows only New until there is something to list", async () => {
    vault.list.mockResolvedValue([]);
    await render();
    expect(find("vault-new")).not.toBeNull();
    expect(find("vault-card")).toBeNull();
    expect(find("vault-filter-all")).toBeNull();
  });

  it("lists the bots' email addresses in the account's vault only", async () => {
    vault.list.mockResolvedValue([]);
    bots.emailAddresses.mockResolvedValue({
      domain: "bots.test",
      addresses: [{ botId: "bot-1", botName: "Scout", address: "scout@bots.test" }],
    });
    await render("space");
    expect(find("vault-bot-emails")).toBeNull();

    await render();
    expect(byTestId("vault-bot-emails").textContent).toContain("scout@bots.test");
    expect(document.querySelector('button[aria-label="Copy scout@bots.test"]')).not.toBeNull();
  });

  it("filters by kind once there are two kinds, and searches once there are many", async () => {
    vault.list.mockResolvedValue(rows.slice(0, 1));
    await render();
    expect(find("vault-filter-all")).toBeNull();
    expect(document.querySelector('input[aria-label="Search Vault"]')).toBeNull();

    vault.list.mockResolvedValue(rows);
    await act(async () => root.unmount());
    root = createRoot(container);
    queryClient.clear();
    await render();
    expect(byTestId("vault-filter-all").textContent).toBe("All5");
    expect(byTestId("vault-filter-card").textContent).toBe("Cards1");
    await click("vault-filter-card");
    expect(byTestId("vault-filter-card").getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelectorAll('[data-testid="vault-credential-row"]')).toHaveLength(1);
    expect(rowNamed("visa")).not.toBeNull();

    const many = Array.from({ length: 8 }, (_, index) =>
      item({ name: `key-${index}`, title: `Key ${index}`, auth: { type: "command" } }),
    );
    vault.list.mockResolvedValue(many);
    await act(async () => root.unmount());
    root = createRoot(container);
    queryClient.clear();
    await render();
    const search = document.querySelector<HTMLInputElement>('input[aria-label="Search Vault"]')!;
    await type(search, "key 3");
    expect(
      [...document.querySelectorAll('[data-testid="vault-credential-row"]')].map((row) =>
        row.getAttribute("data-name"),
      ),
    ).toEqual(["key-3"]);
  });

  it("reads and writes the Space's own vault when scoped to the Space", async () => {
    await render("space");
    expect(vault.list.mock.calls[0]?.[0]).toEqual({ scope: "space" });
    await click(rowNamed("deploy-token"));
    await click("vault-item-remove");
    await click("vault-item-remove-confirm");
    expect(vault.remove).toHaveBeenCalledWith({ scope: "space", name: "deploy-token" });
  });
});

describe("VaultSettings new items", () => {
  it("saves a card as one encoded value, named by the server and billed to a contact", async () => {
    await render();
    await startNew("card");
    await type(field("Card number"), "4242 4242 4242 4242");
    expect(byTestId("vault-card-brand").textContent).toBe("Visa");
    await type(field("Expiry"), "08/30");
    await type(field("Security code"), "123");
    await type(field("Billing address"), "home");
    await click(buttonIn(editor(), "Save")!);
    expect(vault.put).toHaveBeenCalledWith({
      scope: "account",
      destination: { name: undefined, origin: "", auth: { type: "card" } },
      value: encodeCardSecret({
        number: "4242424242424242",
        expMonth: 8,
        expYear: 2030,
        cvc: "123",
        billing: "home",
      }),
    });
    expect(vault.list).toHaveBeenCalledTimes(2);
    expect(editor()).toBeNull();
  });

  it("saves a contact under its label, with a note added on request", async () => {
    await render();
    await startNew("contact");
    await type(field("Label"), "Office");
    await type(field("Address"), "1 Main St");
    await click(buttonIn(editor(), "Add a note")!);
    await type(field("When to use"), "Deliveries");
    await click(buttonIn(editor(), "Save")!);
    expect(vault.put).toHaveBeenCalledWith({
      scope: "account",
      destination: { name: undefined, origin: "", auth: { type: "contact" } },
      value: JSON.stringify({ line1: "1 Main St" }),
      title: "Office",
      note: "Deliveries",
    });
  });

  it("encodes a website login's fields, and can't save until each has a label and value", async () => {
    await render();
    await startNew("login");
    await type(field("Site"), "https://portal.example.com");
    const values = editor()!.querySelectorAll<HTMLInputElement>(
      '[data-testid="login-field"] input:not([aria-label="Label"])',
    );
    await type(values[0]!, "jamie");
    expect(buttonIn(editor(), "Save")!.disabled).toBe(true);
    await type(values[1]!, FAKE_VALUE);
    // Both start folded away, as the note does.
    expect(() => field("Also on")).toThrow();
    await click(buttonIn(editor(), "Add other sites")!);
    await click(buttonIn(editor(), "Add an authenticator key")!);
    await type(field("Also on"), "https://www.portal.example.com, https://sso.example.com");
    await type(field("Authenticator key"), "not a key");
    expect(buttonIn(editor(), "Save")!.disabled).toBe(true);
    await type(field("Authenticator key"), TEST_KEY);
    await click(buttonIn(editor(), "Save")!);
    expect(vault.put).toHaveBeenCalledWith({
      scope: "account",
      destination: {
        name: undefined,
        origin: "https://portal.example.com",
        auth: { type: "login" },
      },
      value: encodeLoginSecret({
        fields: [
          { label: "Username", value: "jamie", hidden: false },
          { label: "Password", value: FAKE_VALUE, hidden: true },
        ],
        otp: TEST_KEY,
      }),
      alsoOn: ["https://www.portal.example.com", "https://sso.example.com"],
    });
  });

  it("shows a login's other sites by their full host, and that it has an authenticator key", async () => {
    vault.list.mockResolvedValue([
      {
        ...rows[0]!,
        alsoOn: ["https://www.github.com"],
        preview: { username: "octo@example.com", otp: true },
      },
    ]);
    await render();
    await click(rowNamed("github"));
    expect(detail()?.textContent).toContain("Also onwww.github.com");
    expect(detail()?.textContent).toContain("Authenticator key••••••••");
  });

  it("sends a login's authenticator key only when it was changed in the editor", async () => {
    const otp = TEST_KEY;
    const keyed = { ...rows[0]!, preview: { username: "octo@example.com", otp: true } };
    vault.list.mockResolvedValue([keyed]);
    vault.put.mockResolvedValue(keyed);
    const fields = [{ label: "Email", value: "octo@example.com", hidden: false }];
    vault.reveal.mockResolvedValue({ fields, otp });
    await render();
    await click(rowNamed("github"));
    await click("vault-item-edit");
    expect((field("Authenticator key") as HTMLInputElement).value).toBe(otp);
    // Left as shown, the key is not sent: one removed elsewhere since this copy was read stays so.
    await click("vault-editor-save");
    const sent = () => JSON.parse(vault.put.mock.lastCall?.[0].value as string);
    expect(sent()).toEqual({ fields });
    await click("vault-item-edit");
    await type(field("Authenticator key"), "");
    await click("vault-editor-save");
    expect(sent()).toEqual({ fields, otp: "" });
  });

  it("adds a header credential, clears the value, and shows the server's error", async () => {
    vault.put.mockRejectedValueOnce(new Error("Credential limit reached"));
    await render();
    await startNew("api_key");
    await type(field("Site"), "https://api.example.com");
    await type(field("Type"), "header");
    await type(field("Header name"), "X-Api-Key");
    await type(field("Value"), FAKE_VALUE);
    await click(buttonIn(editor(), "Save")!);
    expect(vault.put).toHaveBeenCalledWith({
      scope: "account",
      destination: {
        name: undefined,
        origin: "https://api.example.com",
        auth: { type: "header", name: "X-Api-Key" },
      },
      value: FAKE_VALUE,
    });
    expect(editor()?.textContent).toContain("Credential limit reached");
    expect((field("Value") as HTMLInputElement).value).toBe("");
    expect(document.body.innerHTML).not.toContain(FAKE_VALUE);
  });

  it("names a variable as it is exported, and refuses a reserved one", async () => {
    await render();
    await startNew("variable");
    await type(field("Variable name"), "PATH");
    await type(field("Value"), FAKE_VALUE);
    expect(byTestId("vault-editor-variable-error").textContent).toContain("$PATH is reserved");
    expect(buttonIn(editor(), "Save")!.disabled).toBe(true);
    await type(field("Variable name"), "NETBIRD_SETUP_KEY");
    await click(buttonIn(editor(), "Save")!);
    expect(vault.put).toHaveBeenCalledWith({
      scope: "account",
      destination: { name: "netbird_setup_key", origin: "", auth: { type: "command" } },
      value: FAKE_VALUE,
    });
    // A new item's save returns to the list; only an edit, or a notice, opens the item.
    expect(editor()).toBeNull();
    expect(detail()).toBeNull();
  });
});

describe("VaultSettings item details", () => {
  const confirmationRequired = Object.assign(new Error("Confirm it's you"), {
    code: "IDENTITY_CONFIRMATION_REQUIRED",
  });

  it("shows a contact in full and a card's billing contact by its title", async () => {
    await render();
    await click(rowNamed("home"));
    expect(detail()?.textContent).toContain("Alex Rivera");
    expect(detail()?.textContent).toContain("+1 555 0100");
    expect(vault.reveal).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    await click(rowNamed("visa"));
    expect(detail()?.textContent).toContain("•••• 4242");
    expect(detail()?.textContent).toContain("Billing addressHome");
    expect(detail()?.textContent).toContain("For travel");
  });

  it("shows a value after the person confirms it's them, and hides it again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vault.reveal
      .mockRejectedValueOnce(confirmationRequired)
      .mockResolvedValueOnce({ value: FAKE_VALUE });
    await render();
    await click(rowNamed("custom"));
    expect(detail()?.textContent).toContain('Header "X-Api-Key"');
    await click("vault-item-show");
    await click("identity-confirm");
    expect(vault.reveal).toHaveBeenCalledWith({ scope: "account", name: "custom" });
    expect(byTestId("vault-item-value").textContent).toContain(FAKE_VALUE);
    // A shown value never lands in the query cache.
    const cached = queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.state.data);
    expect(JSON.stringify(cached)).not.toContain(FAKE_VALUE);
    await act(async () => {
      byTestId("vault-item-value").querySelector<HTMLButtonElement>('[aria-label="Copy"]')!.click();
    });
    expect(writeText).toHaveBeenCalledWith(FAKE_VALUE);
    await act(async () => {
      vi.advanceTimersByTime(REVEAL_MS);
    });
    expect(document.body.innerHTML).not.toContain(FAKE_VALUE);
  });

  it("shows nothing and no error when the confirmation is dismissed", async () => {
    vault.reveal.mockRejectedValueOnce(confirmationRequired);
    await render();
    await click(rowNamed("custom"));
    await click("vault-item-show");
    await click("identity-cancel");
    expect(detail()?.querySelector('[role="alert"]')).toBeNull();
    expect(byTestId("vault-item-value").textContent).toContain("••••");
  });

  it("shows each field of a website login with its label", async () => {
    vault.reveal.mockResolvedValue({
      fields: [
        { label: "Username", value: "jamie", hidden: false },
        { label: "PIN", value: FAKE_VALUE, hidden: true },
      ],
    });
    await render();
    await click(rowNamed("github"));
    await click("vault-item-show");
    expect(
      [...document.querySelectorAll('[data-testid="vault-item-field"]')].map(
        (row) => row.textContent,
      ),
    ).toEqual(["Usernamejamie", `PIN${FAKE_VALUE}`]);
  });

  it("shows and copies a login's authenticator key with its password, and hides both together", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    // Copied as it was saved, here its setup link, never with its label.
    const otp = `otpauth://totp/GitHub:octo?secret=${TEST_KEY}&issuer=GitHub`;
    vault.list.mockResolvedValue([
      {
        ...rows[0]!,
        alsoOn: ["https://gist.github.com"],
        preview: { username: "octo@example.com", otp: true },
      },
    ]);
    vault.reveal.mockResolvedValue({
      fields: [
        { label: "Username", value: "octo@example.com", hidden: false },
        { label: "Password", value: FAKE_VALUE, hidden: true },
      ],
      otp,
    });
    const shown = () =>
      [...detail()!.querySelectorAll('[data-testid="vault-item-field"]')].map(
        (row) => row.textContent,
      );
    await render();
    await click(rowNamed("github"));
    expect(byTestId("vault-item-otp").textContent).toBe("Authenticator key••••••••");
    expect(byTestId("vault-item-otp").querySelector('[aria-label="Copy"]')).toBeNull();
    await click("vault-item-show");
    // What mobile's Show lists too: each field, then the key.
    expect(shown()).toEqual(["Usernameocto@example.com", `Password${FAKE_VALUE}`]);
    expect(byTestId("vault-item-otp").textContent).toBe(`Authenticator key${otp}`);
    expect(detail()?.textContent).toContain("Also ongist.github.com");
    await act(async () => {
      byTestId("vault-item-otp").querySelector<HTMLButtonElement>('[aria-label="Copy"]')!.click();
    });
    expect(writeText.mock.calls).toEqual([[otp]]);
    // Hidden with the password once the reveal expires.
    await act(async () => {
      vi.advanceTimersByTime(REVEAL_MS);
    });
    expect(document.body.innerHTML).not.toContain(FAKE_VALUE);
    expect(document.body.innerHTML).not.toContain("GEZDGNBVGY3TQOJQ");
    expect(byTestId("vault-item-otp").textContent).toBe("Authenticator key••••••••");
    // And when the detail closes and opens again.
    await click("vault-item-show");
    expect(byTestId("vault-item-otp").textContent).toBe(`Authenticator key${otp}`);
    await click("vault-back");
    await click(rowNamed("github"));
    expect(document.body.innerHTML).not.toContain("GEZDGNBVGY3TQOJQ");
    expect(byTestId("vault-item-otp").textContent).toBe("Authenticator key••••••••");
  });

  it("edits a card from its revealed value", async () => {
    vault.reveal.mockResolvedValue({
      card: { number: "4242424242424242", expMonth: 8, expYear: 2030, cvc: "123" },
    });
    await render();
    await click(rowNamed("visa"));
    await click("vault-item-edit");
    expect(detail()).toBeNull();
    expect((field("Expiry") as HTMLInputElement).value).toBe("08/30");
    await type(field("Name"), "Travel card");
    await click(buttonIn(editor(), "Save")!);
    expect(vault.put).toHaveBeenCalledWith({
      scope: "account",
      destination: { name: "visa", origin: "", auth: { type: "card" } },
      value: encodeCardSecret({
        number: "4242424242424242",
        expMonth: 8,
        expYear: 2030,
        cvc: "123",
      }),
      title: "Travel card",
      note: "For travel",
    });
  });

  it("keeps a key's saved value when an edit leaves it empty", async () => {
    await render();
    await click(rowNamed("custom"));
    await click("vault-item-edit");
    expect((field("Site") as HTMLInputElement).disabled).toBe(true);
    await type(field("Name"), "Service");
    await click(buttonIn(editor(), "Save")!);
    expect(vault.put).toHaveBeenCalledWith({
      scope: "account",
      destination: {
        name: "custom",
        origin: "https://svc.example.com",
        auth: { type: "header", name: "X-Api-Key" },
      },
      title: "Service",
      note: "",
    });
  });

  it("reviews a CSV export on the device, then imports only the new logins", async () => {
    await render();
    const csv = [
      "name,url,username,password",
      `GitHub,https://github.com/login,octo@example.com,${FAKE_VALUE}`,
      `Shop,https://shop.example.com,alice,${FAKE_VALUE}`,
      `Old,http://old.example.com,alice,${FAKE_VALUE}`,
    ].join("\n");
    const input = byTestId<HTMLInputElement>("vault-import-file");
    Object.defineProperty(input, "files", { value: [new File([csv], "export.csv")] });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    const counts = () =>
      [...document.querySelectorAll("[data-testid=vault-import-count]")].map(
        (row) => row.textContent,
      );
    expect(counts()).toEqual(["To add1", "Already saved1", "Not on an HTTPS site1"]);
    // Which rows, by row and title, never by username or password.
    expect(find("vault-import-problems")?.textContent).toBe(
      "Row 2 · GitHub · Already savedRow 4 · Old · Not on an HTTPS site",
    );
    // Said before the logins are added, the one moment no Bots setting is in sight.
    const botsNote = "Bots can use each imported login until you change its Bots setting.";
    expect(find("vault-import-page")?.textContent).toContain(botsNote);
    vault.import.mockResolvedValue({
      added: 1,
      skipped: { notHttps: 0, noPassword: 0, duplicate: 0, invalid: 0, limit: 0 },
    });
    await click(buttonIn(find("vault-import-page"), "Import")!);
    expect(vault.import).toHaveBeenCalledWith({
      scope: "account",
      rows: [
        {
          title: "Shop",
          origin: "https://shop.example.com",
          username: "alice",
          password: FAKE_VALUE,
        },
      ],
    });
    expect(counts()).toEqual(["Added1", "Already saved1", "Not on an HTTPS site1"]);
    expect(find("vault-import-page")?.textContent).toContain("Delete the exported file now.");
    expect(find("vault-import-page")?.textContent).not.toContain(botsNote);
    expect(find("vault-import-page")?.textContent).not.toContain(FAKE_VALUE);
    await click(buttonIn(find("vault-import-page"), "Done")!);
    expect(find("vault-import-page")).toBeNull();
  });

  it("lists left-out rows with the wording and limit both apps share", async () => {
    // A locale no catalog ships, so only these two strings change.
    i18n.load("en-XA", { "Row {line}": "Zeile {line}", "And {more} more": "Und {more} weitere" });
    i18n.activate("en-XA");
    await render();
    const csv = [
      "name,url,username,password",
      ...Array.from({ length: 7 }, (_, index) => `Old ${index},http://old.example.com,a,x`),
    ].join("\n");
    const input = byTestId<HTMLInputElement>("vault-import-file");
    Object.defineProperty(input, "files", { value: [new File([csv], "export.csv")] });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(
      [...find("vault-import-problems")!.querySelectorAll("li")].map((row) => row.textContent),
    ).toEqual([
      ...[0, 1, 2, 3, 4].map((index) => `Zeile ${index + 2} · Old ${index} · Not on an HTTPS site`),
      "Und 2 weitere",
    ]);
    // With nothing to add, nothing is said of what bots may use.
    expect(find("vault-import-page")?.textContent).not.toContain("Bots can use");
  });

  it("imports the file picked last, whichever read finishes first", async () => {
    for (const order of [
      ["a", "b"],
      ["b", "a"],
    ] as const) {
      vault.import.mockReset().mockResolvedValue({
        added: 1,
        skipped: { notHttps: 0, noPassword: 0, duplicate: 0, invalid: 0, limit: 0 },
        notSaved: [],
      });
      await render();
      const reads: Record<string, (text: string) => void> = {};
      const picked = (name: "a" | "b") => {
        const file = new File([""], `${name}.csv`);
        Object.defineProperty(file, "text", {
          value: () => new Promise<string>((resolve) => (reads[name] = resolve)),
        });
        return file;
      };
      const input = byTestId<HTMLInputElement>("vault-import-file");
      for (const name of ["a", "b"] as const) {
        Object.defineProperty(input, "files", { value: [picked(name)], configurable: true });
        await act(async () => {
          input.dispatchEvent(new Event("change", { bubbles: true }));
        });
      }
      for (const name of order) {
        await act(async () =>
          reads[name]!(`url,password\nhttps://${name}.example.com,fake-${name}`),
        );
        await flush();
      }
      await click(buttonIn(find("vault-import-page"), "Import")!);
      expect(vault.import).toHaveBeenCalledWith({
        scope: "account",
        rows: [expect.objectContaining({ origin: "https://b.example.com" })],
      });
      await act(async () => root.unmount());
      root = createRoot(container);
    }
  });

  it("says how many logins look past the room left, and sends them all for the server to judge", async () => {
    await render();
    // The Vault already holds the five listed items.
    const csv = [
      "url,password",
      ...Array.from({ length: 97 }, (_, index) => `https://s${index}.example.com,fake`),
    ].join("\n");
    const input = byTestId<HTMLInputElement>("vault-import-file");
    Object.defineProperty(input, "files", { value: [new File([csv], "export.csv")] });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    const counts = [...document.querySelectorAll("[data-testid=vault-import-count]")].map(
      (row) => row.textContent,
    );
    expect(counts).toEqual(["To add95", "Vault full2"]);
    await click(buttonIn(find("vault-import-page"), "Import")!);
    expect(vault.import.mock.lastCall?.[0].rows).toHaveLength(97);
  });

  it("says an import that stopped partway may have saved some, and plans again without them", async () => {
    await render();
    const csv =
      "url,username,password\nhttps://a.example.com,ann,fake-a\nhttps://b.example.com,bob,fake-b";
    const input = byTestId<HTMLInputElement>("vault-import-file");
    Object.defineProperty(input, "files", { value: [new File([csv], "export.csv")] });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    // The first login was saved before the server failed on the second.
    vault.import.mockRejectedValueOnce(new Error("Internal server error"));
    const saved = item({
      name: "a",
      origin: "https://a.example.com",
      auth: { type: "login" },
      preview: { username: "ann" },
    });
    vault.list.mockResolvedValue([...rows, saved]);
    await click(buttonIn(find("vault-import-page"), "Import")!);
    await flush();
    // Two sentences on two lines: joining them would need punctuation each language writes its way.
    const alert = find("vault-import-page")?.querySelector("[role=alert]");
    expect(alert?.textContent).toBe(
      "Internal server error\nSome logins may have been saved. Importing the file again skips them.",
    );
    expect(alert?.className).toContain("whitespace-pre-line");
    const counts = [...document.querySelectorAll("[data-testid=vault-import-count]")].map(
      (row) => row.textContent,
    );
    expect(counts).toEqual(["To add1", "Already saved1"]);
    vault.import.mockResolvedValue({ added: 1, skipped: noneSkipped(), notSaved: [] });
    await click(buttonIn(find("vault-import-page"), "Import")!);
    expect(vault.import.mock.lastCall?.[0].rows).toEqual([
      expect.objectContaining({ origin: "https://b.example.com" }),
    ]);
  });

  it("offers Import CSV only once the Vault is read, so a review never plans against nothing", async () => {
    vault.list.mockRejectedValue(new Error("offline"));
    await render();
    await click("vault-new");
    expect(find("vault-import")?.hasAttribute("data-disabled")).toBe(true);
  });

  it("keeps the plan of an import that stopped partway when the Vault can't be read again", async () => {
    await render();
    const csv =
      "url,username,password\nhttps://a.example.com,ann,fake-a\nhttps://b.example.com,bob,fake-b";
    const input = byTestId<HTMLInputElement>("vault-import-file");
    Object.defineProperty(input, "files", { value: [new File([csv], "export.csv")] });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    vault.import.mockRejectedValueOnce(new Error("Internal server error"));
    vault.list.mockRejectedValue(new Error("offline"));
    await click(buttonIn(find("vault-import-page"), "Import")!);
    await flush();
    expect(find("vault-import-page")?.querySelector("[role=alert]")?.textContent).toContain(
      "Some logins may have been saved. Importing the file again skips them.",
    );
    const counts = [...document.querySelectorAll("[data-testid=vault-import-count]")].map(
      (row) => row.textContent,
    );
    expect(counts).toEqual(["To add2"]);
  });

  it("asks to update a server that can't import yet", async () => {
    vault.import.mockRejectedValueOnce(
      Object.assign(new Error("Not found"), { code: "NOT_FOUND" }),
    );
    await render();
    const input = byTestId<HTMLInputElement>("vault-import-file");
    const csv = "url,password\nhttps://new.example.com,fake";
    Object.defineProperty(input, "files", { value: [new File([csv], "export.csv")] });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    await click(buttonIn(find("vault-import-page"), "Import")!);
    expect(find("vault-import-page")?.textContent).toContain(
      "Update your server to import logins.",
    );
  });

  it("removes only after an explicit confirm", async () => {
    await render();
    await click(rowNamed("deploy-token"));
    await click("vault-item-remove");
    expect(vault.remove).not.toHaveBeenCalled();
    expect(detail()?.textContent).toContain("Remove deploy-token?");
    await click("vault-item-remove-confirm");
    expect(vault.remove).toHaveBeenCalledWith({ scope: "account", name: "deploy-token" });
    expect(detail()).toBeNull();
  });

  it("offers only Remove on an item whose saved settings can't be read", async () => {
    vault.list.mockResolvedValue([
      item({ name: "broken", auth: null }),
      item({ name: "Legacy Name", origin: "https://x.example.com", auth: { type: "bearer" } }),
    ]);
    await render();
    expect(rowNamed("broken").textContent).toContain("can't be read");
    for (const name of ["broken", "Legacy Name"]) {
      await click(rowNamed(name));
      expect(find("vault-item-edit")).toBeNull();
      expect(find("vault-item-show")).toBeNull();
      expect(find("vault-item-remove")).not.toBeNull();
      await act(async () => root.unmount());
      root = createRoot(container);
      await render();
    }
  });
});
