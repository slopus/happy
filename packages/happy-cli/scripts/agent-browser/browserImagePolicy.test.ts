/** The agent browser must never keep what a user typed into it (a login in the viewer, a form). */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))

describe('browser image Chromium policy', () => {
    it('turns off saving passwords and autofill data in the shared profile', () => {
        const policy = JSON.parse(readFileSync(join(here, 'images/chromium-policy.json'), 'utf8'))
        expect(policy).toMatchObject({
            PasswordManagerEnabled: false,
            PasswordLeakDetectionEnabled: false,
            AutofillAddressEnabled: false,
            AutofillCreditCardEnabled: false,
        })
    })

    it('installs the policy where Debian Chromium reads managed policies, and ships it in the build context', () => {
        expect(readFileSync(join(here, 'images/browser.Dockerfile'), 'utf8'))
            .toMatch(/^COPY chromium-policy\.json \/etc\/chromium\/policies\/managed\/abp\.json$/m)
        expect(readFileSync(join(here, 'abp-stack.mjs'), 'utf8')).toContain('"chromium-policy.json"')
    })

    it('makes the policy readable by the browser user whatever mode the checkout gave the file', () => {
        // COPY keeps the build context mode: a checkout made under umask 077 ships a root-only 0600 file Chromium silently ignores.
        expect(readFileSync(join(here, 'images/browser.Dockerfile'), 'utf8'))
            .toMatch(/^(?:RUN|\s+&&) chmod 644 \/etc\/chromium\/policies\/managed\/abp\.json$/m)
    })
})
