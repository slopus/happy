import type { RakazoDesktopSpeechEvent } from "@rakazo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopSpeechRecognition } from "./desktop-speech.js";
import { Dictation } from "./dictation.js";

function fakeSpeech(started: () => Promise<boolean> = async () => true) {
  const listeners = new Set<(event: RakazoDesktopSpeechEvent) => void>();
  const speech = {
    start: vi.fn((_language: string, _session: number) => started()),
    stop: vi.fn(async (_session: number) => undefined),
    abort: vi.fn(async (_session: number) => undefined),
    onEvent: vi.fn((listener: (event: RakazoDesktopSpeechEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
  };
  const emit = (event: RakazoDesktopSpeechEvent) => {
    for (const listener of [...listeners]) listener(event);
  };
  const session = () => speech.start.mock.calls.at(-1)?.[1] ?? 0;
  return { speech, emit, session, listeners };
}

function useDesktop(speech: ReturnType<typeof fakeSpeech>["speech"]) {
  vi.stubGlobal("window", { rakazoDesktop: { platform: "darwin", speech } });
  vi.stubGlobal("navigator", { language: "es-CL", userAgent: "Mozilla/5.0 Electron/45.0.0" });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("DesktopSpeechRecognition", () => {
  let desktop: ReturnType<typeof fakeSpeech>;

  beforeEach(() => {
    desktop = fakeSpeech();
    useDesktop(desktop.speech);
  });

  it("reports the session's text, errors and end the way Web Speech does", () => {
    const rec = new DesktopSpeechRecognition();
    const results: string[] = [];
    rec.onresult = (event) =>
      results.push(Array.from(event.results, (result) => result[0]?.transcript).join(" "));
    rec.onerror = vi.fn();
    rec.onend = vi.fn();
    rec.lang = "es-CL";
    rec.start();
    const session = desktop.session();
    expect(desktop.speech.start).toHaveBeenCalledWith("es-CL", session);

    desktop.emit({ session: session + 1, type: "result", text: "otra sesión" });
    desktop.emit({ session, type: "result", text: "hola" });
    desktop.emit({ session, type: "result", text: "hola mundo" });
    desktop.emit({ session, type: "error", error: "no-speech" });
    desktop.emit({ session, type: "end" });

    expect(results).toEqual(["hola", "hola mundo"]);
    expect(rec.onerror).toHaveBeenCalledWith({ error: "no-speech" });
    expect(rec.onend).toHaveBeenCalledTimes(1);
    expect(desktop.listeners.size).toBe(0);
  });

  it("starts a new session after the last one ended", () => {
    const rec = new DesktopSpeechRecognition();
    rec.start();
    const first = desktop.session();
    expect(() => rec.start()).toThrow();
    desktop.emit({ session: first, type: "end" });
    rec.start();
    expect(desktop.session()).not.toBe(first);
  });

  it.each([
    ["refuses", async () => false],
    ["fails", () => Promise.reject(new Error("IPC closed"))],
  ])("ends like a refused service when the desktop %s to start", async (_label, started) => {
    desktop = fakeSpeech(started);
    useDesktop(desktop.speech);
    const rec = new DesktopSpeechRecognition();
    rec.onerror = vi.fn();
    rec.onend = vi.fn();
    rec.start();
    await vi.waitFor(() => expect(rec.onend).toHaveBeenCalledTimes(1));
    expect(rec.onerror).toHaveBeenCalledWith({ error: "service-not-allowed" });
  });

  it("asks for the final text on stop and drops the session on abort", () => {
    const rec = new DesktopSpeechRecognition();
    rec.onend = vi.fn();
    rec.start();
    const session = desktop.session();
    rec.stop();
    expect(desktop.speech.stop).toHaveBeenCalledWith(session);

    rec.abort();
    expect(desktop.speech.abort).toHaveBeenCalledWith(session);
    desktop.emit({ session, type: "end" });
    expect(rec.onend).not.toHaveBeenCalled();
  });
});

describe("Dictation on the desktop app", () => {
  let desktop: ReturnType<typeof fakeSpeech>;

  beforeEach(() => {
    desktop = fakeSpeech();
    useDesktop(desktop.speech);
  });

  it("dictates through the system recognizer without a voice provider", async () => {
    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", transcribe: false, onFinal });
    const session = desktop.session();
    expect(desktop.speech.start).toHaveBeenCalledTimes(1);

    desktop.emit({ session, type: "result", text: "Hola, ¿cómo estás?" });
    expect(dictation.state).toEqual({ status: "listening", transcript: "Hola, ¿cómo estás?" });

    dictation.submitHold();
    expect(onFinal).toHaveBeenCalledWith("Hola, ¿cómo estás?");
    expect(desktop.speech.stop).toHaveBeenCalledWith(session);
  });

  it("keeps listening across the recognizer's own pauses in a call", async () => {
    vi.useFakeTimers();
    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({ mode: "endpoint", transcribe: false, onFinal });
    const first = desktop.session();
    desktop.emit({ session: first, type: "result", text: "quiero saber" });
    desktop.emit({ session: first, type: "end" });
    const second = desktop.session();
    expect(second).not.toBe(first);

    desktop.emit({ session: second, type: "result", text: "el clima de mañana" });
    await vi.advanceTimersByTimeAsync(1_300);
    expect(onFinal).toHaveBeenCalledWith("quiero saber el clima de mañana");
  });

  it("explains where to allow dictation after macOS refused it", async () => {
    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", transcribe: false, onFinal: () => undefined });
    desktop.emit({ session: desktop.session(), type: "error", error: "not-allowed" });
    expect(dictation.state.error).toBe(
      "Allow Rakazo to use Speech Recognition and the microphone in System Settings.",
    );
  });
});
