import type { ApnsVoipConfig } from "./apns-voip.js";

/** The published app's bundle id (apps/mobile/app.json); self-built apps set their own. */
const DEFAULT_BUNDLE_ID = "com.rakazo.app";

export function apnsVoipConfig(
  source: Record<string, string | undefined>,
): ApnsVoipConfig | undefined {
  if (!source.APNS_VOIP_KEY_ID && !source.APNS_VOIP_TEAM_ID && !source.APNS_VOIP_PRIVATE_KEY)
    return undefined;
  if (!source.APNS_VOIP_KEY_ID || !source.APNS_VOIP_TEAM_ID || !source.APNS_VOIP_PRIVATE_KEY)
    throw new Error(
      "APNS_VOIP_KEY_ID, APNS_VOIP_TEAM_ID and APNS_VOIP_PRIVATE_KEY must be configured together.",
    );
  if (
    source.APNS_VOIP_ENVIRONMENT &&
    !["sandbox", "production"].includes(source.APNS_VOIP_ENVIRONMENT)
  )
    throw new Error("APNS_VOIP_ENVIRONMENT must be sandbox or production.");
  return {
    keyId: source.APNS_VOIP_KEY_ID,
    teamId: source.APNS_VOIP_TEAM_ID,
    privateKey: source.APNS_VOIP_PRIVATE_KEY.replace(/\\n/g, "\n"),
    environment: source.APNS_VOIP_ENVIRONMENT === "sandbox" ? "sandbox" : "production",
    bundleId: source.APNS_VOIP_BUNDLE_ID || DEFAULT_BUNDLE_ID,
  };
}

export async function createApnsVoipProvider(config: ApnsVoipConfig | undefined) {
  if (!config) return undefined;
  const { ApnsVoipProvider } = await import("./apns-voip.js");
  return new ApnsVoipProvider(config);
}

/** The same key also sends Live Activity updates. */
export async function createApnsActivityProvider(config: ApnsVoipConfig | undefined) {
  if (!config) return undefined;
  const { ApnsActivityProvider } = await import("./apns-activity.js");
  return new ApnsActivityProvider(config);
}
