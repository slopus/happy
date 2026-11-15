export function computerTestSandbox(provider = "boat") {
  if (provider === "boat") return { provider, apiKeyEnv: "BOAT_API_KEY" } as const;
  if (provider === "e2b") return { provider, apiKeyEnv: "E2B_API_KEY" } as const;
  if (provider === "novita") return { provider, apiKeyEnv: "NOVITA_API_KEY" } as const;
  throw new Error("Live computer tests support --sandbox boat, --sandbox e2b, or --sandbox novita");
}
