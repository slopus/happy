// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CallState } from "../../lib/call-session";
import { endCall } from "../../lib/call-session";
import { CallCard } from "./CallCard";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values),
  }),
}));
vi.mock("@rakazo/ui-web", () => ({
  BotAvatar: () => null,
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
  defaultBotAvatarValue: () => "",
  Button: ({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn(), useParams: () => ({}) }));
let session: CallState | null = null;
vi.mock("../../lib/call-session", () => ({
  endCall: vi.fn(),
  setCallMinimized: vi.fn(),
  toggleMute: vi.fn(),
  toggleTranscript: vi.fn(),
  useCallSession: () => session,
}));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let composer: HTMLTextAreaElement;
/** Below md the call view covers the app. */
function viewport(width: number) {
  vi.stubGlobal("innerWidth", width);
  vi.stubGlobal("matchMedia", () => ({
    matches: width < 768,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}
/** Base UI moves focus a microtask and an animation frame after a change. */
async function flushFocus() {
  await act(() => vi.advanceTimersByTimeAsync(50));
}
function render(call: Partial<CallState> | null) {
  session = call
    ? ({
        botId: "bot-1",
        botName: "Test bot",
        phase: "listening",
        exchanges: [],
        ...call,
      } as CallState)
    : null;
  act(() => root.render(<CallCard onSettings={vi.fn()} />));
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  container = document.createElement("div");
  composer = document.createElement("textarea");
  document.body.append(container, composer);
  composer.focus();
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  composer.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("takes focus on a phone screen, shuts out the app behind it, and gives focus back", async () => {
  viewport(375);
  render({});
  await flushFocus();
  const view = document.querySelector('[data-testid="call-view"]');
  expect(view?.getAttribute("role")).toBe("dialog");
  expect(view?.contains(document.activeElement)).toBe(true);
  expect(composer.closest('[aria-hidden="true"]')).not.toBeNull();
  render({ minimized: true });
  await flushFocus();
  expect(document.activeElement).toBe(composer);
  expect(composer.closest('[aria-hidden="true"]')).toBeNull();
});

it("still hangs up on Escape on a phone screen", async () => {
  viewport(375);
  render({});
  await flushFocus();
  act(() => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
  expect(endCall).toHaveBeenCalledOnce();
});

it("leaves focus in the app beside the desktop card", async () => {
  viewport(1024);
  render({});
  await flushFocus();
  expect(container.querySelector('[data-testid="call-view"]')).not.toBeNull();
  expect(document.activeElement).toBe(composer);
  expect(composer.closest('[aria-hidden="true"]')).toBeNull();
});
