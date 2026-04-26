import type { ChromeTheme, ThemeMode } from './types'

/* ─────────────────────────────────────────────────────────────────────────
 * Codex theme derivation, reverse-engineered from the running app.
 *
 * 5 user inputs (accent, ink, surface, contrast, opaqueWindows) + fonts +
 * semanticColors drive 60+ derived CSS custom properties on `<html>`.
 *
 * Every contrast-driven alpha token has the form:
 *     value(c) = base + delta · (c/100)^p
 * with mode-specific p (≈1.5 light, ≈1.66 dark) and per-token (base, delta)
 * coefficients fit empirically from snapshots of the running Codex app.
 *
 * See packages/codium/design-system.md for the full treatment.
 * ──────────────────────────────────────────────────────────────────────── */

type RGB = [number, number, number]
type Curve = { base: number; delta: number }

interface ModeCoeffs {
    p: number
    /* — contrast-shaped rgba(ink, …) overlays — */
    fgSecondary: Curve
    fgTertiary: Curve
    border: Curve
    borderHeavy: Curve
    borderLight: Curve
    /** Light: passthrough ink. Dark: rgba(ink, base+delta·t). */
    iconPrimary: Curve | 'passthrough'
    btnPrimaryActive: Curve
    btnPrimaryHover: Curve
    btnPrimaryInactive: Curve
    btnSecondary: Curve
    btnSecondaryActive: Curve
    btnSecondaryHover: Curve
    btnSecondaryInactive: Curve
    btnTertiary: Curve
    btnTertiaryActive: Curve
    btnTertiaryHover: Curve
    /* — contrast-shaped mixes — */
    /** Light: mix(surface, ink, …). Dark: mix(surface, BLACK, …). */
    surfUnder: Curve
    /** Light: mix(surface, accent, …). Dark: mix(BLACK, accent, …). */
    bgAccent: Curve
    bgAccentHover: Curve
    bgAccentActive: Curve
    /** Dark: mix(accent, WHITE, …) for legible accent foreground. */
    accentForegroundMix: Curve
    /* — fixed brand colors per mode — */
    accentPurple: string
    decorationAdded: string
    decorationDeleted: string
    /** alpha applied to decoration colors for `editor-added` / `editor-deleted`. */
    editorOverlayAlpha: number
}

