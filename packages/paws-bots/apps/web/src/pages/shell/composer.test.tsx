// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type { AgentSkillCatalogEntry, BillingStatus, ThreadMessage } from "@rakazo/contracts";
import type { ComposerMention } from "@rakazo/core";
import { MODEL_REQUIRED_SEND_ERROR, resolveComposerSendPlan } from "@rakazo/core";
import type { ComponentProps, ReactNode } from "react";
import { act, createRef } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

const billing = vi.hoisted(() => ({ status: null as BillingStatus | null }));
vi.mock("../../components/SubscriptionGate", () => ({
  useBilling: () => ({ status: billing.status, showPlans: () => {} }),
}));

import { replaceComposerDraft } from "../../lib/composer-draft";
import { dictation } from "../../lib/dictation";
import { createPageSession, PagesProvider } from "../../lib/pages";
import { Composer, LARGE_PASTE_THRESHOLD } from "./composer";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let composerProps: ComponentProps<typeof Composer>;

beforeEach(() => {
  i18n.load("en", {});
  i18n.activate("en");
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  localStorage.clear();
  billing.status = null;
});

const bob: ComposerMention = { kind: "bot", id: "bot-2", name: "Bob" };
const summarize: AgentSkillCatalogEntry = {
  id: "skill-1",
  name: "summarize",
  description: "Summarize a document",
  source: "user",
  readOnly: false,
};

function renderComposer(
  onSend: ComponentProps<typeof Composer>["onSend"],
  overrides: Partial<ComponentProps<typeof Composer>> = {},
) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // Reduced motion skips the chip-row resize animation, which jsdom cannot run.
  window.matchMedia ??= () =>
    ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }) as unknown as MediaQueryList;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  composerProps = {
    artifactTarget: { botId: "bot-1" },
    activeName: "Ada",
    running: false,
    pendingAttachments: [],
    attachmentNotice: null,
    sendError: null,
    onOpenModels: () => {},
    onOpenConnections: () => {},
    onOpenBilling: () => {},
    runError: null,
    runErrorId: null,
    onRunErrorPresented: () => {},
    onDismissError: () => {},
    sending: false,
    fileInputRef: createRef(),
    onAttachmentPick: () => true,
    onRemoveAttachment: () => {},
    onSend,
    onStop: async () => {},
    draftKey: "bot:bot-1",
    enterToSend: true,
    mentionTargets: [bob],
    agentSkills: [summarize],
    ...overrides,
  };
  rerenderComposer({});
  const textarea = container.querySelector("textarea");
  if (!textarea) throw new Error("composer textarea not found");
  return textarea;
}

function rerenderComposer(overrides: Partial<ComponentProps<typeof Composer>>) {
  composerProps = { ...composerProps, ...overrides };
  act(() => root?.render(<Composer {...composerProps} />));
}

it("colors the send button like the bot's user bubbles", () => {
  renderComposer(async () => true, {
    sendColors: { background: "#9C47E9", foreground: "#FFFFFF" },
  });
  const send = () => container?.querySelector<HTMLButtonElement>('button[aria-label="Send"]');
  expect(send()?.style.getPropertyValue("--chat-user")).toBe("#9C47E9");
  expect(send()?.className).toContain("bg-chat-user");

  rerenderComposer({ sendColors: undefined });
  expect(send()?.style.getPropertyValue("--chat-user")).toBe("");
  expect(send()?.className).not.toContain("bg-chat-user");
});

it("shows a readable run error with raw details, while preserving send errors", () => {
  const runError = '429: {"message":"Too many requests","metadata":{"provider":"OpenRouter"}}';
  renderComposer(async () => true, { runError, runErrorId: "failed-run" });
  const error = container?.querySelector('[data-testid="composer-error"]');
  expect(error?.textContent).toContain(
    "Your OpenRouter is rate limiting requests. Try again shortly.",
  );
  const details = error?.querySelector("details");
  expect(details?.open).toBe(false);
  expect(details?.querySelector("summary")?.textContent).toBe("Details");
  act(() => details?.querySelector("summary")?.click());
  expect(details?.open).toBe(true);
  expect(details?.querySelector("pre")?.textContent).toBe(runError);

  rerenderComposer({ sendError: "Could not send the message." });
  expect(error?.textContent).toBe("Could not send the message.");
  expect(error?.querySelector("details")).toBeNull();
});

it.each([
  ['402: {"message":"You have no credits remaining."}', "Choose a model", "models"],
  [
    '403: {"type":"FreeTierError","message":"This free tier can only be used from within its own app."}',
    "Choose a model",
    "models",
  ],
  ['404: {"message":"Model example-model does not exist"}', "Choose a model", "models"],
  ['401: {"message":"Invalid API key"}', "Replace key", "connections"],
  ["Connect a model in Settings before running bots.", "Connect a model", "connections"],
  ["Request timed out.", null, null],
  ['429: {"message":"Too many requests"}', null, null],
] as const)("offers the one action that fixes %s", (runError, label, opens) => {
  const onOpenModels = vi.fn();
  const onOpenConnections = vi.fn();
  renderComposer(async () => true, {
    runError,
    runErrorId: "failed-run",
    onOpenModels,
    onOpenConnections,
  });
  const actions = container?.querySelectorAll<HTMLButtonElement>(
    '[data-testid="composer-error-action"]',
  );
  expect(actions?.length).toBe(label ? 1 : 0);
  if (!label) return;
  expect(actions?.[0]?.textContent).toBe(label);
  act(() => actions?.[0]?.click());
  expect(onOpenModels).toHaveBeenCalledTimes(opens === "models" ? 1 : 0);
  expect(onOpenConnections).toHaveBeenCalledTimes(opens === "connections" ? 1 : 0);

  rerenderComposer({ sendError: "Could not send the message." });
  expect(container?.querySelector('[data-testid="composer-error-action"]')).toBeNull();
});

it.each([
  ["active", false, "This month's computer hours are used up.", "Upgrade"],
  ["trialing", false, "Your trial's computer hours are used up.", "Start plan now"],
  ["trialing", true, "Cancelled trials have no computer hours.", "Renew plan"],
] as const)(
  "says why computer hours ran out on a %s plan (cancelling: %s) and opens billing",
  (state, cancelAtPeriodEnd, summary, label) => {
    billing.status = { state, cancelAtPeriodEnd, canManage: true } as BillingStatus;
    const onOpenBilling = vi.fn();
    renderComposer(async () => true, {
      runError: "No computer hours left.",
      runErrorId: "failed-run",
      onOpenBilling,
    });
    const error = container?.querySelector('[data-testid="composer-error"]');
    expect(error?.textContent).toContain(summary);
    const action = error?.querySelector<HTMLButtonElement>('[data-testid="composer-error-action"]');
    expect(action?.textContent).toBe(label);
    act(() => action?.click());
    expect(onOpenBilling).toHaveBeenCalledOnce();
  },
);

it("offers no billing action to a member who cannot manage the plan", () => {
  billing.status = { state: "active", cancelAtPeriodEnd: false, canManage: false } as BillingStatus;
  renderComposer(async () => true, {
    runError: "No computer hours left.",
    runErrorId: "failed-run",
  });
  const error = container?.querySelector('[data-testid="composer-error"]');
  expect(error?.textContent).toContain("This month's computer hours are used up.");
  expect(error?.querySelector('[data-testid="composer-error-action"]')).toBeNull();
});

it.each([MODEL_REQUIRED_SEND_ERROR, `  ${MODEL_REQUIRED_SEND_ERROR}  `])(
  "links the missing-model send error to model settings: %s",
  (sendError) => {
    const onOpenModels = vi.fn();
    renderComposer(async () => true, { sendError, onOpenModels });
    const link = container?.querySelector<HTMLButtonElement>(
      '[data-testid="composer-error-open-models"]',
    );
    expect(link?.textContent).toBe(sendError);
    act(() => link?.click());
    expect(onOpenModels).toHaveBeenCalledOnce();

    rerenderComposer({ sendError: "Could not send the message." });
    expect(container?.querySelector('[data-testid="composer-error-open-models"]')).toBeNull();
  },
);

function pickAttachment() {
  const input = container?.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("attachment input not found");
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [new File(["notes"], "notes.txt", { type: "text/plain" })],
  });
  act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
}

function type(textarea: HTMLTextAreaElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  act(() => {
    setValue?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function nativeDelete(
  textarea: HTMLTextAreaElement,
  selection: [number, number],
  removed: [number, number],
  { key = "Backspace", isComposing = false } = {},
) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  act(() => textarea.setSelectionRange(...selection));
  act(() => textarea.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
  act(() => {
    setValue?.call(
      textarea,
      textarea.value.slice(0, removed[0]) + textarea.value.slice(removed[1]),
    );
    textarea.setSelectionRange(removed[0], removed[0]);
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing }));
  });
}

