import { describe, it, expect } from 'vitest';

describe('doctor redaction', () => {
    it('does not treat ${VAR:-default} templates as safe', async () => {
        const doctorModule = await import('./doctor');
        const maskValue = (doctorModule as any).maskValue as ((value: string | undefined) => string | undefined) | undefined;

        expect(typeof maskValue).toBe('function');
        expect(maskValue!('${SAFE_TEMPLATE}')).toBe('${SAFE_TEMPLATE}');
        expect(maskValue!('${LEAK:-sk-live-secret}')).not.toBe('${LEAK:-sk-live-secret}');
    });
});