const COEFFS: Record<ThemeMode, ModeCoeffs> = {
    light: {
        p: 1.5,
        fgSecondary:          { base: 0.598, delta: 0.335 },
        fgTertiary:           { base: 0.398, delta: 0.335 },
        border:               { base: 0.04,  delta: 0.133 },
        borderHeavy:          { base: 0.06,  delta: 0.20  },
        borderLight:          { base: 0.03,  delta: 0.067 },
        iconPrimary:          'passthrough',
        btnPrimaryActive:     { base: 0.04,   delta: 0.40  },
        btnPrimaryHover:      { base: 0.02,   delta: 0.20  },
        btnPrimaryInactive:   { base: 0.151,  delta: 0.306 },
        btnSecondary:         { base: 0.037,  delta: 0.041 },
        btnSecondaryActive:   { base: 0.027,  delta: 0.041 },
        btnSecondaryHover:    { base: 0.035,  delta: 0.061 },
        btnSecondaryInactive: { base: 0.007,  delta: 0.041 },
        btnTertiary:          { base: 0,      delta: 0     }, // always transparent
        btnTertiaryActive:    { base: 0.140,  delta: 0.184 },
        btnTertiaryHover:     { base: 0.073,  delta: 0.082 },
        surfUnder:            { base: 0.0,   delta: 0.10  }, // mix(surface, ink)
        bgAccent:             { base: 0.09,  delta: 0.13  }, // mix(surface, accent)
        bgAccentHover:        { base: 0.10,  delta: 0.15  },
        bgAccentActive:       { base: 0.11,  delta: 0.16  },
        accentForegroundMix:  { base: 0,    delta: 0     }, // light: passthrough
        accentPurple:         '#751ed9',
        decorationAdded:      '#00a240',
        decorationDeleted:    '#e02e2a',
        editorOverlayAlpha:   0.15,
    },
    dark: {
        p: 1.66,
        fgSecondary:          { base: 0.58,  delta: 0.303 },
        fgTertiary:           { base: 0.329, delta: 0.394 },
        border:               { base: 0.032, delta: 0.121 },
        borderHeavy:          { base: 0.078, delta: 0.182 },
        borderLight:          { base: 0.016, delta: 0.061 },
        iconPrimary:          { base: 0.79,  delta: 0.27 },
        btnPrimaryActive:     { base: 0.035, delta: 0.152 },
        btnPrimaryHover:      { base: 0.019, delta: 0.091 },
        btnPrimaryInactive:   { base: 0.017, delta: 0.036 },
        btnSecondary:         { base: 0.037, delta: 0.036 },
        btnSecondaryActive:   { base: 0.078, delta: 0.099 },
        btnSecondaryHover:    { base: 0.051, delta: 0.063 },
        btnSecondaryInactive: { base: 0.015, delta: 0.054 },
        btnTertiary:          { base: 0.017, delta: 0.027 },
        btnTertiaryActive:    { base: 0.058, delta: 0.099 },
        btnTertiaryHover:     { base: 0.041, delta: 0.063 },
        surfUnder:            { base: 0.05,  delta: 0.16 }, // mix(surface, BLACK)
        bgAccent:             { base: 0.17,  delta: 0.19 }, // mix(BLACK, accent)
        bgAccentHover:        { base: 0.18,  delta: 0.21 },
        bgAccentActive:       { base: 0.20,  delta: 0.23 },
        accentForegroundMix:  { base: 0.19,  delta: 0.46 },
        accentPurple:         '#ad7bf9',
        decorationAdded:      '#40c977',
        decorationDeleted:    '#fa423e',
        editorOverlayAlpha:   0.23,
    },
}

/** Dark-mode contrast-shaped surface↔ink mixes (in light, surface=white, no headroom). */
const DARK_SURFACE_MIX = {
    /** mix(surface, ink, …) → control-opaque */
    controlOpaque:        { base: 0.049, delta: 0.099 },
    /** mix(surface, ink, …) → editor-opaque + elevated-secondary-opaque */
    editorOpaque:         { base: 0.058, delta: 0.027 },
    /** mix(surface, ink, …) → elevated-primary[-opaque] */
    elevatedPrimary:      { base: 0.053, delta: 0.180 },
    /** mix(surface, BLACK, …) → button-primary bg + text-button-primary */
    buttonPrimaryFill:    { base: 0.46,  delta: 0     },
    /** mix(surface, ink, …) → text-button-secondary */
    textBtnSecondary:     { base: 0.20,  delta: 0.09  },
}

/* ─────────── color helpers ─────────── */

function parseHex(hex: string): RGB {
    const h = hex.startsWith('#') ? hex.slice(1) : hex
    const expanded = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
    return [
        parseInt(expanded.slice(0, 2), 16),
        parseInt(expanded.slice(2, 4), 16),
        parseInt(expanded.slice(4, 6), 16),
    ]
}

const clampByte = (n: number) => Math.max(0, Math.min(255, Math.round(n)))
const toHex = (n: number) => clampByte(n).toString(16).padStart(2, '0')
const rgbToHex = ([r, g, b]: RGB) => '#' + toHex(r) + toHex(g) + toHex(b)

function rgba(rgb: RGB, alpha: number) {
    const a = Math.max(0, Math.min(1, alpha))
    return `rgba(${clampByte(rgb[0])}, ${clampByte(rgb[1])}, ${clampByte(rgb[2])}, ${Math.round(a * 1000) / 1000})`
}

function rgb(rgb: RGB) {
    return `rgb(${clampByte(rgb[0])}, ${clampByte(rgb[1])}, ${clampByte(rgb[2])})`
}

