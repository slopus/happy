import { describe, it, expect, vi } from 'vitest';

vi.mock('react-native', () => ({
    Platform: { OS: 'web', select: (obj: any) => obj.default },
}));
vi.mock('react-native-device-info', () => ({
    getDeviceType: () => 'Handset',
}));

import { formatTrayStatus } from './tauriTray';

describe('tauriTray', () => {
    describe('formatTrayStatus', () => {
        it('sorts sessions by activeAt descending and limits to 5', () => {
            const sessions = Array.from({ length: 8 }, (_, i) => ({
                id: `s${i}`,
                name: `Session ${i}`,
                activeAt: i * 1000,
            }));

            const result = formatTrayStatus(true, sessions);
            expect(result.sessions).toHaveLength(5);
            expect(result.sessions[0].id).toBe('s7');
            expect(result.sessions[4].id).toBe('s3');
        });

        it('passes online status through', () => {
            expect(formatTrayStatus(true, []).online).toBe(true);
            expect(formatTrayStatus(false, []).online).toBe(false);
        });

        it('returns empty sessions array when no sessions', () => {
            const result = formatTrayStatus(true, []);
            expect(result.sessions).toEqual([]);
        });

        it('maps to id and name only (strips activeAt)', () => {
            const result = formatTrayStatus(true, [
                { id: 'a', name: 'Test', activeAt: 1000 },
            ]);
            expect(result.sessions[0]).toEqual({ id: 'a', name: 'Test' });
        });
    });
});
