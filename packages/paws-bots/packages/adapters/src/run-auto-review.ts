import type { AgentRuntimeEvent, AutoReviewProvider } from "@rakazo/adapter-kit";
import { recordUsage } from "@rakazo/db";
import type { AutoReviewChecker } from "./auto-review.js";
import { autoReviewTimeoutMs, resolveAutoReviewProviderKind } from "./auto-review.js";
import { createAutoReviewProvider } from "./auto-review-factory.js";
import { DecisionAutoReviewProvider } from "./decision-auto-review.js";
import { decisionModel } from "./decision-models.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { HttpDecisionProvider } from "./http-decisions.js";
import { findConnectedModelCredential, hasHostedModelCredits } from "./model-selection.js";
import { resolveModelKey } from "./run-model.js";
/** The Auto Review provider that judges a run's action with one checker choice. */
export async function autoReviewCheckerProvider(
  deps: ExecutorDeps,
  scope: { runId: string; spaceId: string; userId: string; botId: string; threadId: string },
  options: {
    injectedReview?: AutoReviewProvider;
    memberChecker: boolean;
    backups?: readonly { provider: string; modelId: string }[];
    registerSecrets: (values: string[]) => void;
  },
  checker: AutoReviewChecker,
): Promise<AutoReviewProvider> {
  const { runId, spaceId, userId, botId, threadId } = scope;
  const { injectedReview, memberChecker, backups, registerSecrets } = options;
  if (injectedReview) return injectedReview;
  const kind =
    memberChecker || (checker.provider !== "jev" && checker.provider !== "scripted")
      ? "llm"
      : resolveAutoReviewProviderKind();
  if (kind === "jev" || kind === "scripted") {
    return createAutoReviewProvider(kind);
  }
  const reviewCredential = await findConnectedModelCredential(
    deps.prisma,
    deps.secretStore,
    { userId, spaceId },
    checker.provider,
    checker.model,
    { credentialId: checker.credentialId },
  );
  if (
    (memberChecker ||
      checker.credentialId ||
      backups?.some(
        (choice) => choice.provider === checker.provider && choice.modelId === checker.model,
      )) &&
    !reviewCredential &&
    !(await hasHostedModelCredits(deps.prisma, { userId, spaceId }, checker.provider))
  ) {
    throw new Error("Selected checker connection is unavailable");
  }
  const judgeKey = await resolveModelKey(
    deps,
    userId,
    spaceId,
    reviewCredential,
    checker.provider,
    checker.model,
    registerSecrets,
  );
  const onUsage = (event: Extract<AgentRuntimeEvent, { type: "usage" }>) =>
    recordUsage(deps.prisma, event, {
      spaceId,
      userId,
      botId,
      parentRunId: runId,
      runId,
      operationId: `auto-review:${runId}`,
      operationKind: "setup",
    });
  return decisionModel(checker.provider, checker.model)
    ? new DecisionAutoReviewProvider({
        provider: new HttpDecisionProvider("openrouter", {
          apiKey: judgeKey.apiKey ?? "",
          callObserver: judgeKey.callObserver,
          onUsage,
        }),
        providerId: checker.provider,
        model: checker.model,
      })
    : createAutoReviewProvider("llm", {
        llm: {
          onUsage,
          runtime: deps.runtime,
          checker,
          apiKey: judgeKey.oauth ? undefined : judgeKey.apiKey,
          callObserver: judgeKey.callObserver,
          accountId: judgeKey.accountId,
          gatewayId: judgeKey.gatewayId,
          baseUrl: judgeKey.baseUrl,
          headers: judgeKey.headers,
          allowPrivateEndpoint: judgeKey.allowPrivateEndpoint,
          cacheCapabilities: judgeKey.cacheCapabilities,
          contextWindow: judgeKey.contextWindow,
          maxTokens: judgeKey.maxTokens,
          reasoning: judgeKey.reasoning,
          oauth: judgeKey.oauth
            ? {
                credential: judgeKey.oauth,
                persist: judgeKey.persistOAuth,
                refresh: judgeKey.refreshOAuth,
                retire: judgeKey.retireOAuth,
              }
            : undefined,
          runId,
          spaceId,
          userId,
          botId,
          threadId,
          timeoutMs: autoReviewTimeoutMs(),
        },
      });
}
