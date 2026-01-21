import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('react-native', () => ({
    Platform: {
        OS: 'ios',
        select: (options: any) => options.ios ?? options.default,
    },
    Alert: {
        alert: vi.fn(),
        prompt: vi.fn(),
    },
}));

describe('Modal.prompt', () => {
    it('uses the app modal prompt on iOS (not Alert.prompt)', async () => {
        const { Modal } = await import('./ModalManager');
        const { Alert } = await import('react-native');

        let lastModalConfig: any = null;
        Modal.setFunctions(
            (config) => {
                lastModalConfig = config;
                return 'prompt-1';
            },
            () => {},
            () => {},
        );

        const promise = Modal.prompt('Title', 'Message');

        expect((Alert as any).prompt).not.toHaveBeenCalled();
        expect(lastModalConfig?.type).toBe('prompt');

        Modal.resolvePrompt('prompt-1', 'hello');
        await expect(promise).resolves.toBe('hello');
    });
});

