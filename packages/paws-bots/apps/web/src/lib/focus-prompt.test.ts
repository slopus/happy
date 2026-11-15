import { describe, expect, it, vi } from "vitest";
import { FOCUS_PROMPT_DELAY_MS, scheduleFocusPrompt } from "./focus-prompt";

describe("scheduleFocusPrompt", () => {
  it("prompts immediately for the first bot", async () => {
    const prompt = vi.fn(async () => undefined);
    const controller = new AbortController();
    await expect(
      scheduleFocusPrompt({ immediate: true, signal: controller.signal, prompt }),
    ).resolves.toBe("prompted");
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("waits before prompting a later bot", async () => {
    vi.useFakeTimers();
    const prompt = vi.fn(async () => undefined);
    const controller = new AbortController();
    const pending = scheduleFocusPrompt({
      immediate: false,
      signal: controller.signal,
      prompt,
    });
    expect(prompt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(FOCUS_PROMPT_DELAY_MS - 1);
    expect(prompt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe("prompted");
    expect(prompt).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("cancels when the signal aborts before the delay", async () => {
    vi.useFakeTimers();
    const prompt = vi.fn(async () => undefined);
    const controller = new AbortController();
    const pending = scheduleFocusPrompt({
      immediate: false,
      signal: controller.signal,
      prompt,
    });
    controller.abort();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe("cancelled");
    expect(prompt).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does not prompt when send is already in flight after the delay", async () => {
    vi.useFakeTimers();
    const prompt = vi.fn(async () => undefined);
    const controller = new AbortController();
    const pending = scheduleFocusPrompt({
      immediate: false,
      signal: controller.signal,
      prompt,
      shouldSkip: () => true,
    });
    await vi.advanceTimersByTimeAsync(FOCUS_PROMPT_DELAY_MS);
    await expect(pending).resolves.toBe("cancelled");
    expect(prompt).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
