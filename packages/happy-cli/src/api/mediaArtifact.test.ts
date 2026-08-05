import { describe, expect, it } from 'vitest';
import { resolveMediaArtifact } from './mediaArtifact';

describe('resolveMediaArtifact', () => {
    it('infers MP4, MOV and WebM video artifacts', () => {
        expect(resolveMediaArtifact('/tmp/acceptance.mp4')).toEqual({ kind: 'video', mimeType: 'video/mp4' });
        expect(resolveMediaArtifact('/tmp/acceptance.mov')).toEqual({ kind: 'video', mimeType: 'video/quicktime' });
        expect(resolveMediaArtifact('/tmp/acceptance.webm')).toEqual({ kind: 'video', mimeType: 'video/webm' });
    });

    it('accepts a matching explicit MIME and rejects unsafe inputs', () => {
        expect(resolveMediaArtifact('/tmp/capture.webm', 'video/webm')).toEqual({ kind: 'video', mimeType: 'video/webm' });
        expect(() => resolveMediaArtifact('clip.mp4')).toThrow(/absolute/);
        expect(() => resolveMediaArtifact('/tmp/report.pdf')).toThrow(/Unsupported media file/);
        expect(() => resolveMediaArtifact('/tmp/clip.mp4', 'audio/mpeg')).toThrow(/does not match/);
    });
});
