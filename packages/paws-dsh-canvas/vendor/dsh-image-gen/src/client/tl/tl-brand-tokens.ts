/**
 * Single source of truth for the brand colors used across the tldraw surface.
 *
 * Consumed by tl-theme-css.ts (DOM chrome via CSS variables) and
 * tl-brand-theme.ts (canvas renderer via the runtime theme patch), so
 * re-tinting the surface is a one-file change instead of a hex hunt across
 * two files. Values mirror the workbench tokens in studio-style.ts
 * (`--ig-blue` and friends).
 */

/** Brand blue, shared with studio-style.ts `--ig-blue`. */
export const BRAND_BLUE = '#2f64f5'
/** Brand blue RGB components, for composing rgba() tints in one place. */
export const BRAND_BLUE_RGB = '47, 100, 245'
/** Brand blue tuned for dark surfaces. */
export const BRAND_BLUE_DARK = '#5b83f8'
/** Brand blue (dark) RGB components, for composing rgba() tints. */
export const BRAND_BLUE_DARK_RGB = '91, 131, 248'
/** Cool ink from the workbench foreground family. */
export const BRAND_INK = '#182033'
/** Flat canvas surface; also feeds export backgrounds, so it stays solid. */
export const CANVAS_BG = '#e6ebf5'
/** Canvas gradient stops (top and bottom); the mid stop is CANVAS_BG. */
export const CANVAS_BG_TOP = '#eef2fa'
export const CANVAS_BG_BOTTOM = '#dfe6f4'
