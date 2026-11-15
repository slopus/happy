import { createHash } from "node:crypto";
import type {
  AdapterContext,
  AgentUsage,
  PaidService,
  PaidServiceCallResult,
  PaidServiceProvider,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  organizationForMember,
  recordModelCreditReceipt,
  recordUsage,
  reserveModelCredits,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { z } from "zod";

/** Hosted calls are billed at the provider's cost plus this share. */
export const PAID_SERVICE_MARKUP = 1.2;
/** Usage and credit rows of these calls share this provider value; the model is the service id. */
export const PAID_SERVICE_USAGE_PROVIDER = "services";
export const MAX_PAID_SERVICE_CALL_USD = 2;
const RESULT_MAX_CHARS = 50_000;
const BODY_MAX_CHARS = 20_000;
const QUERY_MAX_CHARS = 4_000;
const SEARCH_RESULTS = 10;

const searchArgs = z.object({ query: z.string().trim().min(1).max(200) });
const callArgs = z.object({
  service: z.string().trim().min(1).max(300),
  query: z
    .record(z.string().max(100), z.union([z.string().max(2_000), z.number(), z.boolean()]))
    .optional(),
  body: z.unknown().optional(),
  max_cost_usd: z.number().min(0.001).max(MAX_PAID_SERVICE_CALL_USD),
});

type Scope = { userId: string; spaceId: string; runId: string; botId: string };
type Deps = { prisma: PrismaClient; provider: PaidServiceProvider; billing: boolean };

const roundUsd = (usd: number) => Math.round(usd * 1_000_000) / 1_000_000;
const factor = (billing: boolean) => (billing ? PAID_SERVICE_MARKUP : 1);

function shownService(service: PaidService, billing: boolean) {
  return {
    id: service.id,
    name: service.name,
    description: service.description,
    price_usd: service.priceUsd === null ? null : roundUsd(service.priceUsd * factor(billing)),
    ...(service.priceVaries ? { price_varies: true } : {}),
    params: service.params,
  };
}

export async function serviceSearchFromTool(
  provider: PaidServiceProvider,
  context: AdapterContext,
  args: Record<string, unknown>,
  billing: boolean,
) {
  const parsed = searchArgs.safeParse(args);
  if (!parsed.success) return { error: "query must be 1-200 characters." };
  try {
    const services = await provider.search(parsed.data.query, context);
    return {
      services: services
        .filter(
          (service) =>
            service.priceUsd === null ||
            service.priceUsd * factor(billing) <= MAX_PAID_SERVICE_CALL_USD,
        )
        .slice(0, SEARCH_RESULTS)
        .map((service) => shownService(service, billing)),
    };
  } catch (error) {
    context.signal.throwIfAborted();
    getLogger().warn("paid_services.search_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { error: "Service search is unavailable right now." };
  }
}

function boundedResult(data: unknown) {
  const text = JSON.stringify(data) ?? "null";
  return text.length > RESULT_MAX_CHARS
    ? { result_truncated: true, result: text.slice(0, RESULT_MAX_CHARS) }
    : { result: data };
}

function refusal(result: Extract<PaidServiceCallResult, { outcome: "refused" }>, maxUsd: number) {
  if (result.reason === "over_max_cost")
    return {
      error: `This call would cost more than $${maxUsd}. Ask for fewer results, or raise max_cost_usd (at most $${MAX_PAID_SERVICE_CALL_USD}).`,
    };
  if (result.reason === "invalid_input")
    return { error: result.message ?? "The service refused this input. Check its params." };
  return { error: "This service is unavailable right now. Try another one." };
}

/**
 * Run one paid service. A hosted deployment holds the most the call may cost from the
 * organization's credits first, then settles to what the provider charged plus the markup. A call
 * that may have run without an answer keeps its hold for the credit reconciler to flag.
 */
export async function serviceCallFromTool(
  deps: Deps,
  scope: Scope,
  args: Record<string, unknown>,
  effectKey: string,
  context: AdapterContext,
) {
  const parsed = callArgs.safeParse(args);
  if (!parsed.success)
    return {
      error: `Pass service, max_cost_usd (at most ${MAX_PAID_SERVICE_CALL_USD}), then query and/or body as its params list them.`,
    };
  const { service: serviceId, query, body, max_cost_usd } = parsed.data;
  if (body !== undefined && (JSON.stringify(body)?.length ?? 0) > BODY_MAX_CHARS)
    return { error: "body is too large." };
  if (
    query &&
    new URLSearchParams(
      Object.entries(query).map(([key, value]) => [key, String(value)]),
    ).toString().length > QUERY_MAX_CHARS
  )
    return { error: "query is too large." };
  const service = await deps.provider.describe(serviceId, context).catch((error: unknown) => {
    context.signal.throwIfAborted();
    getLogger().warn("paid_services.describe_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  });
  if (service === undefined) return { error: "Service search is unavailable right now." };
  if (!service) return { error: "Unknown service. Use service_search to find one." };

  const markup = factor(deps.billing);
  const maxUsd = roundUsd(max_cost_usd);
  const key = createHash("sha256").update(effectKey).digest("hex");
  const callId = `service:${key}`;
  const membership = deps.billing ? await organizationForMember(deps.prisma, scope) : null;
  if (deps.billing && !membership) return { error: "Credits are unavailable for this space." };

  let reservationId: string | undefined;
  if (membership) {
    try {
      reservationId = await reserveModelCredits(deps.prisma, membership.organizationId, maxUsd, {
        callId,
        userId: scope.userId,
        spaceId: scope.spaceId,
        runId: scope.runId,
        provider: PAID_SERVICE_USAGE_PROVIDER,
        model: service.id,
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Not enough"))
        return { error: "Not enough credits for this service. Add credits in Billing." };
      throw error;
    }
  }

  let result: PaidServiceCallResult;
  try {
    result = await deps.provider.call(
      service,
      { ...(query ? { query } : {}), ...(body !== undefined ? { body } : {}) },
      {
        idempotencyKey: key,
        customer: membership?.organizationId ?? scope.spaceId,
        maxCostUsd: maxUsd / markup,
      },
      context,
    );
  } catch (error) {
    getLogger().warn("paid_services.call_unfinished", {
      service: service.id,
      error: error instanceof Error ? error.message : String(error),
    });
    context.signal.throwIfAborted();
    return {
      error:
        "The call did not finish, and it may still be charged. Don't retry it automatically; tell the user.",
    };
  }

  // The agent agreed to at most maxUsd; a provider that settles above its ceiling is not passed on.
  const costUsd =
    result.outcome === "answered" ? Math.min(maxUsd, roundUsd(result.costUsd * markup)) : 0;
  if (reservationId || result.outcome === "answered") {
    const usage: AgentUsage = {
      providerRequestId: result.outcome === "answered" ? (result.providerCallId ?? null) : null,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd,
      costSource: "provider-reported",
      usageSource: result.outcome === "answered" ? "provider-reported" : "not-started",
    };
    if (reservationId) {
      try {
        await recordModelCreditReceipt(deps.prisma, reservationId, usage);
      } catch (error) {
        getLogger().error("paid_services.receipt_unrecorded", {
          service: service.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    try {
      await recordUsage(
        deps.prisma,
        {
          type: "usage",
          ...usage,
          provider: PAID_SERVICE_USAGE_PROVIDER,
          model: service.id,
          callId,
        },
        {
          spaceId: scope.spaceId,
          userId: scope.userId,
          botId: scope.botId,
          runId: scope.runId,
          operationId: callId,
        },
      );
    } catch (error) {
      getLogger().error("paid_services.usage_unrecorded", {
        service: service.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (result.outcome === "refused") return refusal(result, maxUsd);
  if (!result.ok)
    return {
      error: `The service answered ${result.status}.`,
      cost_usd: costUsd,
      ...boundedResult(result.data),
    };
  return { service: service.name, cost_usd: costUsd, ...boundedResult(result.data) };
}
