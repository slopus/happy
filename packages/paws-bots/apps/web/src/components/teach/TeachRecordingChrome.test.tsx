// @vitest-environment jsdom

import type { TaughtSkill } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { enqueueTeachComputerInput } from "./teach-computer-input-chain";

const computerInput = vi.hoisted(() => vi.fn());
vi.mock("../../lib/rpc", () => ({
  rpc: { computer: { input: computerInput } },
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray) => parts.join("");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
}));

import { TeachRecordingChrome } from "./TeachRecordingChrome";

function recording(id: string): TaughtSkill {
  return {
    id,
    botId: "bot-1",
    name: "Export",
    goal: "Export weekly CRM list",
    status: "recording",
    playbook: {
      whenToUse: "",
      inputs: [],
      steps: [],
      howToCheck: "",
      whatToReturn: "",
      approvalBoundaries: "",
      failureHandling: "",
    },
    recording: { events: [], snapshots: [] },
    startedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:10:00.000Z",
    stoppedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  return { container, root };
}

async function renderChrome(
  skill: TaughtSkill,
  botId: string,
  variant: "overlay" | "panel" = "overlay",
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { container, root } = mount();
  async function draw(next: TaughtSkill) {
    await act(async () => {
      root.render(
        <TeachRecordingChrome
          recording={next}
          botId={botId}
          onStop={() => undefined}
          variant={variant}
        />,
      );
    });
  }
  await draw(skill);
  return {
    container,
    rerender: draw,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}

function field(container: HTMLElement) {
  const input = container.querySelector('[data-testid="teach-protected-input"] input');
  if (!(input instanceof HTMLInputElement)) throw new Error("missing protected input");
  return input;
}

function submit(container: HTMLElement) {
  const button = container.querySelector('[data-testid="teach-protected-input"] button');
  if (!(button instanceof HTMLButtonElement)) throw new Error("missing protected submit");
  return button;
}

async function typeProtected(container: HTMLElement, value: string) {
  const input = field(container);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  computerInput.mockReset();
  computerInput.mockResolvedValue({ ok: true });
});

it("shows protected input in the recording chrome", async () => {
  const view = await renderChrome(recording("skill-visible"), "bot-visible");
  try {
    const form = view.container.querySelector('[data-testid="teach-protected-input"]');
    expect(form).toBeTruthy();
    expect(view.container.querySelector('[data-testid="teach-recording-overlay"] form')).toBe(form);
    expect(form?.className).not.toContain("absolute");
    expect(view.container.textContent).toContain("Use Protected input for passwords.");
    expect(field(view.container).getAttribute("aria-label")).toBe("Protected input");
    expect(submit(view.container).getAttribute("aria-label")).toBe("Type without recording");
  } finally {
    await view.cleanup();
  }
});

it("shows protected input in the panel variant", async () => {
  const view = await renderChrome(recording("skill-panel"), "bot-panel", "panel");
  try {
    expect(
      view.container.querySelector(
        '[data-testid="teach-recording"] [data-testid="teach-protected-input"]',
      ),
    ).toBeTruthy();
  } finally {
    await view.cleanup();
  }
});

it("clears protected input after the sandbox accepts it", async () => {
  const view = await renderChrome(recording("skill-ok"), "bot-ok");
  try {
    await typeProtected(view.container, "pw-fixture");
    await act(async () => {
      submit(view.container).click();
      await Promise.resolve();
      await computerInput.mock.results[0]?.value;
    });
    expect(computerInput).toHaveBeenCalledWith({
      botId: "bot-ok",
      kind: "clipboard",
      payload: { text: "pw-fixture", sensitive: true, skillId: "skill-ok" },
    });
    expect(field(view.container).value).toBe("");
  } finally {
    await view.cleanup();
  }
});

it("keeps protected input when the sandbox request fails", async () => {
  computerInput.mockRejectedValueOnce(new Error("offline"));
  const view = await renderChrome(recording("skill-fail"), "bot-fail");
  try {
    await typeProtected(view.container, "pw-fixture");
    await act(async () => {
      submit(view.container).click();
      await Promise.resolve();
      await computerInput.mock.results[0]?.value.catch(() => undefined);
    });
    expect(field(view.container).value).toBe("pw-fixture");
    expect(submit(view.container).disabled).toBe(false);
  } finally {
    await view.cleanup();
  }
});

it("drops a queued protected submit when recording ends or the skill changes", async () => {
  const botId = "bot-queued";
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocked = enqueueTeachComputerInput(botId, () => gate);
  const view = await renderChrome(recording("skill-a"), botId);
  try {
    await typeProtected(view.container, "pw-fixture");
    await act(async () => {
      submit(view.container).click();
    });
    expect(computerInput).not.toHaveBeenCalled();

    await view.rerender(recording("skill-b"));
    await act(async () => {
      release();
      await blocked;
      await enqueueTeachComputerInput(botId, async () => undefined);
    });
    expect(computerInput).not.toHaveBeenCalled();

    await typeProtected(view.container, "next-fixture");
    await act(async () => {
      submit(view.container).click();
      await Promise.resolve();
      await computerInput.mock.results[0]?.value;
    });
    expect(computerInput).toHaveBeenCalledTimes(1);
    expect(computerInput).toHaveBeenCalledWith({
      botId,
      kind: "clipboard",
      payload: { text: "next-fixture", sensitive: true, skillId: "skill-b" },
    });
  } finally {
    release();
    await blocked.catch(() => undefined);
    await view.cleanup();
  }
});

it("drops a queued protected submit when the chrome unmounts", async () => {
  const botId = "bot-unmount";
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocked = enqueueTeachComputerInput(botId, () => gate);
  const view = await renderChrome(recording("skill-unmount"), botId);
  await typeProtected(view.container, "pw-fixture");
  await act(async () => {
    submit(view.container).click();
  });
  await view.cleanup();
  await act(async () => {
    release();
    await blocked;
    await enqueueTeachComputerInput(botId, async () => undefined);
  });
  expect(computerInput).not.toHaveBeenCalled();
});
