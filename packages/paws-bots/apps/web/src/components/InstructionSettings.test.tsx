// @vitest-environment jsdom
import type { Bot } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ restoreInstructions: vi.fn() }));
vi.mock("../lib/rpc", () => ({ rpc: { bots: api } }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));

import { InstructionSettings } from "./InstructionSettings";

it("keeps history behind its label action and restores with the current baseline", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const bot = {
    id: "fixture",
    instructions: "Current",
    instructionHistory: [
      {
        id: "version",
        instructions: "Earlier",
        createdAt: "2026-10-01T00:00:00Z",
        reason: "Manual edit",
      },
    ],
  } as Bot;
  api.restoreInstructions.mockResolvedValue({ ...bot, instructions: "Earlier" });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<InstructionSettings bot={bot} />));
    expect(document.body.textContent).not.toContain("Manual edit");
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="Instruction history"]')!.click(),
    );
    expect(document.body.textContent).toContain("Manual edit");
    await act(async () =>
      [...document.body.querySelectorAll("button")]
        .find((button) => button.textContent === "Restore")!
        .click(),
    );
    expect(api.restoreInstructions).toHaveBeenCalledWith({
      botId: "fixture",
      versionId: "version",
      expectedInstructions: "Current",
    });
    expect(host.querySelector("textarea")?.value).toBe("Earlier");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
