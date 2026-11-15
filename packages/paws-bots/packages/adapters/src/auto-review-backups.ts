import type { AutoReviewResult } from "@rakazo/adapter-kit";
import type { AutoReviewChecker } from "./auto-review.js";

/** A deliberate ask is final. Only unavailable checkers advance to an ordered backup. */
export async function reviewWithBackups(
  candidates: AutoReviewChecker[],
  review: (candidate: AutoReviewChecker) => Promise<AutoReviewResult>,
  signal: AbortSignal,
): Promise<AutoReviewResult> {
  let result: AutoReviewResult = {
    decision: "error",
    model: "unavailable",
    reason: "Checker could not complete the review.",
  };
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (signal.aborted) break;
    const key = JSON.stringify([
      candidate.provider,
      candidate.model,
      candidate.credentialId ?? null,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      result = await review(candidate);
    } catch {
      result = {
        decision: "error",
        model: `${candidate.provider}/${candidate.model}`,
        reason: "Checker could not complete the review.",
      };
    }
    if (result.decision !== "error") return result;
  }
  return result;
}
