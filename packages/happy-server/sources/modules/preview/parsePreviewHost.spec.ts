import { describe, it, expect } from 'vitest';
import { parsePreviewHost } from '@/modules/preview/parsePreviewHost';

const MID = '12345678-1234-1234-1234-123456789abc';

describe('parsePreviewHost', () => {
    it('parses production wildcard host', () => {
        expect(parsePreviewHost(`${MID}-3000.preview.saycode.ai`)).toEqual({
            machineId: MID,
            port: 3000,
        });
    });

    it('parses env-prefixed wildcard host (staging/dev)', () => {
        expect(parsePreviewHost(`${MID}-8080.preview.staging.saycode.ai`)).toEqual({
            machineId: MID,
            port: 8080,
        });
        expect(parsePreviewHost(`${MID}-8080.preview.dev.saycode.ai`)).toEqual({
            machineId: MID,
            port: 8080,
        });
    });

    it('parses host with port suffix (local dev)', () => {
        expect(parsePreviewHost(`${MID}-3005.preview.localhost:3005`)).toEqual({
            machineId: MID,
            port: 3005,
        });
    });

    it('normalizes uppercase machineId to lowercase', () => {
        const upper = MID.toUpperCase();
        expect(parsePreviewHost(`${upper}-3000.preview.saycode.ai`)).toEqual({
            machineId: MID,
            port: 3000,
        });
    });

    it('returns null for studio root host', () => {
        expect(parsePreviewHost('saycode.ai')).toBeNull();
        expect(parsePreviewHost('staging.saycode.ai')).toBeNull();
    });

    it('returns null when not under .preview. zone', () => {
        expect(parsePreviewHost(`${MID}-3000.saycode.ai`)).toBeNull();
        expect(parsePreviewHost(`${MID}-3000.notpreview.saycode.ai`)).toBeNull();
    });

    it('returns null for malformed machineId', () => {
        expect(parsePreviewHost('bad-host-3000.preview.saycode.ai')).toBeNull();
        expect(parsePreviewHost(`${MID.slice(0, -1)}-3000.preview.saycode.ai`)).toBeNull();
    });

    it('returns null for out-of-range port', () => {
        expect(parsePreviewHost(`${MID}-0.preview.saycode.ai`)).toBeNull();
        expect(parsePreviewHost(`${MID}-65536.preview.saycode.ai`)).toBeNull();
        expect(parsePreviewHost(`${MID}-999999.preview.saycode.ai`)).toBeNull();
    });

    it('returns null for missing port', () => {
        expect(parsePreviewHost(`${MID}.preview.saycode.ai`)).toBeNull();
    });

    it('returns null for undefined / empty host', () => {
        expect(parsePreviewHost(undefined)).toBeNull();
        expect(parsePreviewHost('')).toBeNull();
    });
});