function pressEnter(textarea: HTMLTextAreaElement) {
  act(() => {
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

describe("Composer", () => {
  it.each(["Enter", "Tab", "pointer"])(
    "completes an inline bot at the caret with %s",
    async (method) => {
      const onSend = vi.fn().mockResolvedValue(true);
      const textarea = renderComposer(onSend);
      const original = "i need u to message @Bo and do this";
      type(textarea, original);
      act(() => {
        textarea.focus();
        textarea.setSelectionRange(original.indexOf(" and"), original.indexOf(" and"));
        document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      });
      expect(container?.querySelector('[data-testid="mention-picker"]')).not.toBeNull();
      if (method === "pointer") {
        act(() => container?.querySelector<HTMLButtonElement>('[role="option"]')?.click());
      } else {
        act(() =>
          textarea.dispatchEvent(new KeyboardEvent("keydown", { key: method, bubbles: true })),
        );
      }
      expect(textarea.value).toBe("i need u to message @Bob and do this");
      expect(textarea.selectionStart).toBe("i need u to message @Bob ".length);
      expect(document.activeElement).toBe(textarea);
      pressEnter(textarea);
      await act(async () => {});
      expect(onSend).toHaveBeenCalledWith(
        "i need u to message @Bob and do this",
        [bob],
        expect.any(String),
      );
    },
  );

  it("keeps repeated inline mentions in order with one routing target", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const textarea = renderComposer(onSend);
    type(textarea, "ask @Bo");
    pressEnter(textarea);
    type(textarea, `${textarea.value}and then @Bo`);
    pressEnter(textarea);
    expect(textarea.value).toBe("ask @Bob and then @Bob ");
    expect(container?.querySelectorAll('[data-testid="mention-chip"]')).toHaveLength(2);
    expect(container?.querySelector('[data-testid="mention-picker"]')).toBeNull();
    expect(textarea.selectionStart).toBe(textarea.value.length);
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend).toHaveBeenCalledWith("ask @Bob and then @Bob", [bob], expect.any(String));
  });

  it("removes stale routing when a selected token is renamed or deleted", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const textarea = renderComposer(onSend);
    type(textarea, "ask @Bo");
    pressEnter(textarea);
    type(textarea, "ask @Bobby later");
    expect(container?.querySelectorAll('[data-testid="mention-chip"]')).toHaveLength(0);
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend).toHaveBeenCalledWith("ask @Bobby later", [], expect.any(String));
  });

  it("draws each completed mention inline in the field instead of beside it", () => {
    const textarea = renderComposer(vi.fn(), {
      mentionTargets: [{ ...bob, color: "#3366FF" }],
    });
    type(textarea, "ask @Bo");
    pressEnter(textarea);
    type(textarea, `${textarea.value}now`);
    const field = container?.querySelector('[data-testid="composer-field"]');
    const card = field?.querySelector('[data-testid="mention-chip"]');
    expect(card?.textContent).toBe("@Bob");
    expect((card as HTMLElement | null)?.style.color).toBe("rgb(51, 102, 255)");
    expect(card?.closest("[inert]")?.textContent).toBe("ask @Bob now");
    expect(container?.querySelector('[aria-label="Remove mention Bob"]')).toBeNull();
    expect(textarea.className).toContain("text-transparent");

    const uploaded = "data:image/png;base64,bmV3";
    rerenderComposer({ mentionTargets: [{ ...bob, color: uploaded }] });
    expect(container?.querySelector('[data-testid="mention-chip"] img')?.getAttribute("src")).toBe(
      uploaded,
    );
  });

  it.each([
    ["Backspace at its end", [9, 9], [8, 9], "Backspace", "ask   ", 5],
    ["Delete at its start", [5, 5], [5, 6], "Delete", "ask   ", 5],
    ["Backspace inside it", [7, 7], [6, 7], "Backspace", "ask   ", 5],
    ["a selection cutting into it", [2, 7], [2, 7], "Backspace", "as ", 2],
    ["a phone keyboard deletion", [9, 9], [8, 9], "Unidentified", "ask   ", 5],
  ] as const)(
    "removes the whole mention after %s",
    (_label, selection, removed, key, value, caret) => {
      const textarea = renderComposer(vi.fn());
      type(textarea, "ask  @Bo");
      pressEnter(textarea);
      expect(textarea.value).toBe("ask  @Bob ");
      nativeDelete(textarea, [...selection], [...removed], { key });
      expect(textarea.value).toBe(value);
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([caret, caret]);
      expect(container?.querySelector('[data-testid="mention-chip"]')).toBeNull();
    },
  );

  it.each([
    ["the space after it", [10, 10], [9, 10], false, "ask  @Bob", 1],
    ["an IME composition edit", [9, 9], [8, 9], true, "ask  @Bo ", 0],
  ] as const)(
    "keeps the native edit for %s",
    (_label, selection, removed, isComposing, value, cards) => {
      const textarea = renderComposer(vi.fn());
      type(textarea, "ask  @Bo");
      pressEnter(textarea);
      nativeDelete(textarea, [...selection], [...removed], { isComposing });
      expect(textarea.value).toBe(value);
      expect(container?.querySelectorAll('[data-testid="mention-chip"]')).toHaveLength(cards);
    },
  );

  it("moves the caret past the full token even when completion leaves text unchanged", () => {
    const textarea = renderComposer(vi.fn());
    type(textarea, "ask @Bob, please");
    act(() => {
      textarea.focus();
      textarea.setSelectionRange(7, 7);
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    });
    pressEnter(textarea);
    expect(textarea.value).toBe("ask @Bob, please");
    expect(textarea.selectionStart).toBe(8);
    expect(container?.querySelector('[data-testid="mention-picker"]')).toBeNull();
  });

  it("replaces a selected bot without retaining its previous routing target", async () => {
    const bobby: ComposerMention = { kind: "bot", id: "bot-3", name: "Bobby" };
    const onSend = vi.fn().mockResolvedValue(true);
    const textarea = renderComposer(onSend, { mentionTargets: [bob, bobby] });
    type(textarea, "ask @Bo");
    pressEnter(textarea);
    act(() => {
      textarea.setSelectionRange(7, 7);
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    });
    act(() =>
      container?.querySelector<HTMLButtonElement>('[role="option"][aria-label="@Bobby"]')?.click(),
    );
    expect(textarea.value).toBe("ask @Bobby ");
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend).toHaveBeenCalledWith("ask @Bobby", [bobby], expect.any(String));
  });

  it.each(["bot", "group"] as const)(
    "replaces an overlapping %s name without stale routing",
    async (kind) => {
      const short: ComposerMention = { kind, id: "short", name: "Bob" };
      const long: ComposerMention = { kind: "bot", id: "long", name: "Bob Smith" };
      const onSend = vi.fn().mockResolvedValue(true);
      const textarea = renderComposer(onSend, { mentionTargets: [short, long] });
      type(textarea, "ask @Bo");
      pressEnter(textarea);
      act(() => {
        textarea.setSelectionRange(7, 7);
        document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      });
      act(() =>
        container
          ?.querySelector<HTMLButtonElement>('[role="option"][aria-label="@Bob Smith"]')
          ?.click(),
      );
      expect(textarea.value).toBe("ask @Bob Smith ");
      expect(container?.querySelectorAll('[data-testid="mention-chip"]')).toHaveLength(1);
      pressEnter(textarea);
      await act(async () => {});
      expect(onSend).toHaveBeenCalledWith("ask @Bob Smith", [long], expect.any(String));
    },
  );

  it("replaces the full existing multiword name and preserves a separate short mention", async () => {
    const smith: ComposerMention = { kind: "bot", id: "smith", name: "Bob Smith" };
    const jones: ComposerMention = { kind: "bot", id: "jones", name: "Bob Jones" };
    const onSend = vi.fn().mockResolvedValue(true);
    const textarea = renderComposer(onSend, { mentionTargets: [bob, smith, jones] });
    type(textarea, "@Bo");
    pressEnter(textarea);
    type(textarea, `${textarea.value}ask @Bo`);
    act(() =>
      container
        ?.querySelector<HTMLButtonElement>('[role="option"][aria-label="@Bob Smith"]')
        ?.click(),
    );
    act(() => {
      textarea.setSelectionRange(12, 12);
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    });
    act(() =>
      container
        ?.querySelector<HTMLButtonElement>('[role="option"][aria-label="@Bob Jones"]')
        ?.click(),
    );
    expect(textarea.value).toBe("@Bob ask @Bob Jones ");
    nativeDelete(textarea, [4, 4], [3, 4]);
    expect(textarea.value).toBe(" ask @Bob Jones ");
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend).toHaveBeenCalledWith("ask @Bob Jones", [jones], expect.any(String));
  });

  it("keeps Escape dismissal through a delayed native selection event", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const textarea = renderComposer(onSend);
    act(() => textarea.focus());
    type(textarea, "@Bo");
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      textarea.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true }));
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    });
    expect(container?.querySelector('[data-testid="mention-picker"]')).toBeNull();
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend).toHaveBeenCalledWith("@Bo", [], expect.any(String));
  });

  it("retires the replaced group identity when a bot has the same name", async () => {
    const group: ComposerMention = { kind: "group", id: "group-bob", name: "Bob" };
    const onSend = vi.fn().mockResolvedValue(true);
    const textarea = renderComposer(onSend, { mentionTargets: [group, bob] });
    type(textarea, "ask @Bo");
    pressEnter(textarea);
    act(() => {
      textarea.setSelectionRange(7, 7);
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    });
    act(() => container?.querySelectorAll<HTMLButtonElement>('[role="option"]')[1]?.click());
    expect(textarea.value).toBe("ask @Bob ");
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend).toHaveBeenCalledWith("ask @Bob", [bob], expect.any(String));
  });

  it.each(["bot", "group"])(
    "deleting only a same-name %s occurrence retires that target",
    async (deleted) => {
      const group: ComposerMention = { kind: "group", id: "group-bob", name: "Bob" };
      const onSend = vi.fn().mockResolvedValue(true);
      const textarea = renderComposer(onSend, { mentionTargets: [bob, group] });
      type(textarea, "ask @Bo");
      pressEnter(textarea);
      type(textarea, `${textarea.value}then @Bo`);
      act(() => container?.querySelectorAll<HTMLButtonElement>('[role="option"]')[1]?.click());
      type(textarea, `${textarea.value}please`);
      type(textarea, deleted === "group" ? "ask @Bob then please" : "ask then @Bob please");
      pressEnter(textarea);
      await act(async () => {});
      expect(onSend).toHaveBeenCalledWith(
        deleted === "group" ? "ask @Bob then please" : "ask then @Bob please",
        [expect.objectContaining(deleted === "group" ? bob : group)],
        expect.any(String),
      );
      const [text, mentions] = onSend.mock.calls[0]!;
      expect(
        resolveComposerSendPlan({ text, mentions, hasAttachments: false }).rerouteGroupId,
      ).toBe(deleted === "group" ? null : group.id);
    },
  );

  it.each(["bot", "group"])(
    "deleting a same-name %s card with Backspace removes only its occurrence",
    async (removed) => {
      const group: ComposerMention = { kind: "group", id: "group-bob", name: "Bob" };
      const onSend = vi.fn().mockResolvedValue(true);
      const textarea = renderComposer(onSend, { mentionTargets: [bob, group] });
      type(textarea, "ask @Bo");
      pressEnter(textarea);
      type(textarea, `${textarea.value}then @Bo`);
      act(() => container?.querySelectorAll<HTMLButtonElement>('[role="option"]')[1]?.click());
      const end = removed === "group" ? 18 : 8;
      nativeDelete(textarea, [end, end], [end - 1, end]);
      expect(textarea.value).toBe(removed === "group" ? "ask @Bob then  " : "ask  then @Bob ");
      pressEnter(textarea);
      await act(async () => {});
      expect(onSend).toHaveBeenCalledWith(
        removed === "group" ? "ask @Bob then" : "ask  then @Bob",
        [expect.objectContaining(removed === "group" ? bob : group)],
        expect.any(String),
      );
    },
  );

  it("keeps the correct identity after deleting the first of adjacent identical tokens", async () => {
    const group: ComposerMention = { kind: "group", id: "group-bob", name: "Bob" };
    const onSend = vi.fn().mockResolvedValue(true);
    const textarea = renderComposer(onSend, { mentionTargets: [bob, group] });
    type(textarea, "@Bo");
    pressEnter(textarea);
    type(textarea, `${textarea.value}@Bo`);
    act(() => container?.querySelectorAll<HTMLButtonElement>('[role="option"]')[1]?.click());
    act(() => {
      textarea.setSelectionRange(0, 5);
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    });
    type(textarea, "@Bob ");
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend).toHaveBeenCalledWith(
      "@Bob",
      [expect.objectContaining(group)],
      expect.any(String),
    );
    const [text, mentions] = onSend.mock.calls[0]!;
    expect(resolveComposerSendPlan({ text, mentions, hasAttachments: false }).shouldOpenGroup).toBe(
      true,
    );
  });

  it("restores occurrence identity after remounting a persisted draft", async () => {
    const group: ComposerMention = { kind: "group", id: "group-bob", name: "Bob" };
    const onSend = vi.fn().mockResolvedValue(true);
    let textarea = renderComposer(onSend, { mentionTargets: [bob, group] });
    type(textarea, "ask @Bo");
    pressEnter(textarea);
    type(textarea, `${textarea.value}then @Bo`);
    act(() => container?.querySelectorAll<HTMLButtonElement>('[role="option"]')[1]?.click());
    type(textarea, `${textarea.value}please`);
    act(() => root?.render(<Composer key="restored" {...composerProps} />));
    textarea = container!.querySelector("textarea")!;
    expect(textarea.value).toBe("ask @Bob then @Bob please");
    expect(container?.querySelectorAll('[data-testid="mention-chip"]')).toHaveLength(2);
    type(textarea, "ask @Bob then please");
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend).toHaveBeenCalledWith("ask @Bob then please", [bob], expect.any(String));
  });

  it("restores text and occurrence identity together after a refused send", async () => {
    const group: ComposerMention = { kind: "group", id: "group-bob", name: "Bob" };
    const onSend = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const textarea = renderComposer(onSend, { mentionTargets: [bob, group] });
    type(textarea, "ask @Bo");
    pressEnter(textarea);
    type(textarea, `${textarea.value}then @Bo`);
    act(() => container?.querySelectorAll<HTMLButtonElement>('[role="option"]')[1]?.click());
    type(textarea, `${textarea.value}please`);
    pressEnter(textarea);
    await act(async () => {});
    expect(textarea.value).toBe("ask @Bob then @Bob please");
    type(textarea, "ask @Bob then please");
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend.mock.calls[1]?.[1]).toEqual([bob]);
  });

  it("restores a legacy raw same-name draft without inventing either target identity", async () => {
    localStorage.setItem("rakazo.composerDraft.bot:bot-1", "@Bob ");
    const group: ComposerMention = { kind: "group", id: "group-bob", name: "Bob" };
    const onSend = vi.fn().mockResolvedValue(true);
    const textarea = renderComposer(onSend, { mentionTargets: [bob, group] });
    expect(textarea.value).toBe("@Bob ");
    expect(container?.querySelectorAll('[data-testid="mention-chip"]')).toHaveLength(0);
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend).toHaveBeenCalledWith("@Bob", [], expect.any(String));
  });

  it("sends only the bound group occurrence through cleanup after a skill prefix and whitespace trim", async () => {
    const group: ComposerMention = { kind: "group", id: "group-bob", name: "Bob" };
    const onSend = vi.fn().mockResolvedValue(true);
    const textarea = renderComposer(onSend, { mentionTargets: [bob, group] });
    type(textarea, "/sum");
    act(() =>
      container?.querySelector<HTMLButtonElement>('[aria-label="Skill summarize"]')?.click(),
    );
    type(textarea, "  ask @Bo");
    pressEnter(textarea);
    type(textarea, `${textarea.value}then @Bo`);
    act(() => container?.querySelectorAll<HTMLButtonElement>('[role="option"]')[1]?.click());
    type(textarea, `${textarea.value}please`);
    pressEnter(textarea);
    await act(async () => {});
    const [text, mentions] = onSend.mock.calls[0]!;
    expect(text).toBe("/summarize\nask @Bob then @Bob please");
    expect(resolveComposerSendPlan({ text, mentions, hasAttachments: false })).toMatchObject({
      trimmed: "/summarize\nask @Bob then please",
      rerouteGroupId: group.id,
      mentionPayload: [{ kind: "bot", id: bob.id }],
    });
  });

  it.each([false, true])(
    "keeps the keyboard mention selection when targets refresh (reorder: %s)",
    (reorder) => {
      const alice: ComposerMention = { kind: "bot", id: "bot-3", name: "Alice" };
      const textarea = renderComposer(vi.fn(), { mentionTargets: [alice, bob] });
      type(textarea, "@");
      act(() => {
        textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      });
      expect(container?.querySelector('[aria-selected="true"]')?.textContent).toContain("Bob");

      rerenderComposer({
        mentionTargets: reorder ? [{ ...bob }, { ...alice }] : [{ ...alice }, { ...bob }],
      });
      pressEnter(textarea);

      expect(container?.querySelector('[data-testid="mention-chip"]')?.textContent).toBe("@Bob");
      expect(container?.querySelector('[data-testid="mention-picker"]')).toBeNull();
    },
  );

  it("falls back to the first mention when the highlighted target disappears", () => {
    const alice: ComposerMention = { kind: "bot", id: "bot-3", name: "Alice" };
    const textarea = renderComposer(vi.fn(), { mentionTargets: [alice, bob] });
    type(textarea, "@");
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });

    rerenderComposer({ mentionTargets: [alice] });
    pressEnter(textarea);

    expect(container?.querySelector('[data-testid="mention-chip"]')?.textContent).toBe("@Alice");
  });

  it.each([false, true])(
    "draws an idle Send button with the primary disabled tokens (running: %s)",
    (running) => {
      renderComposer(vi.fn(), { running });
      const send = container?.querySelector<HTMLButtonElement>('button[aria-label="Send"]');
      expect(send?.disabled).toBe(true);
      expect(send?.className.split(" ")).toEqual(
        expect.arrayContaining([
          "bg-primary",
          "hover:bg-primary-hover",
          "disabled:bg-primary-disabled",
          "disabled:text-foreground/30",
          "disabled:opacity-100",
        ]),
      );
      expect(send?.className).not.toContain("disabled:opacity-50");
    },
  );

  it("clears the draft once the message is sent", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const textarea = renderComposer(onSend);
    type(textarea, "hello");
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend).toHaveBeenCalledWith("hello", [], expect.any(String));
    expect(textarea.value).toBe("");
  });

  it("keeps the draft cleared when the send callback rejects", async () => {
    const onSend = vi
      .fn()
      .mockRejectedValueOnce(new Error("unknown outcome"))
      .mockResolvedValue(true);
    const textarea = renderComposer(onSend);
    type(textarea, "@Bo");
    pressEnter(textarea);
    type(textarea, "hello");
    pressEnter(textarea);
    await act(async () => {});
    expect(textarea.value).toBe("");
    expect(container?.querySelector("[data-testid='mention-chip']")).toBeNull();
    type(textarea, "another message");
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend.mock.calls[1]?.[2]).not.toBe(onSend.mock.calls[0]?.[2]);
  });

  it("restores the draft and its mentions when the send fails", async () => {
    let finishSend = (_sent: boolean) => {};
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishSend = resolve;
        }),
    );
    const textarea = renderComposer(onSend);
    const mentionChips = () =>
      [...(container?.querySelectorAll("[data-testid='mention-chip']") ?? [])].map(
        (chip) => chip.textContent,
      );
    type(textarea, "@Bo");
    pressEnter(textarea);
    type(textarea, "@Bob hello");
    pressEnter(textarea);
    expect(onSend).toHaveBeenCalledWith("@Bob hello", [bob], expect.any(String));
    expect(textarea.value).toBe("");
    expect(mentionChips()).toEqual([]);
    await act(async () => finishSend(false));
    expect(textarea.value).toBe("@Bob hello");
    expect(mentionChips()).toEqual(["@Bob"]);
  });

  it("restores the chosen skill when the send fails", async () => {
    let finishSend = (_sent: boolean) => {};
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishSend = resolve;
        }),
    );
    const textarea = renderComposer(onSend);
    const skillChip = () => container?.querySelector("[data-testid='skill-chip']")?.textContent;
    type(textarea, "/sum");
    act(() =>
      container?.querySelector<HTMLButtonElement>("button[aria-label='Skill summarize']")?.click(),
    );
    type(textarea, "the notes");
    pressEnter(textarea);
    expect(onSend).toHaveBeenCalledWith("/summarize\nthe notes", [], expect.any(String));
    expect(skillChip()).toBeUndefined();
    await act(async () => finishSend(false));
    expect(textarea.value).toBe("the notes");
    expect(skillChip()).toBe("summarize");
  });

  it("keeps a newer draft when an earlier send fails", async () => {
    let finishSend = (_sent: boolean) => {};
    const textarea = renderComposer(
      () =>
        new Promise<boolean>((resolve) => {
          finishSend = resolve;
        }),
    );
    type(textarea, "hello");
    pressEnter(textarea);
    type(textarea, "newer");
    await act(async () => finishSend(false));
    expect(textarea.value).toBe("newer");
  });

  it("does not restore after a newer draft was typed then cleared while sending", async () => {
    let finishSend = (_sent: boolean) => {};
    const textarea = renderComposer(
      () =>
        new Promise<boolean>((resolve) => {
          finishSend = resolve;
        }),
    );
    type(textarea, "hello");
    pressEnter(textarea);
    type(textarea, "newer");
    type(textarea, "");
    await act(async () => finishSend(false));
    expect(textarea.value).toBe("");
  });

  it("reuses the nonce on an unchanged retry but renews it after an edit", async () => {
    const onSend = vi.fn().mockResolvedValue(false);
    const textarea = renderComposer(onSend);
    type(textarea, "hello");
    pressEnter(textarea);
    await act(async () => {});
    pressEnter(textarea);
    await act(async () => {});
    const firstNonce = onSend.mock.calls[0]?.[2];
    expect(firstNonce).toEqual(expect.any(String));
    expect(onSend.mock.calls[1]?.[2]).toBe(firstNonce);
    type(textarea, "hello edited");
    type(textarea, "hello");
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend.mock.calls[2]?.[2]).not.toBe(firstNonce);
  });

  it("does not restore after an attachment was picked while sending", async () => {
    let finishSend = (_sent: boolean) => {};
    const textarea = renderComposer(
      () =>
        new Promise<boolean>((resolve) => {
          finishSend = resolve;
        }),
    );
    type(textarea, "hello");
    pressEnter(textarea);
    pickAttachment();
    await act(async () => finishSend(false));
    expect(textarea.value).toBe("");
  });

  it("restores after a rejected attachment pick and preserves the nonce on rejected retry picks", async () => {
    let finishSend = (_sent: boolean) => {};
    const onSend = vi.fn<ComponentProps<typeof Composer>["onSend"]>(
      () =>
        new Promise<boolean>((resolve) => {
          finishSend = resolve;
        }),
    );
    const onAttachmentPick = vi.fn(() => false);
    const textarea = renderComposer(onSend, { onAttachmentPick });
    type(textarea, "hello");
    pressEnter(textarea);
    pickAttachment();
    await act(async () => finishSend(false));
    expect(textarea.value).toBe("hello");
    pickAttachment();
    pressEnter(textarea);
    await act(async () => finishSend(false));
    expect(onAttachmentPick).toHaveBeenCalledTimes(2);
    expect(onSend.mock.calls[1]?.[2]).toBe(onSend.mock.calls[0]?.[2]);
  });

  const reply: ThreadMessage = {
    id: "message-1",
    threadId: "thread-1",
    seq: 1,
    role: "bot",
    blocks: [{ kind: "text", text: "original reply" }],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const replyChanges = [
    { name: "cancelled reply", props: { replyTarget: null, replyQuote: null } },
    { name: "different reply", props: { replyTarget: { ...reply, id: "message-2" } } },
    { name: "different quote", props: { replyQuote: "different quote" } },
  ];

  it.each(replyChanges)("renews the retry nonce for a $name", async ({ props }) => {
    const onSend = vi.fn().mockResolvedValue(false);
    const textarea = renderComposer(onSend, { replyTarget: reply, replyQuote: "original" });
    type(textarea, "hello");
    pressEnter(textarea);
    await act(async () => {});
    rerenderComposer(props);
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend.mock.calls[1]?.[2]).not.toBe(onSend.mock.calls[0]?.[2]);
  });

  it.each(replyChanges)("does not restore after a $name while sending", async ({ props }) => {
    let finishSend = (_sent: boolean) => {};
    const textarea = renderComposer(
      () =>
        new Promise<boolean>((resolve) => {
          finishSend = resolve;
        }),
      { replyTarget: reply, replyQuote: "original" },
    );
    type(textarea, "hello");
    pressEnter(textarea);
    rerenderComposer(props);
    await act(async () => finishSend(false));
    expect(textarea.value).toBe("");
  });

  it("preserves the retry nonce when the reply object refreshes without changing its ID or quote", async () => {
    const onSend = vi.fn().mockResolvedValue(false);
    const textarea = renderComposer(onSend, { replyTarget: reply, replyQuote: "original" });
    type(textarea, "hello");
    pressEnter(textarea);
    await act(async () => {});
    rerenderComposer({ replyTarget: { ...reply } });
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend.mock.calls[1]?.[2]).toBe(onSend.mock.calls[0]?.[2]);
  });

  it("uses a fresh nonce for another message after a successful retry", async () => {
    const onSend = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const textarea = renderComposer(onSend);
    type(textarea, "hello");
    pressEnter(textarea);
    await act(async () => {});
    pressEnter(textarea);
    await act(async () => {});
    type(textarea, "hello");
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend.mock.calls[1]?.[2]).toBe(onSend.mock.calls[0]?.[2]);
    expect(onSend.mock.calls[2]?.[2]).not.toBe(onSend.mock.calls[0]?.[2]);
  });

  it("restores an unsent draft when the composer remounts", () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const draftKey = "bot:draft-restore-test";
    const first = renderComposer(onSend, { draftKey });
    type(first, "unsent thought");
    expect(window.localStorage.getItem(`rakazo.composerDraft.${draftKey}`)).toBe("unsent thought");
    act(() => root?.unmount());
    container?.remove();
    const second = renderComposer(onSend, { draftKey });
    expect(second.value).toBe("unsent thought");
  });

  it("keeps Enter as newline and Ctrl+Enter as send when enter-to-send is off", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const textarea = renderComposer(onSend, {
      draftKey: "bot:enter-toggle-test",
      enterToSend: false,
    });
    expect(container?.querySelector('[data-testid="composer-enter-to-send-toggle"]')).toBeNull();
    type(textarea, "line one");
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend).not.toHaveBeenCalled();
    act(() => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
      );
    });
    await act(async () => {});
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});

