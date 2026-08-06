export type ComposerPrimaryAction = 'send' | 'abort';

export function resolveComposerPrimaryAction({
    mode,
    showAbortButton,
    hasAbortHandler,
    hasPayload,
}: {
    mode: 'home' | 'session';
    showAbortButton: boolean;
    hasAbortHandler: boolean;
    hasPayload: boolean;
}): ComposerPrimaryAction {
    if (mode === 'session' && showAbortButton && hasAbortHandler && !hasPayload) {
        return 'abort';
    }

    return 'send';
}
