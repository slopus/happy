import { plural, t } from "@lingui/core/macro";
import type { ModelCredential } from "@rakazo/contracts";

type ModelPreflightOutcome =
  | "timeout"
  | "rate_limit"
  | "unauthorized"
  | "unavailable_model"
  | "unreachable"
  | "needs_sign_in"
  | "missing_fields"
  | "unknown";

export type ModelPreflightFailure = {
  outcome: ModelPreflightOutcome;
  message: string;
  nextAction: string;
};

type StoredModelAuthKind = NonNullable<ModelCredential["authKind"]>;

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[a-zA-Z0-9_-]{8,}\b/g,
  /\bBearer\s+[\w.~+/=-]+/gi,
  /\bapi[_-]?key["']?\s*[=:]\s*["']?[^\s"',}]+/gi,
];

/** Strip patterns that look like credentials from user-visible errors. */
export function sanitizeModelConnectionError(raw: string): string {
  let text = raw.trim();
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, "•••");
  }
  return text;
}

function messageFromError(error: unknown): string {
  if (error instanceof Error) return sanitizeModelConnectionError(error.message);
  return sanitizeModelConnectionError(String(error));
}

export function classifyModelConnectionFailure(
  error: unknown,
  context: { modelId?: string; discoveredModels?: string[]; manualEntry?: boolean } = {},
): ModelPreflightFailure {
  const message = messageFromError(error);
  const lower = message.toLowerCase();

  if (context.modelId && context.discoveredModels && context.discoveredModels.length > 0) {
    const modelId = sanitizeModelConnectionError(context.modelId.trim());
    if (modelId && !context.discoveredModels.includes(context.modelId.trim())) {
      return {
        outcome: "unavailable_model",
        message: t`Model "${modelId}" was not listed.`,
        nextAction:
          context.manualEntry === false
            ? t`Pick a model from the catalog.`
            : t`Pick a model from the list or enter a model id served by this endpoint.`,
      };
    }
  }

  if (lower.includes("timed out") || lower.includes("timeout")) {
    return {
      outcome: "timeout",
      message: message || t`The connection timed out.`,
      nextAction: t`Check the server URL and network, then test again.`,
    };
  }

  if (/\b429\b/.test(lower) || lower.includes("rate limit") || lower.includes("rate-limit")) {
    return {
      outcome: "rate_limit",
      message: message || t`The provider is rate-limiting requests.`,
      nextAction: t`Wait a moment and test again.`,
    };
  }

  if (
    /\b(401|403)\b/.test(lower) ||
    lower.includes("unauthorized") ||
    lower.includes("invalid api key") ||
    lower.includes("authentication")
  ) {
    return {
      outcome: "unauthorized",
      message: message || t`Authentication failed.`,
      nextAction: t`Check the API key or sign-in, then test again.`,
    };
  }

  if (
    lower.includes("econnrefused") ||
    lower.includes("connection refused") ||
    lower.includes("failed to fetch") ||
    lower.includes("network") ||
    lower.includes("enotfound") ||
    lower.includes("could not reach")
  ) {
    return {
      outcome: "unreachable",
      message: message || t`Could not reach the model server.`,
      nextAction: t`Confirm the URL is reachable from this browser session, then test again.`,
    };
  }

  return {
    outcome: "unknown",
    message: message || t`Connection test failed.`,
    nextAction: t`Review provider settings and test again.`,
  };
}

/** Failure when a non-empty model list omits the selected id. Empty lists stay reachable. */
export function unavailableSelectedModel(
  modelId: string | undefined,
  discoveredModels: string[],
  options?: { manualEntry?: boolean },
): ModelPreflightFailure | null {
  const trimmed = modelId?.trim() ?? "";
  if (!trimmed || discoveredModels.length === 0 || discoveredModels.includes(trimmed)) return null;
  return classifyModelConnectionFailure(new Error("model not listed"), {
    modelId: trimmed,
    discoveredModels,
    manualEntry: options?.manualEntry,
  });
}

type ListedModelCredential = {
  id?: string;
  provider: string;
  authKind?: StoredModelAuthKind;
  modelId?: string;
  isDefault?: boolean;
  reconnectRequired?: boolean;
};

/**
 * Newest-first list. The row that owns `modelId` wins, then the space default,
 * then any saved model for the provider, then the newest row.
 */
function credentialForSpaceModel<T extends ListedModelCredential>(
  credentials: readonly T[],
  provider: string,
  modelId?: string,
): T | undefined {
  const rows = credentials.filter((entry) => entry.provider === provider);
  const requested = modelId?.trim() ?? "";
  if (requested) {
    const owner = rows.find((entry) => entry.modelId?.trim() === requested);
    if (owner) return owner;
  }
  return (
    rows.find((entry) => entry.isDefault) ??
    rows.find((entry) => Boolean(entry.modelId?.trim())) ??
    rows[0]
  );
}