it.each([true, false])(
  "keeps a pending draft recoverable across unmount (accepted: %s)",
  async (accepted) => {
    let finishSend = (_accepted: boolean) => {};
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishSend = resolve;
        }),
    );
    const draftKey = "bot:pending-draft";
    const textarea = renderComposer(onSend, { draftKey });
    type(textarea, "pending text");
    pressEnter(textarea);
    expect(textarea.value).toBe("");
    expect(localStorage.getItem(`rakazo.composerDraft.${draftKey}`)).toBe("pending text");
    act(() => root?.unmount());
    container?.remove();
    await act(async () => finishSend(accepted));
    const restored = renderComposer(vi.fn(), { draftKey });
    expect(restored.value).toBe(accepted ? "" : "pending text");
  },
);

it.each([true, false])(
  "preserves newer stored edits when a send settles (accepted: %s)",
  async (accepted) => {
    let finishSend = (_accepted: boolean) => {};
    const textarea = renderComposer(
      () =>
        new Promise<boolean>((resolve) => {
          finishSend = resolve;
        }),
    );
    type(textarea, "submitted text");
    pressEnter(textarea);
    type(textarea, "newer text");
    await act(async () => finishSend(accepted));
    expect(textarea.value).toBe("newer text");
    expect(localStorage.getItem("rakazo.composerDraft.bot:bot-1")).toBe("newer text");
  },
);

