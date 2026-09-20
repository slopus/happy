import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
    Alert: {},
    Platform: { OS: 'android' },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

import { Modal } from './ModalManager';

describe('ModalManager prompt deduplication', () => {
    const showModal = vi.fn();

    beforeEach(() => {
        showModal.mockReset();
        showModal.mockReturnValueOnce('prompt-1').mockReturnValueOnce('prompt-2');
        Modal.setFunctions(showModal, vi.fn(), vi.fn());
    });

    it('shares one modal result between identical concurrent prompts', async () => {
        const options = { placeholder: 'happy://terminal?...' };
        const first = Modal.prompt('Paste link', 'Enter the link', options);
        const duplicate = Modal.prompt('Paste link', 'Enter the link', options);

        expect(showModal).toHaveBeenCalledTimes(1);

        Modal.resolvePrompt('prompt-1', 'happy://terminal?token=one');

        await expect(first).resolves.toBe('happy://terminal?token=one');
        await expect(duplicate).resolves.toBe('happy://terminal?token=one');

        const next = Modal.prompt('Paste link', 'Enter the link', options);
        expect(showModal).toHaveBeenCalledTimes(2);
        Modal.resolvePrompt('prompt-2', null);
        await expect(next).resolves.toBeNull();
    });
});