import type { CapabilityDetectRequest, ChecklistId } from './types';
import { CODEX_MCP_RESUME_DIST_TAG } from './deps/codexMcpResume';

export const checklists: Record<ChecklistId, CapabilityDetectRequest[]> = {
    'new-session': [
        { id: 'cli.codex' },
        { id: 'cli.claude' },
        { id: 'cli.gemini' },
        { id: 'tool.tmux' },
    ],
    'machine-details': [
        { id: 'cli.codex' },
        { id: 'cli.claude' },
        { id: 'cli.gemini' },
        { id: 'tool.tmux' },
        { id: 'dep.codex-mcp-resume' },
    ],
    'resume.codex': [
        { id: 'cli.codex' },
        { id: 'dep.codex-mcp-resume', params: { includeRegistry: true, onlyIfInstalled: true, distTag: CODEX_MCP_RESUME_DIST_TAG } },
    ],
};

