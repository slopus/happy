import type { AnalyticsEvent } from "@rakazo/contracts";

/** Optional, best-effort product measurement. Implementations must never throw or block work. */
export interface ProductAnalytics {
  /** `experiments` maps each running A/B test to the variant the user saw, so results split by it. */
  capture(
    userId: string,
    event: AnalyticsEvent,
    identity?: { id: string; at: Date },
    experiments?: Record<string, string>,
  ): void;
  flush(): Promise<void>;
}
