import { describe, expect, it } from "vitest";
import { createExperiments } from "./experiments.js";

describe("experiments", () => {
  it("shows everyone the control unless the experiment is running", () => {
    for (const running of [undefined, "", "unknown-test"]) {
      const experiments = createExperiments(running);
      expect(experiments.variant("plan-layout", "org-1")).toBe("cards");
      expect(experiments.tags("plan-layout", "org-1")).toBeUndefined();
    }
  });

  it("keeps each subject on one variant and splits subjects about evenly", () => {
    const experiments = createExperiments("other, plan-layout");
    const ids = Array.from({ length: 2000 }, (_, index) => `org-${index}`);
    const variants = ids.map((id) => experiments.variant("plan-layout", id));
    expect(variants).toEqual(ids.map((id) => experiments.variant("plan-layout", id)));
    const tiers = variants.filter((variant) => variant === "tiers").length;
    expect(tiers).toBeGreaterThan(900);
    expect(tiers).toBeLessThan(1100);
    expect(experiments.tags("plan-layout", "org-1")).toEqual({
      "plan-layout": experiments.variant("plan-layout", "org-1"),
    });
  });
});