it.each([true, false])(
  "settles a submission after returning to its thread (accepted: %s)",
  async (accepted) => {
    let finishSend = (_accepted: boolean) => {};
    const draftKey = "bot:return-before-settle";
    const first = renderComposer(
      () =>
        new Promise<boolean>((resolve) => {
          finishSend = resolve;
        }),
      { draftKey },
    );
    type(first, "submitted text");
    pressEnter(first);
    act(() => root?.unmount());
    container?.remove();
    const returned = renderComposer(vi.fn(), { draftKey });
    expect(returned.value).toBe("submitted text");
    await act(async () => finishSend(accepted));
    expect(returned.value).toBe(accepted ? "" : "submitted text");
    expect(localStorage.getItem(`rakazo.composerDraft.${draftKey}`)).toBe(
      accepted ? null : "submitted text",
    );
  },
);

it("preserves edits made after returning, even when the text matches the submission", async () => {
  let finishSend = (_accepted: boolean) => {};
  const draftKey = "bot:identical-newer-edit";
  const first = renderComposer(
    () =>
      new Promise<boolean>((resolve) => {
        finishSend = resolve;
      }),
    { draftKey },
  );
  type(first, "submitted text");
  pressEnter(first);
  act(() => root?.unmount());
  container?.remove();
  const returned = renderComposer(vi.fn(), { draftKey });
  type(returned, "edited text");
  type(returned, "submitted text");
  await act(async () => finishSend(true));
  expect(returned.value).toBe("submitted text");
  expect(localStorage.getItem(`rakazo.composerDraft.${draftKey}`)).toBe("submitted text");
});

it("clears accepted saved text when only an attachment was picked during the send", async () => {
  let finishSend = (_accepted: boolean) => {};
  const textarea = renderComposer(
    () =>
      new Promise<boolean>((resolve) => {
        finishSend = resolve;
      }),
  );
  type(textarea, "submitted text");
  pressEnter(textarea);
  pickAttachment();
  await act(async () => finishSend(true));
  expect(textarea.value).toBe("");
  expect(localStorage.getItem("rakazo.composerDraft.bot:bot-1")).toBeNull();
});

it.each([false, true])(
  "sends dictation at once and keeps a draft typed during its failing send (throws=%s)",
  async (throws) => {
    let finish!: (value: boolean) => void;
    let fail!: (error: Error) => void;
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        }),
    );
    let onFinal!: (text: string) => void;
    const listen = vi.spyOn(dictation, "listen").mockImplementation(async (options) => {
      onFinal = options.onFinal;
    });
    try {
      const textarea = renderComposer(onSend, { phoneCallsEnabled: true });
      const mic = container?.querySelector<HTMLButtonElement>('button[aria-label="Hold to talk"]');
      expect(mic).not.toBeNull();
      act(() => mic?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
      act(() => onFinal("dictated words"));
      await act(async () => {});
      // The words went out alone, as a typed send of the same draft would.
      expect(onSend).toHaveBeenCalledWith("dictated words", [], expect.any(String));
      expect(textarea.value).toBe("");
      type(textarea, "typed draft");
      await act(async () => {
        if (throws) fail(new Error("offline"));
        else finish(false);
      });
      // The draft the user typed while the send was in flight stays theirs alone.
      expect(textarea.value).toBe("typed draft");
      expect(localStorage.getItem("rakazo.composerDraft.bot:bot-1")).toBe("typed draft");
    } finally {
      listen.mockRestore();
    }
  },
);

it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])(
  "ignores a late dictation failure after remount (throws=%s, different chat=%s)",
  async (throws, differentChat) => {
    let finish!: (accepted: boolean) => void;
    let fail!: (error: Error) => void;
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        }),
    );
    let onFinal!: (text: string) => void;
    const listen = vi.spyOn(dictation, "listen").mockImplementation(async (options) => {
      onFinal = options.onFinal;
    });
    try {
      const original = renderComposer(onSend, { phoneCallsEnabled: true });
      const mic = container?.querySelector<HTMLButtonElement>('button[aria-label="Hold to talk"]');
      act(() => mic?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
      act(() => onFinal("late dictation"));
      type(original, "original draft");
      act(() => root?.unmount());
      container?.remove();
      const draftKey = differentChat ? "bot:other-bot" : "bot:bot-1";
      const returned = renderComposer(vi.fn(), { draftKey });
      type(returned, "@Bo");
      pressEnter(returned);
      type(returned, "@Bob newer draft");
      const saved = localStorage.getItem(`rakazo.composerDraft.${draftKey}`);
      const bindings = localStorage.getItem(`rakazo.composerBindings.${draftKey}`);
      await act(async () => {
        if (throws) fail(new Error("offline"));
        else finish(false);
      });
      expect(returned.value).toBe("@Bob newer draft");
      expect(localStorage.getItem(`rakazo.composerDraft.${draftKey}`)).toBe(saved);
      expect(localStorage.getItem(`rakazo.composerBindings.${draftKey}`)).toBe(bindings);
      if (differentChat)
        expect(localStorage.getItem("rakazo.composerDraft.bot:bot-1")).toBe("original draft");
      act(() => root?.unmount());
      container?.remove();
      const reloaded = renderComposer(vi.fn(), { draftKey });
      expect(reloaded.value).toBe("@Bob newer draft");
      expect(container?.querySelectorAll('[data-testid="mention-chip"]')).toHaveLength(1);
    } finally {
      listen.mockRestore();
    }
  },
);

