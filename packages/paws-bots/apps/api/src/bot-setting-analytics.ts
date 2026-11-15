import type { AnalyticsBotSetting, UpdateBotInput } from "@rakazo/contracts";

type Field = Exclude<keyof UpdateBotInput, "botId">;

// Pinning and sections are sidebar organization, not settings.
const SETTINGS: Partial<Record<Field, AnalyticsBotSetting>> = {
  name: "name",
  description: "description",
  instructions: "instructions",
  color: "avatar",
  avatarSet: "avatar",
  notifyOnFinish: "notifications",
  memoryScope: "memory",
  voiceId: "voice",
  autoSpeak: "auto_speak",
  modelProvider: "model",
  modelId: "model",
  thinkingLevel: "thinking",
  teamChatAmbientEnabled: "team_chat",
  teamChatRules: "team_chat",
  crossSpaceCommunication: "cross_space",
  dailyCheckIns: "daily_check_ins",
  fleetManagement: "fleet_management",
  replyMode: "reply_mode",
  disabledBuiltinTools: "tools",
};

/** Settings an update actually changes; clients resend unchanged fields with every save. */
export function changedBotSettings(
  existing: Partial<Record<Field, unknown>>,
  input: UpdateBotInput,
): AnalyticsBotSetting[] {
  const changed = new Set<AnalyticsBotSetting>();
  for (const [field, setting] of Object.entries(SETTINGS) as [Field, AnalyticsBotSetting][]) {
    const next = input[field];
    if (next === undefined) continue;
    if (JSON.stringify(next) !== JSON.stringify(existing[field])) changed.add(setting);
  }
  return [...changed];
}
