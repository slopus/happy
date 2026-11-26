import type { Editor, TLThemeColors } from 'tldraw'
import { BRAND_BLUE, BRAND_BLUE_DARK, BRAND_BLUE_DARK_RGB, BRAND_BLUE_RGB, BRAND_INK, CANVAS_BG } from './tl-brand-tokens.js'

/**
 * Runtime theme patch: re-tints tldraw's canvas-rendered colors to the plugin
 * brand. The UI chrome is handled by CSS variables (tl-theme-css.ts); these
 * values feed the canvas renderer and the style-panel swatches, which paint
 * from theme colors rather than CSS. `editor.updateTheme` is tldraw's
 * supported override API, and patching the built-in "default" theme keeps
 * every existing shape rendering — only the color values change.
 */

/** One palette entry (e.g. colors.blue); specials are plain strings. */
type PaletteEntry = Extract<TLThemeColors['blue'], object>

/** Re-tint the palette's "blue" family to the brand blue. */
function brandBluePalette(colors: TLThemeColors, dark: boolean): TLThemeColors {
  const blue = colors.blue as PaletteEntry | undefined
  if (typeof blue !== 'object' || blue === null) return colors
  const solid = dark ? BRAND_BLUE_DARK : BRAND_BLUE
  return {
    ...colors,
    blue: {
      ...blue,
      solid,
      fill: solid,
      linedFill: dark ? blue.linedFill : '#5a82f7',
      frameHeadingStroke: dark ? blue.frameHeadingStroke : '#6f8ff5',
      frameHeadingFill: dark ? blue.frameHeadingFill : '#f7f9ff',
      frameStroke: dark ? blue.frameStroke : '#6f8ff5',
      frameFill: dark ? blue.frameFill : '#f7f9ff',
      noteFill: dark ? blue.noteFill : '#91a9ff',
      semi: dark ? blue.semi : '#e3e9fd',
      pattern: dark ? blue.pattern : '#5a82f7',
    },
  }
}

/** Re-tint the special (string) theme colors: selection, marquee, ink, surface. */
function brandSpecials(colors: TLThemeColors, dark: boolean): TLThemeColors {
  const lightOnly: Partial<TLThemeColors> = dark
    ? {}
    : { text: BRAND_INK, background: CANVAS_BG, negativeSpace: CANVAS_BG }
  return {
    ...colors,
    ...lightOnly,
    selectionStroke: dark ? BRAND_BLUE_DARK : BRAND_BLUE,
    selectionFill: `rgba(${dark ? BRAND_BLUE_DARK_RGB : BRAND_BLUE_RGB}, ${dark ? '0.22' : '0.15'})`,
    brushFill: dark ? 'rgba(148, 163, 184, 0.12)' : 'rgba(100, 116, 139, 0.1)',
    brushStroke: dark ? 'rgba(148, 163, 184, 0.3)' : 'rgba(100, 116, 139, 0.28)',
  }
}

/** Apply the brand theme patch to a freshly mounted tldraw editor. */
export function applyBrandTheme(editor: Editor): void {
  const base = editor.getTheme('default')
  if (base === undefined) return
  editor.updateTheme({
    ...base,
    colors: {
      light: brandBluePalette(brandSpecials(base.colors.light, false), false),
      dark: brandBluePalette(brandSpecials(base.colors.dark, true), true),
    },
  })
}

/**
 * Match tldraw's light/dark canvas to the DSH host theme. The host publishes
 * dark mode as the data-ds-dark-theme attribute on <body>; tldraw keeps its
 * own persisted user preference, so apply the host value now and observe
 * later flips. Returns the observer disposer.
 */
export function syncTldrawThemeWithHost(editor: Editor): () => void {
  const apply = (): void => {
    editor.user.updateUserPreferences({ colorScheme: document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light' })
  }
  apply()
  const observer = new MutationObserver(apply)
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
  return () => observer.disconnect()
}
