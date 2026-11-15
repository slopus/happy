import { MAX_TRANSCRIPTION_RESPONSE_BYTES, VOICE_RESPONSE_TIMEOUT_MS } from "@rakazo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  combineTranscript,
  Dictation,
  MAX_ENDPOINT_RECORDING_MS,
  transcriptionLanguage,
  webSpeechAvailable,
  webSpeechNeedsServerFallback,
} from "./dictation.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function stubRecorderFallback(fetchMock: ReturnType<typeof vi.fn>) {
  const track = { stop: vi.fn() };
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
    },
    language: "en-US",
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal(
    "MediaRecorder",
    class {
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
        this.onstop?.();
      }
    },
  );
}

describe("Dictation recorder fallback", () => {
  it("stops tracks if hold-to-talk is cancelled while the mic prompt is open", async () => {
    const track = { stop: vi.fn() };
    let grant!: (stream: { getTracks: () => Array<{ stop: () => void }> }) => void;
    const pending = new Promise<{ getTracks: () => Array<{ stop: () => void }> }>((resolve) => {
      grant = resolve;
    });
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(() => pending) },
      language: "en-US",
    });
    const started = vi.fn();
    vi.stubGlobal(
      "MediaRecorder",
      class {
        state = "inactive";
        start() {
          started();
          this.state = "recording";
        }
        stop() {
          this.state = "inactive";
        }
      },
    );

    const dictation = new Dictation();
    const listening = dictation.listen({
      mode: "hold",
      transcribe: true,
      onFinal: () => undefined,
    });
    dictation.stop("cancel");
    grant({ getTracks: () => [track] });
    await listening;

    expect(track.stop).toHaveBeenCalledOnce();
    expect(started).not.toHaveBeenCalled();
    expect(dictation.state.status).toBe("idle");
  });

  it("does not deliver a stale transcript to a newer session", async () => {
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });

    let transcribe!: (body: { text: string }) => void;
    const fetchMock = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("Aborted"), { name: "AbortError" })),
          );
          transcribe = (body) => resolve(Response.json(body));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    class FakeRecorder {
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);

    const first = vi.fn();
    const second = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", transcribe: true, onFinal: first });
    dictation.submitHold();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    await dictation.listen({ mode: "hold", transcribe: true, onFinal: second });
    transcribe({ text: "stale take" });
    await Promise.resolve();
    await Promise.resolve();

    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(dictation.state.status).toBe("listening");
  });

  it("keeps line breaks in a server transcript with no speech prefix", async () => {
    const fetchMock = vi.fn(async () => Response.json({ text: "  line one\n\nline two  " }));
    stubRecorderFallback(fetchMock);
    const onFinal = vi.fn();
    const dictation = new Dictation();

    await dictation.listen({ mode: "hold", transcribe: true, onFinal });
    dictation.submitHold();

    await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith("line one\n\nline two"));
  });

  it("keeps transcription in the space where recording started", async () => {
    const store = new Map<string, string>([["rakazo:space-id", "space-support"]]);
    const localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    };
    vi.stubGlobal("window", { localStorage });
    vi.stubGlobal("localStorage", localStorage);

    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ text: "hello" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    class FakeRecorder {
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);

    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", transcribe: true, onFinal });
    store.set("rakazo:space-id", "space-other");
    dictation.submitHold();
    await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith("hello"));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/voice/transcribe",
      expect.objectContaining({ credentials: "include" }),
    );
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-rakazo-space-id")).toBe("space-support");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("sends Android to the server before the voice status has loaded", async () => {
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/141 Mobile Safari/537.36",
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });
    const fetchMock = vi.fn(async () => Response.json({ text: "hola, una prueba" }));
    vi.stubGlobal("fetch", fetchMock);

    class FakeRecorder {
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);

    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", onFinal });
    dictation.submitHold();
    await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith("hola, una prueba"));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/voice/transcribe",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it.each([
    [
      "iOS Safari",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    ],
    [
      "iPadOS desktop-style Safari",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    ],
  ])("prefers the server on %s with Web Speech available", async (_browser, userAgent) => {
    const recognition = vi.fn();
    vi.stubGlobal("window", { webkitSpeechRecognition: recognition });
    expect(webSpeechAvailable()).toBe(true);
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      userAgent,
      maxTouchPoints: 5,
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "es-ES",
    });
    const fetchMock = vi.fn(async () => Response.json({ text: "hola otra vez" }));
    vi.stubGlobal("fetch", fetchMock);

    class FakeRecorder {
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/mp4" }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);

    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", onFinal });
    expect(recognition).not.toHaveBeenCalled();
    expect(dictation.state.status).toBe("listening");
    dictation.submitHold();
    await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith("hola otra vez"));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/voice/transcribe",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(track.stop).toHaveBeenCalled();
  });

  it("tells the provider which language the caller speaks", async () => {
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/141 Mobile Safari/537.36",
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "es-ES",
    });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ text: "hola" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    class FakeRecorder {
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);

    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", onFinal });
    dictation.submitHold();
    await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith("hola"));

    const sent = fetchMock.mock.calls[0]?.[1] as { body?: string } | undefined;
    expect(JSON.parse(String(sent?.body)).language).toBe("es");
  });

  it("rejects oversized transcription responses without waiting for cancellation", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const fetchMock = vi.fn(
      async () =>
        new Response(new ReadableStream({ cancel }), {
          headers: { "content-length": String(MAX_TRANSCRIPTION_RESPONSE_BYTES + 1) },
        }),
    );
    stubRecorderFallback(fetchMock);
    const dictation = new Dictation();

    await dictation.listen({ mode: "hold", transcribe: true, onFinal: () => undefined });
    dictation.submitHold();

    await vi.waitFor(() =>
      expect(dictation.state.error).toBe("Transcription response is too large."),
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("times out while a transcription response body is stalled", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            pull: () => new Promise<void>(() => undefined),
          }),
        ),
    );
    stubRecorderFallback(fetchMock);
    const dictation = new Dictation();

    await dictation.listen({ mode: "hold", transcribe: true, onFinal: () => undefined });
    dictation.submitHold();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(VOICE_RESPONSE_TIMEOUT_MS);

    expect(dictation.state.error).toBe("Transcription request timed out.");
  });

  it("surfaces timeout when fetch rejects with AbortError", async () => {
    // Browsers reject aborted fetch with DOMException AbortError. Matching token
    // means the deadline fired (stop() bumps token first), so this must not stay
    // stuck on "transcribing".
    const fetchMock = vi.fn(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    stubRecorderFallback(fetchMock);
    const dictation = new Dictation();

    await dictation.listen({ mode: "hold", transcribe: true, onFinal: () => undefined });
    dictation.submitHold();

    await vi.waitFor(() => expect(dictation.state.error).toBe("Transcription request timed out."));
    expect(dictation.state.status).toBe("idle");
  });

  it("stays silent when stop cancels an in-flight transcription", async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            },
            { once: true },
          );
        }),
    );
    stubRecorderFallback(fetchMock);
    const dictation = new Dictation();

    await dictation.listen({ mode: "hold", transcribe: true, onFinal: () => undefined });
    dictation.submitHold();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(dictation.state.status).toBe("transcribing");

    dictation.stop("cancel");
    await Promise.resolve();
    await Promise.resolve();

    expect(dictation.state.status).toBe("idle");
    expect(dictation.state.error).toBeUndefined();
  });

  it("ignores leftover audio from a replaced recorder", async () => {
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });
    const fetchMock = vi.fn(async (_url: string, _init?: { body?: string }) =>
      Response.json({ text: "ok" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const recorders: Array<{
      ondataavailable: ((event: { data: Blob }) => void) | null;
      onstop: (() => void) | null;
      stop: () => void;
    }> = [];
    class FakeRecorder {
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor() {
        recorders.push(this);
      }
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["new"], { type: "audio/webm" }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);

    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", transcribe: true, onFinal: () => undefined });
    await dictation.listen({ mode: "hold", transcribe: true, onFinal: () => undefined });
    recorders[0]?.ondataavailable?.({
      data: new Blob(["STALE-AUDIO-DATA"], { type: "audio/webm" }),
    });
    dictation.submitHold();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "")) as {
      audioBase64: string;
    };
    const decoded = atob(body.audioBase64);
    expect(decoded).toContain("new");
    expect(decoded).not.toContain("STALE");
  });

  it("returns to idle when the recorder cannot start", async () => {
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });
    vi.stubGlobal(
      "MediaRecorder",
      class {
        start() {
          throw new Error("recorder unavailable");
        }
      },
    );

    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", transcribe: true, onFinal: () => undefined });

    expect(dictation.state.status).toBe("idle");
    expect(dictation.state.error).toBe("recorder unavailable");
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("fails visibly when endpoint dictation has no silence detector", async () => {
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });
    const started = vi.fn();
    vi.stubGlobal(
      "MediaRecorder",
      class {
        start() {
          started();
        }
      },
    );

    const dictation = new Dictation();
    await dictation.listen({
      mode: "endpoint",
      transcribe: true,
      onFinal: () => undefined,
    });
    expect(started).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(dictation.state.error).toMatch(/stop talking/i);
  });

  it.each([
    ["recorder fallback", "", 240],
    [
      "phone with Web Speech available",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      undefined,
    ],
  ])("stops an endpoint recording after silence on %s", async (_browser, userAgent, endpointMs) => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const level = { current: 0.6 };
    class FakeAnalyser {
      fftSize = 2048;
      getByteTimeDomainData(data: Uint8Array) {
        data.fill(Math.round(128 + level.current * 127));
      }
    }
    class FakeContext {
      state = "running";
      createMediaStreamSource() {
        return { connect() {} };
      }
      createAnalyser() {
        return new FakeAnalyser();
      }
      close() {
        return Promise.resolve();
      }
      resume() {
        return Promise.resolve();
      }
    }
    vi.stubGlobal("AudioContext", FakeContext);

    const recognition = vi.fn();
    if (userAgent) {
      vi.stubGlobal("window", { webkitSpeechRecognition: recognition });
      expect(webSpeechAvailable()).toBe(true);
    }
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      userAgent,
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });
    const fetchMock = vi.fn(async () => Response.json({ text: "hello" }));
    vi.stubGlobal("fetch", fetchMock);

    const onFinal = vi.fn();
    const stopped = vi.fn();
    class FakeRecorder {
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        this.state = "recording";
      }
      stop() {
        stopped();
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);

    const dictation = new Dictation();
    await dictation.listen({
      mode: "endpoint",
      transcribe: true,
      endpointMs,
      onFinal,
    });
    expect(recognition).not.toHaveBeenCalled();
    expect(dictation.state.status).toBe("listening");
    await vi.advanceTimersByTimeAsync(80);
    level.current = 0;
    await vi.advanceTimersByTimeAsync((endpointMs ?? 1_200) - 80);
    expect(stopped).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onFinal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(80);
    await vi.waitFor(() => expect(onFinal).toHaveBeenCalledExactlyOnceWith("hello"));
    expect(stopped).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "/api/voice/transcribe",
      expect.objectContaining({ method: "POST" }),
    );
    await vi.advanceTimersByTimeAsync(1_200);
    expect(onFinal).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it.each([
    ["a release before the first tick", 0, "running", false],
    ["speech at release between ticks", 80, "running", true],
    ["a context still resuming", 160, "suspended", false],
    ["a context whose resume failed", 160, "suspended", true],
  ])("transcribes %s", async (_label, elapsed, state, speechOrFailure) => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let level = 128;
    const read = vi.fn((data: Uint8Array) => data.fill(level));
    vi.stubGlobal(
      "AudioContext",
      class {
        state = state;
        resume() {
          return speechOrFailure
            ? Promise.reject(new Error("Unavailable"))
            : new Promise<void>(() => {});
        }
        createMediaStreamSource() {
          return { connect() {} };
        }
        createAnalyser() {
          return { fftSize: 2048, getByteTimeDomainData: read };
        }
        close() {
          return Promise.resolve();
        }
      },
    );
    const fetchMock = vi.fn(async () => Response.json({ text: "hello" }));
    stubRecorderFallback(fetchMock);
    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", transcribe: true, onFinal });
    await vi.advanceTimersByTimeAsync(elapsed);
    if (state === "running" && speechOrFailure) level = 200;
    dictation.submitHold();
    await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith("hello"));
    expect(fetchMock).toHaveBeenCalledOnce();
    if (state === "suspended") expect(read).not.toHaveBeenCalled();
    else expect(read).toHaveBeenCalledTimes(elapsed / 80 + 1);
  });

  it("skips a hold recording that never rose above the speech threshold", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const level = { current: 0 };
    class FakeAnalyser {
      fftSize = 2048;
      getByteTimeDomainData(data: Uint8Array) {
        data.fill(Math.round(128 + level.current * 127));
      }
    }
    class FakeContext {
      state = "running";
      createMediaStreamSource() {
        return { connect() {} };
      }
      createAnalyser() {
        return new FakeAnalyser();
      }
      close() {
        return Promise.resolve();
      }
    }
    vi.stubGlobal("AudioContext", FakeContext);
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });
    const fetchMock = vi.fn(async () => Response.json({ text: "Meow!" }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "MediaRecorder",
      class {
        state = "inactive";
        ondataavailable: ((event: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null;
        start() {
          this.state = "recording";
        }
        stop() {
          this.state = "inactive";
          this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
          this.onstop?.();
        }
      },
    );

    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", transcribe: true, onFinal });
    await vi.advanceTimersByTimeAsync(160);
    dictation.submitHold();
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(onFinal).not.toHaveBeenCalled();
    expect(dictation.state.status).toBe("idle");
    expect(dictation.state.error).toMatch(/didn't catch that/i);
    expect(Reflect.get(dictation, "chunks")).toEqual([]);
    expect(Reflect.get(dictation, "media")).toBeNull();
    expect(track.stop).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("transcribes a hold recording that did rise above the speech threshold", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const level = { current: 0.6 };
    class FakeAnalyser {
      fftSize = 2048;
      getByteTimeDomainData(data: Uint8Array) {
        data.fill(Math.round(128 + level.current * 127));
      }
    }
    class FakeContext {
      state = "running";
      createMediaStreamSource() {
        return { connect() {} };
      }
      createAnalyser() {
        return new FakeAnalyser();
      }
      close() {
        return Promise.resolve();
      }
    }
    vi.stubGlobal("AudioContext", FakeContext);
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });
    const fetchMock = vi.fn(async () => Response.json({ text: "hello there" }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "MediaRecorder",
      class {
        state = "inactive";
        ondataavailable: ((event: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null;
        start() {
          this.state = "recording";
        }
        stop() {
          this.state = "inactive";
          this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
          this.onstop?.();
        }
      },
    );

    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", transcribe: true, onFinal });
    await vi.advanceTimersByTimeAsync(160);
    dictation.submitHold();
    await vi.waitFor(() => expect(onFinal).toHaveBeenCalledExactlyOnceWith("hello there"));
    expect(fetchMock).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it.each([
    ["sends a recording that never goes quiet", 0.6, "hello"],
    ["drops a recording that never heard speech", 0, ""],
  ])("%s once it reaches the length cap", async (_case, loudness, final) => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.stubGlobal(
      "AudioContext",
      class {
        state = "running";
        createMediaStreamSource() {
          return { connect() {} };
        }
        createAnalyser() {
          return {
            fftSize: 2048,
            getByteTimeDomainData: (data: Uint8Array) =>
              data.fill(Math.round(128 + loudness * 127)),
          };
        }
        close() {
          return Promise.resolve();
        }
      },
    );
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) },
      language: "en-US",
    });
    const fetchMock = vi.fn(async () => Response.json({ text: "hello" }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "MediaRecorder",
      class {
        state = "inactive";
        ondataavailable: ((event: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null;
        start() {
          this.state = "recording";
        }
        stop() {
          this.state = "inactive";
          this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
          this.onstop?.();
        }
      },
    );

    const onFinal = vi.fn();
    const dictation = new Dictation();
    const seen: boolean[] = [];
    dictation.subscribe(() => seen.push(dictation.recording));
    await dictation.listen({ mode: "endpoint", transcribe: true, onFinal });
    expect(dictation.recording).toBe(true);
    expect(seen.at(-1)).toBe(true);
    vi.setSystemTime(Date.now() + MAX_ENDPOINT_RECORDING_MS - 1_000);
    await vi.advanceTimersByTimeAsync(960);
    expect(onFinal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(80);
    await Promise.resolve();
    expect(onFinal).toHaveBeenCalledExactlyOnceWith(final);
    expect(fetchMock).toHaveBeenCalledTimes(final ? 1 : 0);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(dictation.recording).toBe(false);
  });

  it("does not let a replaced recorder tear down the new silence detector", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const level = { current: 0.6 };
    class FakeAnalyser {
      fftSize = 2048;
      getByteTimeDomainData(data: Uint8Array) {
        data.fill(Math.round(128 + level.current * 127));
      }
    }
    class FakeContext {
      state = "running";
      createMediaStreamSource() {
        return { connect() {} };
      }
      createAnalyser() {
        return new FakeAnalyser();
      }
      close() {
        return Promise.resolve();
      }
      resume() {
        return Promise.resolve();
      }
    }
    vi.stubGlobal("AudioContext", FakeContext);

    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });
    const fetchMock = vi.fn(async () => Response.json({ text: "later" }));
    vi.stubGlobal("fetch", fetchMock);

    const recorders: Array<{
      onstop: (() => void) | null;
      stop: () => void;
    }> = [];
    class FakeRecorder {
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor() {
        recorders.push(this);
      }
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);

    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({
      mode: "endpoint",
      transcribe: true,
      endpointMs: 240,
      onFinal,
    });
    const staleStop = recorders[0]?.onstop;
    await dictation.listen({
      mode: "endpoint",
      transcribe: true,
      endpointMs: 240,
      onFinal,
    });
    staleStop?.();
    await vi.advanceTimersByTimeAsync(80);
    level.current = 0;
    await vi.advanceTimersByTimeAsync(240);
    await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith("later"));
    vi.useRealTimers();
  });

  it.each(["", "   "])(
    "reports an empty final when endpoint transcription hears nothing (%j)",
    async (text) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const level = { current: 0.6 };
      class FakeAnalyser {
        fftSize = 2048;
        getByteTimeDomainData(data: Uint8Array) {
          data.fill(Math.round(128 + level.current * 127));
        }
      }
      class FakeContext {
        state = "running";
        createMediaStreamSource() {
          return { connect() {} };
        }
        createAnalyser() {
          return new FakeAnalyser();
        }
        close() {
          return Promise.resolve();
        }
        resume() {
          return Promise.resolve();
        }
      }
      vi.stubGlobal("AudioContext", FakeContext);

      const track = { stop: vi.fn() };
      vi.stubGlobal("navigator", {
        mediaDevices: {
          getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
        },
        language: "en-US",
      });
      const fetchMock = vi.fn(async () => Response.json({ text }));
      vi.stubGlobal("fetch", fetchMock);
      vi.stubGlobal(
        "MediaRecorder",
        class {
          state = "inactive";
          ondataavailable: ((event: { data: Blob }) => void) | null = null;
          onstop: (() => void) | null = null;
          start() {
            this.state = "recording";
          }
          stop() {
            this.state = "inactive";
            this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
            this.onstop?.();
          }
        },
      );

      const onFinal = vi.fn();
      const dictation = new Dictation();
      await dictation.listen({
        mode: "endpoint",
        transcribe: true,
        endpointMs: 240,
        onFinal,
      });
      // A cough, then the quiet gap whose end stops the recording.
      await vi.advanceTimersByTimeAsync(80);
      level.current = 0;
      await vi.advanceTimersByTimeAsync(240);

      await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith(""));
      expect(onFinal).toHaveBeenCalledOnce();
      expect(dictation.state.status).toBe("idle");
      expect(dictation.state.error).toBeUndefined();
      vi.useRealTimers();
    },
  );

  it("reports an empty final when the endpoint recorder captured no audio", async () => {
    class FakeAnalyser {
      fftSize = 2048;
      getByteTimeDomainData(data: Uint8Array) {
        data.fill(200);
      }
    }
    class FakeContext {
      state = "running";
      createMediaStreamSource() {
        return { connect() {} };
      }
      createAnalyser() {
        return new FakeAnalyser();
      }
      close() {
        return Promise.resolve();
      }
      resume() {
        return Promise.resolve();
      }
    }
    vi.stubGlobal("AudioContext", FakeContext);

    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });
    const fetchMock = vi.fn(async () => Response.json({ text: "never asked" }));
    vi.stubGlobal("fetch", fetchMock);
    const recorders: Array<{ stop: () => void }> = [];
    vi.stubGlobal(
      "MediaRecorder",
      class {
        state = "inactive";
        ondataavailable: ((event: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null;
        constructor() {
          recorders.push(this as unknown as { stop: () => void });
        }
        start() {
          this.state = "recording";
        }
        stop() {
          this.state = "inactive";
          this.onstop?.();
        }
      },
    );

    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({
      mode: "endpoint",
      transcribe: true,
      endpointMs: 240,
      onFinal,
    });
    // The silence detector ended the turn with nothing on tape.
    recorders[0]?.stop();

    await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith(""));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dictation.state.status).toBe("idle");
    expect(dictation.state.error).toBeUndefined();
  });

  it("keeps an empty hold final to itself", async () => {
    const fetchMock = vi.fn(async () => Response.json({ text: "" }));
    stubRecorderFallback(fetchMock);
    const onFinal = vi.fn();
    const dictation = new Dictation();

    await dictation.listen({ mode: "hold", transcribe: true, onFinal });
    dictation.submitHold();

    await vi.waitFor(() => expect(dictation.state.status).toBe("idle"));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(onFinal).not.toHaveBeenCalled();
    expect(dictation.state.error).toBeUndefined();
  });
});

