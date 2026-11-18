import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    process.env.HAPPY_HOME_DIR = '/tmp/happy-cli-auth-test';

    return {
        render: vi.fn(),
    };
});

vi.mock('ink', () => ({
    render: mocks.render,
    Text: () => null,
    Box: () => null,
    useInput: vi.fn(),
}));

import { selectAuthenticationMethod } from './auth.js';

const originalStdinTTY = process.stdin.isTTY;
const originalStdoutTTY = process.stdout.isTTY;

function setTTY(stdinTTY: boolean, stdoutTTY: boolean) {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: stdinTTY });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: stdoutTTY });
}

describe('selectAuthenticationMethod', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.clearAllMocks();
        setTTY(true, true);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    afterAll(() => {
        Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: originalStdinTTY });
        Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: originalStdoutTTY });
    });

    it.each([
        [false, true],
        [true, false],
    ])('falls back to web authentication when stdin=%s and stdout=%s are not both TTY', async (stdinTTY, stdoutTTY) => {
        setTTY(stdinTTY, stdoutTTY);
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        await expect(selectAuthenticationMethod()).resolves.toBe('web');

        expect(logSpy).toHaveBeenCalledWith(
            'Non-interactive terminal detected. Falling back to Web Browser authentication.',
        );
        expect(mocks.render).not.toHaveBeenCalled();
    });

    it('renders the selector in interactive terminals', async () => {
        const unmount = vi.fn();
        mocks.render.mockImplementation((element: { props: { onSelect: (method: string) => void } }) => {
            queueMicrotask(() => element.props.onSelect('mobile'));
            return { unmount };
        });

        await expect(selectAuthenticationMethod()).resolves.toBe('mobile');

        expect(mocks.render).toHaveBeenCalledTimes(1);
        expect(unmount).toHaveBeenCalledTimes(1);
    });
});
