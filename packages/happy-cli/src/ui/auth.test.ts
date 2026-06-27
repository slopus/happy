import { afterEach, describe, expect, it } from 'vitest';
import { getAuthMethodFallbackForEnvironment } from './auth';

const originalStdoutIsTTY = process.stdout.isTTY;
const originalStdinIsTTY = process.stdin.isTTY;
const originalCI = process.env.CI;
const originalHeadless = process.env.HEADLESS;

describe('getAuthMethodFallbackForEnvironment', () => {
    afterEach(() => {
        Object.defineProperty(process.stdout, 'isTTY', { value: originalStdoutIsTTY, configurable: true });
        Object.defineProperty(process.stdin, 'isTTY', { value: originalStdinIsTTY, configurable: true });

        if (originalCI === undefined) {
            delete process.env.CI;
        } else {
            process.env.CI = originalCI;
        }

        if (originalHeadless === undefined) {
            delete process.env.HEADLESS;
        } else {
            process.env.HEADLESS = originalHeadless;
        }
    });

    it('falls back to web auth when stdout is not a TTY', () => {
        Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
        Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

        expect(getAuthMethodFallbackForEnvironment()).toBe('web');
    });

    it('falls back to web auth when stdin is not a TTY', () => {
        Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
        Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

        expect(getAuthMethodFallbackForEnvironment()).toBe('web');
    });

    it('falls back to web auth in CI or headless environments', () => {
        Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
        Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
        process.env.CI = '1';

        expect(getAuthMethodFallbackForEnvironment()).toBe('web');

        delete process.env.CI;
        process.env.HEADLESS = '1';

        expect(getAuthMethodFallbackForEnvironment()).toBe('web');
    });

    it('keeps the interactive selector when the terminal is fully interactive', () => {
        Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
        Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
        delete process.env.CI;
        delete process.env.HEADLESS;

        expect(getAuthMethodFallbackForEnvironment()).toBeNull();
    });
});