function mix(a: RGB, b: RGB, t: number): RGB {
    const k = Math.max(0, Math.min(1, t))
    return [a[0] * (1 - k) + b[0] * k, a[1] * (1 - k) + b[1] * k, a[2] * (1 - k) + b[2] * k]
}

const BLACK: RGB = [0, 0, 0]
const WHITE: RGB = [255, 255, 255]

/* ─────────── derivation ─────────── */

function shape(contrast: number, mode: ThemeMode) {
    const c = Math.max(0, Math.min(100, contrast)) / 100
    return Math.pow(c, COEFFS[mode].p)
}

const apply = (curve: Curve, t: number) => curve.base + curve.delta * t

interface DerivedTokens { [key: string]: string }

const TYPOGRAPHY: DerivedTokens = {
    '--text-xs':         '11px',
    '--text-sm':         '12px',
    '--text-base':       '13px',
    '--text-lg':         '16px',
    '--text-heading-sm': '18px',
    '--text-heading-md': '20px',
    '--text-heading-lg': '24px',
    '--text-xl':         '28px',
    '--text-2xl':        '36px',
    '--text-3xl':        '48px',
    '--text-4xl':        '72px',
    '--vscode-font-size':         '13px',
    '--vscode-editor-font-size':  '12px',
}

export function deriveTokens(theme: ChromeTheme, mode: ThemeMode): DerivedTokens {
    const ink = parseHex(theme.ink)
    const surface = parseHex(theme.surface)
    const accent = parseHex(theme.accent)
    const t = shape(theme.contrast, mode)
    const C = COEFFS[mode]

    const inkA = (alpha: number) => rgba(ink, alpha)
    const inkOverlay = (curve: Curve) => inkA(apply(curve, t))

    /* — accent foreground (legibility) — */
    const accentFg = mode === 'dark'
        ? rgbToHex(mix(accent, WHITE, apply(C.accentForegroundMix, t)))
        : theme.accent

    /* — surface "below" (page/sidebar bg) — */
    const surfUnderTarget = mode === 'dark' ? BLACK : ink
    const surfaceUnder = rgbToHex(mix(surface, surfUnderTarget, apply(C.surfUnder, t)))

    /* — surface "above" (panel/elevated/control/dropdown) — */
    let bgControlRgb: RGB
    let bgEditorRgb: RGB
    let bgElevatedPrimaryRgb: RGB
    let panel: string
    if (mode === 'dark') {
        bgControlRgb = mix(surface, ink, apply(DARK_SURFACE_MIX.controlOpaque, t))
        bgEditorRgb = mix(surface, ink, apply(DARK_SURFACE_MIX.editorOpaque, t))
        bgElevatedPrimaryRgb = mix(surface, ink, apply(DARK_SURFACE_MIX.elevatedPrimary, t))
        panel = rgbToHex(mix(surface, ink, 0.07))
    } else {
        bgControlRgb = surface
        bgEditorRgb = surface
        bgElevatedPrimaryRgb = surface
        panel = theme.surface
    }
    const bgControlOpaque = rgb(bgControlRgb)
    const bgControl = rgba(bgControlRgb, 0.96)
    const bgEditorOpaque = rgb(bgEditorRgb)
    const bgElevatedPrimary = rgba(bgElevatedPrimaryRgb, 0.96)
    const bgElevatedPrimaryOpaque = rgb(bgElevatedPrimaryRgb)
    const bgElevatedSecondaryOpaque = rgbToHex(bgEditorRgb)
    const bgElevatedSecondary = mode === 'dark'
        ? inkOverlay(C.btnPrimaryInactive) // matches Codex value (≈ rgba(ink, 0.032) at c=60)
        : rgba(surface, 0.96)

    /* — bg-accent family (selection accent backgrounds) — */
    const bgAccentBase: RGB = mode === 'dark' ? BLACK : surface
    const bgAccent       = rgbToHex(mix(bgAccentBase, accent, apply(C.bgAccent,       t)))
    const bgAccentHover  = rgbToHex(mix(bgAccentBase, accent, apply(C.bgAccentHover,  t)))
    const bgAccentActive = rgbToHex(mix(bgAccentBase, accent, apply(C.bgAccentActive, t)))

    /* — primary button fill (contrast-independent in our model) — */
    const buttonPrimaryFillRgb: RGB = mode === 'dark'
        ? mix(surface, BLACK, apply(DARK_SURFACE_MIX.buttonPrimaryFill, t))
        : ink
    const buttonPrimaryFill = mode === 'dark' ? rgb(buttonPrimaryFillRgb) : rgbToHex(buttonPrimaryFillRgb)

    /* — text-button colors — */
    const textBtnPrimary = mode === 'dark' ? rgb(buttonPrimaryFillRgb) : theme.surface
    const textBtnSecondary = mode === 'dark'
        ? rgbToHex(mix(surface, ink, apply(DARK_SURFACE_MIX.textBtnSecondary, t)))
        : theme.ink
    const textBtnTertiary = inkOverlay(C.fgTertiary) // = text-foreground-tertiary

    /* — decoration / editor overlays — */
    const decorationAdded = C.decorationAdded
    const decorationDeleted = C.decorationDeleted
    const editorAdded = rgba(parseHex(decorationAdded), C.editorOverlayAlpha)
    const editorDeleted = rgba(parseHex(decorationDeleted), C.editorOverlayAlpha)

    /* — icon-primary (contrast-shaped in dark only) — */
    const iconPrimary = C.iconPrimary === 'passthrough'
        ? theme.ink
        : inkA(apply(C.iconPrimary, t))

    return {
        /* === BASE INPUTS (echoed) === */
        '--codex-base-accent':   theme.accent,
        '--codex-base-ink':      theme.ink,
        '--codex-base-surface':  theme.surface,
        '--codex-base-contrast': String(theme.contrast),

        /* === FONTS === */
        '--vscode-font-family':         appendFontFallback(theme.fonts.ui ?? 'Geist, Inter', 'sans'),
        '--vscode-editor-font-family':  appendFontFallback(theme.fonts.code ?? '"Geist Mono", ui-monospace, "SFMono-Regular"', 'mono'),

        /* === TYPOGRAPHY (fixed) === */
        ...TYPOGRAPHY,

        /* === PASS-THROUGHS / ACCENT === */
        '--color-text-foreground':   theme.ink,
        '--color-icon-primary':      iconPrimary,
        '--color-text-accent':       accentFg,
        '--color-icon-accent':       accentFg,
        '--color-background-surface': theme.surface,
        '--color-accent-blue':       theme.accent,
        '--color-accent-purple':     C.accentPurple,

        /* === STATIC-ALPHA INK OVERLAYS === */
        '--color-hover':                          inkA(0.05),
        '--color-token-list-hover-background':    inkA(0.05),
        '--color-token-toolbar-hover-background': inkA(0.05),
        '--color-token-badge-background':         inkA(0.047),
        '--color-token-input-border':             inkA(0.074),
        '--color-token-bg-fog':                   inkA(0.025),

        /* === CONTRAST-SHAPED INK OVERLAYS === */
        '--color-text-foreground-secondary':            inkOverlay(C.fgSecondary),
        '--color-text-foreground-tertiary':             inkOverlay(C.fgTertiary),
        '--color-icon-secondary':                       inkOverlay(C.fgSecondary),
        '--color-icon-tertiary':                        inkOverlay(C.fgTertiary),
        '--color-border':                               inkOverlay(C.border),
        '--color-border-heavy':                         inkOverlay(C.borderHeavy),
        '--color-border-light':                         inkOverlay(C.borderLight),
        '--color-active':                               inkA(0.04 + 0.06 * t),
        '--color-button-bg':                            inkA(0.04 + 0.06 * t),
        '--color-button-hover':                         inkA(0.04 + 0.04 * t),
        // Light: black overlay over light surfaces. Dark: ink overlay over dark.
        '--color-simple-scrim':                         mode === 'light'
            ? rgba(BLACK, 0.06 + 0.13 * t)
            : inkA(0.06 + 0.13 * t),

        /* button background family */
        '--color-background-button-primary':            buttonPrimaryFill,
        '--color-background-button-primary-active':     inkOverlay(C.btnPrimaryActive),
        '--color-background-button-primary-hover':      inkOverlay(C.btnPrimaryHover),
        '--color-background-button-primary-inactive':   inkOverlay(C.btnPrimaryInactive),
        '--color-background-button-secondary':          inkOverlay(C.btnSecondary),
        '--color-background-button-secondary-active':   inkOverlay(C.btnSecondaryActive),
        '--color-background-button-secondary-hover':    inkOverlay(C.btnSecondaryHover),
        '--color-background-button-secondary-inactive': inkOverlay(C.btnSecondaryInactive),
        '--color-background-button-tertiary':           inkOverlay(C.btnTertiary),
        '--color-background-button-tertiary-active':    inkOverlay(C.btnTertiaryActive),
        '--color-background-button-tertiary-hover':     inkOverlay(C.btnTertiaryHover),

        /* text on buttons */
        '--color-text-button-primary':   textBtnPrimary,
        '--color-text-button-secondary': textBtnSecondary,
        '--color-text-button-tertiary':  textBtnTertiary,

        /* === SURFACE FAMILY === */
        '--color-background-surface-under':            surfaceUnder,
        '--color-background-panel':                    panel,
        '--color-background-control':                  bgControl,
        '--color-background-control-opaque':           bgControlOpaque,
        '--color-background-editor-opaque':            bgEditorOpaque,
        '--color-background-elevated':                 bgElevatedPrimary, // legacy alias
        '--color-background-elevated-primary':         bgElevatedPrimary,
        '--color-background-elevated-primary-opaque':  bgElevatedPrimaryOpaque,
        '--color-background-elevated-secondary':       bgElevatedSecondary,
        '--color-background-elevated-secondary-opaque': bgElevatedSecondaryOpaque,

        /* === ACCENT BACKGROUNDS === */
        '--color-background-accent':         bgAccent,
        '--color-background-accent-hover':   bgAccentHover,
        '--color-background-accent-active':  bgAccentActive,

        /* === FOCUS ring === */
        // Light: passthrough accent (full opacity).
        // Dark: accent-foreground (auto-lightened) at 0.76 alpha.
        '--color-border-focus':
            mode === 'dark'
                ? rgba(parseHex(accentFg), 0.76)
                : theme.accent,

        /* === DIFF / EDITOR DECORATIONS (fixed brand per mode) === */
        '--color-decoration-added':   decorationAdded,
        '--color-decoration-deleted': decorationDeleted,
        '--color-editor-added':       editorAdded,
        '--color-editor-deleted':     editorDeleted,

        /* legacy semantic-color shortcuts (unchanged from theme.semanticColors) */
        '--color-accent-green': theme.semanticColors.diffAdded,
        '--color-accent-red':   theme.semanticColors.diffRemoved,
    }
}

/** Codex appends `, var(--font-{sans,mono}-default)` to user-supplied font stacks. */
function appendFontFallback(value: string, kind: 'sans' | 'mono'): string {
    const tail = `var(--font-${kind}-default)`
    return value.includes(tail) ? value : `${value}, ${tail}`
}

/** Apply derived tokens to <html>'s inline style and toggle theme classes. */
export function applyTheme(theme: ChromeTheme, mode: ThemeMode) {
    const root = document.documentElement
    const tokens = deriveTokens(theme, mode)
    for (const [k, v] of Object.entries(tokens)) {
        root.style.setProperty(k, v)
    }
    root.classList.toggle('electron-light', mode === 'light')
    root.classList.toggle('electron-dark', mode === 'dark')
    root.classList.toggle('electron-opaque', !!theme.opaqueWindows)
    root.style.colorScheme = mode
}
