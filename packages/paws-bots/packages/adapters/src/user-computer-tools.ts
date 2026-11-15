// Tool names and the app label the approval card shows. Kept free of Node imports: the web
// approval-card fixture loads approval-ask.ts in the browser.
export const USER_COMPUTER_SHELL_TOOL = "user_computer_shell";
export const USER_COMPUTER_OBSERVE_TOOL = "user_computer_observe";
export const USER_COMPUTER_ACT_TOOL = "user_computer_act";
/** Both look at or drive one app, so one approval covers that app for the chat. */
export const USER_COMPUTER_SCREEN_TOOLS: ReadonlySet<string> = new Set([
  USER_COMPUTER_OBSERVE_TOOL,
  USER_COMPUTER_ACT_TOOL,
]);
export const USER_COMPUTER_TOOLS: ReadonlySet<string> = new Set([
  USER_COMPUTER_SHELL_TOOL,
  ...USER_COMPUTER_SCREEN_TOOLS,
]);

/** The app a screen call names, as its approval card shows it and later calls match it. */
export function userComputerAppName(value: unknown): string {
  return String(value ?? "")
    .replaceAll(/[^\p{L}\p{N} .&'+-]/gu, "")
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}
