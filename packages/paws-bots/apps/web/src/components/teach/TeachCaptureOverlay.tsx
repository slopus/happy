import { listenWindow } from "../../paws/runtime";
import type { TaughtSkill } from "@rakazo/contracts";
import { DEFAULT_COMPUTER_SCREEN, mapTeachPointer, teachCaptureKey } from "@rakazo/core";
import { useEffect, useRef } from "react";
import { rpc } from "../../lib/rpc";
import { enqueueTeachComputerInput } from "./teach-computer-input-chain";

export function TeachCaptureOverlay({
  botId,
  skill,
  enabled,
  screenWidth,
  screenHeight,
}: {
  botId: string;
  skill: TaughtSkill | null;
  enabled: boolean;
  screenWidth?: number;
  screenHeight?: number;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const width = screenWidth ?? DEFAULT_COMPUTER_SCREEN.width;
  const height = screenHeight ?? DEFAULT_COMPUTER_SCREEN.height;

  useEffect(() => {
    if (!enabled || !skill || skill.status !== "recording") return;
    const overlay = rootRef.current;
    if (!overlay) return;
    const target: HTMLDivElement = overlay;

    function enqueueInput(task: () => Promise<void>) {
      void enqueueTeachComputerInput(botId, task);
    }

    function pointerAt(event: MouseEvent) {
      return mapTeachPointer(event.clientX, event.clientY, target.getBoundingClientRect(), {
        width,
        height,
      });
    }

    async function sendPointer(
      type: "move" | "down" | "up" | "click",
      x: number,
      y: number,
      button: "left" | "right" = "left",
    ) {
      await rpc.computer.input({
        botId,
        kind: "pointer",
        payload: { x, y, button, type },
      });
    }

    async function sendKey(key: string) {
      await rpc.computer.input({ botId, kind: "key", payload: { key } });
    }

    async function sendScroll(
      direction: "up" | "down" | "left" | "right",
      amount: number,
      x: number,
      y: number,
    ) {
      await rpc.computer.input({
        botId,
        kind: "scroll",
        payload: { direction, amount, x, y },
      });
    }

    function buttonFor(event: PointerEvent): "left" | "right" {
      return event.button === 2 ? "right" : "left";
    }

    function onPointerDown(event: PointerEvent) {
      event.preventDefault();
      target.setPointerCapture(event.pointerId);
      const { x, y } = pointerAt(event);
      enqueueInput(() => sendPointer("down", x, y, buttonFor(event)));
    }

    // Each input is one request, one recording write and one sandbox action, so a raw pointer
    // stream would queue faster than it drains. Keep only the newest position and send it once
    // the previous one has landed.
    let pendingMove: { x: number; y: number; button: "left" | "right" } | null = null;
    let moveInFlight = false;

    function pumpMove() {
      if (moveInFlight || !pendingMove) return;
      const move = pendingMove;
      pendingMove = null;
      moveInFlight = true;
      enqueueInput(async () => {
        try {
          await sendPointer("move", move.x, move.y, move.button);
        } finally {
          moveInFlight = false;
          pumpMove();
        }
      });
    }

    function onPointerMove(event: PointerEvent) {
      if (!event.buttons) return;
      event.preventDefault();
      const { x, y } = pointerAt(event);
      pendingMove = { x, y, button: event.buttons === 2 ? "right" : "left" };
      pumpMove();
    }

    function onPointerUp(event: PointerEvent) {
      event.preventDefault();
      if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
      const { x, y } = pointerAt(event);
      const button = buttonFor(event);
      const dragged = pendingMove !== null;
      pendingMove = null;
      // The final position has to reach the sandbox before the release; dropped intermediate
      // moves are fine, a release at a stale position is not.
      if (dragged) enqueueInput(() => sendPointer("move", x, y, button));
      enqueueInput(() => sendPointer("up", x, y, button));
    }

    function onWheel(event: WheelEvent) {
      event.preventDefault();
      // A mostly sideways wheel or trackpad swipe scrolls left or right.
      const sideways = Math.abs(event.deltaX) > Math.abs(event.deltaY);
      const delta = sideways ? event.deltaX : event.deltaY;
      const direction = sideways ? (delta < 0 ? "left" : "right") : delta < 0 ? "up" : "down";
      const amount = Math.min(20, Math.max(1, Math.round(Math.abs(delta) / 80) || 1));
      // The computer scrolls what is under the same point on its screen.
      const { x, y } = pointerAt(event);
      enqueueInput(() => sendScroll(direction, amount, x, y));
    }

    function onKeyDown(event: KeyboardEvent) {
      // Keys aimed at page controls (the Stop teaching button, dialogs) must keep working;
      // only keystrokes with no other target belong to the demo.
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("button, input, textarea, select, a, [contenteditable]")
      ) {
        return;
      }
      const key = teachCaptureKey(event.key, event);
      if (!key) return;
      event.preventDefault();
      enqueueInput(() => sendKey(key));
    }

    function onContextMenu(event: Event) {
      event.preventDefault();
    }

    target.addEventListener("pointerdown", onPointerDown);
    target.addEventListener("pointermove", onPointerMove);
    target.addEventListener("pointerup", onPointerUp);
    target.addEventListener("pointercancel", onPointerUp);
    target.addEventListener("wheel", onWheel, { passive: false });
    target.addEventListener("contextmenu", onContextMenu);
    listenWindow("keydown", onKeyDown);
    return () => {
      target.removeEventListener("pointerdown", onPointerDown);
      target.removeEventListener("pointermove", onPointerMove);
      target.removeEventListener("pointerup", onPointerUp);
      target.removeEventListener("pointercancel", onPointerUp);
      target.removeEventListener("wheel", onWheel);
      target.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [botId, enabled, height, skill, width]);

  if (!enabled || !skill || skill.status !== "recording") return null;

  return (
    <div
      ref={rootRef}
      data-testid="teach-capture-overlay"
      role="presentation"
      className="absolute inset-0 z-10 cursor-crosshair bg-transparent"
    />
  );
}
