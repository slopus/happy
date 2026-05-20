/**
 * Inference-LLM vendor allowlist for the `/v1/connect/:vendor/*` endpoint
 * family and for `serviceAccountToken` aggregation surfaces.
 *
 * `ServiceAccountToken` rows are namespaced by a free-form `vendor` string,
 * so adding a non-inference vendor (e.g. 'github-pat') would otherwise leak
 * through `/v1/connect/tokens` and `accountRoutes` connected-vendors lists
 * that were written assuming only inference tokens live in that table.
 * Centralising the list here is the canonical way to add a new vendor
 * without re-checking 3 query sites.
 *
 * Cross-repo reference:
 *   aplus-dev-studio specs/remote-git-clone-per-user-credentials Step 2.2.
 */

export const INFERENCE_VENDORS = ['openai', 'anthropic', 'gemini'] as const;

export type InferenceVendor = (typeof INFERENCE_VENDORS)[number];
