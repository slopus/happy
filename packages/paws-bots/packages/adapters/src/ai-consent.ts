import { createHash } from "node:crypto";
import type { AiDataUse, AiRecipient } from "@rakazo/contracts";
import { localBaseUrl } from "./pi-local-provider.js";
import { listPiCatalog } from "./pi-models.js";
import { voiceCatalogEntry } from "./voice-factory.js";

const PRIVACY_URLS: Record<string, string> = {
  cursor: "https://cursor.com/privacy",
  openrouter: "https://openrouter.ai/privacy",
  openai: "https://openai.com/policies/privacy-policy/",
  "openai-codex": "https://openai.com/policies/privacy-policy/",
  anthropic: "https://www.anthropic.com/legal/privacy",
  google: "https://policies.google.com/privacy",
  "vercel-ai-gateway": "https://vercel.com/legal/privacy-policy",
  elevenlabs: "https://elevenlabs.io/privacy-policy",
  cartesia: "https://cartesia.ai/legal/privacy",
  "fish-audio": "https://fish.audio/privacy/",
  xai: "https://x.ai/legal/privacy-policy",
  supermemory: "https://supermemory.ai/privacy",
  honcho: "https://app.honcho.dev/privacy",
  hindsight: "https://vectorize.io/privacy",
};

/** Never expose endpoint paths, query parameters, user info, or credentials in a disclosure. */
export function aiRecipient(input: {
  provider: string;
  use: AiDataUse;
  modelId?: string;
  baseUrl?: string;
}): Omit<AiRecipient, "allowed"> | null {
  if (input.provider === "scripted") return null;
  const endpoint = input.baseUrl ?? (input.provider === "local" ? localBaseUrl() : undefined);
  const origin = endpoint ? new URL(endpoint).origin : undefined;
  const name = recipientName(input.provider, input.use);
  // Bind custom connections to the full endpoint without exposing private URL components.
  const key = createHash("sha256")
    .update(JSON.stringify([input.use, input.provider, endpoint ?? "", input.modelId ?? ""]))
    .digest("hex");
  return {
    key,
    name: origin ? `${name} (${origin})` : name,
    use: input.use,
    detail: ["openrouter", "vercel-ai-gateway"].includes(input.provider)
      ? input.modelId
        ? `${input.modelId}, forwarded to its provider`
        : "Forwards to model providers"
      : (input.modelId ?? ""),
    privacyUrl: PRIVACY_URLS[input.provider],
  };
}

function recipientName(provider: string, use: AiDataUse) {
  if (use === "voice") return voiceCatalogEntry(provider)?.name ?? provider;
  if (use === "memory") {
    if (provider === "supermemory") return "Supermemory";
    if (provider === "honcho") return "Honcho";
    if (provider === "hindsight") return "Hindsight";
    return provider;
  }
  if (provider === "cursor") return "Cursor";
  if (provider === "t3code") return "T3 Code";
  return listPiCatalog().find((entry) => entry.provider === provider)?.providerName ?? provider;
}
