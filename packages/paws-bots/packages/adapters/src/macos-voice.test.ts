import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SayRunner } from "./macos-voice.js";
import { MacOsVoiceProvider, parseSayVoices } from "./macos-voice.js";
import { MAX_SPEAK_CHARS } from "./voice-http.js";

const ctx = {
  operationId: "voice",
  traceId: "voice",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

const LISTING = [
  "Albert              en_US    # Hello! My name is Albert.",
  "Eddy (English (US)) en_US    # Hello! My name is Eddy.",
  "Zoe (Premium)       en_US    # Hello! My name is Zoe.",
  "",
  "not a voice line",
].join("\n");

const WAV = new TextEncoder().encode("RIFF\0\0\0\0WAVEfmt ");

function fakeSay(onSpeak?: (args: string[], input?: string) => Promise<void>) {
  const run = vi.fn<SayRunner>(async (args, options) => {
    if (args[1] === "?") return LISTING;
    if (onSpeak) await onSpeak(args, options.input);
    const output = args[args.indexOf("-o") + 1];
    if (output) await writeFile(output, WAV);
    return "";
  });
  return { run, provider: new MacOsVoiceProvider(run, {}) };
}

describe("parseSayVoices", () => {
  it("keeps full voice names and lists Premium and Enhanced voices first", () => {
    expect(parseSayVoices(LISTING)).toEqual([
      { id: "Zoe (Premium)", label: "Zoe (Premium)", description: "en_US" },
      { id: "Albert", label: "Albert", description: "en_US" },
      { id: "Eddy (English (US))", label: "Eddy (English (US))", description: "en_US" },
    ]);
  });
});

describe("MacOsVoiceProvider", () => {
  it("lists installed voices once and reuses the list", async () => {
    const { run, provider } = fakeSay();
    await provider.listVoices("", ctx);
    await expect(provider.verify("", ctx)).resolves.toEqual({ ok: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toEqual(["-v", "?"]);
  });

  it("retries a listing that failed instead of caching the failure", async () => {
    const run = vi
      .fn<SayRunner>()
      .mockRejectedValueOnce(new Error("say failed"))
      .mockResolvedValue(LISTING);
    const provider = new MacOsVoiceProvider(run, {});
    await expect(provider.verify("", ctx)).resolves.toEqual({
      ok: false,
      message: "No voices are installed.",
    });
    await expect(provider.listVoices("", ctx)).resolves.toHaveLength(3);
  });

  it("renders a WAV clip through an args array and removes the temp file", async () => {
    let tempDir = "";
    const { run, provider } = fakeSay(async (args) => {
      tempDir = dirname(args[args.indexOf("-o") + 1] ?? "");
    });
    const clip = await provider.synthesize(
      { text: " Hi [[volm 0]] there ", voiceId: "Eddy (English (US))", apiKey: "macos" },
      ctx,
    );
    expect(clip).toEqual({ bytes: WAV, mimeType: "audio/wav" });
    const [args, options] = run.mock.calls[1] ?? [];
    expect(args).toEqual([
      "-v",
      "Eddy (English (US))",
      "--file-format=WAVE",
      "--data-format=LEI16@22050",
      "-o",
      expect.stringMatching(/speech\.wav$/),
      "-f",
      "-",
    ]);
    expect(options?.input).toBe("Hi [ [volm 0]] there");
    expect(tempDir).not.toBe("");
    expect(existsSync(tempDir)).toBe(false);
  });

  it.each([2, 3, 4, 5, 6, 7])("neutralises commands after %i opening brackets", async (count) => {
    const { run, provider } = fakeSay();
    await provider.synthesize(
      { text: `${"[".repeat(count)}volm 0]]`, voiceId: "Albert", apiKey: "macos" },
      ctx,
    );
    const input = run.mock.calls[1]?.[1].input;
    expect(input).toBe(`${"[ ".repeat(count - 1)}[volm 0]]`);
    expect(input).not.toContain("[[");
  });

  it("refuses a voice that is not installed without running say", async () => {
    const { run, provider } = fakeSay();
    await expect(
      provider.synthesize({ text: "Hi", voiceId: "-o /etc/passwd", apiKey: "macos" }, ctx),
    ).rejects.toThrow("That voice is not installed on this Mac.");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("refuses empty and over-long text", async () => {
    const { run, provider } = fakeSay();
    await expect(
      provider.synthesize({ text: " ", voiceId: "Albert", apiKey: "macos" }, ctx),
    ).rejects.toThrow("Nothing to speak.");
    await expect(
      provider.synthesize(
        { text: "a".repeat(MAX_SPEAK_CHARS + 1), voiceId: "Albert", apiKey: "macos" },
        ctx,
      ),
    ).rejects.toThrow("That utterance is too long to speak.");
    expect(run).not.toHaveBeenCalled();
  });

  it("removes the temp file when say fails", async () => {
    let tempDir = "";
    const { provider } = fakeSay(async (args) => {
      tempDir = dirname(args[args.indexOf("-o") + 1] ?? "");
      throw new Error("say exited with 1.");
    });
    await expect(
      provider.synthesize({ text: "Hi", voiceId: "Albert", apiKey: "macos" }, ctx),
    ).rejects.toThrow("say exited with 1.");
    expect(existsSync(tempDir)).toBe(false);
  });
});
