import { describe, expect, it } from 'vitest'
import { deriveTokens } from '../derive'
import { BUILTIN_THEMES, CODEX_DARK_DEFAULT, CODEX_LIGHT_DEFAULT } from '../presets'
import type { ChromeTheme, ThemeMode } from '../types'
import snapshotsRaw from './codex-snapshots.json'

interface Snapshot {
    name: string
    mode: ThemeMode
    theme: ChromeTheme
    tokens: Record<string, string>
    htmlClass: string
}

// The Codex sweep set accent/ink/surface/contrast on each theme but did NOT
// override the font input — so the captured `--vscode-font-family` reflects
// whatever font is selected in the running app (the codex default), not each
// theme's preferred font. Force fonts to null on the snapshot themes so our
// derive falls back to the same default.
const snapshots: Snapshot[] = (snapshotsRaw as Snapshot[]).map((s) => ({
    ...s,
    theme: { ...s.theme, fonts: { ui: null, code: null } },
}))

/* ---------- color helpers ---------- */

function parseHex(hex: string): [number, number, number] {
    const h = hex.startsWith('#') ? hex.slice(1) : hex
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

function parseRgba(value: string): { rgb: [number, number, number]; a: number } | null {
    let m = /^#([0-9a-fA-F]{6})$/.exec(value.trim())
    if (m) return { rgb: parseHex(m[1]), a: 1 }
    m = /^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/.exec(value.trim())
    if (m) return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], a: 1 }
    m = /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/.exec(value.trim())
    if (m) return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], a: Number(m[4]) }
    return null
}

const HEX_TOL = 8      // allow ±8 per RGB channel — deflakes oklab vs sRGB rounding + curve-fit drift
const ALPHA_TOL = 0.04 // ±0.04 alpha — accommodates curve-fit residuals across themes

function expectColorClose(actual: string, expected: string, label: string) {
    const a = parseRgba(actual)
    const e = parseRgba(expected)
    if (!a || !e) {
        expect(actual, `${label}: unparseable`).toBe(expected)
        return
    }
    for (let i = 0; i < 3; i++) {
        const d = Math.abs(a.rgb[i] - e.rgb[i])
        expect(d, `${label}: channel ${i} ${a.rgb[i]} vs ${e.rgb[i]} (got=${actual} want=${expected})`).toBeLessThanOrEqual(HEX_TOL)
    }
    expect(Math.abs(a.a - e.a), `${label}: alpha ${a.a} vs ${e.a}`).toBeLessThanOrEqual(ALPHA_TOL)
}

/* ---------- tokens we cover ---------- */

// All tokens Codex writes to <html>'s inline style. This covers every value
// the JS derivation pipeline owns — the test asserts our deriveTokens() output
// matches Codex byte-for-byte (within a small tolerance) for every theme.
const COVERED_TOKENS = [
    /* base inputs (echoed) */
    '--codex-base-accent',
    '--codex-base-ink',
    '--codex-base-surface',
    '--codex-base-contrast',
    /* fonts + typography */
    '--vscode-font-family',
    '--vscode-editor-font-family',
    '--vscode-font-size',
    '--vscode-editor-font-size',
    '--text-xs',
    '--text-sm',
    '--text-base',
    '--text-lg',
    '--text-heading-sm',
    '--text-heading-md',
    '--text-heading-lg',
    '--text-xl',
    '--text-2xl',
    '--text-3xl',
    '--text-4xl',
    /* foreground / icon */
    '--color-text-foreground',
    '--color-text-foreground-secondary',
    '--color-text-foreground-tertiary',
    '--color-icon-primary',
    '--color-icon-secondary',
    '--color-icon-tertiary',
    '--color-text-accent',
    '--color-icon-accent',
    /* backgrounds */
    '--color-background-surface',
    '--color-background-surface-under',
    '--color-background-panel',
    '--color-background-control',
    '--color-background-control-opaque',
    '--color-background-editor-opaque',
    '--color-background-elevated-primary',
    '--color-background-elevated-primary-opaque',
    '--color-background-elevated-secondary',
    '--color-background-elevated-secondary-opaque',
    /* button bg */
    '--color-background-button-primary',
    '--color-background-button-primary-active',
    '--color-background-button-primary-hover',
    '--color-background-button-primary-inactive',
    '--color-background-button-secondary',
    '--color-background-button-secondary-active',
    '--color-background-button-secondary-hover',
    '--color-background-button-secondary-inactive',
    '--color-background-button-tertiary',
    '--color-background-button-tertiary-active',
    '--color-background-button-tertiary-hover',
    /* button fg */
    '--color-text-button-primary',
    '--color-text-button-secondary',
    '--color-text-button-tertiary',
    /* accent bg */
    '--color-background-accent',
    '--color-background-accent-hover',
    '--color-background-accent-active',
    /* borders + scrim */
    '--color-border',
    '--color-border-heavy',
    '--color-border-light',
    '--color-border-focus',
    '--color-simple-scrim',
    /* fixed brand colors per mode */
    '--color-accent-blue',
    '--color-accent-purple',
    '--color-decoration-added',
    '--color-decoration-deleted',
    '--color-editor-added',
    '--color-editor-deleted',
] as const

/* ---------- tests ---------- */

function expectStringEqualish(actual: string, expected: string, label: string) {
    // Strings (font family, sizes, contrast number) compared verbatim.
    expect(actual, label).toBe(expected)
}

