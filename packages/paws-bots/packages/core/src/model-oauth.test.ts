import { describe, expect, it, vi } from "vitest";
import { waitForModelOAuthCompletion } from "./model-oauth.js";

describe("waitForModelOAuthCompletion", () => {
  it.each([408, 429, 500, 502, 503, 504, undefined])(
    "retries a temporary read failure (%s) before readiness",
    async (status) => {
      const complete = vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error("Temporary failure"), { status }))
        .mockResolvedValueOnce({ status: "pending" })
        .mockResolvedValueOnce({ status: "ready" });

      await expect(
        waitForModelOAuthCompletion(complete, {
          attempts: 3,
          pollIntervalMs: 0,
        }),
      ).resolves.toEqual({ status: "ready" });
      expect(complete).toHaveBeenCalledTimes(3);
    },
  );

  it.each([400, 401, 403, 404, 409, 426])("does not retry HTTP %s", async (status) => {
    const error = Object.assign(new Error("Request rejected"), { status });
    const complete = vi.fn().mockRejectedValue(error);
    await expect(waitForModelOAuthCompletion(complete)).rejects.toBe(error);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("counts failed reads toward the attempt limit", async () => {
    const complete = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("Unavailable"), { status: 503 }));
    await expect(
      waitForModelOAuthCompletion(complete, {
        attempts: 2,
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow("timed out");
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("preserves cancellation when an in-flight read rejects", async () => {
    const controller = new AbortController();
    const reason = new Error("Cancelled");
    const complete = vi.fn(async () => {
      controller.abort(reason);
      throw Object.assign(new Error("Unavailable"), { status: 503 });
    });
    await expect(
      waitForModelOAuthCompletion(complete, {
        signal: controller.signal,
        pollIntervalMs: 0,
      }),
    ).rejects.toBe(reason);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("waits between failed reads and can cancel that wait", async () => {
    const complete = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const controller = new AbortController();
    const polling = waitForModelOAuthCompletion(complete, {
      signal: controller.signal,
      pollIntervalMs: 60_000,
    });
    const rejected = expect(polling).rejects.toBeDefined();
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    controller.abort();
    await rejected;
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("still stops on a provider denial after a temporary failure", async () => {
    const complete = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue({ status: "error", error: "Denied" });
    await expect(
      waitForModelOAuthCompletion(complete, {
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow("Denied");
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("stops polling when its signal is aborted", async () => {
    const complete = vi.fn().mockResolvedValue({ status: "pending" as const });
    const controller = new AbortController();
    const polling = waitForModelOAuthCompletion(complete, {
      signal: controller.signal,
      pollIntervalMs: 60_000,
    });

    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(polling).rejects.toBeDefined();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("returns readiness without another poll", async () => {
    const complete = vi.fn().mockResolvedValue({ status: "ready" as const });

    await expect(waitForModelOAuthCompletion(complete)).resolves.toEqual({
      status: "ready",
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("fails with the provider's error instead of polling again", async () => {
    const complete = vi.fn().mockResolvedValue({ status: "error" as const, error: "Denied" });

    await expect(waitForModelOAuthCompletion(complete)).rejects.toThrow("Denied");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("stops after the configured attempt limit", async () => {
    const complete = vi.fn().mockResolvedValue({ status: "pending" as const });

    await expect(
      waitForModelOAuthCompletion(complete, { attempts: 2, pollIntervalMs: 0 }),
    ).rejects.toThrow("timed out");
    expect(complete).toHaveBeenCalledTimes(2);
  });
});
