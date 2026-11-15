/**
 * The official Claude Code CLI on the server's own host, signed in by the operator with
 * `claude auth login`. Kept apart from the provider so the deployment model can name it
 * without loading the CLI bridge.
 */
export const CLAUDE_CODE_PROVIDER_ID = "claude-code";

/** What the deployment's host credentials are, for the existing "Uses this server's own …" line. */
export const CLAUDE_CODE_CREDENTIAL_SOURCE = "CLI";
