import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTimestampForFilename, createTimestampForLogEntry, resolveLocalTimeZone } from './logger'

/**
 * Regression tests for #194: the CLI crashed at startup with
 * `RangeError: Invalid time zone specified: Etc/Unknown` whenever the host did
 * not expose a usable time zone (e.g. a container that does not set `TZ`). The
 * logger is constructed at module load, so this took down every command.
 */
describe('logger timestamp timezone handling (#194)', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    /** Force `Intl.DateTimeFormat().resolvedOptions().timeZone` to a given value. */
    function mockHostTimeZone(timeZone: string | undefined) {
        const original = Intl.DateTimeFormat.prototype.resolvedOptions
        vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
            return { ...original.call(this), timeZone } as Intl.ResolvedDateTimeFormatOptions
        })
    }

    it('builds a filename timestamp without throwing when the host reports Etc/Unknown', () => {
        mockHostTimeZone('Etc/Unknown')
        const date = new Date('2026-01-02T03:04:05Z')
        expect(() => createTimestampForFilename(date)).not.toThrow()
        // Falls back to UTC → sv-SE format "2026-01-02 03:04:05" with separators normalized.
        expect(createTimestampForFilename(date)).toMatch(/^2026-01-02-03-04-05-pid-\d+$/)
    })

    it('builds a log-entry timestamp without throwing when the host reports Etc/Unknown', () => {
        mockHostTimeZone('Etc/Unknown')
        expect(() => createTimestampForLogEntry(new Date('2026-01-02T03:04:05Z'))).not.toThrow()
    })

    it('resolveLocalTimeZone falls back to UTC for an unusable host zone', () => {
        mockHostTimeZone('Etc/Unknown')
        expect(resolveLocalTimeZone()).toBe('UTC')
    })

    it('resolveLocalTimeZone falls back to UTC when the host reports no zone', () => {
        mockHostTimeZone(undefined)
        expect(resolveLocalTimeZone()).toBe('UTC')
    })

    it('resolveLocalTimeZone keeps a valid host zone', () => {
        mockHostTimeZone('America/New_York')
        expect(resolveLocalTimeZone()).toBe('America/New_York')
    })
})
