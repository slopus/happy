export type ThinkingModeControlProps = { sessionId?: string };
export type ThinkingReplyActionsProps = { sessionId: string; messageId: string; text: string };
// The first release is Web-only. Native keeps its current UI and send behavior.
export function ThinkingModeSetting() { return null; }
export function ThinkingModeControl(_props: ThinkingModeControlProps) { return null; }
export function ThinkingReplyActions(_props: ThinkingReplyActionsProps) { return null; }
