import { describe, expect, it, vi } from 'vitest';

import { validateRelationshipAdvisorProviderUrl } from '@/modules/relationship-advisor/providerUrlSafety';

describe('validateRelationshipAdvisorProviderUrl', () => {
    it.each([
        'http://api.example.com/v1',
        'https://user:password@api.example.com/v1',
        'https://127.0.0.1/v1',
        'https://10.0.0.8/v1',
        'https://[::1]/v1',
    ])('rejects unsafe provider URL %s', async (baseUrl) => {
        await expect(validateRelationshipAdvisorProviderUrl(baseUrl, vi.fn()))
            .rejects.toThrow('Unsafe relationship advisor provider URL');
    });

    it('rejects a public hostname when DNS resolves it to a private address', async () => {
        const lookup = vi.fn(async () => [{ address: '192.168.1.20', family: 4 as const }]);

        await expect(validateRelationshipAdvisorProviderUrl('https://api.example.com/v1', lookup))
            .rejects.toThrow('Unsafe relationship advisor provider URL');
    });

    it('accepts a credential-free HTTPS URL only when every resolved address is public', async () => {
        const lookup = vi.fn(async () => [
            { address: '93.184.216.34', family: 4 as const },
            { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 as const },
        ]);

        await expect(validateRelationshipAdvisorProviderUrl('https://api.example.com/v1', lookup))
            .resolves.toBe('https://api.example.com/v1');
    });
});
