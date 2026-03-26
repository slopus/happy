/**
 * Shared Codex integration types that still sit above the SDK layer:
 * execution-policy enums and the normalized event shape our v3 mapper consumes.
 */

export type ApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type EventMsg = { type: string } & Record<string, unknown>;
