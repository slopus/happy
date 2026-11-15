import type { AdapterContext, AgentUsage, ModelCallObserver } from "./types.js";

/** A bounded semantic choice. Callers own criteria and the policy applied to an answer. */
export interface DecisionQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}
export interface DecisionRequest {
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, DecisionQuestion>;
}
export interface DecisionAnswer {
  type: "choice";
  choice: string;
  confidence?: number;
}
export interface DecisionResult {
  model: string;
  answers: Record<string, DecisionAnswer>;
  usage?: AgentUsage;
}
export interface DecisionProvider {
  decide(request: DecisionRequest, context: AdapterContext): Promise<DecisionResult>;
}
export interface DecisionProviderOptions {
  apiKey: string;
  fetch?: typeof fetch;
  callObserver?: ModelCallObserver;
  onUsage?: (
    event: AgentUsage & { type: "usage"; provider: string; model: string; callId: string },
  ) => Promise<unknown>;
}

export class DecisionProviderError extends Error {
  constructor(
    readonly kind: "authentication" | "invalid" | "invalid_response" | "busy" | "unavailable",
  ) {
    super("Decision provider could not complete the request");
  }
}