describe("combineTranscript", () => {
  it("joins a short prefix that is not a whole word in the replayed text", () => {
    expect(combineTranscript("we", "welcome")).toBe("we welcome");
  });

  it("does not repeat a word when the replayed transcript adds a comma", () => {
    expect(combineTranscript("hello", "hello, world")).toBe("hello, world");
    expect(combineTranscript("hello", "Hello, world")).toBe("Hello, world");
  });

  it.each([
    ["hello."],
    ["hello!"],
    ["hello?"],
    ["hello; world"],
    ["hello: world"],
    ["hello's world"],
    ["hello-world"],
    ["hello)"],
    ['hello"'],
    ["hello，world"],
  ])("treats punctuation after the retained word as a boundary (%s)", (speechText) => {
    expect(combineTranscript("hello", speechText)).toBe(speechText);
  });

  it("keeps the replayed transcript when whitespace follows the retained words", () => {
    expect(combineTranscript("call me later", "Call me later and goodbye")).toBe(
      "Call me later and goodbye",
    );
  });

  it("still joins when the replayed text continues the retained token", () => {
    expect(combineTranscript("hello", "helloworld")).toBe("hello helloworld");
    expect(combineTranscript("hello", "hello2")).toBe("hello hello2");
    expect(combineTranscript("hello", "hello_world")).toBe("hello hello_world");
    expect(combineTranscript("na", "naïve")).toBe("na naïve");
    expect(combineTranscript("a", "a𐐀")).toBe("a a𐐀");
    expect(combineTranscript("a𐐀", "a𐐀 more")).toBe("a𐐀 more");
  });
});

