/** Shared section membership and order; surfaces omit unavailable capabilities. */
export const BOT_SETTINGS_SECTIONS = {
  openWork: ["scratchpad"],
  memory: ["knowledge"],
  advanced: [
    "model",
    "thinking",
    "computer",
    "memoryScope",
    "readAloud",
    "voice",
    "dailyCheckIns",
    "crossSpaceCommunication",
    "fleetManagement",
    "replyMode",
    "instructions",
    "description",
    "disabledTools",
    "credentials",
    "skills",
    "export",
    "clear",
  ],
} as const;

export const BOT_SETTINGS_ADVANCED_ORDER = BOT_SETTINGS_SECTIONS.advanced;

/** Labels stay literal in each platform's translation calls. */
export const BOT_COMPUTER_MODES = ["team", "dedicated"] as const;
