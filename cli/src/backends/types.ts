import type { AgentId } from '@/agent/core';
import type { AgentBackend } from '@/agent/core';
import type { ChecklistId } from '@/capabilities/checklistIds';
import type { Capability } from '@/capabilities/service';
import type { CommandHandler } from '@/cli/commandRegistry';
import type { CloudConnectTarget } from '@/cloud/connect/types';
import type { DaemonSpawnHooks } from '@/daemon/spawnHooks';

export type CatalogAgentId = Extract<AgentId, 'claude' | 'codex' | 'gemini' | 'opencode'>;

export type CatalogAcpBackendCreateResult = Readonly<{ backend: AgentBackend }>;
export type CatalogAcpBackendFactory = (opts: unknown) => CatalogAcpBackendCreateResult;

export type AgentChecklistContributions = Partial<
  Record<ChecklistId, ReadonlyArray<Readonly<{ id: string; params?: Record<string, unknown> }>>>
>;

export type CliDetectSpec = Readonly<{
  /**
   * Candidate argv lists to try for `--version` probing.
   * The first matching semver is returned (best-effort).
   */
  versionArgsToTry?: ReadonlyArray<ReadonlyArray<string>>;
  /**
   * Optional argv for best-effort "am I logged in?" probing.
   * When omitted/undefined, the snapshot returns null (unknown/unsupported).
   */
  loginStatusArgs?: ReadonlyArray<string> | null;
}>;

export type AgentCatalogEntry = Readonly<{
  id: CatalogAgentId;
  cliSubcommand: CatalogAgentId;
  /**
   * Optional CLI subcommand handler for this agent.
   */
  getCliCommandHandler?: () => Promise<CommandHandler>;
  getCliCapabilityOverride?: () => Promise<Capability>;
  getCliDetect?: () => Promise<CliDetectSpec>;
  /**
   * Optional cloud connect target for this agent.
   *
   * When present, `happy connect <agent>` will be available.
   */
  getCloudConnectTarget?: () => Promise<CloudConnectTarget>;
  /**
   * Optional daemon spawn hooks for this agent.
   *
   * These are evaluated by the daemon before spawning a child process.
   */
  getDaemonSpawnHooks?: () => Promise<DaemonSpawnHooks>;
  /**
   * Optional ACP backend factory for this agent.
   *
   * This is intentionally "pull-based" (lazy import) to avoid side-effect
   * registration and import-order dependence.
   */
  getAcpBackendFactory?: () => Promise<CatalogAcpBackendFactory>;
  /**
   * Optional capability checklist contributions for agent-specific UX.
   *
   * This is intentionally data-only (no self-registration) so the capabilities
   * engine can stay deterministic and easy to inspect.
   */
  checklists?: AgentChecklistContributions;
}>;
