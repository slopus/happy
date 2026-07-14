import { describe, expect, it } from 'vitest';
import { resolveControlHandoffDirection, resolveControlMode } from './controlHandoff';

describe('control handoff helpers', () => {
    it('maps controlledByUser to the local UI control mode', () => {
        expect(resolveControlMode(true)).toBe('mobile');
        expect(resolveControlMode(false)).toBe('desktop');
        expect(resolveControlMode(null)).toBe('desktop');
        expect(resolveControlMode(undefined)).toBe('desktop');
    });

    it('detects desktop to mobile handoff including the legacy missing previous value', () => {
        expect(resolveControlHandoffDirection(false, true)).toBe('desktop-to-mobile');
        expect(resolveControlHandoffDirection(undefined, true)).toBe('desktop-to-mobile');
        expect(resolveControlHandoffDirection(null, true)).toBe('desktop-to-mobile');
    });

    it('detects mobile to desktop handoff', () => {
        expect(resolveControlHandoffDirection(true, false)).toBe('mobile-to-desktop');
    });

    it('ignores unchanged and incomplete handoff states', () => {
        expect(resolveControlHandoffDirection(false, false)).toBeNull();
        expect(resolveControlHandoffDirection(true, true)).toBeNull();
        expect(resolveControlHandoffDirection(undefined, false)).toBeNull();
        expect(resolveControlHandoffDirection(true, undefined)).toBeNull();
    });
});
