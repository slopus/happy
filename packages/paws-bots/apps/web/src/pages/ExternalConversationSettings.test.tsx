// @vitest-environment jsdom

import type { Bot, ExternalConversation } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values);
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children?: ReactNode }) => children,
  };
});

import { ExternalConversationSettings } from "./ExternalConversationSettings";

const bot = {
  id: "bot-1",
  name: "Researcher",
  teamChatAmbientEnabled: true,
  teamChatRules: "Answer research questions.",
} as Bot;
const conversation = {
  id: "room-1",
  botId: "bot-1",
  displayName: "#launch",
  participantNames: ["Ada"],
  teamChatAmbientEnabled: null,
  teamChatRules: null,
  automatedSenderPolicies: {},
  automatedSenders: [],
} as unknown as ExternalConversation;

let host: HTMLDivElement;
let root: Root;

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
  Element.prototype.scrollIntoView = () => {};
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function button(label: string) {
  const found = [...document.querySelectorAll<HTMLElement>("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (!found) throw new Error(`Missing ${label}`);
  return found;
}

it("shows the bot's reply mode and rules when inheriting, and saves a room override", async () => {
  const onSave = vi.fn(async () => {});
  await act(async () =>
    root.render(
      <ExternalConversationSettings conversation={conversation} bot={bot} onSave={onSave} />,
    ),
  );
  const trigger = document.querySelector<HTMLElement>('[data-slot="select-trigger"]')!;
  expect(trigger.textContent).toBe("Every message");
  const rules = document.querySelector("textarea")!;
  expect(rules.value).toBe("");
  expect(rules.placeholder).toBe("Answer research questions.");
  expect(host.textContent).not.toContain("Automated senders");
  expect(host.textContent).not.toContain("Reset");

  await act(async () => trigger.click());
  expect(
    [...document.querySelectorAll('[role="option"]')].map((option) => option.textContent),
  ).toEqual(["Same as Researcher", "Every message", "Mentions only"]);
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent === "Mentions only")!
      .click(),
  );
  expect(trigger.textContent).toBe("Mentions only");

  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      rules,
      "Only launch questions.",
    );
    rules.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Save").click());
  expect(onSave).toHaveBeenLastCalledWith({
    teamChatAmbientEnabled: false,
    teamChatRules: "Only launch questions.",
    automatedSenderPolicies: {},
  });

  // Emptying the field follows the bot again rather than saving no rules.
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(rules, "");
    rules.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(host.textContent).not.toContain("Reset");
  await act(async () => button("Save").click());
  expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ teamChatRules: null }));
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      rules,
      "Only launch questions.",
    );
    rules.dispatchEvent(new Event("input", { bubbles: true }));
  });

  await act(async () => button("Reset").click());
  expect(rules.value).toBe("");
  await act(async () => button("Save").click());
  expect(onSave).toHaveBeenLastCalledWith(
    expect.objectContaining({ teamChatAmbientEnabled: false, teamChatRules: null }),
  );
});

it("does not claim Saved for a draft edited while the save is in flight", async () => {
  let finishSave!: () => void;
  const onSave = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishSave = resolve;
      }),
  );
  await act(async () =>
    root.render(
      <ExternalConversationSettings conversation={conversation} bot={bot} onSave={onSave} />,
    ),
  );
  const rules = document.querySelector("textarea")!;
  const type = (text: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        rules,
        text,
      );
      rules.dispatchEvent(new Event("input", { bubbles: true }));
    });
  await type("First take.");

  await act(async () => button("Save").click());
  await type("Second take.");
  finishSave();
  await act(async () => {});

  expect(host.textContent).not.toContain("Saved");

  onSave.mockResolvedValue(undefined);
  await act(async () => button("Save").click());
  await act(async () => {});
  expect(onSave).toHaveBeenLastCalledWith(
    expect.objectContaining({ teamChatRules: "Second take." }),
  );
  expect(host.textContent).toContain("Saved");
});
