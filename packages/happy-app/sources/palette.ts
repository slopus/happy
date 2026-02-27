/**
 * Happy App Color Palette — Single Source of Truth
 *
 * All chromatic values derived from OKLCH anchor colors.
 * All neutrals share H=286° C=0.005 (iOS cool-gray tint).
 *
 * Components should never import this directly — use theme.ts.
 *
 * Variant derivation (OKLCH shifts from anchor):
 *   standard: the anchor itself
 *   dark:     L+0.03, C+0.01 (brighter for dark backgrounds)
 *   soft:     L+0.06, C×0.85 (muted for secondary elements)
 *   bgLight:  L=0.96, C×0.15 (tinted background, light mode)
 *   bgDark:   L=0.25, C×0.25 (tinted background, dark mode)
 */

// ─── Chromatic Colors ──────────────────────────────────────────────────

export const palette = {
    // Red — H=28.7° — Destructive, error, critical
    red: {
        standard: '#FF3B30',
        dark:     '#FF5849',
        soft:     '#FF6F5F',
        bgLight:  '#FFEDEA',
        bgDark:   '#391511',
    },

    // Orange — H=62.6° — Warning, caution, pending
    orange: {
        standard: '#FF9500',
        dark:     '#FFA549',
        soft:     '#FFB36D',
        bgLight:  '#FFEFE1',
        bgDark:   '#301C09',
    },

    // Yellow — H=90.4° — Highlight, attention, star
    yellow: {
        standard: '#FFCC00',
        dark:     '#FFD869',
        soft:     '#FFE49A',
        bgLight:  '#F9F2DE',
        bgDark:   '#2A2105',
    },

    // Green — H=147.4° — Success, connected, positive
    green: {
        standard: '#34C759',
        dark:     '#35D25D',
        soft:     '#67D77A',
        bgLight:  '#E6F8E7',
        bgDark:   '#102814',
    },

    // Cyan — H=219.1° — Links, accents, brand teal
    cyan: {
        standard: '#2BACCC',
        dark:     '#20B7DA',
        soft:     '#5EBDD8',
        bgLight:  '#E6F5FA',
        bgDark:   '#10252B',
    },

    // Blue — H=257.4° — Primary action, interactive
    blue: {
        standard: '#007AFF',
        dark:     '#2B86FF',
        soft:     '#4291FF',
        bgLight:  '#EAF3FF',
        bgDark:   '#10223B',
    },

    // Purple — H=278.3° — Info, section accent
    purple: {
        standard: '#5856D6',
        dark:     '#5F5DE6',
        soft:     '#6A6EDB',
        bgLight:  '#EFF1FF',
        bgDark:   '#1D1F38',
    },

    // Pink — H=17.9° — Fills the purple→red hue gap
    pink: {
        standard: '#FF2D55',
        dark:     '#FF5065',
        soft:     '#FF6875',
        bgLight:  '#FFEDED',
        bgDark:   '#391417',
    },

    // ─── Neutral Scale ─────────────────────────────────────────────────
    // H=286° (iOS cool-gray tint), C=0.005
    // Steps are spaced to hit iOS dark mode elevation tiers precisely
    neutral: {
        black:   '#000000',  // L=0.000
        gray975: '#111113',  // L=0.160 — dark mode grouped background
        gray950: '#1A1A1D',  // L=0.220 — dark mode base
        gray900: '#2B2B2E',  // L=0.290 — dark elevated/pressed
        gray800: '#38383A',  // L=0.340 — dark highest surface
        gray700: '#47474A',  // L=0.400 — dark secondary controls
        gray600: '#636366',  // L=0.500 — tertiary text
        gray500: '#717174',  // L=0.550 — muted text/icons
        gray400: '#8F8F92',  // L=0.650 — secondary text (iOS)
        gray300: '#9E9EA1',  // L=0.700 — disabled text
        gray200: '#C0C0C4',  // L=0.810 — disabled controls
        gray150: '#D4D4D7',  // L=0.870 — borders
        gray100: '#E4E4E8',  // L=0.920 — subtle dividers
        gray75:  '#F8F8FC',  // L=0.980 — elevated surface (cards above grouped bg)
        gray50:  '#ECECF0',  // L=0.945 — grouped background
        white:   '#FFFFFF',  // L=1.000
    },
};

export type Palette = typeof palette;
