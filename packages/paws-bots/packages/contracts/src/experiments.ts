/**
 * Every A/B test, by key, with its variants. The first variant is the control, and what everyone
 * sees when the test is not running. To add a test: list it here, read its variant on the API with
 * `experiments.variant(key, subjectId)`, and pass `experiments.tags(...)` when capturing the events
 * the test should be judged on. A deployment runs it by listing the key in `EXPERIMENTS`.
 */
export const EXPERIMENTS = {
  "plan-layout": ["cards", "tiers"],
} as const;
export type ExperimentKey = keyof typeof EXPERIMENTS;
export type ExperimentVariant<K extends ExperimentKey> = (typeof EXPERIMENTS)[K][number];
