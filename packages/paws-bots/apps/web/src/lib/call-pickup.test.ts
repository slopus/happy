import { afterEach, expect, it, vi } from "vitest";
import { pickUp } from "./call-pickup.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("stops ringing immediately on abort and releases a late microphone grant", async () => {
  vi.useFakeTimers();
  const stopTone = vi.fn();
  const close = vi.fn(async () => undefined);
  vi.stubGlobal(
    "AudioContext",
    class {
      currentTime = 0;
      destination = {};
      createOscillator() {
        return { frequency: { value: 0 }, connect: vi.fn(), start: vi.fn(), stop: stopTone };
      }
      createGain() {
        return { gain: { value: 0, setValueAtTime: vi.fn() }, connect: vi.fn() };
      }
      close = close;
    },
  );
  let grant!: (stream: MediaStream) => void;
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: () =>
        new Promise<MediaStream>((resolve) => {
          grant = resolve;
        }),
    },
  });
  const controller = new AbortController();
  const pending = pickUp(controller.signal);
  controller.abort();
  expect(stopTone).toHaveBeenCalledOnce();
  const stopTrack = vi.fn();
  grant({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream);
  await pending;
  expect(stopTrack).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});
