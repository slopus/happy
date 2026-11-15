import { describe, expect, it } from "vitest";
import type { Situation } from "./simulated-user.js";
import { parseMove, screenStepLog } from "./simulated-user.js";

const chat: Situation = { kind: "chat" };
const approval: Situation = {
  kind: "card",
  ask: { text: "Place order?", actions: [{ id: "allow", label: "Allow" }] },
};
const screen: Situation = {
  kind: "screen",
  image: { name: "screen.png", mimeType: "image/png", data: new Uint8Array() },
  width: 1280,
  height: 800,
  steps: [],
};

describe("simulated user moves", () => {
  it("reads a JSON move even when the model wraps it in prose", () => {
    expect(parseMove('Sure.\n{"kind":"say","text":" Do my shopping "}', chat)).toEqual({
      kind: "say",
      text: "Do my shopping",
    });
  });

  it("only presses buttons that are on the pending card", () => {
    expect(parseMove('{"kind":"choose","actionId":"allow"}', approval)).toEqual({
      kind: "choose",
      actionId: "allow",
    });
    expect(() => parseMove('{"kind":"choose","actionId":"always"}', approval)).toThrow();
    expect(() => parseMove('{"kind":"choose","actionId":"allow"}', chat)).toThrow();
  });

  it("keeps a login username with the secret, only on a card", () => {
    const move = '{"kind":"secret","value":"pw","username":"shopper@example.test"}';
    expect(parseMove(move, approval)).toEqual({
      kind: "secret",
      value: "pw",
      username: "shopper@example.test",
    });
    expect(() => parseMove(move, chat)).toThrow();
  });

  it("allows screen actions only while holding the screen, inside its bounds", () => {
    expect(parseMove('{"kind":"click","x":640.4,"y":20}', screen)).toEqual({
      kind: "click",
      x: 640,
      y: 20,
    });
    expect(parseMove('{"kind":"key","key":"Return"}', screen)).toEqual({
      kind: "key",
      key: "Return",
    });
    expect(parseMove('{"kind":"release"}', screen)).toEqual({ kind: "release" });
    expect(() => parseMove('{"kind":"click","x":2000,"y":20}', screen)).toThrow();
    expect(() => parseMove('{"kind":"key","key":"a; rm -rf"}', screen)).toThrow();
    expect(() => parseMove('{"kind":"say","text":"hi"}', screen)).toThrow();
    expect(() => parseMove('{"kind":"release"}', chat)).toThrow();
  });

  it("takes only the first move when the model plans several", () => {
    expect(
      parseMove('{"kind":"type","text":"a}b\\"c"}\n{"kind":"key","key":"Return"}', screen),
    ).toEqual({ kind: "type", text: 'a}b"c' });
  });

  it("rejects empty or unknown moves", () => {
    expect(() => parseMove('{"kind":"say","text":"  "}', chat)).toThrow();
    expect(() => parseMove('{"kind":"wave"}', chat)).toThrow();
    expect(() => parseMove("no json", chat)).toThrow();
  });

  it("marks only the step that left the screen unchanged, per takeover", () => {
    const a = new Uint8Array([1]);
    const b = new Uint8Array([2]);
    const log = screenStepLog();
    log.saw(a);
    log.did("click 1,1");
    log.saw(a);
    log.did("typed 3 characters");
    log.saw(b);
    log.did("pressed Return");
    log.saw(b);
    expect(log.steps).toEqual([
      "click 1,1 (nothing on screen changed)",
      "typed 3 characters",
      "pressed Return (nothing on screen changed)",
    ]);
    log.did("pressed Return");
    expect(log.steps.at(-1)).toBe("pressed Return");
    log.did("click 10,20", { x: 10, y: 20 });
    log.did("click 10,200", { x: 10, y: 200 });
    log.did("click 10,200", { x: 10, y: 200 });
    expect(log.steps.slice(-3)).toEqual([
      "click 10,20",
      "click 10,200",
      "click 10,200 (same click as your previous step)",
    ]);
    const next = screenStepLog();
    next.saw(b);
    expect(next.steps).toEqual([]);
  });
});
