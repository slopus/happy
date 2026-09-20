import type { MultiTextInputHandle } from '@/components/MultiTextInput';

/**
 * Give the caret to a composer that has just mounted, and keep it.
 *
 * A chat asked for from the strip's `+` was asked for in order to be typed
 * into, so its screen opens with the keyboard already up. The claim is
 * synchronous, made from the layout effect of the commit that mounted the
 * field: a 50ms timer, which is what used to be here on its own, is far too
 * late — the screen is up and the keyboard visibly arrives after it.
 *
 * The retries are kept behind that immediate claim because a field focused in
 * the very commit that mounted it does not always take it — a fresh screen is
 * still settling, and Android in particular can drop it. Focusing a field that
 * already has the caret does nothing, so they cost nothing when the first one
 * worked.
 */
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
