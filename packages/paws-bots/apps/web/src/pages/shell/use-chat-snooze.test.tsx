// @vitest-environment jsdom
import type { Bot, Group, Space } from "@rakazo/contracts";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { createSpaceRpc } from "../../lib/rpc";
import type { SnoozeChat } from "./use-chat-snooze";
import { useChatSnooze } from "./use-chat-snooze";

const toast = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("@rakazo/ui-web", () => ({ toast }));
vi.mock("../../lib/rpc", () => ({ rpcForSpace: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("puts a chat back to what the server saved when a snooze and its quick undo both fail", async () => {
  const calls: Array<{ reject: (error: Error) => void }> = [];
  const rpc = {
    threads: {
      snooze: () => new Promise((_resolve, reject) => calls.push({ reject })),
    },
  } as unknown as ReturnType<typeof createSpaceRpc>;
  const refreshBots = vi.fn(async () => undefined);
  let state: { bots: Bot[]; snooze: SnoozeChat } | undefined;
  function Harness() {
    const [bots, setBots] = useState([{ id: "bot", spaceId: "space", snoozedUntil: null } as Bot]);
    const [, setGroups] = useState<Group[]>([]);
    const [, setSpaces] = useState<Space[]>([]);
    const snooze = useChatSnooze({
      rpc,
      openSpaceId: "space",
      setBots,
      setGroups,
      setSpaces,
      refreshBots,
    });
    state = { bots, snooze };
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Harness)));
  const chat = { kind: "bot" as const, id: "bot", spaceId: "space" };

  const tomorrow = "2026-11-08T09:00:00.000Z";
  await act(async () => state!.snooze({ ...chat, snoozedUntil: null }, tomorrow));
  await act(async () => state!.snooze({ ...chat, snoozedUntil: tomorrow }, null));
  expect(state!.bots[0]!.snoozedUntil).toBeNull();

  // The snooze fails; the undo, sent after it, fails too.
  await act(async () => calls[0]!.reject(new Error("offline")));
  await act(async () => calls[1]!.reject(new Error("offline")));

  expect(state!.bots[0]!.snoozedUntil).toBeNull();
  expect(toast.error).toHaveBeenCalledTimes(1);
  expect(refreshBots).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
});
