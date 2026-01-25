import type { CapabilityDetectRequest, ChecklistId } from './types';
import { CODEX_MCP_RESUME_DIST_TAG } from './deps/codexMcpResume';

export const checklists: Record<ChecklistId, CapabilityDetectRequest[]> = {
    'new-session': [
        { id: 'cli.codex' },
        { id: 'cli.claude' },
        { id: 'cli.gemini' },
        { id: 'cli.opencode' },
        { id: 'tool.tmux' },
    ],
    'machine-details': [
        { id: 'cli.codex' },
        { id: 'cli.claude' },
        { id: 'cli.gemini' },
        { id: 'cli.opencode' },
        { id: 'tool.tmux' },
        { id: 'dep.codex-mcp-resume' },
        { id: 'dep.codex-acp' },
    ],
    'resume.codex': [
        { id: 'cli.codex' },
        { id: 'dep.codex-mcp-resume', params: { includeRegistry: true, onlyIfInstalled: true, distTag: CODEX_MCP_RESUME_DIST_TAG } },
    ],
    'resume.gemini': [
        { id: 'cli.gemini', params: { includeAcpCapabilities: true, includeLoginStatus: true } },
    ],
    'resume.opencode': [
        { id: 'cli.opencode', params: { includeAcpCapabilities: true, includeLoginStatus: true } },
    ],
};