it("restores dictation to the previous chat after switching draft keys", async () => {
  let finish!: (accepted: boolean) => void;
  let onFinal!: (text: string) => void;
  const listen = vi.spyOn(dictation, "listen").mockImplementation(async (options) => {
    onFinal = options.onFinal;
  });
  try {
    const textarea = renderComposer(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
      {
        phoneCallsEnabled: true,
      },
    );
    const mic = container?.querySelector<HTMLButtonElement>('button[aria-label="Hold to talk"]');
    act(() => mic?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
    act(() => onFinal("late dictation"));
    rerenderComposer({ draftKey: "bot:other-bot" });
    type(textarea, "newer draft");
    await act(async () => finish(false));
    expect(textarea.value).toBe("newer draft");
    expect(localStorage.getItem("rakazo.composerDraft.bot:other-bot")).toBe("newer draft");
    expect(localStorage.getItem("rakazo.composerDraft.bot:bot-1")).toBe("late dictation");
  } finally {
    listen.mockRestore();
  }
});

it("keeps a dictation still being transcribed in the chat it was recorded in", async () => {
  const onSend = vi.fn(async () => true);
  let onFinal!: (text: string) => void;
  const listen = vi.spyOn(dictation, "listen").mockImplementation(async (options) => {
    onFinal = options.onFinal;
  });
  const stop = vi.spyOn(dictation, "stop");
  const state = vi
    .spyOn(dictation, "state", "get")
    .mockReturnValue({ status: "transcribing", transcript: "" });
  try {
    renderComposer(onSend, { phoneCallsEnabled: true });
    localStorage.setItem("rakazo.composerDraft.bot:bot-1", "earlier draft");
    const mic = container?.querySelector<HTMLButtonElement>('button[aria-label="Hold to talk"]');
    act(() => mic?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
    // The user opens another chat while the recording is on its way to the server.
    act(() => root?.render(<Composer {...composerProps} key="bot:bot-2" draftKey="bot:bot-2" />));
    expect(stop).not.toHaveBeenCalledWith("cancel");
    act(() => onFinal("and a hotel"));
    await act(async () => {});
    expect(onSend).not.toHaveBeenCalled();
    expect(localStorage.getItem("rakazo.composerDraft.bot:bot-1")).toBe(
      "earlier draft and a hotel",
    );
    expect(localStorage.getItem("rakazo.composerDraft.bot:bot-2")).toBeNull();
  } finally {
    state.mockRestore();
    stop.mockRestore();
    listen.mockRestore();
  }
});

it("shows late dictated words in the chat's composer when the user came back first", async () => {
  let onFinal!: (text: string) => void;
  const listen = vi.spyOn(dictation, "listen").mockImplementation(async (options) => {
    onFinal = options.onFinal;
  });
  const state = vi
    .spyOn(dictation, "state", "get")
    .mockReturnValue({ status: "transcribing", transcript: "" });
  try {
    renderComposer(
      vi.fn(async () => true),
      { phoneCallsEnabled: true },
    );
    const mic = container?.querySelector<HTMLButtonElement>('button[aria-label="Hold to talk"]');
    act(() => mic?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
    act(() => root?.render(<Composer {...composerProps} key="bot:bot-2" draftKey="bot:bot-2" />));
    act(() => root?.render(<Composer {...composerProps} key="bot:bot-1:again" />));
    const returned = container?.querySelector("textarea");
    if (!returned) throw new Error("composer textarea not found");
    act(() => onFinal("and a hotel"));
    await act(async () => {});
    expect(returned.value).toBe("and a hotel");
    // The next edit keeps the words instead of writing over them.
    type(returned, "and a hotel please");
    expect(localStorage.getItem("rakazo.composerDraft.bot:bot-1")).toBe("and a hotel please");
  } finally {
    state.mockRestore();
    listen.mockRestore();
  }
});

it("keeps only the late dictated words once the earlier send is accepted", async () => {
  let finish!: (accepted: boolean) => void;
  const onSend = vi.fn(
    (_text: string) =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  let onFinal!: (text: string) => void;
  const listen = vi.spyOn(dictation, "listen").mockImplementation(async (options) => {
    onFinal = options.onFinal;
  });
  const state = vi
    .spyOn(dictation, "state", "get")
    .mockReturnValue({ status: "transcribing", transcript: "" });
  try {
    const textarea = renderComposer(onSend, { phoneCallsEnabled: true });
    type(textarea, "already sent");
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend).toHaveBeenCalledTimes(1);
    const mic = container?.querySelector<HTMLButtonElement>('button[aria-label="Hold to talk"]');
    act(() => mic?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
    act(() => root?.render(<Composer {...composerProps} key="bot:bot-2" draftKey="bot:bot-2" />));
    act(() => onFinal("new words"));
    await act(async () => finish(true));
    expect(localStorage.getItem("rakazo.composerDraft.bot:bot-1")).toBe("new words");
  } finally {
    state.mockRestore();
    listen.mockRestore();
  }
});

it("keeps the failed send's text with the late dictated words", async () => {
  let finish!: (accepted: boolean) => void;
  const onSend = vi.fn(
    (_text: string) =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  let onFinal!: (text: string) => void;
  const listen = vi.spyOn(dictation, "listen").mockImplementation(async (options) => {
    onFinal = options.onFinal;
  });
  const state = vi
    .spyOn(dictation, "state", "get")
    .mockReturnValue({ status: "transcribing", transcript: "" });
  try {
    const textarea = renderComposer(onSend, { phoneCallsEnabled: true });
    type(textarea, "not sent");
    pressEnter(textarea);
    await act(async () => {});
    const mic = container?.querySelector<HTMLButtonElement>('button[aria-label="Hold to talk"]');
    act(() => mic?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
    act(() => root?.render(<Composer {...composerProps} key="bot:bot-2" draftKey="bot:bot-2" />));
    act(() => onFinal("new words"));
    await act(async () => finish(false));
    expect(localStorage.getItem("rakazo.composerDraft.bot:bot-1")).toBe("not sent new words");
  } finally {
    state.mockRestore();
    listen.mockRestore();
  }
});

it("keeps late dictated words that landed during a send that then fails", async () => {
  let finish!: (accepted: boolean) => void;
  const onSend = vi.fn(
    (_text: string) =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  let onFinal!: (text: string) => void;
  const listen = vi.spyOn(dictation, "listen").mockImplementation(async (options) => {
    onFinal = options.onFinal;
  });
  const state = vi
    .spyOn(dictation, "state", "get")
    .mockReturnValue({ status: "transcribing", transcript: "" });
  try {
    renderComposer(onSend, { phoneCallsEnabled: true });
    const mic = container?.querySelector<HTMLButtonElement>('button[aria-label="Hold to talk"]');
    act(() => mic?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
    act(() => root?.render(<Composer {...composerProps} key="bot:bot-2" draftKey="bot:bot-2" />));
    act(() => root?.render(<Composer {...composerProps} key="bot:bot-1:again" />));
    const returned = container?.querySelector("textarea");
    if (!returned) throw new Error("composer textarea not found");
    type(returned, "not sent");
    pressEnter(returned);
    await act(async () => {});
    expect(onSend).toHaveBeenCalledTimes(1);
    act(() => onFinal("new words"));
    expect(returned.value).toBe("not sent new words");
    await act(async () => finish(false));
    expect(returned.value).toBe("not sent new words");
    type(returned, "not sent new words please");
    expect(localStorage.getItem("rakazo.composerDraft.bot:bot-1")).toBe(
      "not sent new words please",
    );
  } finally {
    state.mockRestore();
    listen.mockRestore();
  }
});

it("still cancels a recording that is listening when the chat changes", () => {
  const listen = vi.spyOn(dictation, "listen").mockImplementation(async () => {});
  const stop = vi.spyOn(dictation, "stop");
  try {
    renderComposer(vi.fn(), { phoneCallsEnabled: true });
    const mic = container?.querySelector<HTMLButtonElement>('button[aria-label="Hold to talk"]');
    act(() => mic?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
    act(() => root?.render(<Composer {...composerProps} key="bot:bot-2" draftKey="bot:bot-2" />));
    expect(stop).toHaveBeenCalledWith("cancel");
  } finally {
    stop.mockRestore();
    listen.mockRestore();
  }
});

it("retries an unchanged dictation with the same nonce after a failed send", async () => {
  const nonces: string[] = [];
  const onSend = vi.fn(async (_text: string, _mentions: unknown[], clientNonce: string) => {
    nonces.push(clientNonce);
    return false;
  });
  let onFinal!: (text: string) => void;
  const listen = vi.spyOn(dictation, "listen").mockImplementation(async (options) => {
    onFinal = options.onFinal;
  });
  try {
    const textarea = renderComposer(onSend, { phoneCallsEnabled: true });
    const mic = container?.querySelector<HTMLButtonElement>('button[aria-label="Hold to talk"]');
    act(() => mic?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
    act(() => onFinal("create the task"));
    await act(async () => {});
    expect(textarea.value).toBe("create the task");
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(nonces[1]).toBe(nonces[0]);
  } finally {
    listen.mockRestore();
  }
});

it("does not retry a changed payload with a dictation's nonce", async () => {
  const nonces: string[] = [];
  let finish!: (accepted: boolean) => void;
  const onSend = vi.fn((_text: string, _mentions: unknown[], clientNonce: string) => {
    nonces.push(clientNonce);
    return new Promise<boolean>((resolve) => {
      finish = resolve;
    });
  });
  let onFinal!: (text: string) => void;
  const listen = vi.spyOn(dictation, "listen").mockImplementation(async (options) => {
    onFinal = options.onFinal;
  });
  try {
    const textarea = renderComposer(onSend, { phoneCallsEnabled: true });
    const mic = container?.querySelector<HTMLButtonElement>('button[aria-label="Hold to talk"]');
    act(() => mic?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
    act(() => onFinal("create the task"));
    await act(async () => {});
    // Arming a reply while the send is in flight changes the payload; the
    // failure must not bring the retired nonce back for the retry.
    rerenderComposer({
      replyTarget: { id: "m-9", blocks: [] } as unknown as ThreadMessage,
    });
    await act(async () => {});
    finish(false);
    await act(async () => {});
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend).toHaveBeenCalled();
    expect(new Set(nonces).size).toBe(nonces.length);
    expect(localStorage.getItem("rakazo.composerDraft.bot:bot-1")).toBe("create the task");
  } finally {
    listen.mockRestore();
  }
});

it.each([
  ["an attachment pick", "create the task"],
  ["a skill selection", "/summarize\ncreate the task"],
])("does not retry a failed dictation with its nonce after %s", async (change, retried) => {
  const nonces: string[] = [];
  const onSend = vi.fn(async (_text: string, _mentions: unknown[], clientNonce: string) => {
    nonces.push(clientNonce);
    return false;
  });
  let onFinal!: (text: string) => void;
  const listen = vi.spyOn(dictation, "listen").mockImplementation(async (options) => {
    onFinal = options.onFinal;
  });
  try {
    const textarea = renderComposer(onSend, { phoneCallsEnabled: true });
    const mic = container?.querySelector<HTMLButtonElement>('button[aria-label="Hold to talk"]');
    act(() => mic?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
    act(() => onFinal("create the task"));
    await act(async () => {});
    expect(textarea.value).toBe("create the task");
    if (change === "an attachment pick") {
      pickAttachment();
      rerenderComposer({
        pendingAttachments: [
          { id: "a-1", threadKey: "bot:bot-1", file: new File(["notes"], "notes.txt") },
        ],
      });
    } else {
      type(textarea, "/sum");
      act(() =>
        container
          ?.querySelector<HTMLButtonElement>("button[aria-label='Skill summarize']")
          ?.click(),
      );
      type(textarea, "create the task");
    }
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend.mock.calls[1]?.[0]).toBe(retried);
    expect(nonces[1]).not.toBe(nonces[0]);
  } finally {
    listen.mockRestore();
  }
});

it.each(["a typed draft", "a chosen skill", "a pending attachment"])(
  "leaves a dictation over %s in the field to review",
  async (content) => {
    const onSend = vi.fn().mockResolvedValue(true);
    let onFinal!: (text: string) => void;
    const listen = vi.spyOn(dictation, "listen").mockImplementation(async (options) => {
      onFinal = options.onFinal;
    });
    try {
      const textarea = renderComposer(onSend, {
        phoneCallsEnabled: true,
        pendingAttachments:
          content === "a pending attachment"
            ? [{ id: "a-1", threadKey: "bot:bot-1", file: new File(["notes"], "notes.txt") }]
            : [],
      });
      if (content === "a chosen skill") {
        type(textarea, "/sum");
        act(() =>
          container
            ?.querySelector<HTMLButtonElement>("button[aria-label='Skill summarize']")
            ?.click(),
        );
      }
      const mic = container?.querySelector<HTMLButtonElement>('button[aria-label="Hold to talk"]');
      act(() => mic?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
      // The draft is already there when the words arrive.
      if (content === "a typed draft") type(textarea, "half typed");
      act(() => onFinal("dictated words"));
      await act(async () => {});
      const expected = content === "a typed draft" ? "half typed dictated words" : "dictated words";
      expect(onSend).not.toHaveBeenCalled();
      expect(textarea.value).toBe(expected);
      expect(localStorage.getItem("rakazo.composerDraft.bot:bot-1")).toBe(expected);
      if (content === "a chosen skill")
        expect(container?.querySelector("[data-testid='skill-chip']")?.textContent).toBe(
          "summarize",
        );
    } finally {
      listen.mockRestore();
    }
  },
);

it("keeps a reply-linked dictation's words without its nonce", async () => {
  const nonces: string[] = [];
  let fail!: (error: Error) => void;
  const onSend = vi.fn((_text: string, _mentions: unknown[], clientNonce: string) => {
    nonces.push(clientNonce);
    return new Promise<boolean>((_resolve, reject) => {
      fail = reject;
    });
  });
  let onFinal!: (text: string) => void;
  const listen = vi.spyOn(dictation, "listen").mockImplementation(async (options) => {
    onFinal = options.onFinal;
  });
  try {
    renderComposer(onSend, {
      phoneCallsEnabled: true,
      replyTarget: { id: "m-9", blocks: [] } as unknown as ThreadMessage,
    });
    const mic = container?.querySelector<HTMLButtonElement>('button[aria-label="Hold to talk"]');
    act(() => mic?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
    act(() => onFinal("spoken words"));
    await act(async () => {});
    // Leaving during the send drops the armed reply; the answer never arrives.
    act(() => root?.unmount());
    container?.remove();
    await act(async () => {
      fail(new Error("offline"));
    });
    expect(localStorage.getItem("rakazo.composerDraft.bot:bot-1")).toBe("spoken words");
    expect(localStorage.getItem("rakazo.composerNonce.bot:bot-1")).toBeNull();
    const reopened = renderComposer(
      vi.fn(async (_text: string, _mentions: unknown[], clientNonce: string) => {
        nonces.push(clientNonce);
        return true;
      }),
    );
    expect(reopened.value).toBe("spoken words");
    pressEnter(reopened);
    await act(async () => {});
    // The retry cannot rebuild the reply the original carried, so it must not
    // reuse the original nonce: a committed first send would swallow it.
    expect(nonces[1]).not.toBe(nonces[0]);
  } finally {
    listen.mockRestore();
  }
});

it("reuses the stored nonce when a send that lost its answer is retried from the saved draft", async () => {
  const nonces: string[] = [];
  let fail!: (error: Error) => void;
  const onSend = vi.fn((_text: string, _mentions: unknown[], clientNonce: string) => {
    nonces.push(clientNonce);
    return new Promise<boolean>((_resolve, reject) => {
      fail = reject;
    });
  });
  let onFinal!: (text: string) => void;
  const listen = vi.spyOn(dictation, "listen").mockImplementation(async (options) => {
    onFinal = options.onFinal;
  });
  try {
    renderComposer(onSend, { phoneCallsEnabled: true });
    const mic = container?.querySelector<HTMLButtonElement>('button[aria-label="Hold to talk"]');
    act(() => mic?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
    act(() => onFinal("spoken words"));
    await act(async () => {});
    // The chat closes before the server's answer, which then never arrives.
    act(() => root?.unmount());
    container?.remove();
    await act(async () => {
      fail(new Error("offline"));
    });
    expect(localStorage.getItem("rakazo.composerDraft.bot:bot-1")).toBe("spoken words");
    expect(localStorage.getItem("rakazo.composerNonce.bot:bot-1")).toBe(nonces[0]);
    const reopened = renderComposer(
      vi.fn(async (_text: string, _mentions: unknown[], clientNonce: string) => {
        nonces.push(clientNonce);
        return true;
      }),
    );
    expect(reopened.value).toBe("spoken words");
    pressEnter(reopened);
    await act(async () => {});
    expect(nonces[1]).toBe(nonces[0]);
  } finally {
    listen.mockRestore();
  }
});

it("recovers a dictation in a chat reopened before the send settles", async () => {
  const nonces: string[] = [];
  let fail!: (error: Error) => void;
  const onSend = vi.fn((_text: string, _mentions: unknown[], clientNonce: string) => {
    nonces.push(clientNonce);
    return new Promise<boolean>((_resolve, reject) => {
      fail = reject;
    });
  });
  let onFinal!: (text: string) => void;
  const listen = vi.spyOn(dictation, "listen").mockImplementation(async (options) => {
    onFinal = options.onFinal;
  });
  try {
    renderComposer(onSend, { phoneCallsEnabled: true });
    const mic = container?.querySelector<HTMLButtonElement>('button[aria-label="Hold to talk"]');
    act(() => mic?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
    act(() => onFinal("spoken words"));
    await act(async () => {});
    act(() => root?.unmount());
    container?.remove();
    // The chat reopens before the failed request settles: the words are already
    // in the saved draft, and the retry still carries the original nonce.
    const reopened = renderComposer(
      vi.fn(async (_text: string, _mentions: unknown[], clientNonce: string) => {
        nonces.push(clientNonce);
        return true;
      }),
    );
    expect(reopened.value).toBe("spoken words");
    await act(async () => {
      fail(new Error("offline"));
    });
    expect(localStorage.getItem("rakazo.composerNonce.bot:bot-1")).toBe(nonces[0]);
    pressEnter(reopened);
    await act(async () => {});
    expect(nonces[1]).toBe(nonces[0]);
  } finally {
    listen.mockRestore();
  }
});

it("sends a dictation that finishes while an earlier send is in flight", async () => {
  let finish!: (accepted: boolean) => void;
  const onSend = vi.fn(
    (_text: string) =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  let onFinal!: (text: string) => void;
  const listen = vi.spyOn(dictation, "listen").mockImplementation(async (options) => {
    onFinal = options.onFinal;
  });
  try {
    renderComposer(onSend, { phoneCallsEnabled: true });
    const mic = container?.querySelector<HTMLButtonElement>('button[aria-label="Hold to talk"]');
    act(() => mic?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
    act(() => onFinal("first words"));
    await act(async () => {});
    rerenderComposer({ sending: true });
    act(() => onFinal("second words"));
    await act(async () => {});
    expect(onSend).toHaveBeenCalledTimes(1);
    await act(async () => finish(true));
    rerenderComposer({ sending: false });
    await act(async () => {});
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend.mock.calls[1]?.[0]).toBe("second words");
  } finally {
    listen.mockRestore();
  }
});

it("keeps a dictation queued behind a send that fails with that send's words", async () => {
  let finish!: (accepted: boolean) => void;
  const onSend = vi.fn(
    (_text: string) =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  let onFinal!: (text: string) => void;
  const listen = vi.spyOn(dictation, "listen").mockImplementation(async (options) => {
    onFinal = options.onFinal;
  });
  try {
    const textarea = renderComposer(onSend, { phoneCallsEnabled: true });
    const mic = container?.querySelector<HTMLButtonElement>('button[aria-label="Hold to talk"]');
    act(() => mic?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
    act(() => onFinal("please book the flight"));
    await act(async () => {});
    rerenderComposer({ sending: true });
    act(() => onFinal("and a hotel"));
    await act(async () => {});
    expect(onSend).toHaveBeenCalledTimes(1);
    // The first send fails; the dictation queued behind it must not go out alone.
    await act(async () => finish(false));
    rerenderComposer({ sending: false });
    await act(async () => {});
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(textarea.value).toBe("please book the flight and a hotel");
    expect(localStorage.getItem("rakazo.composerDraft.bot:bot-1")).toBe(
      "please book the flight and a hotel",
    );
  } finally {
    listen.mockRestore();
  }
});

it("keeps a newer draft typed after returning to the chat when the queued send fails", async () => {
  let finish!: (accepted: boolean) => void;
  const onSend = vi.fn(
    (_text: string) =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  let onFinal!: (text: string) => void;
  const listen = vi.spyOn(dictation, "listen").mockImplementation(async (options) => {
    onFinal = options.onFinal;
  });
  try {
    renderComposer(onSend, { phoneCallsEnabled: true });
    const mic = container?.querySelector<HTMLButtonElement>('button[aria-label="Hold to talk"]');
    act(() => mic?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
    act(() => onFinal("please book the flight"));
    await act(async () => {});
    rerenderComposer({ sending: true });
    act(() => onFinal("and a hotel"));
    await act(async () => {});
    // The user leaves the chat, comes back and types a newer draft before the send fails.
    act(() => root?.render(<Composer {...composerProps} key="bot:bot-2" draftKey="bot:bot-2" />));
    act(() => root?.render(<Composer {...composerProps} key="bot:bot-1:again" />));
    const returned = container?.querySelector("textarea");
    if (!returned) throw new Error("composer textarea not found");
    type(returned, "newer draft");
    await act(async () => finish(false));

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(returned.value).toBe("newer draft");
    expect(localStorage.getItem("rakazo.composerDraft.bot:bot-1")).toBe("newer draft");
  } finally {
    listen.mockRestore();
  }
});

it("recovers a queued dictation's failed send for a chat that was left and not edited", async () => {
  let finish!: (accepted: boolean) => void;
  const onSend = vi.fn(
    (_text: string) =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  let onFinal!: (text: string) => void;
  const listen = vi.spyOn(dictation, "listen").mockImplementation(async (options) => {
    onFinal = options.onFinal;
  });
  try {
    renderComposer(onSend, { phoneCallsEnabled: true });
    const mic = container?.querySelector<HTMLButtonElement>('button[aria-label="Hold to talk"]');
    act(() => mic?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
    act(() => onFinal("please book the flight"));
    await act(async () => {});
    rerenderComposer({ sending: true });
    act(() => onFinal("and a hotel"));
    await act(async () => {});
    act(() => root?.render(<Composer {...composerProps} key="bot:bot-2" draftKey="bot:bot-2" />));
    // The user comes back without editing; the open field follows the recovered draft.
    act(() => root?.render(<Composer {...composerProps} key="bot:bot-1:again" sending={false} />));
    const returned = container?.querySelector("textarea");
    if (!returned) throw new Error("composer textarea not found");
    expect(returned.value).toBe("and a hotel");
    await act(async () => finish(false));

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(returned.value).toBe("please book the flight and a hotel");
    type(returned, "please book the flight and a hotel tonight");
    expect(localStorage.getItem("rakazo.composerDraft.bot:bot-1")).toBe(
      "please book the flight and a hotel tonight",
    );
  } finally {
    listen.mockRestore();
  }
});

it("keeps a mention bound after reopening the chat when the queued send fails", async () => {
  let finish!: (accepted: boolean) => void;
  const onSend = vi.fn(
    (_text: string) =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  let onFinal!: (text: string) => void;
  const listen = vi.spyOn(dictation, "listen").mockImplementation(async (options) => {
    onFinal = options.onFinal;
  });
  try {
    renderComposer(onSend, { phoneCallsEnabled: true });
    const mic = container?.querySelector<HTMLButtonElement>('button[aria-label="Hold to talk"]');
    act(() => mic?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
    act(() => onFinal("please book the flight"));
    await act(async () => {});
    rerenderComposer({ sending: true });
    act(() => onFinal("@Bob"));
    await act(async () => {});
    act(() => root?.render(<Composer {...composerProps} key="bot:bot-2" draftKey="bot:bot-2" />));
    act(() => root?.render(<Composer {...composerProps} key="bot:bot-1:again" sending={false} />));
    const returned = container?.querySelector("textarea");
    if (!returned) throw new Error("composer textarea not found");
    // The user binds the dictated name to Bob through the picker, keeping its spelling.
    type(returned, "@Bo");
    pressEnter(returned);
    type(returned, "@Bob");
    expect(container?.querySelectorAll('[data-testid="mention-chip"]')).toHaveLength(1);
    const saved = localStorage.getItem("rakazo.composerDraft.bot:bot-1");
    const bindings = localStorage.getItem("rakazo.composerBindings.bot:bot-1");
    expect(saved).toBe("@Bob");
    expect(bindings).not.toBeNull();

    await act(async () => finish(false));
    expect(localStorage.getItem("rakazo.composerDraft.bot:bot-1")).toBe(saved);
    expect(localStorage.getItem("rakazo.composerBindings.bot:bot-1")).toBe(bindings);
    expect(container?.querySelectorAll('[data-testid="mention-chip"]')).toHaveLength(1);
  } finally {
    listen.mockRestore();
  }
});

it("does not auto-send a draft typed over a dictation queued behind an earlier send", async () => {
  let finish!: (accepted: boolean) => void;
  const onSend = vi.fn(
    (_text: string) =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  let onFinal!: (text: string) => void;
  const listen = vi.spyOn(dictation, "listen").mockImplementation(async (options) => {
    onFinal = options.onFinal;
  });
  try {
    const textarea = renderComposer(onSend, { phoneCallsEnabled: true });
    const mic = container?.querySelector<HTMLButtonElement>('button[aria-label="Hold to talk"]');
    act(() => mic?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
    act(() => onFinal("first words"));
    await act(async () => {});
    rerenderComposer({ sending: true });
    act(() => onFinal("second words"));
    await act(async () => {});
    type(textarea, "half typed");
    await act(async () => finish(true));
    rerenderComposer({ sending: false });
    await act(async () => {});
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(textarea.value).toBe("half typed");
  } finally {
    listen.mockRestore();
  }
});

it("does not auto-send a queued dictation when a reply arms as the earlier send settles", async () => {
  let finish!: (accepted: boolean) => void;
  const onSend = vi.fn(
    (_text: string) =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  let onFinal!: (text: string) => void;
  const listen = vi.spyOn(dictation, "listen").mockImplementation(async (options) => {
    onFinal = options.onFinal;
  });
  try {
    renderComposer(onSend, { phoneCallsEnabled: true });
    const mic = container?.querySelector<HTMLButtonElement>('button[aria-label="Hold to talk"]');
    act(() => mic?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
    act(() => onFinal("first words"));
    await act(async () => {});
    rerenderComposer({ sending: true });
    act(() => onFinal("second words"));
    await act(async () => {});
    await act(async () => finish(true));
    // The reply and the end of the earlier send land in one commit.
    rerenderComposer({
      sending: false,
      replyTarget: { id: "m-9", blocks: [] } as unknown as ThreadMessage,
    });
    await act(async () => {});
    expect(onSend).toHaveBeenCalledTimes(1);
  } finally {
    listen.mockRestore();
  }
});

it("does not auto-send a queued dictation into a page opened before the earlier send settles", async () => {
  let finish!: (accepted: boolean) => void;
  const onSend = vi.fn(
    (_text: string) =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  let onFinal!: (text: string) => void;
  const listen = vi.spyOn(dictation, "listen").mockImplementation(async (options) => {
    onFinal = options.onFinal;
  });
  try {
    renderComposer(onSend, { phoneCallsEnabled: true });
    const session = createPageSession();
    const renderInChat = (overrides: Partial<ComponentProps<typeof Composer>>) => {
      composerProps = { ...composerProps, ...overrides };
      act(() =>
        root?.render(
          <PagesProvider value={{ open: () => {}, session }}>
            <Composer {...composerProps} />
          </PagesProvider>,
        ),
      );
    };
    renderInChat({});
    const mic = container?.querySelector<HTMLButtonElement>('button[aria-label="Hold to talk"]');
    act(() => mic?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
    act(() => onFinal("first words"));
    await act(async () => {});
    renderInChat({ sending: true });
    act(() => onFinal("second words"));
    await act(async () => {});
    act(() => session.dock.set({ page: { id: "page-1", title: "Plan" } }));
    await act(async () => finish(true));
    renderInChat({ sending: false });
    await act(async () => {});
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(container?.querySelector("textarea")?.value).toBe("second words");
  } finally {
    listen.mockRestore();
  }
});

it("does not keep the nonce when a reopened chat rebinds the same mention text", async () => {
  const nonces: string[] = [];
  let fail!: (error: Error) => void;
  const onSend = vi.fn((_text: string, _mentions: unknown[], clientNonce: string) => {
    nonces.push(clientNonce);
    return new Promise<boolean>((_resolve, reject) => {
      fail = reject;
    });
  });
  const textarea = renderComposer(onSend);
  type(textarea, "@Bo");
  pressEnter(textarea);
  type(textarea, `${textarea.value}hi`);
  pressEnter(textarea);
  await act(async () => {});
  expect(onSend.mock.calls[0]?.[1]).toEqual([bob]);
  act(() => root?.unmount());
  container?.remove();
  // The chat reopens before the answer: the same spelling, without Bob bound.
  const reopened = renderComposer(vi.fn());
  expect(reopened.value).toBe("@Bob hi");
  type(reopened, "@Bo hi");
  type(reopened, "@Bob hi");
  expect(container?.querySelectorAll('[data-testid="mention-chip"]')).toHaveLength(0);
  await act(async () => {
    fail(new Error("offline"));
  });
  expect(localStorage.getItem("rakazo.composerNonce.bot:bot-1")).toBeNull();
});

function renderWithOpenPage(onSend: ComponentProps<typeof Composer>["onSend"]) {
  renderComposer(onSend);
  const session = createPageSession();
  session.dock.set({ page: { id: "page-1", title: "Plan" } });
  act(() =>
    root?.render(
      <PagesProvider value={{ open: () => {}, session }}>
        <Composer {...composerProps} />
      </PagesProvider>,
    ),
  );
  return { session, textarea: container!.querySelector("textarea")! };
}

it("does not store a retry nonce for a send made with a page open", async () => {
  let fail!: (error: Error) => void;
  const onSend = vi.fn(
    () =>
      new Promise<boolean>((_resolve, reject) => {
        fail = reject;
      }),
  );
  const { textarea } = renderWithOpenPage(onSend);
  type(textarea, "about the page");
  pressEnter(textarea);
  await act(async () => {});
  act(() => root?.unmount());
  container?.remove();
  await act(async () => {
    fail(new Error("offline"));
  });
  expect(localStorage.getItem("rakazo.composerDraft.bot:bot-1")).toBe("about the page");
  expect(localStorage.getItem("rakazo.composerNonce.bot:bot-1")).toBeNull();
});

it("renews the nonce when the page closes before a retry", async () => {
  const nonces: string[] = [];
  const onSend = vi.fn(async (_text: string, _mentions: unknown[], clientNonce: string) => {
    nonces.push(clientNonce);
    return false;
  });
  const { session, textarea } = renderWithOpenPage(onSend);
  type(textarea, "about the page");
  pressEnter(textarea);
  await act(async () => {});
  expect(textarea.value).toBe("about the page");
  act(() => session.dock.set({ page: null }));
  pressEnter(textarea);
  await act(async () => {});
  expect(onSend).toHaveBeenCalledTimes(2);
  expect(nonces[1]).not.toBe(nonces[0]);
});

it.each([false, true])(
  "restores dictation to the saved draft when the chat closes before the send fails (throws=%s)",
  async (throws) => {
    let finish!: (accepted: boolean) => void;
    let fail!: (error: Error) => void;
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        }),
    );
    let onFinal!: (text: string) => void;
    const listen = vi.spyOn(dictation, "listen").mockImplementation(async (options) => {
      onFinal = options.onFinal;
    });
    try {
      renderComposer(onSend, { phoneCallsEnabled: true });
      const mic = container?.querySelector<HTMLButtonElement>('button[aria-label="Hold to talk"]');
      act(() => mic?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
      act(() => onFinal("spoken words"));
      act(() => root?.unmount());
      container?.remove();
      await act(async () => {
        if (throws) fail(new Error("offline"));
        else finish(false);
      });
      expect(localStorage.getItem("rakazo.composerDraft.bot:bot-1")).toBe("spoken words");
      const returned = renderComposer(vi.fn());
      expect(returned.value).toBe("spoken words");
    } finally {
      listen.mockRestore();
    }
  },
);

it.each([false, true])(
  "keeps a mention typed while a dictation send fails (throws=%s)",
  async (throws) => {
    let finish!: (accepted: boolean) => void;
    let fail!: (error: Error) => void;
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        }),
    );
    let onFinal!: (text: string) => void;
    const listen = vi.spyOn(dictation, "listen").mockImplementation(async (options) => {
      onFinal = options.onFinal;
    });
    try {
      const textarea = renderComposer(onSend, { phoneCallsEnabled: true });
      const mic = container?.querySelector<HTMLButtonElement>('button[aria-label="Hold to talk"]');
      expect(mic).not.toBeNull();
      act(() => mic?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
      act(() => onFinal("@Bob"));
      await act(async () => {});
      type(textarea, "@Bo");
      pressEnter(textarea);
      type(textarea, "@Bob");
      act(() => {
        textarea.focus();
        textarea.setSelectionRange(0, 0);
        document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      });
      await act(async () => {
        if (throws) fail(new Error("offline"));
        else finish(false);
      });
      expect(textarea.value).toBe("@Bob");
      const record = JSON.parse(localStorage.getItem("rakazo.composerBindings.bot:bot-1")!);
      expect(record.bindings).toMatchObject([{ start: 0, end: 4, mention: bob }]);
      type(textarea, "@Bob ");
      expect(container?.querySelectorAll('[data-testid="mention-chip"]')).toHaveLength(1);
    } finally {
      listen.mockRestore();
    }
  },
);

it("hides call dictation until the server enables it", () => {
  renderComposer(vi.fn().mockResolvedValue(true));
  expect(container?.querySelector('button[aria-label="Hold to talk"]')).toBeNull();
});

it("shows file confirmation only for a recognized server response", () => {
  renderComposer(async () => false, {
    sendError: "This model cannot read images. Choose a model that supports images.",
  });
  expect(
    Array.from(container!.querySelectorAll("button")).some(
      (button) => button.textContent === "Send as file",
    ),
  ).toBe(false);
  rerenderComposer({ imageConfirmation: true });
  expect(
    Array.from(container!.querySelectorAll("button")).some(
      (button) => button.textContent === "Send as file",
    ),
  ).toBe(true);
});

it("never carries file confirmation into a later run error after send error dismissal", () => {
  renderComposer(async () => false, {
    sendError: "Image input is not configured for this model.",
    imageConfirmation: true,
  });
  expect(
    Array.from(container!.querySelectorAll("button")).some(
      (button) => button.textContent === "Send as file",
    ),
  ).toBe(true);
  rerenderComposer({ sendError: null, runError: "Another failure", runErrorId: "later-run" });
  expect(
    Array.from(container!.querySelectorAll("button")).some(
      (button) => button.textContent === "Send as file",
    ),
  ).toBe(false);
});

it("invalidates confirmation on user text, attachment removal and replacement only", async () => {
  const onDraftEdited = vi.fn();
  const attachment = { id: "attachment", file: new File(["old"], "old.txt"), threadKey: "bot-1" };
  const textarea = renderComposer(async () => false, {
    onDraftEdited,
    pendingAttachments: [attachment],
  });
  type(textarea, "edited");
  expect(onDraftEdited).toHaveBeenCalledTimes(1);
  act(() => container!.querySelector<HTMLButtonElement>('[aria-label="Remove old.txt"]')!.click());
  expect(onDraftEdited).toHaveBeenCalledTimes(2);
  pickAttachment();
  expect(onDraftEdited).toHaveBeenCalledTimes(3);
  onDraftEdited.mockClear();
  await act(async () => pressEnter(textarea));
  expect(textarea.value).toBe("edited");
  expect(onDraftEdited).not.toHaveBeenCalled();
});

it("shows an image confirmation as a warning with file and model actions", () => {
  const onOpenModels = vi.fn();
  renderComposer(async () => false, {
    sendError: "This model cannot read images. Choose a model that supports images.",
    imageConfirmation: true,
    onOpenModels,
  });
  const error = container!.querySelector('[data-testid="composer-error"]')!;
  expect(error.className).toContain("text-warning");
  expect(error.className).not.toContain("text-destructive");
  const buttons = Array.from(error.querySelectorAll("button"));
  expect(buttons.map((button) => button.textContent)).toEqual(
    expect.arrayContaining(["Send as file", "Change model"]),
  );
  const note = Array.from(error.querySelectorAll("p")).find(
    (element) => element.textContent === "The bot can use the file but won't see the picture.",
  );
  expect(note).toBeDefined();
  const sendAsFile = buttons.find((button) => button.textContent === "Send as file")!;
  expect(sendAsFile.getAttribute("aria-describedby")).toBe(note!.id);
  act(() => buttons.find((button) => button.textContent === "Change model")!.click());
  expect(onOpenModels).toHaveBeenCalledOnce();
  expect(container!.querySelector('[aria-label="Dismiss error"]')).not.toBeNull();

  rerenderComposer({ sendError: "Could not send the message.", imageConfirmation: false });
  expect(error.className).toContain("text-destructive");
  expect(error.className).not.toContain("text-warning");
  expect(error.textContent).not.toContain("The bot can use the file but won't see the picture.");
  expect(
    Array.from(error.querySelectorAll("button")).some(
      (button) => button.textContent === "Change model",
    ),
  ).toBe(false);
});

it("accepts file drops in transparent padding only during file drags", () => {
  const onAttachmentPick = vi.fn(() => true);
  renderComposer(async () => true, { onAttachmentPick });
  const fieldset = container!.querySelector("fieldset")!;
  const dispatchDrag = (target: EventTarget, type: string, dataTransfer: object) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    act(() => target.dispatchEvent(event));
  };
  dispatchDrag(window, "dragenter", { types: ["text/plain"], items: [] });
  expect(fieldset.classList.contains("pointer-events-none")).toBe(true);
  const files = [new File(["example"], "example.txt", { type: "text/plain" })];
  const dataTransfer = { types: ["Files"], items: [], files };
  dispatchDrag(window, "dragenter", dataTransfer);
  expect(fieldset.classList.contains("pointer-events-auto")).toBe(true);
  dispatchDrag(fieldset, "dragover", dataTransfer);
  expect(fieldset.dataset.dragging).toBe("files");
  dispatchDrag(fieldset, "drop", dataTransfer);
  expect(onAttachmentPick).toHaveBeenCalledExactlyOnceWith(files);
  expect(fieldset.classList.contains("pointer-events-none")).toBe(true);
  expect(fieldset.dataset.dragging).toBeUndefined();
  dispatchDrag(window, "dragenter", dataTransfer);
  dispatchDrag(window, "dragleave", dataTransfer);
  expect(fieldset.classList.contains("pointer-events-none")).toBe(true);
  dispatchDrag(window, "dragenter", dataTransfer);
  dispatchDrag(window, "dragend", dataTransfer);
  expect(fieldset.classList.contains("pointer-events-none")).toBe(true);
});

it("stops the running reply on Escape, but lets Escape close the mention picker first", () => {
  const onStop = vi.fn(async () => {});
  const textarea = renderComposer(async () => true, { onStop });
  const pressEscape = () =>
    act(() =>
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );

  pressEscape();
  expect(onStop).not.toHaveBeenCalled();

  rerenderComposer({ running: true });
  pressEscape();
  expect(onStop).toHaveBeenCalledTimes(1);

  type(textarea, "@");
  pressEscape();
  expect(onStop).toHaveBeenCalledTimes(1);

  type(textarea, "/sum");
  expect(container?.querySelector('[aria-label="Skill summarize"]')).not.toBeNull();
  pressEscape();
  expect(onStop).toHaveBeenCalledTimes(1);
  expect(container?.querySelector('[aria-label="Skill summarize"]')).toBeNull();

  act(() =>
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", repeat: true, bubbles: true }),
    ),
  );
  expect(onStop).toHaveBeenCalledTimes(1);
});

it.each([10, -30, window.innerHeight - 10])(
  "records an intersecting run error at top %s once uncovered and stops hit testing",
  async (top) => {
    let fire: ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined;
    const onRunErrorPresented = vi.fn();
    const original = globalThis.IntersectionObserver;
    class FakeIntersectionObserver {
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
        fire = callback;
      }
      observe(target: Element) {
        const callback = fire;
        fire = (entries) => callback?.(entries.map((entry) => ({ ...entry, target })));
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const rect = {
      width: 200,
      height: 40,
      top,
      left: 10,
      bottom: top + 40,
      right: 210,
      x: 10,
      y: top,
      toJSON: () => ({}),
    } as DOMRect;
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect);
    let covered = true;
    const pointSpy = vi.fn((x: number, y: number) =>
      x < 0 || x >= window.innerWidth || y < 0 || y >= window.innerHeight
        ? null
        : covered
          ? document.body
          : document.querySelector('[data-testid="composer-error"]'),
    );
    Object.defineProperty(document, "elementFromPoint", {
      value: pointSpy,
      configurable: true,
      writable: true,
    });
    try {
      renderComposer(async () => true, {
        runError: "Something failed.",
        runErrorId: "run-1",
        onRunErrorPresented,
      });

      // Off screen: nothing is marked.
      act(() => fire?.([{ isIntersecting: false }]));
      expect(onRunErrorPresented).not.toHaveBeenCalled();

      act(() => fire?.([{ isIntersecting: true }]));
      expect(onRunErrorPresented).not.toHaveBeenCalled();
      expect(pointSpy).toHaveBeenCalledTimes(1);
      expect(pointSpy).toHaveBeenLastCalledWith(
        110,
        (Math.max(0, top) + Math.min(window.innerHeight, top + 40)) / 2,
      );

      // The last entry wins when a fast scroll enters and leaves in one batch.
      act(() => fire?.([{ isIntersecting: true }, { isIntersecting: false }]));
      await act(async () => {
        document.body.setAttribute("data-uncovered", "false");
        document.dispatchEvent(new Event("transitionend"));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
      expect(pointSpy).toHaveBeenCalledTimes(1);
      expect(onRunErrorPresented).not.toHaveBeenCalled();

      act(() => fire?.([{ isIntersecting: true }]));
      expect(pointSpy).toHaveBeenCalledTimes(2);
      covered = false;
      await act(async () => {
        document.body.setAttribute("data-uncovered", "true");
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
      expect(onRunErrorPresented).toHaveBeenCalledExactlyOnceWith("run-1");
      expect(pointSpy).toHaveBeenCalledTimes(3);

      await act(async () => {
        document.body.removeAttribute("data-uncovered");
        document.dispatchEvent(new Event("transitionend"));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
      expect(pointSpy).toHaveBeenCalledTimes(3);

      // A second entry for the same card does not report it twice.
      act(() => fire?.([{ isIntersecting: true }]));
      expect(onRunErrorPresented).toHaveBeenCalledTimes(1);
    } finally {
      rectSpy.mockRestore();
      Reflect.deleteProperty(document, "elementFromPoint");
      vi.stubGlobal("IntersectionObserver", original);
    }
  },
);

it("answers the page, not an earlier picked message, when the page's reply button fills it", () => {
  const onClearReply = vi.fn();
  renderComposer(vi.fn(), {
    onClearReply,
    replyTarget: {
      id: "message-1",
      threadId: "thread-1",
      seq: 1,
      role: "bot",
      blocks: [{ kind: "text", text: "earlier" }],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  });
  const session = createPageSession();
  session.dock.set({ page: { id: "page-1", title: "Plan" } });
  act(() =>
    root?.render(
      <PagesProvider value={{ open: () => {}, session }}>
        <Composer {...composerProps} />
      </PagesProvider>,
    ),
  );
  act(() => session.offerReply("Mark task 3 done"));
  expect(onClearReply).toHaveBeenCalledTimes(1);
  expect(container?.querySelector("textarea")?.value).toBe("Mark task 3 done");
});

it.each([
  { name: "mention", typed: "@Bo", picker: "mention-picker" },
  { name: "slash", typed: "/sum", picker: "slash-picker" },
])(
  "closes an open $name picker when the draft is rewritten from elsewhere",
  async ({ typed, picker }) => {
    const onSend = vi.fn(async (_text: string) => true);
    const textarea = renderComposer(onSend);
    type(textarea, typed);
    expect(container?.querySelector(`[data-testid="${picker}"]`)).not.toBeNull();

    // A recovered send rewrites this chat's draft while the picker is open.
    act(() => replaceComposerDraft("bot:bot-1", "please book the flight and a hotel", []));
    expect(textarea.value).toBe("please book the flight and a hotel");
    expect(container?.querySelector(`[data-testid="${picker}"]`)).toBeNull();

    pressEnter(textarea);
    await act(async () => {});
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]?.[0]).toBe("please book the flight and a hotel");
  },
);

function pasteText(textarea: HTMLTextAreaElement, text: string, files: File[] = []) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: () => text, files },
  });
  act(() => textarea.dispatchEvent(event));
  return event;
}

function pasteAction(label: string) {
  const button = Array.from(container!.querySelectorAll("button")).find(
    (button) => button.textContent === label,
  );
  if (!button) throw new Error(`Missing paste action: ${label}`);
  act(() => button.click());
}

it.each(["small paste", "x".repeat(LARGE_PASTE_THRESHOLD)])(
  "leaves native inline paste alone up to the threshold (%#. case)",
  (text) => {
    const onAttachmentPick = vi.fn(() => true);
    const textarea = renderComposer(async () => true, { onAttachmentPick });
    expect(pasteText(textarea, text).defaultPrevented).toBe(false);
    expect(container!.querySelector('[aria-label="Large paste"]')).toBeNull();
    expect(onAttachmentPick).not.toHaveBeenCalled();
  },
);

it("keeps a large paste inline with its original whitespace and sends it", async () => {
  const onSend = vi.fn<ComponentProps<typeof Composer>["onSend"]>(async () => true);
  const textarea = renderComposer(onSend);
  const text = `  ${"log line\n".repeat(500)}  `;
  expect(pasteText(textarea, text).defaultPrevented).toBe(true);
  expect(textarea.value).toBe(text);
  expect(document.activeElement).toBe(textarea);
  pasteAction("Keep inline");
  expect(container!.querySelector('[aria-label="Large paste"]')).toBeNull();
  expect(textarea.value).toBe(text);
  expect(document.activeElement).toBe(textarea);
  await act(async () => pressEnter(textarea));
  expect(onSend.mock.calls[0]?.[0]).toBe(text.trim());
});

it("switches the pasted selection to a text attachment and restores the surrounding draft", async () => {
  const onAttachmentPick = vi.fn<ComponentProps<typeof Composer>["onAttachmentPick"]>(() => true);
  const textarea = renderComposer(async () => true, { onAttachmentPick });
  type(textarea, "before replace after");
  textarea.setSelectionRange(7, 14);
  const text = "x".repeat(LARGE_PASTE_THRESHOLD + 1);
  pasteText(textarea, text);
  expect(textarea.value).toBe(`before ${text} after`);
  pasteAction("Attach as file");
  const file = onAttachmentPick.mock.calls[0]?.[0]?.[0] as File;
  expect(file.name).toBe("pasted-text.txt");
  expect(file.type).toBe("text/plain");
  const reader = new FileReader();
  const contents = new Promise((resolve) => {
    reader.onload = () => resolve(reader.result);
  });
  reader.readAsText(file);
  expect(await contents).toBe(text);
  expect(textarea.value).toBe("before replace after");
  expect(textarea.selectionStart).toBe(7);
  expect(textarea.selectionEnd).toBe(14);
  expect(document.activeElement).toBe(textarea);
  expect(container!.querySelector('[aria-label="Large paste"]')).toBeNull();
});

it("keeps the text and choice when the normal attachment path rejects the file", () => {
  const textarea = renderComposer(async () => true, { onAttachmentPick: () => false });
  const text = "x".repeat(LARGE_PASTE_THRESHOLD + 1);
  pasteText(textarea, text);
  pasteAction("Attach as file");
  expect(textarea.value).toBe(text);
  expect(container!.querySelector('[aria-label="Large paste"]')).not.toBeNull();
  pasteAction("Keep inline");
  expect(textarea.value).toBe(text);
});

it("dismisses a stale paste choice on editing and replaces it on the next large paste", () => {
  const textarea = renderComposer(async () => true);
  pasteText(textarea, "x".repeat(LARGE_PASTE_THRESHOLD + 1));
  type(textarea, "edited");
  expect(container!.querySelector('[aria-label="Large paste"]')).toBeNull();
  pasteText(textarea, "y".repeat(LARGE_PASTE_THRESHOLD + 1));
  pasteAction("Attach as file");
  expect(textarea.value).toBe("edited");
});

it("preserves mixed file and text paste without offering to attach the text again", () => {
  const onAttachmentPick = vi.fn(() => true);
  const textarea = renderComposer(async () => true, { onAttachmentPick });
  const file = new File(["content"], "example.txt", { type: "text/plain" });
  const text = "x".repeat(LARGE_PASTE_THRESHOLD + 1);
  pasteText(textarea, text, [file]);
  expect(onAttachmentPick).toHaveBeenCalledWith([file]);
  expect(textarea.value).toBe(text);
  expect(container!.querySelector('[aria-label="Large paste"]')).toBeNull();
});
