/**
 * Empty / unknown / cursor-without-key becomes none so the API still boots and
 * cloud-agent tools stay uninjected.
 */
export function resolveCloudAgentProvider(source: NodeJS.ProcessEnv = process.env): string {
  const configured = source.CLOUD_AGENT_PROVIDER;
  if (configured !== undefined && !configured.trim()) return "none";
  const requested = (configured?.trim() || "none").toLowerCase();
  if (requested === "none" || requested === "") return "none";
  if (requested === "emulator" || requested === "fake") return "emulator";
  if (requested === "cursor") {
    return optional(source.CURSOR_API_KEY) && optional(source.CLOUD_AGENT_SPACE_ID)
      ? "cursor"
      : "none";
  }
  // Soft-fall: do not throw at API boot for typos / future vendor names.
  return "none";
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
