export const SLASH_ACTIONS = [
  { id: "chat-settings" as const, label: "Chat Settings" },
  { id: "settings-general" as const, label: "Settings: General" },
  { id: "settings-usage" as const, label: "Settings: Usage" },
] as const;

export type SlashActionId = (typeof SLASH_ACTIONS)[number]["id"];

/** Keep inline mentions in the draft; only a selected skill adds a prefix. */
export function serializeComposerPrompt(draft: string, skill: { name: string } | null): string {
  const body = draft.replace(/^\s+/, "");
  if (!skill) return body.trimEnd();
  return body.trim().length > 0 ? `/${skill.name}\n${body}` : `/${skill.name}`;
}

export function truncateSlashDescription(value: string, max = 72): string {
  const text = value.replace(/\s+/g, " ").trim();
  const codePoints = Array.from(text);
  if (codePoints.length <= max) return text;
  return `${codePoints
    .slice(0, max - 1)
    .join("")
    .trimEnd()}…`;
}
