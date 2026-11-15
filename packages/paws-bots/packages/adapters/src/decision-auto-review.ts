import type {
  AdapterContext,
  AdapterDescriptor,
  AutoReviewCapabilities,
  AutoReviewProvider,
  AutoReviewRequest,
  AutoReviewResult,
  DecisionProvider,
} from "@rakazo/adapter-kit";
import { DecisionProviderError } from "@rakazo/adapter-kit";
import {
  AUTO_REVIEW_ASK,
  AUTO_REVIEW_PASS,
  autoReviewMinConfidence,
  autoReviewTimeoutMs,
  MAX_OWNER_WORDS_CHARS,
  MEMORY_WRITE_ASK,
  MEMORY_WRITE_PASS,
  reviewArgsTooLong,
  sanitizeAutoReviewReason,
  TOO_LONG_TO_REVIEW,
  truncateReviewText,
} from "./auto-review.js";

const MAX_TASK_CHARS = 400;
const MAX_BOT_CHARS = 240;
export const APPROVAL_DECISION_RUBRIC_VERSION = "approval-v3";
export class DecisionAutoReviewProvider implements AutoReviewProvider {
  constructor(
    private readonly options: {
      provider: DecisionProvider;
      providerId: string;
      model: string;
      minConfidence?: number;
      timeoutMs?: number;
    },
  ) {}
  describe(): AdapterDescriptor<AutoReviewCapabilities> {
    return {
      id: this.options.providerId,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { offline: false, keyless: false },
    };
  }
  async review(request: AutoReviewRequest, context: AdapterContext): Promise<AutoReviewResult> {
    const modelLabel = `${this.options.providerId}/${this.options.model}`;
    if (reviewArgsTooLong(request)) {
      return { decision: "ask", model: modelLabel, reason: TOO_LONG_TO_REVIEW };
    }
    try {
      const result = await this.options.provider.decide(
        {
          model: this.options.model,
          state: {
            rubricVersion: APPROVAL_DECISION_RUBRIC_VERSION,
            toolName: request.toolName,
            connectorKind: request.connectorKind,
            args: request.args,
            userTask: truncateReviewText(
              request.userTask,
              request.newSite || request.memoryWrite ? MAX_OWNER_WORDS_CHARS : MAX_TASK_CHARS,
            ),
            botDescription: truncateReviewText(request.botDescription, MAX_BOT_CHARS),
            matchingRules: request.matchingRules.map((rule) => ({
              effect: rule.effect,
              matchKind: rule.matchKind,
              matchValue: rule.matchValue,
            })),
            ...(request.newSite ? { newSite: true } : {}),
            ...(request.memoryWrite ? { memoryWrite: true } : {}),
          },
          questions: {
            decision: {
              type: "choice",
              instructions: "Should this bot action run without asking its owner first?",
              criteria: request.newSite
                ? {
                    pass: "The owner's words or the bot's role clearly call for this site, and the URL carries nothing beyond what that needs",
                    ask: "The site does not fit, or the URL's path or query holds data that looks taken from private context. Ask the user",
                  }
                : request.memoryWrite
                  ? { pass: MEMORY_WRITE_PASS, ask: MEMORY_WRITE_ASK }
                  : {
                      pass: AUTO_REVIEW_PASS,
                      ask: AUTO_REVIEW_ASK,
                    },
            },
          },
        },
        {
          ...context,
          signal: AbortSignal.any([
            context.signal,
            AbortSignal.timeout(this.options.timeoutMs ?? autoReviewTimeoutMs()),
          ]),
        },
      );
      const answer = result.answers.decision;
      const model = `${this.options.providerId}/${result.model}`;
      if (answer?.choice === "ask") return { decision: "ask", model };
      if (answer?.choice !== "pass")
        return { decision: "error", model, reason: "Checker returned no decision." };
      if (
        typeof answer.confidence !== "number" ||
        answer.confidence < (this.options.minConfidence ?? autoReviewMinConfidence())
      )
        return { decision: "ask", model, reason: "Checker is unsure." };
      return { decision: "pass", model };
    } catch (error) {
      const reason =
        error instanceof DecisionProviderError
          ? {
              authentication: "Checker could not authenticate.",
              invalid_response: "Checker returned no decision.",
              invalid: "Checker request was invalid.",
              busy: "Checker is busy.",
              unavailable: "Checker timed out or failed.",
            }[error.kind]
          : "Checker returned no decision.";
      return { decision: "error", model: modelLabel, reason: sanitizeAutoReviewReason(reason) };
    }
  }
}
