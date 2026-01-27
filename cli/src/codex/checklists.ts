import { CODEX_MCP_RESUME_DIST_TAG } from '@/capabilities/deps/codexMcpResume';
import type { AgentChecklistContributions } from '@/backends/types';

export const checklists = {
  'resume.codex': [
    // Codex can be resumed via either:
    // - MCP resume (codex-mcp-resume), or
    // - ACP resume (codex-acp + ACP `loadSession` support)
    //
    // The app uses this checklist for inactive-session resume UX, so include both:
    // - `includeAcpCapabilities` so the UI can enable/disable resume correctly when `expCodexAcp` is enabled
    // - dep statuses so we can block with a helpful install prompt
    { id: 'cli.codex', params: { includeAcpCapabilities: true, includeLoginStatus: true } },
    { id: 'dep.codex-acp', params: { onlyIfInstalled: true, includeRegistry: true } },
    {
      id: 'dep.codex-mcp-resume',
      params: { includeRegistry: true, onlyIfInstalled: true, distTag: CODEX_MCP_RESUME_DIST_TAG },
    },
  ],
} satisfies AgentChecklistContributions;

