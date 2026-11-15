// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type { LoginFieldInput } from "@rakazo/contracts";
import { BLOCKED_ITEM_ANSWER, UNCHOSEN_ITEM_ANSWER } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values),
  }),
}));
const favicon = vi.hoisted(() => ({ icon: null as string | null, asked: [] as string[] }));
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  useLinkFavicon: (href: string) => {
    if (href) favicon.asked.push(href);
    return { icon: href ? favicon.icon : null, unusable: () => undefined };
  },
}));
const { rpc, spaceRpc } = vi.hoisted(() => {
  const client = () => ({
    bots: { update: vi.fn(async () => ({})), restoreInstructions: vi.fn(async () => ({})) },
  });
  return { rpc: client(), spaceRpc: client() };
});
vi.mock("../lib/rpc", () => ({ rpc }));
// A card's editor lists the vault's saved contacts; these cards need none.
vi.mock("./vault/use-vault-contacts", () => ({ useVaultContacts: () => [] }));

import { ChoiceCard } from "../pages/shell/message-cards";
import type { AskBlock } from "./AskCard";
import { AskCard } from "./AskCard";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  // The app renders only once I18nBootstrap has activated a locale; the refusal text is shared.
  i18n.load("en", {});
  i18n.activate("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const secretCard: AskBlock = {
  kind: "ask",
  text: "API key",
  input: "secret",
  purpose: "api_key",
  credential: { name: "example_api", origin: "https://api.example.test", auth: { type: "bearer" } },
  status: "pending",
};

async function render(
  block: AskBlock,
  onDismiss: () => Promise<void> = async () => undefined,
  onAnswer: (
    text: string,
    fields?: LoginFieldInput[],
    remember?: false,
  ) => Promise<void> = async () => undefined,
  answerIsSeparate?: boolean,
) {
  await act(async () =>
    root.render(
      <AskCard
        block={block}
        answerIsSeparate={answerIsSeparate}
        canAnswer
        canDismiss
        onAnswer={onAnswer}
        onDismiss={onDismiss}
      />,
    ),
  );
}

function button(name: string) {
  return [...container.querySelectorAll("button")].find((item) => item.textContent === name);
}

async function type(label: string, value: string) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("dismisses a secret card without sending the typed value", async () => {
  const onAnswer = vi.fn(async () => undefined);
  const onDismiss = vi.fn(async () => undefined);
  await render(secretCard, onDismiss, onAnswer);
  await type("API key", "example-key");

  await act(async () => button("Dismiss")!.click());

  expect(onDismiss).toHaveBeenCalledTimes(1);
  expect(onDismiss).toHaveBeenCalledWith();
  expect(onAnswer).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Dismissed");
  expect(button("Dismiss")).toBeUndefined();
  expect(container.querySelector("input")).toBeNull();
});

it("shows a generic error when dismissing fails", async () => {
  await render(secretCard, async () => {
    throw new Error("server detail");
  });

  await act(async () => button("Dismiss")!.click());

  expect(container.textContent).toContain("Could not submit this answer");
  expect(container.textContent).not.toContain("server detail");
  expect(button("Dismiss")!.disabled).toBe(false);
});

it("shows a dismissed secret card as Dismissed, not Saved", async () => {
  await render({ ...secretCard, status: "answered", answer: "", dismissed: true });
  expect(container.textContent).toContain("Dismissed");
  expect(container.textContent).not.toContain("Saved");
  expect(button("Dismiss")).toBeUndefined();

  await render({ ...secretCard, status: "answered", answer: "" });
  expect(container.textContent).toContain("Saved");
  const card = container.querySelector('[data-testid="secret-ask-card"]')!;
  expect(card.classList.contains("max-w-xl")).toBe(true);
});

it("offers Dismiss only on secret cards", async () => {
  await render({ kind: "ask", text: "Which city?", status: "pending" });
  expect(button("Dismiss")).toBeUndefined();
});

it("puts primary Save before secondary Dismiss at the default button size", async () => {
  await render(secretCard);
  expect(
    [...button("Save")!.parentElement!.querySelectorAll("button")].map((item) => item.textContent),
  ).toEqual(["Save", "Dismiss"]);
  expect(button("Save")?.classList.contains("bg-primary")).toBe(true);
  expect(button("Dismiss")?.classList.contains("border-border")).toBe(true);
  expect(button("Save")!.disabled).toBe(true);
  expect(container.querySelector("input")?.classList.contains("w-full")).toBe(true);
  const card = container.querySelector('[data-testid="secret-ask-card"]')!;
  expect(card.classList.contains("max-w-xl")).toBe(true);
  for (const label of ["Save", "Dismiss"]) {
    expect(button(label)?.classList.contains("h-8")).toBe(true);
    expect(button(label)?.classList.contains("flex-1")).toBe(false);
  }
  await type("API key", "example-key");
  expect(button("Save")!.disabled).toBe(false);
});

