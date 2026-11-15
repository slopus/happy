import { listPiCatalog } from "@rakazo/adapters";
import type { Actor, AnalyticsErrorKind, AnalyticsModelConnectMethod } from "@rakazo/contracts";
import {
  canonicalPiProviderId,
  MODEL_KEY_REJECTED_ERROR,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from "@rakazo/contracts";
import { normalizeRunError } from "@rakazo/core";
import type { RouterDeps } from "./router.js";
import { modelSetup } from "./routes/shared.js";

type ModelConnectOutcome =
  | { name: "model_connect_started" | "model_connected" }
  | { name: "model_connect_failed"; error: unknown };

/**
 * Measures the "Connect a model" step: only while the user has no model chat can run, so
 * later settings edits stay out of the funnel. Returns a recorder that does nothing otherwise.
 */
export async function firstModelConnectAnalytics(
  deps: RouterDeps,
  actor: Actor,
  method: Exclude<AnalyticsModelConnectMethod, "compatible">,
): Promise<(provider: string | undefined, outcome: ModelConnectOutcome) => void> {
  const analytics = deps.analytics;
  if (!analytics) return () => {};
  try {
    if (!(await modelSetup(deps, actor)).needsModel) return () => {};
  } catch {
    // Measurement must never fail a connection.
    return () => {};
  }
  return (provider, outcome) => {
    const properties = modelConnectProperties(provider, method);
    analytics.capture(
      actor.userId,
      outcome.name === "model_connect_failed"
        ? { name: outcome.name, ...properties, errorKind: modelConnectErrorKind(outcome.error) }
        : { name: outcome.name, ...properties },
    );
  };
}

/** Only fixed catalog ids leave the server; compatible endpoints never send their address. */
export function modelConnectProperties(
  provider: string | undefined,
  method: Exclude<AnalyticsModelConnectMethod, "compatible">,
): { method: AnalyticsModelConnectMethod; provider?: string } {
  if (provider === OPENAI_COMPATIBLE_PROVIDER_ID) return { method: "compatible" };
  const canonical = provider && canonicalPiProviderId(provider);
  return canonical && listPiCatalog().some((entry) => entry.provider === canonical)
    ? { method, provider: canonical }
    : { method };
}

export function modelConnectErrorKind(error: unknown): AnalyticsErrorKind {
  const message = error instanceof Error ? error.message : "";
  if (message === MODEL_KEY_REJECTED_ERROR) return "auth";
  return normalizeRunError(message).kind ?? "other";
}
