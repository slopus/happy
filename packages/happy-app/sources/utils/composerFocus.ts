import type { MultiTextInputHandle } from '@/components/MultiTextInput';

/**
 * Hand the caret to a composer that has just mounted, without letting the
 * keyboard dip on the way.
 *
 * A chat that is still starting and the real chat that replaces it are two
 * screens, so the composer the user is typing in is torn down and a different
 * one is built. The keyboard belongs to whichever field holds focus, and the
 * moment the old field goes there is none — the system starts dismissing it. It
 * only has to be given a new one before that animation commits.
 *
 * So the first claim is synchronous, made from the layout effect of the commit
 * that mounted the replacement. What used to be here was a 50ms timer, which is
 * far too late: the keyboard had already begun sliding away and came back up,
 * which reads as the screen flinching right after it opened.
 *
 * The timer is kept, behind the immediate claim, because a field focused in the
 * very commit that mounted it does not always take it — a fresh screen is still
 * settling, and Android in particular can drop it. Focusing a field that already
 * has the caret does nothing, so the retries cost nothing when the first one
 * worked.
 */
/**
 * How long the outgoing composer has to stay alive for the claim above to land.
 *
 * Covers the last retry with a frame or two to spare. Long enough that focus has
 * certainly moved, short enough that nobody sees the screen it belongs to.
 */
export const COMPOSER_FOCUS_SETTLE_MS = 120;

export function claimComposerFocus(
    ref: { current: MultiTextInputHandle | null },
    options: { caretToEnd?: boolean } = {},
): () => void {
    const focus = () => ref.current?.focus();

    if (options.caretToEnd) {
        // A chat opened with a draft already in it puts the caret after the
        // draft rather than in front of it. Done once: repeating it with the
        // retries below would drag the caret back from wherever typing has
        // since taken it.
        const handle = ref.current;
        if (handle) {
            const text = handle.getText();
            handle.setTextAndSelection(text, { start: text.length, end: text.length });
        }
    }

    focus();
    const frame = requestAnimationFrame(focus);
    const timer = setTimeout(focus, 50);
    return () => {
        cancelAnimationFrame(frame);
        clearTimeout(timer);
    };
}