/** Separate a failed credential lookup from an empty list or an unreadable secret. */
export async function loadStoredModelAuth(
  provider: string,
  listCredentials: () => Promise<ReadonlyArray<ListedModelCredential>>,
  modelId?: string,
  credentialId?: string | null,
): Promise<{
  storedAuthKind: StoredModelAuthKind | null;
  credentialLookupFailed: boolean;
  credentialUnreadable: boolean;
  reconnectRequired: boolean;
}> {
  try {
    const credentials = await listCredentials();
    const match =
      credentialId === undefined
        ? credentialForSpaceModel(credentials, provider, modelId)
        : credentials.find((entry) => entry.id === credentialId && entry.provider === provider);
    return {
      storedAuthKind: match?.authKind ?? null,
      credentialLookupFailed: false,
      credentialUnreadable: Boolean(match && match.authKind === undefined),
      reconnectRequired: match?.reconnectRequired === true,
    };
  } catch {
    return {
      storedAuthKind: null,
      credentialLookupFailed: true,
      credentialUnreadable: false,
      reconnectRequired: false,
    };
  }
}

type ModelConnectionPreflightInput = {
  authKind: "api-key" | "oauth";
  provider: string;
  apiKey?: string;
  modelId?: string;
  /** Kind of the stored credential, when a lookup succeeded and the secret was readable. */
  storedAuthKind?: StoredModelAuthKind | null;
  credentialLookupFailed?: boolean;
  /** A credential row exists but its kind could not be read. */
  credentialUnreadable?: boolean;
  /** The stored subscription sign-in was rejected and has to be signed in again. */
  reconnectRequired?: boolean;
  /** Catalog entry says this provider has a pinned models-list URL. */
  catalogProbe?: boolean;
  probeCatalog?: (input: { provider: string; apiKey: string }) => Promise<{ models: string[] }>;
};

export async function runModelConnectionPreflight(
  input: ModelConnectionPreflightInput,
): Promise<
  { ok: true; discoveredModels: string[] } | { ok: false; failure: ModelPreflightFailure }
> {
  if (input.authKind === "oauth") {
    if (input.credentialLookupFailed || input.credentialUnreadable) {
      return {
        ok: false,
        failure: {
          outcome: "unknown",
          message: t`Could not check stored credentials.`,
          nextAction: t`Try the test again.`,
        },
      };
    }
    if (input.reconnectRequired) {
      return {
        ok: false,
        failure: {
          outcome: "needs_sign_in",
          message: t`This provider is not connected yet.`,
          nextAction: t`Finish subscription sign-in, then test again.`,
        },
      };
    }
    if (input.storedAuthKind === "oauth") {
      return { ok: true, discoveredModels: [] };
    }
    if (input.storedAuthKind === "api_key" || input.storedAuthKind === "openai_compatible") {
      return {
        ok: false,
        failure: {
          outcome: "needs_sign_in",
          message: t`An API key is stored for this provider, not a subscription sign-in.`,
          nextAction: t`Sign in with the subscription, or test the API key instead.`,
        },
      };
    }
    return {
      ok: false,
      failure: {
        outcome: "needs_sign_in",
        message: t`This provider is not connected yet.`,
        nextAction: t`Finish subscription sign-in, then test again.`,
      },
    };
  }

  const trimmedKey = input.apiKey?.trim() ?? "";
  const trimmedModel = input.modelId?.trim() ?? "";

  if (trimmedKey.length < 8) {
    return {
      ok: false,
      failure: {
        outcome: "missing_fields",
        message: t`Enter an API key before testing.`,
        nextAction: t`Paste your API key, then test again.`,
      },
    };
  }
  if (!input.catalogProbe || !input.probeCatalog) {
    return {
      ok: false,
      failure: {
        outcome: "unknown",
        message: t`This provider cannot be tested without saving.`,
        nextAction: t`Use Connect to verify the key.`,
      },
    };
  }
  try {
    const { models } = await input.probeCatalog({
      provider: input.provider,
      apiKey: trimmedKey,
    });
    const unavailable = unavailableSelectedModel(trimmedModel, models, { manualEntry: false });
    if (unavailable) return { ok: false, failure: unavailable };
    return { ok: true, discoveredModels: models };
  } catch (error) {
    return {
      ok: false,
      failure: classifyModelConnectionFailure(error, { modelId: trimmedModel }),
    };
  }
}

/** Catalog models-list result. Custom servers use `openAiCompatibleProbeSuccessMessage`. */
export function modelPreflightSuccessMessage(modelCount: number): string {
  if (modelCount === 0) {
    return t`No models listed.`;
  }
  return t`Models list OK. ${plural(modelCount, {
    one: "# model",
    other: "# models",
  })} available. Chat was not tested.`;
}
