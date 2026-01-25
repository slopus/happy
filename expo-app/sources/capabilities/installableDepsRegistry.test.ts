import { describe, expect, it } from 'vitest';

import { getInstallableDepRegistryEntries } from './installableDepsRegistry';
import { CODEX_MCP_RESUME_DEP_ID } from './codexMcpResume';
import { CODEX_ACP_DEP_ID } from './codexAcpDep';

describe('getInstallableDepRegistryEntries', () => {
    it('returns the expected built-in installable deps', () => {
        const entries = getInstallableDepRegistryEntries();
        expect(entries.map((e) => e.depId)).toEqual([CODEX_MCP_RESUME_DEP_ID, CODEX_ACP_DEP_ID]);
        expect(entries.map((e) => e.installSpecSettingKey)).toEqual(['codexResumeInstallSpec', 'codexAcpInstallSpec']);
    });
});