describe('Codex chrome theme parity (all inline-style tokens)', () => {
    for (const snap of snapshots) {
        const label = `${snap.name} (${snap.mode})`
        it(label, () => {
            const got = deriveTokens(snap.theme, snap.mode)
            let asserted = 0
            for (const tok of COVERED_TOKENS) {
                const expected = snap.tokens[tok]
                const actual = got[tok]
                if (expected === undefined) continue // Codex didn't emit it inline — skip.
                expect(actual, `${label}: missing derived token ${tok}`).toBeTruthy()
                if (tok.startsWith('--color') ||
                    tok === '--codex-base-accent' ||
                    tok === '--codex-base-ink' ||
                    tok === '--codex-base-surface') {
                    expectColorClose(actual!, expected, `${label} ${tok}`)
                } else {
                    expectStringEqualish(actual!, expected, `${label} ${tok}`)
                }
                asserted++
            }
            // Coverage gate — every snapshot must verify a meaningful number
            // of tokens. (The codex sweep doesn't emit fonts in dark, so dark
            // snapshots have 2-4 fewer tokens than light.)
            expect(asserted, `${label}: too few tokens asserted (${asserted})`).toBeGreaterThanOrEqual(
                snap.mode === 'light' ? 60 : 55
            )
        })
    }
})

describe('coverage', () => {
    it('the COVERED_TOKENS list matches the union of tokens Codex emits', () => {
        const codexTokens = new Set<string>()
        for (const s of snapshots) for (const k of Object.keys(s.tokens)) codexTokens.add(k)
        const covered = new Set<string>(COVERED_TOKENS as readonly string[])
        const missing = [...codexTokens].filter((k) => !covered.has(k))
        // Tokens we deliberately don't track yet (would be a future expansion):
        // none — at the time of writing, COVERED_TOKENS is the full union.
        expect(missing, 'Codex emits tokens we don\'t track: ' + missing.join(', ')).toEqual([])
    })
})

describe('passthrough tokens', () => {
    for (const snap of snapshots) {
        it(`${snap.name} (${snap.mode}) — base passthrough`, () => {
            const got = deriveTokens(snap.theme, snap.mode)
            // surface and ink are always strict passthroughs.
            expect(got['--color-background-surface']).toBe(snap.theme.surface)
            expect(got['--color-text-foreground']).toBe(snap.theme.ink)
            // In light, icon-primary and text-accent are strict passthroughs.
            // In dark, both are alpha-modulated for legibility, so we don't
            // enforce strict equality here (the parity tests cover those).
            if (snap.mode === 'light') {
                expect(got['--color-icon-primary']).toBe(snap.theme.ink)
                expect(got['--color-text-accent']).toBe(snap.theme.accent)
            }
        })
    }
})

describe('built-in themes render without errors', () => {
    for (const entry of BUILTIN_THEMES) {
        it(`${entry.codeThemeId} (${entry.variant}) — derive returns full token set`, () => {
            const out = deriveTokens(entry.theme, entry.variant)
            // Every token value must be a non-empty string with no NaN.
            for (const [k, v] of Object.entries(out)) {
                expect(v, `${k} must be a string`).toBeTypeOf('string')
                expect(v.length, `${k} must not be empty`).toBeGreaterThan(0)
                expect(v.includes('NaN'), `${k} contains NaN: ${v}`).toBe(false)
            }
            // Required tokens that all themes must produce.
            const required = [
                '--color-text-foreground',
                '--color-background-surface',
                '--color-text-accent',
                '--color-border',
                '--color-text-foreground-secondary',
                '--codex-base-accent',
                '--codex-base-ink',
                '--codex-base-surface',
                '--codex-base-contrast',
            ]
            for (const k of required) expect(out[k], `missing ${k}`).toBeTruthy()
        })
    }
})

describe('input → output mapping', () => {
    function deriveFor(patch: Partial<ChromeTheme>, mode: ThemeMode) {
        const base = mode === 'light' ? CODEX_LIGHT_DEFAULT : CODEX_DARK_DEFAULT
        return deriveTokens({ ...base, ...patch }, mode)
    }

    it('changing accent only affects the accent family (light)', () => {
        const a = deriveFor({}, 'light')
        const b = deriveFor({ accent: '#ff0000' }, 'light')
        // Accent family changes
        expect(a['--color-text-accent']).not.toBe(b['--color-text-accent'])
        expect(a['--color-background-accent']).not.toBe(b['--color-background-accent'])
        // Non-accent ink overlays unchanged
        expect(a['--color-text-foreground']).toBe(b['--color-text-foreground'])
        expect(a['--color-text-foreground-secondary']).toBe(b['--color-text-foreground-secondary'])
        expect(a['--color-border']).toBe(b['--color-border'])
        expect(a['--color-background-surface']).toBe(b['--color-background-surface'])
    })

    it('changing ink retints all ink overlays (light)', () => {
        const a = deriveFor({}, 'light')
        const b = deriveFor({ ink: '#ff0000' }, 'light')
        expect(a['--color-text-foreground']).not.toBe(b['--color-text-foreground'])
        expect(a['--color-border']).not.toBe(b['--color-border'])
        expect(a['--color-text-foreground-secondary']).not.toBe(b['--color-text-foreground-secondary'])
    })

    it('contrast=0 puts surface-under at the surface itself (light)', () => {
        const t = deriveFor({ contrast: 0 }, 'light')
        expect(t['--color-background-surface-under']).toBe('#ffffff')
    })

    it('contrast slider monotonically darkens surface-under (light)', () => {
        const lows = deriveFor({ contrast: 0  }, 'light')['--color-background-surface-under']
        const mid  = deriveFor({ contrast: 50 }, 'light')['--color-background-surface-under']
        const high = deriveFor({ contrast: 100 }, 'light')['--color-background-surface-under']
        expect(lows).toBe('#ffffff')
        // Each step should yield a darker (lower R) value than the previous.
        const r = (v: string) => parseInt(v.slice(1, 3), 16)
        expect(r(mid)).toBeLessThan(r(lows))
        expect(r(high)).toBeLessThan(r(mid))
    })
})