it("styles dismissed secrets like denied approvals, apart from the destination", async () => {
  await render({ ...secretCard, status: "answered", dismissed: true });
  const dismissed = [...container.querySelectorAll("div")].find(
    (item) => item.textContent === "Dismissed",
  )!;
  expect(dismissed.classList.contains("font-medium")).toBe(true);
  expect(dismissed.classList.contains("text-muted-foreground")).toBe(true);
});

it.each([true, false])("gates secret dismissal: %s", async (canDismiss) => {
  await act(async () =>
    root.render(
      <AskCard
        block={{ kind: "ask", text: "Secret", input: "secret", status: "pending" }}
        canAnswer
        canDismiss={canDismiss}
        onAnswer={async () => {}}
        onDismiss={async () => {}}
      />,
    ),
  );
  const labels = [...container.querySelectorAll("button")].map((button) => button.textContent);
  expect(labels.includes("Dismiss")).toBe(canDismiss);
  expect(labels.includes("Save")).toBe(true);
  expect(button("Save")?.classList.contains("h-8")).toBe(true);
});

it("keeps an accepted secret Save answered without a block update", async () => {
  const onAnswer = vi.fn(async () => undefined);
  await render(secretCard, undefined, onAnswer);
  await type("API key", "example-key");

  await act(async () => button("Save")!.click());

  expect(onAnswer).toHaveBeenCalledWith("example-key");
  expect(container.textContent).toContain("Saved");
  expect(container.textContent).not.toContain("example-key");
  expect(container.querySelector("input")).toBeNull();
  expect(container.querySelector("button")).toBeNull();
  expect(container.querySelector(".text-destructive")).toBeNull();
});

const loginCard: AskBlock = {
  kind: "ask",
  text: "Sign in to Example",
  input: "secret",
  credential: {
    name: "example_login",
    origin: "https://login.example.test",
    auth: { type: "login" },
  },
  loginFields: ["ID number", "Phone number", "PIN"],
  status: "pending",
};

it("marks a login with its site's icon, or else the first letter of the site's own name", async () => {
  favicon.asked = [];
  await render({
    ...loginCard,
    credential: { ...loginCard.credential!, origin: "https://app.example.com" },
  });
  const card = () => container.querySelector('[data-testid="secret-ask-card"]')!;
  expect(favicon.asked).toContain("https://app.example.com");
  expect(card().querySelector("img")).toBeNull();
  expect(card().querySelector("span[aria-hidden]")?.textContent).toBe("E");
  favicon.icon = "data:image/png;base64,AAAA";
  try {
    await render({ ...loginCard });
    expect(card().querySelector("img")?.getAttribute("src")).toBe(favicon.icon);
  } finally {
    favicon.icon = null;
  }
});

it("letters an IPv6 login by its first digit, not a bracket", async () => {
  await render({ ...loginCard, credential: { ...loginCard.credential!, origin: "https://[::1]" } });
  const tile = container.querySelector('[data-testid="secret-ask-card"] span[aria-hidden]');
  expect(tile?.textContent).toBe("1");
});

it("asks for no site icon on a card that is not a login", async () => {
  favicon.asked = [];
  await render(secretCard);
  expect(favicon.asked).toEqual([]);
});

/** The dialog a login, card or contact card opens; it renders outside the card. */
function dialog() {
  return document.querySelector<HTMLElement>('[data-testid="vault-editor"]');
}

function dialogButton(name: string) {
  return [...(dialog()?.querySelectorAll("button") ?? [])].find(
    (item) => item.textContent === name,
  );
}

async function openEditor() {
  await act(async () => button("Add")!.click());
  expect(dialog()).not.toBeNull();
}

function loginInput(label: string) {
  const labelled = [...(dialog()?.querySelectorAll("label") ?? [])].find(
    (item) => item.textContent === label,
  )!;
  return document.getElementById(labelled.htmlFor) as HTMLInputElement;
}

