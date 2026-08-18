/**
 * One horizontal grid for every row of the sessions list.
 *
 * The list mixes three row shapes — the flat "Pinned"/"Today" rows, the
 * project headers, and the compact rows nested under them — and each used to
 * carry its own paddings, so the same status dot landed on a different column
 * depending on which branch of the renderer produced it. They all key off
 * these numbers now, which puts everything on two vertical rules: the
 * indicator column at `gutter`, and the text column at `textInset`.
 */
const GUTTER = 20;
const INDICATOR_SIZE = 16;
const INDICATOR_GAP = 8;

export const sessionRowLayout = {
    /** Left/right inset of a row, and the left edge of the indicator column. */
    gutter: GUTTER,
    /** Square slot the status dot is centered in, sized to the title's cap height. */
    indicatorSize: INDICATOR_SIZE,
    /** Space between the indicator slot and the title. */
    indicatorGap: INDICATOR_GAP,
    /** Left edge of every text column — titles, subtitles and row dividers. */
    textInset: GUTTER + INDICATOR_SIZE + INDICATOR_GAP,
    /** Indent of a subtitle relative to its own row content. */
    subtitleIndent: INDICATOR_SIZE + INDICATOR_GAP,
    /** Two lines of text plus breathing room. */
    minHeight: 62,
};
