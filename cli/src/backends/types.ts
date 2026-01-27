import type { AgentBackend } from '@/agent/core';
import type { ChecklistId } from '@/capabilities/checklistIds';
import type { Capability } from '@/capabilities/service';
import type { CommandHandler } from '@/cli/commandRegistry';
import type { CloudConnectTarget } from '@/cloud/connectTypes';
import type { DaemonSpawnHooks } from '@/daemon/spawnHooks';

import {
  AGENT_IDS as CATALOG_AGENT_IDS,
  DEFAULT_AGENT_ID as DEFAULT_CATALOG_AGENT_ID,
  type AgentId as CatalogAgentId,
  type VendorResumeSupportLevel,
} from '@happy/agents';

export { CATALOG_AGENT_IDS, DEFAULT_CATALOG_AGENT_ID };
export type { CatalogAgentId, VendorResumeSupportLevel };

export type CatalogAcpBackendCreateResult = Readonly<{ backend: AgentBackend }>;
export type CatalogAcpBackendFactory = (opts: unknown) => CatalogAcpBackendCreateResult;

export type VendorResumeSupportParams = Readonly<{
  experimentalCodexResume?: boolean;
  experimentalCodexAcp?: boolean;
}>;

export type VendorResumeSupportFn = (params: VendorResumeSupportParams) => boolean;

export type HeadlessTmuxArgvTransform = (argv: string[]) => string[];

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
  /**
   * Optional extra capabilities contributed by this agent.
   *
   * Use this for agent-specific deps/tools/experiments, not the base `cli.<agentId>`
   * capability (handled by `getCliCapabilityOverride` / generic fallback).
   */
  getCapabilities?: () => Promise<ReadonlyArray<Capability>>;
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
   * Whether this agent supports vendor-level resume (NOT Happy session resume).
   *
   * Used by the daemon to decide whether it may pass `--resume <vendorSessionId>`.
   */
  vendorResumeSupport: VendorResumeSupportLevel;
  /**
   * Optional predicate used when vendor resume support is experimental.
   *
   * This intentionally stays catalog-driven and lazy-imported.
   */
  getVendorResumeSupport?: () => Promise<VendorResumeSupportFn>;
  /**
   * Optional argv rewrite when launching headless sessions in tmux.
   *
   * Used by the CLI `--tmux` launcher before it spawns a child `happy ...` process.
   */
  getHeadlessTmuxArgvTransform?: () => Promise<HeadlessTmuxArgvTransform>;
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