async function typeIn(field: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function hiddenSwitch(label: string) {
  return [...(dialog()?.querySelectorAll('[data-testid="login-field"]') ?? [])]
    .find((row) => row.querySelector("label")?.textContent === label)!
    .querySelector<HTMLElement>('[data-testid="login-field-hidden"]')!;
}

it("starts an ID and a phone visible and a PIN hidden, and the person can flip each", async () => {
  const onAnswer = vi.fn(async () => undefined);
  await render(loginCard, undefined, onAnswer);
  await openEditor();

  for (const [label, hidden] of [
    ["ID number", false],
    ["Phone number", false],
    ["PIN", true],
  ] as const) {
    expect(loginInput(label).type).toBe(hidden ? "password" : "text");
    expect(hiddenSwitch(label).getAttribute("aria-pressed")).toBe(String(hidden));
    expect(hiddenSwitch(label).getAttribute("aria-label")).toBe("Hidden");
    const description = hiddenSwitch(label).getAttribute("aria-describedby")!;
    expect(document.getElementById(description)?.textContent).toBe(label);
  }
  await typeIn(loginInput("ID number"), " fake-id-123 ");
  await typeIn(loginInput("Phone number"), "+1 555 0100");
  expect(dialogButton("Save")!.disabled).toBe(true);
  await typeIn(loginInput("PIN"), "0000");
  await act(async () => hiddenSwitch("Phone number").click());
  expect(loginInput("Phone number").type).toBe("password");
  await act(async () => hiddenSwitch("PIN").click());
  expect(loginInput("PIN").type).toBe("text");

  await act(async () => dialogButton("Save")!.click());

  expect(onAnswer).toHaveBeenCalledWith("", [
    { label: "ID number", value: " fake-id-123 ", hidden: false },
    { label: "Phone number", value: "+1 555 0100", hidden: true },
    { label: "PIN", value: "0000", hidden: false },
  ]);
  expect(container.textContent).toContain("Saved");
  expect(document.body.textContent).not.toContain("fake-id-123");
  expect(dialog()).toBeNull();
});

it("says the bot's browser stays signed in for everyone in a shared space", async () => {
  const line = "The bot's browser stays signed in for everyone in this space";
  await render({ ...loginCard, sharedBrowser: true });
  expect(container.textContent).toContain(line);
  await render(loginCard);
  expect(container.textContent).not.toContain(line);
});

it("starts every field hidden when no label names an identifier", async () => {
  await render({ ...loginCard, loginFields: ["Memorable word", "Card number"] });
  await openEditor();

  for (const label of ["Memorable word", "Card number"]) {
    expect(loginInput(label).type).toBe("password");
    expect(hiddenSwitch(label).getAttribute("aria-pressed")).toBe("true");
  }
});

it("asks for a visible username and a hidden password when the bot names no fields", async () => {
  const onAnswer = vi.fn(async () => undefined);
  const { loginFields: _, ...defaultLogin } = loginCard;
  await render(defaultLogin, undefined, onAnswer);
  await openEditor();

  expect(
    [...dialog()!.querySelectorAll('[data-testid="login-field"] label')].map(
      (label) => label.textContent,
    ),
  ).toEqual(["Username", "Password"]);
  expect(loginInput("Username").type).toBe("text");
  expect(hiddenSwitch("Username").getAttribute("aria-pressed")).toBe("false");
  expect(loginInput("Password").type).toBe("password");
  expect(hiddenSwitch("Password").getAttribute("aria-pressed")).toBe("true");
  await typeIn(loginInput("Username"), "fake-user");
  await typeIn(loginInput("Password"), "fake-password");
  await act(async () => dialogButton("Save")!.click());

  expect(onAnswer).toHaveBeenCalledWith("", [
    { label: "Username", value: "fake-user", hidden: false },
    { label: "Password", value: "fake-password", hidden: true },
  ]);
});

it("keeps an accepted question choice answered until the block updates", async () => {
  const block: AskBlock = {
    kind: "ask",
    text: "Which city?",
    status: "pending",
    actions: [
      { id: "paris", label: "Paris" },
      { id: "london", label: "London" },
    ],
  };
  const onAnswer = vi.fn(async () => undefined);
  await render(block, undefined, onAnswer);

  await act(async () => button("AParis")!.click());

  expect(onAnswer).toHaveBeenCalledWith("paris");
  expect(container.textContent).not.toContain("Answered");
  expect(button("AParis")!.getAttribute("aria-pressed")).toBe("true");
  expect(button("BLondon")!.disabled).toBe(true);
  expect(container.querySelector(".text-destructive")).toBeNull();

  await render({ ...block, status: "answered", answer: "london" });
  expect(button("BLondon")!.getAttribute("aria-pressed")).toBe("true");
  expect(button("AParis")!.hasAttribute("aria-pressed")).toBe(false);
});

it("dims a closed question's options without a status line", async () => {
  await act(async () =>
    root.render(
      <AskCard
        block={{
          kind: "ask",
          text: "Which city?",
          status: "pending",
          actions: [{ id: "paris", label: "Paris" }],
        }}
        canAnswer={false}
        canDismiss={false}
        onAnswer={async () => undefined}
        onDismiss={async () => undefined}
      />,
    ),
  );
  expect(button("AParis")!.disabled).toBe(true);
  expect(container.textContent).not.toContain("No longer active");
});

it("letters question options and fills them only on hover", async () => {
  await render({
    kind: "ask",
    text: "Which city?",
    status: "pending",
    actions: [
      { id: "paris", label: "Paris" },
      { id: "london", label: "London" },
    ],
  });
  const option = button("BLondon")!;
  expect(option.disabled).toBe(false);
  expect(option.classList.contains("bg-secondary")).toBe(false);
  expect(option.classList.contains("hover:bg-accent")).toBe(true);
  expect(option.querySelector("[aria-hidden]")?.textContent).toBe("B");
});

it("sizes approval buttons like the other card buttons", async () => {
  await render({
    kind: "ask",
    approvalEffectId: "effect-1",
    text: "Send it?",
    status: "pending",
    actions: [
      { id: "allow", label: "Allow once" },
      { id: "deny", label: "Deny" },
    ],
  });
  for (const label of ["Allow once", "Deny"]) {
    expect(button(label)?.classList.contains("min-h-8")).toBe(true);
    expect(button(label)?.classList.contains("py-3")).toBe(false);
  }
});

it("offers Always allow only when the approval card does", async () => {
  const card: AskBlock = {
    kind: "ask",
    approvalEffectId: "effect-1",
    text: "Review before schedule_create",
    status: "pending",
    actions: [
      { id: "allow", label: "Allow once" },
      { id: "always", label: "Always allow this tool" },
      { id: "deny", label: "Deny" },
    ],
  };
  const labels = () => [...container.querySelectorAll("button")].map((item) => item.textContent);
  await render(card);
  expect(labels()).toEqual(["Allow once", "Always allow this tool", "Deny"]);
  await render({ ...card, actions: card.actions!.filter((action) => action.id !== "always") });
  expect(labels()).toEqual(["Allow once", "Deny"]);
});

it.each(["Allow in this space", "Allow for this chat"])(
  "says a user's-computer approval labelled %s allows the whole space",
  async (label) => {
    const block: AskBlock = {
      kind: "ask",
      approvalEffectId: "effect-1",
      text: "Run on your computer?",
      status: "pending",
      actions: [
        { id: "allow", label },
        { id: "deny", label: "Deny" },
      ],
    };
    await render({ ...block, detail: "hostname", detailFormat: "code" });
    const detail = container.querySelector('[data-testid="ask-detail"]');
    expect(detail?.textContent).toBe("hostname");
    // The card is muted, so the command sits on the page background to read as a snippet.
    expect(detail?.classList.contains("bg-background")).toBe(true);
    expect(detail?.classList.contains("bg-muted")).toBe(false);
    expect(button("Allow in this space")).toBeTruthy();
    expect(button("Allow once")).toBeUndefined();
    await render({ ...block, status: "answered", answer: "allow" });
    expect(container.textContent).toContain("Allowed in this space");
  },
);

it("shows a question's detail as plain text above its options", async () => {
  await render({
    kind: "ask",
    text: "Send this email to Ana?",
    detail: "To: ana@example.test\nSubject: Demo\n\nThe draft body.",
    detailFormat: "text",
    status: "pending",
    actions: [
      { id: "choice-1", label: "Send it" },
      { id: "choice-2", label: "Show me first" },
    ],
  });
  const detail = container.querySelector('[data-testid="ask-detail"]')!;
  expect(detail.textContent).toBe("To: ana@example.test\nSubject: Demo\n\nThe draft body.");
  // Plain text sits on the card like the question, not in a code snippet box.
  expect(detail.classList.contains("font-sans")).toBe(true);
  expect(detail.classList.contains("bg-background")).toBe(false);
  expect(button("ASend it")).toBeDefined();
});

it("shows what a sign-in approval types besides the login, above its two answers", async () => {
  // The card as the server builds it for a login that asks first and types its code.
  await render({
    kind: "ask",
    approvalEffectId: "effect-1",
    text: "Sign in to login.example.test with Work login?",
    detail: "This types the login's authenticator code.",
    detailFormat: "text",
    status: "pending",
    actions: [
      { id: "allow", label: "Allow once" },
      { id: "deny", label: "Deny" },
    ],
  });
  expect(container.textContent).toContain("Sign in to login.example.test with Work login?");
  expect(container.querySelector('[data-testid="ask-detail"]')?.textContent).toBe(
    "This types the login's authenticator code.",
  );
  expect([...container.querySelectorAll("button")].map((item) => item.textContent)).toEqual([
    "Allow once",
    "Deny",
  ]);
});

it("gives onboarding choices the same lettered rows as questions", async () => {
  await act(async () =>
    root.render(
      <ChoiceCard
        botId="bot"
        block={{
          kind: "choice",
          question: "Which city?",
          options: [{ id: "paris", letter: "A", label: "Paris" }],
        }}
        onBotChanged={async () => {}}
      />,
    ),
  );
  const option = button("AParis")!;
  expect(option.disabled).toBe(false);
  expect(option.classList.contains("hover:bg-accent")).toBe(true);
  expect(option.querySelector("[aria-hidden]")?.textContent).toBe("A");
});

it.each([
  [
    "login",
    { name: "example_login", origin: "https://login.example.test", auth: { type: "login" } },
  ],
  ["API", { name: "example_api", origin: "https://api.example.test", auth: { type: "bearer" } }],
] as const)(
  "shows a %s credential card read-only to anyone but the run's user",
  async (_name, credential) => {
    const render = (canDismiss: boolean) =>
      act(async () =>
        root.render(
          <AskCard
            block={{ kind: "ask", text: "Secret", input: "secret", status: "pending", credential }}
            canAnswer
            canDismiss={canDismiss}
            onAnswer={async () => {}}
            onDismiss={async () => {}}
          />,
        ),
      );

    await render(false);
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(0);
    // A login names its site; an API credential shows the address it is sent to.
    expect(container.textContent).toContain(
      credential.auth.type === "login" ? new URL(credential.origin).host : credential.origin,
    );
    expect(container.textContent).not.toContain("No longer active");

    await render(true);
    if (credential.auth.type === "login") expect(button("Add")).toBeDefined();
    else expect(button("Save")).toBeDefined();
  },
);

it("keeps a connector code card open to others in the chat, without Dismiss", async () => {
  await act(async () =>
    root.render(
      <AskCard
        block={{ kind: "ask", text: "Code", input: "secret", purpose: "otp", status: "pending" }}
        canAnswer
        canDismiss={false}
        onAnswer={async () => {}}
        onDismiss={async () => {}}
      />,
    ),
  );
  expect(container.querySelector("input")).not.toBeNull();
  expect(button("Save")).toBeDefined();
  expect(button("Dismiss")).toBeUndefined();
});

function saveToVault() {
  return dialog()?.querySelector<HTMLElement>('[role="switch"]') ?? null;
}

it("saves a login by default, with Save to Vault on and named by its label", async () => {
  const onAnswer = vi.fn(async () => undefined);
  await render(loginCard, undefined, onAnswer);
  await openEditor();
  const toggle = saveToVault()!;
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  const label = [...dialog()!.querySelectorAll("label")].find(
    (item) => item.textContent === "Save to Vault",
  )!;
  expect(toggle.parentElement?.contains(label) || label.htmlFor !== "").toBe(true);
  await typeIn(loginInput("ID number"), "fake-id-123");
  await typeIn(loginInput("Phone number"), "+1 555 0100");
  await typeIn(loginInput("PIN"), "1234");
  await act(async () => dialogButton("Save")!.click());

  // Nothing extra is sent, so the answer is saved as it always was.
  expect(onAnswer).toHaveBeenCalledWith("", [
    { label: "ID number", value: "fake-id-123", hidden: false },
    { label: "Phone number", value: "+1 555 0100", hidden: false },
    { label: "PIN", value: "1234", hidden: true },
  ]);
  expect(container.textContent).toContain("Saved");
});

it("sends a login for this run only when Save to Vault is off, and reads Sent", async () => {
  const onAnswer = vi.fn(async () => undefined);
  await render(loginCard, undefined, onAnswer);
  await openEditor();
  await typeIn(loginInput("ID number"), "fake-id-123");
  await act(async () => saveToVault()!.click());
  expect(saveToVault()!.getAttribute("aria-checked")).toBe("false");
  // Turning it off keeps what was typed and says the login is only sent on.
  expect(loginInput("ID number").value).toBe("fake-id-123");
  expect(dialogButton("Save")).toBeUndefined();
  await typeIn(loginInput("Phone number"), "+1 555 0100");
  await typeIn(loginInput("PIN"), "1234");
  await act(async () => dialogButton("Continue")!.click());

  expect(onAnswer).toHaveBeenCalledWith(
    "",
    [
      { label: "ID number", value: "fake-id-123", hidden: false },
      { label: "Phone number", value: "+1 555 0100", hidden: false },
      { label: "PIN", value: "1234", hidden: true },
    ],
    false,
  );
  expect(container.textContent).toContain("Sent");
  expect(container.textContent).not.toContain("Saved");
});

it("dismisses a login card from its form, sending nothing typed", async () => {
  const onAnswer = vi.fn(async () => undefined);
  const onDismiss = vi.fn(async () => undefined);
  await render(loginCard, onDismiss, onAnswer);
  await openEditor();
  await typeIn(loginInput("PIN"), "1234");
  await act(async () => dialogButton("Dismiss")!.click());
  expect(onDismiss).toHaveBeenCalledTimes(1);
  expect(onAnswer).not.toHaveBeenCalled();
  expect(dialog()).toBeNull();
  expect(container.textContent).toContain("Dismissed");
});

it("keeps the form open with a generic error when a login fails to save", async () => {
  await render(loginCard, undefined, async () => {
    throw new Error("server echoed fake-id-123");
  });
  await openEditor();
  await typeIn(loginInput("ID number"), "fake-id-123");
  await typeIn(loginInput("Phone number"), "+1 555 0100");
  await typeIn(loginInput("PIN"), "1234");
  await act(async () => dialogButton("Save")!.click());
  expect(dialog()?.textContent).toContain("Could not submit this answer");
  expect(document.body.textContent).not.toContain("server echoed");
  // The values are cleared as the save starts, so nothing typed is left behind.
  expect(loginInput("PIN").value).toBe("");
});

it.each([
  [
    BLOCKED_ITEM_ANSWER,
    "This item is blocked for bots. Allow it in the Vault, or dismiss the request.",
  ],
  [
    UNCHOSEN_ITEM_ANSWER,
    "This bot can't use this item. Change it in the Vault, or dismiss the request.",
  ],
])(
  "says why a login wasn't saved only when bots can't use that item (%s)",
  async (answer, shown) => {
    await render(loginCard, undefined, async () => {
      throw new Error(answer);
    });
    await openEditor();
    await typeIn(loginInput("ID number"), "fake-id-123");
    await typeIn(loginInput("Phone number"), "+1 555 0100");
    await typeIn(loginInput("PIN"), "1234");
    await act(async () => dialogButton("Save")!.click());
    expect(dialog()?.textContent).toContain(shown);
    expect(dialog()?.textContent).not.toContain("Could not submit this answer");
  },
);

const cardAsk: AskBlock = {
  kind: "ask",
  text: "Your card",
  input: "secret",
  credential: { name: "visa", origin: "", auth: { type: "card" } },
  status: "pending",
};

it("saves a card from its form as one encoded value", async () => {
  const onAnswer = vi.fn(async () => undefined);
  await render(cardAsk, undefined, onAnswer);
  await openEditor();
  await typeIn(loginInput("Card number"), "4242 4242 4242 4242");
  expect(dialog()?.querySelector('[data-testid="vault-card-brand"]')?.textContent).toBe("Visa");
  await typeIn(loginInput("Expiry"), "0830");
  expect(loginInput("Expiry").value).toBe("08/30");
  await typeIn(loginInput("Security code"), "123");
  await act(async () => dialogButton("Save")!.click());
  expect(onAnswer).toHaveBeenCalledWith(
    JSON.stringify({ number: "4242424242424242", expMonth: 8, expYear: 2030, cvc: "123" }),
  );
  expect(container.textContent).toContain("Saved");
});

it("saves a contact from its form, without empty fields", async () => {
  const onAnswer = vi.fn(async () => undefined);
  await render(
    {
      ...cardAsk,
      text: "Home address",
      credential: { name: "home", origin: "", auth: { type: "contact" } },
    },
    undefined,
    onAnswer,
  );
  await openEditor();
  expect(dialogButton("Save")!.disabled).toBe(true);
  await typeIn(loginInput("Full name"), "Alex Rivera");
  await typeIn(loginInput("City"), "Springfield");
  await act(async () => dialogButton("Save")!.click());
  expect(onAnswer).toHaveBeenCalledWith(
    JSON.stringify({ name: "Alex Rivera", city: "Springfield" }),
  );
});

it("reads Sent on a login card answered without saving it, after a reload", async () => {
  await render({ ...loginCard, status: "answered", answer: "", remembered: false });
  expect(container.textContent).toContain("Sent");
  await render({ ...loginCard, status: "answered", answer: "" });
  expect(container.textContent).toContain("Saved");
});

it("offers Save to Vault only on login cards", async () => {
  await render(secretCard);
  expect(container.querySelector('[role="switch"]')).toBeNull();
  await render({ kind: "ask", text: "Code", input: "secret", purpose: "otp", status: "pending" });
  expect(container.querySelector('[role="switch"]')).toBeNull();
  await render({
    ...secretCard,
    credential: { name: "deploy_key", origin: "", auth: { type: "command" } },
  } as AskBlock);
  expect(container.querySelector('[role="switch"]')).toBeNull();
  expect(container.textContent).not.toContain("Save to Vault");
});

it("leaves a typed reply in its message and marks a sent draft", async () => {
  const block: AskBlock = { kind: "ask", text: "Send it?", status: "answered", answer: "Tuesday" };
  await render(block);
  expect(container.textContent).toContain("Tuesday");
  await render(block, undefined, undefined, true);
  expect(container.textContent).not.toContain("Tuesday");
  expect(container.textContent).not.toContain("Answered");

  await render({ ...block, answer: "approved" });
  expect(container.querySelector('[data-testid="ask-answer"]')).toBeNull();
  expect(container.textContent).toContain("Sent");
});

it("dims the options a typed answer did not match", async () => {
  await render({
    kind: "ask",
    text: "Which city?",
    status: "answered",
    answer: "Paris",
    actions: [
      { id: "berlin", label: "Berlin" },
      { id: "seoul", label: "Seoul" },
    ],
  });
  expect(container.querySelector('[data-testid="ask-answer"]')).toBeNull();
  expect(container.textContent).not.toContain("Paris");
  expect(container.querySelector("[aria-pressed]")).toBeNull();

  await render({
    kind: "ask",
    text: "Which city?",
    status: "answered",
    answer: "seoul",
    actions: [{ id: "seoul", label: "Seoul" }],
  });
  expect(container.querySelector('[data-testid="ask-answer"]')).toBeNull();
  expect(button("ASeoul")!.getAttribute("aria-pressed")).toBe("true");
});

it("undoes a settings change from chat while it still holds", async () => {
  await render({
    kind: "ask",
    text: "Settings updated",
    status: "answered",
    settingsUpdate: {
      botId: "bot-1",
      before: { modelProvider: null, modelId: null, thinkingLevel: null },
      after: { modelProvider: "google", modelId: "gemini-3.8-flash", thinkingLevel: "high" },
    },
  });
  expect(container.textContent).toContain("Settings updated");
  await act(async () => button("Undo")?.click());
  expect(rpc.bots.update).toHaveBeenCalledWith({
    botId: "bot-1",
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    expectedSettings: {
      modelProvider: "google",
      modelId: "gemini-3.8-flash",
      thinkingLevel: "high",
    },
  });
  expect(button("Restored")?.disabled).toBe(true);
});

const codeCard: AskBlock = {
  kind: "ask",
  text: "Enter the code",
  input: "secret",
  purpose: "otp",
  oneTimeCode: { origin: "https://login.example.test" },
  status: "pending",
};

it("asks for a one-time code in a masked field, with the site and no Save to Vault", async () => {
  const onAnswer = vi.fn(async () => undefined);
  await render(codeCard, undefined, onAnswer);
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Code"]')!;
  expect(input.type).toBe("password");
  expect(input.autocomplete).toBe("one-time-code");
  expect(container.textContent).toContain("Only enter a code login.example.test sent you.");
  expect(container.querySelector('[role="switch"]')).toBeNull();
  expect(button("Save")).toBeUndefined();
  await type("Code", "12");
  expect(button("Continue")!.disabled).toBe(true);
  await type("Code", "123 456");
  await act(async () => button("Continue")!.click());
  expect(onAnswer).toHaveBeenCalledWith("123 456");
});

it("leaves a one-time code to the run's user, and reads Sent once answered", async () => {
  await act(async () =>
    root.render(
      <AskCard
        block={codeCard}
        canAnswer
        canDismiss={false}
        onAnswer={async () => {}}
        onDismiss={async () => {}}
      />,
    ),
  );
  expect(container.querySelector("input")).toBeNull();
  expect(container.querySelectorAll("button")).toHaveLength(0);
  expect(container.textContent).toContain("Only enter a code login.example.test sent you.");
  await render({ ...codeCard, status: "answered", answer: "" });
  expect(container.textContent).toContain("Sent");
  expect(container.textContent).not.toContain("Saved");
});

it("shows the bot's label on a code card as plain text beneath the site's own title", async () => {
  await render({
    ...codeCard,
    text: "Code for login.example.test",
    detail: "Your **bank** [link](https://evil.example)",
  });
  const detail = [...container.querySelectorAll("div")].find((node) =>
    node.textContent?.startsWith("Your **bank**"),
  );
  expect(detail?.textContent).toBe("Your **bank** [link](https://evil.example)");
  expect(detail?.querySelector("a, strong")).toBeNull();
  // Other secret cards keep hiding a detail they do not use.
  await render({ ...secretCard, detail: "hidden detail" });
  expect(container.textContent).not.toContain("hidden detail");
});

it("keeps one-time-code autofill off the other secret cards", async () => {
  await render(secretCard);
  expect(container.querySelector<HTMLInputElement>("input")!.autocomplete).toBe("off");
});

it("shows the site a replace card moves the login from only to the person answering it", async () => {
  const replaced = "https://www.example.test";
  const render = (canDismiss: boolean, status: AskBlock["status"] = "pending") =>
    act(async () =>
      root.render(
        <AskCard
          block={{ ...loginCard, status, replaces: { id: "saved-login-1", origin: replaced } }}
          canAnswer
          canDismiss={canDismiss}
          onAnswer={async () => {}}
          onDismiss={async () => {}}
        />,
      ),
    );

  await render(true);
  expect(container.textContent).toContain(`Replaces the login saved for ${replaced}`);
  await render(false);
  expect(container.textContent).not.toContain(replaced);
  await render(true, "answered");
  expect(container.textContent).not.toContain(replaced);
});

it("sends Undo to the chat's space, not the one selected in another tab", async () => {
  vi.clearAllMocks();
  const card = (block: AskBlock) =>
    act(async () =>
      root.render(
        <AskCard
          key={block.text}
          block={block}
          canAnswer
          canDismiss
          onAnswer={async () => undefined}
          onDismiss={async () => undefined}
          rpc={spaceRpc as never}
        />,
      ),
    );
  await card({
    kind: "ask",
    text: "Instructions updated",
    status: "answered",
    instructionUpdate: {
      botId: "bot-1",
      undoVersionId: "version-1",
      before: "Old",
      after: "New",
      reason: "Asked",
    },
  });
  await act(async () => button("Undo")?.click());
  await card({
    kind: "ask",
    text: "Settings updated",
    status: "answered",
    settingsUpdate: {
      botId: "bot-1",
      before: { modelProvider: null, modelId: null, thinkingLevel: null },
      after: { modelProvider: "google", modelId: "gemini-3.8-flash", thinkingLevel: "high" },
    },
  });
  await act(async () => button("Undo")?.click());
  expect(spaceRpc.bots.restoreInstructions).toHaveBeenCalledTimes(1);
  expect(spaceRpc.bots.update).toHaveBeenCalledTimes(1);
  expect(rpc.bots.restoreInstructions).not.toHaveBeenCalled();
  expect(rpc.bots.update).not.toHaveBeenCalled();
});

it("draws a payment's order as a receipt in place of the text detail", async () => {
  const block: AskBlock = {
    kind: "ask",
    approvalEffectId: "effect-1",
    text: "Pay on freshcart.test?",
    detail: "Bananas × 6: $3.00",
    detailFormat: "text",
    receipt: {
      button: "Place order",
      items: [
        { name: "Bananas × 6", amount: "$3.00" },
        { name: "Delivery", amount: "$6.00" },
        // A page line named like the card's own row is left out.
        { name: "On the button", amount: "$1.00" },
      ],
      more: { count: 23, atLeast: true },
      amount: "$20.00",
      amountSource: "button",
      total: "$17.40",
    },
    status: "pending",
    actions: [
      { id: "allow", label: "Allow once" },
      { id: "deny", label: "Deny" },
    ],
  };
  await render(block);
  const receipt = container.querySelector('[data-testid="ask-receipt"]');
  expect([...receipt!.querySelectorAll("li")].map((row) => row.textContent)).toEqual([
    "Bananas × 6$3.00",
    "Delivery$6.00",
    "23+ more",
    "Total$17.40",
    "On the button$20.00",
  ]);
  expect(receipt?.textContent).toContain("Button “Place order” · read from the page, not checked");
  expect(container.querySelector('[data-testid="ask-detail"]')).toBeNull();

  await render({ ...block, receipt: { items: [], amount: "$20.00", amountSource: "page" } });
  expect(
    [...container.querySelectorAll('[data-testid="ask-receipt"] li')].map((row) => row.textContent),
  ).toEqual(["Total$20.00"]);
  expect(container.textContent).toContain("Read from the page, not checked");
});

it("leaves plain questions to the composer and dims the question after answering", async () => {
  const block: AskBlock = { kind: "ask", text: "Which city?", status: "pending" };
  await render(block);
  expect(container.querySelectorAll("button")).toHaveLength(0);
  expect(container.querySelector("input")).toBeNull();
  expect(
    container.querySelector('[data-testid="question-card"]')?.classList.contains("opacity-50"),
  ).toBe(false);
  await render({ ...block, status: "answered", answer: "Paris" }, undefined, undefined, true);
  expect(
    container.querySelector('[data-testid="question-card"]')?.classList.contains("opacity-50"),
  ).toBe(true);
  expect(container.textContent).not.toContain("Paris");
});
