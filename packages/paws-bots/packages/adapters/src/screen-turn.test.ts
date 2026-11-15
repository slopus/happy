import { describe, expect, it } from "vitest";
import type { ScreenControl, ScreenTurn } from "./screen-turn.js";
import {
  awaitScreenTurn,
  PERSON_HANDED_BACK,
  PERSON_HAS_CONTROL,
  SCREEN_WAIT_MS,
} from "./screen-turn.js";

/** A clock that only moves when the gate sleeps, and the control it reads at each moment. */
function scripted(control: (at: number) => ScreenControl | null) {
  let at = 0;
  const reads: number[] = [];
  return {
    reads,
    readControl: async () => {
      reads.push(at);
      return control(at);
    },
    sleep: async (ms: number) => {
      at += ms;
    },
    now: () => at,
  };
}

const freshTurn = (): ScreenTurn => ({ controlFence: undefined, mustLook: false });
/** A screenshot or snapshot returned the screen, as the screen tools record it. */
const seen = (turn: ScreenTurn) => {
  turn.mustLook = false;
};
const free = (fence = 1): ScreenControl => ({ held: false, fence });
const held = (fence = 1): ScreenControl => ({ held: true, fence });

describe("a bot's screen turn", () => {
  it("acts at once on a screen nobody holds", async () => {
    const clock = scripted(() => free());
    expect(await awaitScreenTurn({ turn: freshTurn(), look: false, ...clock })).toBeUndefined();
    expect(clock.reads).toEqual([0]);
  });

  it("refuses, never queues, an action while a person keeps control past the wait", async () => {
    const clock = scripted(() => held());
    const turn = freshTurn();
    expect(await awaitScreenTurn({ turn, look: false, ...clock })).toBe(PERSON_HAS_CONTROL);
    expect(clock.now()).toBe(SCREEN_WAIT_MS);
    // The screen may have changed meanwhile, so the next action looks first.
    expect(turn.mustLook).toBe(true);
  });

  it("does not perform an action that waited, and asks for a fresh look", async () => {
    const clock = scripted((at) => (at < 5_000 ? held() : free()));
    const turn = freshTurn();
    expect(await awaitScreenTurn({ turn, look: false, ...clock })).toBe(PERSON_HANDED_BACK);
    expect(clock.now()).toBe(5_000);
    // Still not performed on a retry until the bot has looked.
    expect(await awaitScreenTurn({ turn, look: false, ...clock })).toBe(PERSON_HANDED_BACK);
    expect(await awaitScreenTurn({ turn, look: true, ...clock })).toBeUndefined();
    seen(turn);
    expect(await awaitScreenTurn({ turn, look: false, ...clock })).toBeUndefined();
  });

  it("lets a screenshot through once control returns, and still asks until one succeeds", async () => {
    const clock = scripted((at) => (at < 2_000 ? held() : free()));
    const turn = freshTurn();
    expect(await awaitScreenTurn({ turn, look: true, ...clock })).toBeUndefined();
    // The screenshot failed, so the bot has still not seen the screen.
    expect(await awaitScreenTurn({ turn, look: false, ...clock })).toBe(PERSON_HANDED_BACK);
  });

  it("asks for a fresh look when a person took and handed back control between actions", async () => {
    let fence = 1;
    const clock = scripted(() => free(fence));
    const turn = freshTurn();
    expect(await awaitScreenTurn({ turn, look: false, ...clock })).toBeUndefined();
    fence = 2;
    expect(await awaitScreenTurn({ turn, look: false, ...clock })).toBe(PERSON_HANDED_BACK);
    expect(await awaitScreenTurn({ turn, look: true, ...clock })).toBeUndefined();
    seen(turn);
    expect(await awaitScreenTurn({ turn, look: false, ...clock })).toBeUndefined();
  });
});