describe("dictation engine choice", () => {
  it("uses Web Speech when the browser implements it", () => {
    vi.stubGlobal("window", { SpeechRecognition: class {} });
    expect(webSpeechAvailable()).toBe(true);
  });

  it("listens through the desktop app's system recognizer when it offers one", () => {
    vi.stubGlobal("window", {
      webkitSpeechRecognition: class {},
      rakazoDesktop: { platform: "darwin", speech: {} },
    });
    expect(webSpeechAvailable()).toBe(true);
  });

  it("treats Electron as having no usable Web Speech", () => {
    vi.stubGlobal("window", {
      webkitSpeechRecognition: class {},
      rakazoDesktop: { platform: "darwin" },
    });
    expect(webSpeechAvailable()).toBe(false);
  });

  it("treats an Electron user agent as having no usable Web Speech", () => {
    vi.stubGlobal("window", { webkitSpeechRecognition: class {} });
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 Electron/44.2.0" });
    expect(webSpeechAvailable()).toBe(false);
  });

  it.each(["hold", "endpoint"] as const)(
    "prefers a configured provider over desktop speech for %s",
    async (mode) => {
      stubRecorderFallback(vi.fn());
      vi.stubGlobal(
        "AudioContext",
        class {
          state = "running";
          createMediaStreamSource() {
            return { connect() {} };
          }
          createAnalyser() {
            return {
              fftSize: 2048,
              getByteTimeDomainData(data: Uint8Array) {
                data.fill(128);
              },
            };
          }
          close() {
            return Promise.resolve();
          }
        },
      );
      const start = vi.fn();
      vi.stubGlobal("window", { rakazoDesktop: { platform: "darwin", speech: { start } } });
      const dictation = new Dictation();
      await dictation.listen({ mode, transcribe: true, onFinal: vi.fn() });
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce();
      expect(start).not.toHaveBeenCalled();
      expect(dictation.state.status).toBe("listening");
      dictation.stop();
    },
  );

  it.each(["browser", "desktop"])("keeps %s behavior without the speech bridge", async (host) => {
    stubRecorderFallback(vi.fn());
    const start = vi.fn();
    vi.stubGlobal("window", {
      SpeechRecognition: class {
        start = start;
        abort() {}
      },
      ...(host === "desktop" ? { rakazoDesktop: { platform: "darwin" } } : {}),
    });
    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", transcribe: true, onFinal: vi.fn() });
    expect(start).toHaveBeenCalledTimes(host === "browser" ? 1 : 0);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(host === "desktop" ? 1 : 0);
    dictation.stop();
  });

  it("falls back only for service failures when transcription is connected", () => {
    expect(webSpeechNeedsServerFallback("network", true)).toBe(true);
    expect(webSpeechNeedsServerFallback("service-not-allowed", true)).toBe(true);
    expect(webSpeechNeedsServerFallback("network", false)).toBe(false);
    expect(webSpeechNeedsServerFallback("not-allowed", true)).toBe(false);
    expect(webSpeechNeedsServerFallback("aborted", true)).toBe(false);
    expect(webSpeechNeedsServerFallback(undefined, true)).toBe(false);
  });
});

