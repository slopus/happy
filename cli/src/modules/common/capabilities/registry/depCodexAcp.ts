import type { Capability } from '../service';
import { CapabilityError } from '../errors';
import { getCodexAcpDepStatus, installCodexAcp } from '../deps/codexAcp';

export const codexAcpDepCapability: Capability = {
    descriptor: {
        id: 'dep.codex-acp',
        kind: 'dep',
        title: 'Codex ACP',
        methods: {
            install: { title: 'Install' },
            upgrade: { title: 'Upgrade' },
        },
    },
    detect: async ({ request }) => {
        const includeRegistry = Boolean((request.params ?? {}).includeRegistry);
        const onlyIfInstalled = Boolean((request.params ?? {}).onlyIfInstalled);
        const distTag = typeof (request.params ?? {}).distTag === 'string' ? String((request.params ?? {}).distTag) : undefined;
        return await getCodexAcpDepStatus({ includeRegistry, onlyIfInstalled, distTag });
    },
    invoke: async ({ method, params }) => {
        if (method !== 'install' && method !== 'upgrade') {
            throw new CapabilityError(`Unsupported method: ${method}`, 'unsupported-method');
        }

        const installSpec = method === 'install' && typeof params?.installSpec === 'string'
            ? String(params.installSpec)
            : undefined;

        const result = await installCodexAcp(installSpec);
        if (!result.ok) {
            return { ok: false, error: { message: result.errorMessage, code: 'install-failed' }, logPath: result.logPath };
        }
        return { ok: true, result: { logPath: result.logPath } };
    },
};
