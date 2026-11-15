import type { ModelCatalogEntry } from "@rakazo/contracts";

/** Protocol/pricing belongs to the adapter catalog, never approval policy. */
const models = [
  { provider: "openrouter", id: "typesafe/jev-1.14", label: "Jev 1.14", inputUsdPerMillion: 0.042 },
];
export function decisionModel(provider: string, id: string) {
  return models.find((model) => model.provider === provider && model.id === id);
}
export function decisionModelCatalog(): ModelCatalogEntry[] {
  return models.map((model) => ({
    provider: model.provider,
    providerName: "OpenRouter",
    id: model.id,
    label: model.label,
    protocol: "decisions",
    billing: "Uses your API key",
    auth: "api-key",
  }));
}
