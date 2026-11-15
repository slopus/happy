import type {
  AdapterContext,
  AdapterDescriptor,
  AutoReviewCapabilities,
  AutoReviewProvider,
  AutoReviewRequest,
  AutoReviewResult,
} from "@rakazo/adapter-kit";

const DEFAULT_RESULT: AutoReviewResult = {
  decision: "pass",
  model: "scripted",
};

/** Deterministic Auto Review adapter for tests. Never calls a hosted vendor. */
export class ScriptedAutoReviewProvider implements AutoReviewProvider {
  constructor(
    private readonly script:
      | AutoReviewResult
      | ((request: AutoReviewRequest) => AutoReviewResult) = DEFAULT_RESULT,
  ) {}

  describe(): AdapterDescriptor<AutoReviewCapabilities> {
    return {
      id: "scripted",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { offline: true, keyless: true },
    };
  }

  async review(request: AutoReviewRequest, context: AdapterContext): Promise<AutoReviewResult> {
    context.signal.throwIfAborted();
    return typeof this.script === "function" ? this.script(request) : this.script;
  }
}
