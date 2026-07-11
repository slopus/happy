import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readForcedModel, resolveForcedModel, FORCE_MODEL_MARKER } from './forceModel';

describe('forceModel', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'happy-force-model-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('returns undefined when no marker is present', () => {
        expect(readForcedModel(dir)).toBeUndefined();
    });

    it('reads the model id from the marker file', () => {
        writeFileSync(join(dir, FORCE_MODEL_MARKER), 'claude-sonnet-5\n');
        expect(readForcedModel(dir)).toBe('claude-sonnet-5');
    });

    it('ignores comment and blank lines, taking the first meaningful line', () => {
        writeFileSync(join(dir, FORCE_MODEL_MARKER), '# pin this lane to sonnet\n\n  sonnet  \n');
        expect(readForcedModel(dir)).toBe('sonnet');
    });

    it('forced model overrides the app/picker choice', () => {
        expect(resolveForcedModel('claude-sonnet-5', 'claude-opus-4-8')).toBe('claude-sonnet-5');
    });

    it('falls back to the requested model when nothing is forced', () => {
        expect(resolveForcedModel(undefined, 'claude-opus-4-8')).toBe('claude-opus-4-8');
    });
});
