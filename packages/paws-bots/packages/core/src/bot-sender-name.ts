/** Show sender names when the thread needs to distinguish bot speakers. */
export function shouldShowBotSenderName({
  isGroup,
  speakerBotIds,
}: {
  isGroup: boolean;
  speakerBotIds: readonly (string | undefined)[];
}): boolean {
  return isGroup || new Set(speakerBotIds.filter((id) => id !== undefined)).size > 1;
}
