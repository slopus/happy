// @vitest-environment jsdom

import type { BillingStatus, Bot } from "@rakazo/contracts";
import { BOT_COLORS } from "@rakazo/contracts";
import type * as UiWeb from "@rakazo/ui-web";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const billing = vi.hoisted(() => ({ status: null as Partial<BillingStatus> | null }));
const writeText = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
    (value === 1 ? one : other).replace("#", String(value)),
}));
vi.mock("@rakazo/ui-web", async (importOriginal) => {
  const { useCopyText } = await importOriginal<typeof UiWeb>();
  const Plain = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    useCopyText,
    BotAvatar: () => null,
    Input: (props: Record<string, unknown>) => <input {...props} />,
    GroupAvatar: () => null,
    Button: ({
      variant: _v,
      size: _s,
      ...props
    }: ComponentProps<"button"> & Record<string, unknown>) => <button type="button" {...props} />,
    Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? <div role="dialog">{children}</div> : null,
    DialogContent: Plain,
    DialogHeader: Plain,
    DialogTitle: Plain,
  };
});
vi.mock("../../components/IconTooltip", () => ({
  IconTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../components/SubscriptionGate", () => ({
  useBilling: () => ({ status: billing.status, showPlans: () => undefined }),
}));

import { ChatHeader } from "./chat-header";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  billing.status = null;
  writeText.mockClear();
  delete window.rakazoDesktop;
  vi.unstubAllGlobals();
});

function renderHeader({ inGroup = false } = {}) {
  act(() =>
    root.render(
      <ChatHeader
        inGroup={inGroup}
        active={
          inGroup ? undefined : ({ id: "bot-1", name: "Helper", color: BOT_COLORS[0] } as Bot)
        }
        activeGroup={undefined}
        activeSnapshot={null}
        phoneCallsEnabled={false}
        voiceReady={false}
        inCall={false}
        panelOpen={false}
        onOpenNavigation={() => undefined}
        onTogglePanel={() => undefined}
        onCall={() => undefined}
      />,
    ),
  );
}

const gift = () => container.querySelector<HTMLButtonElement>('[aria-label="Invite a friend"]');

it("clears the macOS traffic lights beside Open navigation on a narrow desktop window", () => {
  window.rakazoDesktop = { platform: "darwin" } as never;
  renderHeader();
  expect(container.querySelector('[aria-label="Open navigation"]')!.className).toContain(
    "md:hidden",
  );
  const spacer = container.querySelector<HTMLElement>('[aria-hidden="true"].app-drag');
  expect(spacer?.className).toContain("md:hidden");
  expect(spacer?.style.width).toBe("72px");

  delete window.rakazoDesktop;
  renderHeader();
  expect(container.querySelector(".app-drag")).toBeNull();
});

it("shows no gift when the account cannot invite", () => {
  billing.status = { referral: null };
  renderHeader();
  expect(gift()).toBeNull();
});

it("shows the gift only in a bot chat, as mobile does", () => {
  billing.status = { referral: { url: "https://example.test/sign-up?ref=abc", rewards: 0 } };
  renderHeader({ inGroup: true });
  expect(gift()).toBeNull();
});

it("opens the invite with both rewards and copies the link", async () => {
  billing.status = { referral: { url: "https://example.test/sign-up?ref=abc", rewards: 2 } };
  renderHeader();
  act(() => gift()!.click());
  const dialog = container.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Give a friend 2 weeks free");
  expect(dialog.textContent).toContain("They get 2 weeks free.");
  expect(dialog.textContent).toContain(
    "You get a free month when they start their trial with a new card.",
  );
  // The link is also shown, so it can be copied by hand.
  expect(dialog.querySelector<HTMLInputElement>('input[aria-label="Invite link"]')?.value).toBe(
    "https://example.test/sign-up?ref=abc",
  );
  expect(dialog.textContent).toContain("2 free months earned");
  const copy = [...dialog.querySelectorAll("button")].find(
    (button) => button.textContent === "Copy link",
  )!;
  await act(async () => copy.click());
  expect(writeText).toHaveBeenCalledWith("https://example.test/sign-up?ref=abc");
  expect(dialog.textContent).toContain("Copied");
});
