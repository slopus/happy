import type { AutoReviewResult } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { reviewWithBackups } from "./auto-review-backups.js";

const candidates = [
  { provider: "one", model: "first" },
  { provider: "two", model: "second" },
];
describe("approval model backups", () => {
  it.each(["pass", "ask"] as const)("never retries a deliberate %s", async (decision) => {
    const review = vi.fn(async () => ({ decision, model: "first" }));
    expect(
      (await reviewWithBackups(candidates, review, new AbortController().signal)).decision,
    ).toBe(decision);
    expect(review).toHaveBeenCalledTimes(1);
  });
  it("tries backups in order for errors and deduplicates candidates", async () => {
    const review = vi
      .fn<() => Promise<AutoReviewResult>>()
      .mockRejectedValueOnce(new Error("fake secret"))
      .mockResolvedValue({ decision: "pass", model: "second" });
    expect(
      (
        await reviewWithBackups(
          [candidates[0]!, ...candidates],
          review,
          new AbortController().signal,
        )
      ).decision,
    ).toBe("pass");
    expect(review.mock.calls).toHaveLength(2);
    expect(review).toHaveBeenNthCalledWith(2, candidates[1]);
  });
  it("tries the same model on another account's connection", async () => {
    const personal = { provider: "openai-codex", model: "gpt-5", credentialId: "personal" };
    const work = { ...personal, credentialId: "work" };
    const review = vi
      .fn<() => Promise<AutoReviewResult>>()
      .mockRejectedValueOnce(new Error("usage limit"))
      .mockResolvedValue({ decision: "pass", model: "gpt-5" });
    expect(
      (await reviewWithBackups([personal, work], review, new AbortController().signal)).decision,
    ).toBe("pass");
    expect(review).toHaveBeenNthCalledWith(2, work);
  });
  it("fails closed when all checkers fail and respects cancellation", async () => {
    const review = vi.fn(async () => {
      throw new Error("fake secret");
    });
    const result = await reviewWithBackups(candidates, review, new AbortController().signal);
    expect(result.decision).toBe("error");
    expect(JSON.stringify(result)).not.toContain("fake secret");
    review.mockClear();
    await reviewWithBackups(candidates, review, AbortSignal.abort());
    expect(review).not.toHaveBeenCalled();
  });
});