describe("Dictation web speech", () => {
  class FakeRecognition {
    continuous = false;
    interimResults = false;
    lang = "";
    onresult: ((event: unknown) => void) | null = null;
    onerror: ((event: { error?: string }) => void) | null = null;
    onend: (() => void) | null = null;
    start = vi.fn();
    stop = vi.fn();
    abort = vi.fn();
    constructor() {
      instances.push(this);
    }
  }
  let instances: FakeRecognition[] = [];

  beforeEach(() => {
    instances = [];
    vi.stubGlobal("window", { SpeechRecognition: FakeRecognition });
    vi.stubGlobal("navigator", { language: "en-US" });
  });

  type Part = string | { transcript: string; isFinal: true };

  /** One onresult carrying the whole session so far, the way Chrome reports it. */
  function said(rec: FakeRecognition | undefined, ...parts: Part[]) {
    rec?.onresult?.({
      resultIndex: 0,
      results: parts.map((part) => {
        const { transcript, isFinal } =
          typeof part === "string" ? { transcript: part, isFinal: false } : part;
        return Object.assign([{ transcript }], { isFinal });
      }),
    });
  }

  /** Chrome flips a result to final at its own phrase boundary, mid-sentence. */
  function done(transcript: string): Part {
    return { transcript, isFinal: true };
  }

  it("listens in the language the app is set to", async () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === "rakazo.uiLocale" ? "nl" : null),
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
    });

    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", onFinal: () => undefined });

    expect(instances[0]?.lang).toBe("nl-NL");
  });

  it("hears the browser's regional variant of the app's language", async () => {
    vi.stubGlobal("navigator", { language: "es-CL" });

    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", onFinal: () => undefined });

    expect(instances[0]?.lang).toBe("es-CL");
  });

  it("keeps the app's language when the browser speaks another one", async () => {
    vi.stubGlobal("navigator", { language: "de-DE" });
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === "rakazo.uiLocale" ? "es" : null),
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
    });

    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", onFinal: () => undefined });

    expect(instances[0]?.lang).toBe("es-ES");
  });

  it.each([
    ["es-CL", "es-CL"],
    ["es-ES", "es-ES"],
    ["es-419", "es-MX"],
    ["es_AR", "es-AR"],
    ["it-IT", "it-IT"],
  ])("follows browser %s as %s when the UI is English", async (browser, expected) => {
    vi.stubGlobal("navigator", { language: browser });
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === "rakazo.uiLocale" ? "en" : null),
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
    });

    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", onFinal: () => undefined });

    expect(instances[0]?.lang).toBe(expected);
  });

  it("keeps the browser language when the app has no catalog for it", async () => {
    vi.stubGlobal("navigator", { language: "it-IT" });

    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", onFinal: () => undefined });

    expect(instances[0]?.lang).toBe("it-IT");
  });

  it("rides out a pause in the middle of a sentence", async () => {
    vi.useFakeTimers();
    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({ mode: "endpoint", onFinal });
    const rec = instances[0];
    expect(rec?.continuous).toBe(true);
    expect(rec?.interimResults).toBe(true);

    said(rec, "okay it is based on");
    await vi.advanceTimersByTimeAsync(1_100);
    expect(onFinal).not.toHaveBeenCalled();

    said(rec, "okay it is based on", " the new project");
    await vi.advanceTimersByTimeAsync(1_100);
    expect(onFinal).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(onFinal).toHaveBeenCalledWith("okay it is based on the new project");
  });

  it("keeps the window open when Chrome finalises words it already reported", async () => {
    vi.useFakeTimers();
    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({ mode: "endpoint", onFinal });
    const rec = instances[0];

    said(rec, "okay tell me");
    await vi.advanceTimersByTimeAsync(400);
    // Chrome's phrase boundary: the same words again, this time final. The caller only
    // took a breath, so the quiet gap starts here, not at the first guess at the phrase.
    said(rec, done("okay tell me"));
    await vi.advanceTimersByTimeAsync(900);
    expect(onFinal).not.toHaveBeenCalled();

    said(rec, done("okay tell me"), " about the projects");
    await vi.advanceTimersByTimeAsync(1_100);
    expect(onFinal).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(onFinal).toHaveBeenCalledWith("okay tell me about the projects");
  });

  it("preserves words repeated in separate final results", async () => {
    vi.useFakeTimers();
    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({ mode: "endpoint", onFinal });
    const rec = instances[0];

    said(rec, done("please say no"), done("no"));
    expect(dictation.state.transcript).toBe("please say no no");
    await vi.advanceTimersByTimeAsync(1_200);
    expect(onFinal).toHaveBeenCalledExactlyOnceWith("please say no no");
  });

  it("replaces interim guesses at the same result index without removing repetitions", async () => {
    vi.useFakeTimers();
    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({ mode: "endpoint", onFinal });
    const rec = instances[0];

    said(rec, "no");
    said(rec, "no no");
    said(rec, done("no no"));
    expect(dictation.state.transcript).toBe("no no");
    await vi.advanceTimersByTimeAsync(1_200);
    expect(onFinal).toHaveBeenCalledExactlyOnceWith("no no");
  });

  it("does not repeat what the next session hands back after a restart", async () => {
    vi.useFakeTimers();
    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({ mode: "endpoint", onFinal });
    const rec = instances[0];

    said(rec, done("orlando florida international"));
    rec?.onend?.();
    // Chrome can replay the same buffer once the session is picked back up.
    said(rec, "orlando florida international");

    expect(dictation.state.transcript).toBe("orlando florida international");
  });

  it.each([
    ["orlando florida", "florida international", "orlando florida international"],
    ["say no", "no no please", "say no no please"],
    ["go go now", "go now please", "go go now please"],
    ["go go", "go go now", "go go now"],
    ["we", "welcome", "we welcome"],
    ["hello cat", "catalog", "hello cat catalog"],
    ["hello scat", "cat now", "hello scat cat now"],
  ])("merges restarted speech at whole-word overlaps (%s / %s)", async (first, next, expected) => {
    vi.useFakeTimers();
    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({ mode: "endpoint", onFinal });
    const rec = instances[0];
    said(rec, done(first));
    rec?.onend?.();
    said(rec, next);
    expect(dictation.state.transcript).toBe(expected);
    await vi.advanceTimersByTimeAsync(1_200);
    expect(onFinal).toHaveBeenCalledExactlyOnceWith(expected);
  });

  it("backs off for 900 ms after the second consecutive short empty session", async () => {
    vi.useFakeTimers();
    const dictation = new Dictation();
    await dictation.listen({ mode: "endpoint", onFinal: vi.fn() });
    const rec = instances[0];
    rec?.onend?.();
    expect(rec?.start).toHaveBeenCalledTimes(2);
    said(rec, "   ");
    rec?.onend?.();
    await vi.advanceTimersByTimeAsync(899);
    expect(rec?.start).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(rec?.start).toHaveBeenCalledTimes(3);
    dictation.stop();
  });

  it.each([false, true])(
    "gives up after four short empty sessions (carried speech: %s)",
    async (hasSpeech) => {
      vi.useFakeTimers();
      const onFinal = vi.fn();
      const dictation = new Dictation();
      await dictation.listen({ mode: "endpoint", endpointMs: 10_000, onFinal });
      const rec = instances[0];
      if (hasSpeech) {
        said(rec, done("please say no"), done("no"));
        rec?.onend?.();
      }
      const starts = rec?.start.mock.calls.length ?? 0;
      rec?.onend?.();
      rec?.onend?.();
      await vi.advanceTimersByTimeAsync(900);
      expect(dictation.state.status).toBe("listening");
      rec?.onend?.();
      await vi.advanceTimersByTimeAsync(900);
      expect(dictation.state.status).toBe("listening");
      const staleEnd = rec?.onend;
      rec?.onend?.();
      expect(rec?.abort).toHaveBeenCalledOnce();
      expect(rec?.onresult).toBeNull();
      expect(rec?.onend).toBeNull();
      expect(dictation.state).toEqual({
        status: "idle",
        transcript: "",
        error: "The browser keeps dropping the microphone. Start dictation again to retry.",
      });
      staleEnd?.();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(rec?.start).toHaveBeenCalledTimes(starts + 3);
      if (hasSpeech) expect(onFinal).toHaveBeenCalledExactlyOnceWith("please say no no");
      else expect(onFinal).not.toHaveBeenCalled();
    },
  );

  it("hands the microphone to server transcription after four short empty sessions", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => Response.json({ text: "from server" }));
    stubRecorderFallback(fetchMock);
    vi.stubGlobal(
      "AudioContext",
      class {
        state = "running";
        createMediaStreamSource() {
          return { connect() {} };
        }
        createAnalyser() {
          return {
            fftSize: 2048,
            getByteTimeDomainData(data: Uint8Array) {
              data.fill(200);
            },
          };
        }
        close() {
          return Promise.resolve();
        }
      },
    );
    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({ mode: "endpoint", transcribe: true, onFinal });
    const rec = instances[0];
    rec?.onend?.();
    rec?.onend?.();
    await vi.advanceTimersByTimeAsync(900);
    rec?.onend?.();
    await vi.advanceTimersByTimeAsync(900);
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    const staleEnd = rec?.onend;
    rec?.onend?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce();
    expect(rec?.abort).toHaveBeenCalledOnce();
    expect(dictation.state.status).toBe("listening");
    expect(dictation.state.error).toBeUndefined();
    staleEnd?.();
    await vi.advanceTimersByTimeAsync(900);
    expect(rec?.start).toHaveBeenCalledTimes(4);
    dictation.submitHold();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(onFinal).toHaveBeenCalledExactlyOnceWith("from server");
  });

  it.each([false, true])(
    "resets empty-session limits after speech (final: %s)",
    async (isFinal) => {
      vi.useFakeTimers();
      const dictation = new Dictation();
      await dictation.listen({ mode: "endpoint", endpointMs: 10_000, onFinal: vi.fn() });
      const rec = instances[0];
      rec?.onend?.();
      rec?.onend?.();
      await vi.advanceTimersByTimeAsync(900);
      for (let index = 0; index < 5; index += 1) {
        said(rec, isFinal ? done("hello") : "hello");
        // A later empty event must not erase the fact that this session heard speech.
        said(rec, "");
        rec?.onend?.();
        expect(rec?.start).toHaveBeenCalledTimes(4 + index);
        expect(dictation.state.status).toBe("listening");
      }
      rec?.onend?.();
      expect(rec?.start).toHaveBeenCalledTimes(9);
      rec?.onend?.();
      expect(rec?.start).toHaveBeenCalledTimes(9);
      await vi.advanceTimersByTimeAsync(900);
      expect(rec?.start).toHaveBeenCalledTimes(10);
      dictation.stop();
    },
  );

  it("resets the count after an empty session lasting at least 400 ms", async () => {
    vi.useFakeTimers();
    const dictation = new Dictation();
    await dictation.listen({ mode: "endpoint", onFinal: vi.fn() });
    const rec = instances[0];
    rec?.onend?.();
    rec?.onend?.();
    await vi.advanceTimersByTimeAsync(900);
    await vi.advanceTimersByTimeAsync(400);
    rec?.onend?.();
    expect(rec?.start).toHaveBeenCalledTimes(4);
    rec?.onend?.();
    expect(rec?.start).toHaveBeenCalledTimes(5);
    rec?.onend?.();
    expect(rec?.start).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(900);
    expect(rec?.start).toHaveBeenCalledTimes(6);
    dictation.stop();
  });

  it("cancels a pending restart when stopped", async () => {
    vi.useFakeTimers();
    const dictation = new Dictation();
    await dictation.listen({ mode: "endpoint", onFinal: vi.fn() });
    const rec = instances[0];
    rec?.onend?.();
    rec?.onend?.();
    dictation.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rec?.start).toHaveBeenCalledTimes(2);
    expect(rec?.abort).toHaveBeenCalledOnce();
    expect(dictation.state.status).toBe("idle");
  });

  it("never ends the turn because the browser ended the session", async () => {
    vi.useFakeTimers();
    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({ mode: "endpoint", onFinal });
    const rec = instances[0];

    said(rec, "one of the new projects");
    rec?.onend?.();
    expect(onFinal).not.toHaveBeenCalled();
    expect(rec?.start).toHaveBeenCalledTimes(2);

    // The restarted session numbers its results from zero; the earlier words survive.
    said(rec, "and the deadlines");
    await vi.advanceTimersByTimeAsync(1_200);
    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(onFinal).toHaveBeenCalledWith("one of the new projects and the deadlines");
  });

  it("publishes interim words to watchers long before the turn ends", async () => {
    vi.useFakeTimers();
    const onFinal = vi.fn();
    const dictation = new Dictation();
    const seen: string[] = [];
    dictation.subscribe((snapshot) => seen.push(snapshot.transcript));
    await dictation.listen({ mode: "endpoint", onFinal });

    said(instances[0], "what about the deploy");
    await vi.advanceTimersByTimeAsync(300);

    // The only signal available while the caller is still talking.
    expect(seen.at(-1)).toBe("what about the deploy");
    expect(onFinal).not.toHaveBeenCalled();
  });

  it("restarts endpoint recognition after a quiet end", async () => {
    const dictation = new Dictation();
    await dictation.listen({ mode: "endpoint", onFinal: () => undefined });
    const rec = instances[0];
    expect(rec?.start).toHaveBeenCalledOnce();
    rec?.onend?.();
    expect(rec?.start).toHaveBeenCalledTimes(2);
    expect(dictation.state.status).toBe("listening");
  });

  it("records through the connected voice provider in Electron", async () => {
    const constructed = vi.fn();
    class FakeRecognition {
      start = vi.fn();
      stop = vi.fn();
      abort = vi.fn();
      constructor() {
        constructed();
      }
    }
    vi.stubGlobal("window", {
      webkitSpeechRecognition: FakeRecognition,
      rakazoDesktop: { platform: "darwin" },
    });
    const fetchMock = vi.fn(async () => Response.json({ text: "from fish" }));
    stubRecorderFallback(fetchMock);

    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", transcribe: true, onFinal });
    expect(constructed).not.toHaveBeenCalled();
    expect(dictation.state.error).toBeUndefined();
    expect(dictation.state.status).toBe("listening");
    dictation.submitHold();
    await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith("from fish"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/voice/transcribe",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it.each(["network", "service-not-allowed"])(
    "falls back to server transcription when Web Speech fails with %s",
    async (error) => {
      const instances: Array<{
        onerror: ((event: { error?: string }) => void) | null;
        onend: (() => void) | null;
        start: ReturnType<typeof vi.fn>;
        abort: ReturnType<typeof vi.fn>;
      }> = [];
      class FakeRecognition {
        continuous = false;
        interimResults = false;
        lang = "";
        onresult: ((event: unknown) => void) | null = null;
        onerror: ((event: { error?: string }) => void) | null = null;
        onend: (() => void) | null = null;
        start = vi.fn();
        stop = vi.fn();
        abort = vi.fn(() => {
          this.onerror?.({ error: "aborted" });
          this.onend?.();
        });
        constructor() {
          instances.push(this);
        }
      }
      vi.stubGlobal("window", { SpeechRecognition: FakeRecognition });
      const fetchMock = vi.fn(async () => Response.json({ text: "from server" }));
      let markRecording: () => void = () => undefined;
      const recording = new Promise<void>((resolve) => {
        markRecording = resolve;
      });
      const track = { stop: vi.fn() };
      vi.stubGlobal("navigator", {
        mediaDevices: {
          getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
        },
        language: "en-US",
      });
      vi.stubGlobal("fetch", fetchMock);
      vi.stubGlobal(
        "MediaRecorder",
        class {
          state = "inactive";
          ondataavailable: ((event: { data: Blob }) => void) | null = null;
          onstop: (() => void) | null = null;
          start() {
            this.state = "recording";
            markRecording();
          }
          stop() {
            this.state = "inactive";
            this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
            this.onstop?.();
          }
        },
      );

      const onFinal = vi.fn();
      const dictation = new Dictation();
      await dictation.listen({ mode: "hold", transcribe: true, onFinal });
      const rec = instances[0];
      expect(rec?.start).toHaveBeenCalledOnce();
      const onend = rec?.onend;
      rec?.onerror?.({ error });
      onend?.();
      await recording;
      expect(dictation.state.error).toBeUndefined();
      expect(dictation.state.status).toBe("listening");
      expect(rec?.abort).toHaveBeenCalledOnce();
      dictation.submitHold();
      await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith("from server"));
      expect(onFinal).toHaveBeenCalledOnce();
    },
  );

  it("continues an endpoint turn and joins speech heard before Web Speech failed", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const level = { current: 0.6 };
    class FakeAnalyser {
      fftSize = 2048;
      getByteTimeDomainData(data: Uint8Array) {
        data.fill(Math.round(128 + level.current * 127));
      }
    }
    class FakeContext {
      state = "running";
      createMediaStreamSource() {
        return { connect() {} };
      }
      createAnalyser() {
        return new FakeAnalyser();
      }
      close() {
        return Promise.resolve();
      }
      resume() {
        return Promise.resolve();
      }
    }
    vi.stubGlobal("AudioContext", FakeContext);

    type ResultEvent = {
      resultIndex: number;
      results: ArrayLike<ArrayLike<{ transcript: string }>>;
    };
    const instances: FakeRecognition[] = [];
    class FakeRecognition {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult: ((event: ResultEvent) => void) | null = null;
      onerror: ((event: { error?: string }) => void) | null = null;
      onend: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn();
      abort = vi.fn();
      constructor() {
        instances.push(this);
      }
    }
    vi.stubGlobal("window", { SpeechRecognition: FakeRecognition });
    let markRecording: () => void = () => undefined;
    const recording = new Promise<void>((resolve) => {
      markRecording = resolve;
    });
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });
    const fetchMock = vi.fn(async () => Response.json({ text: "  from   server " }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "MediaRecorder",
      class {
        state = "inactive";
        ondataavailable: ((event: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null;
        start() {
          this.state = "recording";
          markRecording();
        }
        stop() {
          this.state = "inactive";
          this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
          this.onstop?.();
        }
      },
    );

    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({
      mode: "endpoint",
      transcribe: true,
      endpointMs: 240,
      onFinal,
    });
    const rec = instances[0];
    const onend = rec?.onend;
    rec?.onresult?.({
      resultIndex: 0,
      results: [[{ transcript: "call me later" }]],
    });
    rec?.onerror?.({ error: "network" });
    onend?.();
    await recording;

    expect(onFinal).not.toHaveBeenCalled();
    expect(dictation.state.status).toBe("listening");
    expect(dictation.state.transcript).toBe("call me later");
    expect(dictation.state.error).toBeUndefined();
    expect(rec?.abort).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(80);
    level.current = 0;
    await vi.advanceTimersByTimeAsync(240);
    await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith("call me later from server"));
    expect(onFinal).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("submits retained speech when the microphone fails after fallback", async () => {
    type ResultEvent = {
      resultIndex: number;
      results: ArrayLike<ArrayLike<{ transcript: string }>>;
    };
    const instances: FakeRecognition[] = [];
    class FakeRecognition {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult: ((event: ResultEvent) => void) | null = null;
      onerror: ((event: { error?: string }) => void) | null = null;
      onend: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn();
      abort = vi.fn();
      constructor() {
        instances.push(this);
      }
    }
    vi.stubGlobal("window", { SpeechRecognition: FakeRecognition });
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => {
          throw new Error("Microphone denied");
        }),
      },
      language: "en-US",
    });

    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({ mode: "endpoint", transcribe: true, onFinal });
    const rec = instances[0];
    rec?.onresult?.({
      resultIndex: 0,
      results: [[{ transcript: "call me later" }]],
    });
    rec?.onerror?.({ error: "service-not-allowed" });

    await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith("call me later"));
    expect(onFinal).toHaveBeenCalledOnce();
    expect(dictation.state.status).toBe("idle");
    expect(dictation.state.error).toBeUndefined();
  });

  it("submits retained speech when transcription fails after fallback", async () => {
    type ResultEvent = {
      resultIndex: number;
      results: ArrayLike<ArrayLike<{ transcript: string }>>;
    };
    const instances: FakeRecognition[] = [];
    class FakeRecognition {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult: ((event: ResultEvent) => void) | null = null;
      onerror: ((event: { error?: string }) => void) | null = null;
      onend: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn();
      abort = vi.fn();
      constructor() {
        instances.push(this);
      }
    }
    vi.stubGlobal("window", { SpeechRecognition: FakeRecognition });
    let markRecording: () => void = () => undefined;
    const recording = new Promise<void>((resolve) => {
      markRecording = resolve;
    });
    const fetchMock = vi.fn(async () => Response.json({ error: "unavailable" }, { status: 503 }));
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "MediaRecorder",
      class {
        state = "inactive";
        ondataavailable: ((event: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null;
        start() {
          this.state = "recording";
          markRecording();
        }
        stop() {
          this.state = "inactive";
          this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
          this.onstop?.();
        }
      },
    );

    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", transcribe: true, onFinal });
    const rec = instances[0];
    rec?.onresult?.({
      resultIndex: 0,
      results: [[{ transcript: "call me later" }]],
    });
    rec?.onerror?.({ error: "network" });
    await recording;
    expect(onFinal).not.toHaveBeenCalled();
    dictation.submitHold();

    await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith("call me later"));
    expect(onFinal).toHaveBeenCalledOnce();
    expect(dictation.state.status).toBe("idle");
    expect(dictation.state.error).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    ["please say no", "no please", "please say no no please"],
    ["call me later", "Call me later and goodbye", "call me later Call me later and goodbye"],
    ["hello", "hello", "hello hello"],
    ["call me later", "", "call me later"],
  ])(
    "appends fresh recording text without removing repeated words (%s / %s)",
    async (prefix, text, expected) => {
      const fetchMock = vi.fn(async () => Response.json({ text }));
      stubRecorderFallback(fetchMock);
      const onFinal = vi.fn();
      const dictation = new Dictation();
      await dictation.listen({ mode: "hold", transcribe: true, onFinal });
      said(instances[0], prefix);
      instances[0]?.onerror?.({ error: "network" });
      await vi.waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce());
      dictation.submitHold();

      await vi.waitFor(() => expect(onFinal).toHaveBeenCalledExactlyOnceWith(expected));
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it("stops an endpoint fallback on silence without new microphone energy", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    class FakeAnalyser {
      fftSize = 2048;
      getByteTimeDomainData(data: Uint8Array) {
        data.fill(128);
      }
    }
    class FakeContext {
      state = "running";
      createMediaStreamSource() {
        return { connect() {} };
      }
      createAnalyser() {
        return new FakeAnalyser();
      }
      close() {
        return Promise.resolve();
      }
      resume() {
        return Promise.resolve();
      }
    }
    vi.stubGlobal("AudioContext", FakeContext);

    type ResultEvent = {
      resultIndex: number;
      results: ArrayLike<ArrayLike<{ transcript: string }>>;
    };
    const instances: FakeRecognition[] = [];
    class FakeRecognition {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult: ((event: ResultEvent) => void) | null = null;
      onerror: ((event: { error?: string }) => void) | null = null;
      onend: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn();
      abort = vi.fn();
      constructor() {
        instances.push(this);
      }
    }
    vi.stubGlobal("window", { SpeechRecognition: FakeRecognition });
    let markRecording: () => void = () => undefined;
    const recording = new Promise<void>((resolve) => {
      markRecording = resolve;
    });
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });
    const fetchMock = vi.fn(async () => Response.json({ text: "still there" }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "MediaRecorder",
      class {
        state = "inactive";
        ondataavailable: ((event: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null;
        start() {
          this.state = "recording";
          markRecording();
        }
        stop() {
          this.state = "inactive";
          this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
          this.onstop?.();
        }
      },
    );

    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({
      mode: "endpoint",
      transcribe: true,
      endpointMs: 240,
      onFinal,
    });
    instances[0]?.onresult?.({
      resultIndex: 0,
      results: [[{ transcript: "call me later" }]],
    });
    instances[0]?.onerror?.({ error: "network" });
    await recording;

    expect(onFinal).not.toHaveBeenCalled();
    expect(dictation.state.transcript).toBe("call me later");
    await vi.advanceTimersByTimeAsync(80);
    expect(onFinal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(160);
    await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith("call me later still there"));
    expect(onFinal).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps a Web Speech permission error when no server fallback applies", async () => {
    const instances: Array<{
      onerror: ((event: { error?: string }) => void) | null;
    }> = [];
    class FakeRecognition {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: { error?: string }) => void) | null = null;
      onend: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn();
      abort = vi.fn();
      constructor() {
        instances.push(this);
      }
    }
    vi.stubGlobal("window", { SpeechRecognition: FakeRecognition });
    vi.stubGlobal("navigator", { language: "en-US" });
    const started = vi.fn();
    vi.stubGlobal(
      "MediaRecorder",
      class {
        start() {
          started();
        }
      },
    );

    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", transcribe: true, onFinal: () => undefined });
    instances[0]?.onerror?.({ error: "not-allowed" });
    expect(dictation.state.error).toBe("Dictation failed: not-allowed");
    expect(started).not.toHaveBeenCalled();

    const offline = new Dictation();
    await offline.listen({ mode: "hold", onFinal: () => undefined });
    instances[1]?.onerror?.({ error: "network" });
    expect(offline.state.error).toBe("Dictation failed: network");
    expect(started).not.toHaveBeenCalled();
  });
});

describe("transcriptionLanguage", () => {
  it("hints the provider with the language the caller picked", () => {
    vi.stubGlobal("navigator", { language: "es-ES" });
    expect(transcriptionLanguage()).toBe("es");
  });
});
