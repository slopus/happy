import { describe, expect, it } from 'vitest';
import { HappyError } from './errors';

describe('HappyError', () => {
    it('uses a stable error name for debugging', () => {
        const error = new HappyError('boom', true);
        expect(error.name).toBe('HappyError');
    });
});

