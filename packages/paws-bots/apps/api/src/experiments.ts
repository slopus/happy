import { createHash } from "node:crypto";
import type { ExperimentKey, ExperimentVariant } from "@rakazo/contracts";
import { EXPERIMENTS } from "@rakazo/contracts";

/** `runningKeys` is the deployment's `EXPERIMENTS` setting: comma-separated keys. Unknown keys are ignored. */
export function createExperiments(runningKeys: string | undefined) {
  const live = new Set(
    (runningKeys ?? "")
      .split(",")
      .map((key) => key.trim())
      .filter((key): key is ExperimentKey => key in EXPERIMENTS),
  );
  /** The subject's variant; always the control unless the experiment is running. */
  function variant<K extends ExperimentKey>(key: K, subjectId: string): ExperimentVariant<K> {
    const variants = EXPERIMENTS[key];
    if (!live.has(key)) return variants[0];
    // A stable split by subject: the same subject always gets the same variant.
    const bucket = createHash("sha256").update(`${key}:${subjectId}`).digest()[0]!;
    return variants[bucket % variants.length]!;
  }
  /** What to pass when capturing an event the test is judged on; nothing unless it is running. */
  function tags(key: ExperimentKey, subjectId: string): Record<string, string> | undefined {
    return live.has(key) ? { [key]: variant(key, subjectId) } : undefined;
  }
  return { running: (key: ExperimentKey) => live.has(key), variant, tags };
}
