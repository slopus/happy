/**
 * Local OpenAI-compatible model server (Ollama, LM Studio, llama.cpp, MLX).
 * Kept apart from pi-local-provider.ts so the runtime limits can name it without loading the provider.
 */
export const LOCAL_PROVIDER_ID = "local";

/** `off` declares that the local server does not cache prompts. */
export const LOCAL_PROMPT_CACHE_ENV = "RAKAZO_LOCAL_PROMPT_CACHE";

/** Whether the operator declared that the server behind `providerId` does not cache prompts. */
export function promptCacheDeclaredOff(
  providerId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    providerId === LOCAL_PROVIDER_ID && env[LOCAL_PROMPT_CACHE_ENV]?.trim().toLowerCase() === "off"
  );
}

/** Comma-separated model ids exactly as the local server names them. */
export function localModelIds(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.RAKAZO_LOCAL_MODELS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

/** Bearer key for a local server that requires one; unset sends the placeholder `local`. */
export function localModelsApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.RAKAZO_LOCAL_MODELS_API_KEY?.trim() || undefined;
}
