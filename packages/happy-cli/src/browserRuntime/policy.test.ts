import { describe, expect, it } from 'vitest'
import { BrowserRuntimeError, type BatchStep, type ElementDescription, type ElementRef, type FormSubmission } from './contracts'
import { assertAllowedOrigin, approvalBinding, classifySiteAction, classifyUserWait, formDigest, formSummary, loginCompleted, parseSitePolicies, redact, type SitePolicy } from './policy'
import { fixtureSitePolicies } from './testing/fixtureSitePolicy'

const step: BatchStep = { stepId: 's' as never, actionId: 'a' as never, tabId: 't' as never, kind: 'click', ref: '@e1' as ElementRef, timeoutMs: 1000 }

describe('fixture site policy (parity with the PoC classifier)', () => {
    const sites = fixtureSitePolicies(['https://fixture.test'])
    const described = (over: Partial<ElementDescription> = {}): ElementDescription => ({ ref: '@e1' as ElementRef, role: 'button', name: 'Continue',
        frameOrigin: 'https://fixture.test', pageUrl: 'https://fixture.test/start', formValues: {}, documentGeneration: 1, identity: 'id', ...over })

    it('requires approval for risky accessible names and risky form paths but ignores page text', () => {
        expect(classifySiteAction(sites, step, described({ name: 'Pay now' }))).toBe('requires-approval')
        expect(classifySiteAction(sites, step, described({ formAction: 'https://fixture.test/risky-submit' }))).toBe('requires-approval')
        expect(classifySiteAction(sites, step, described())).toBe('auto')
    })

    it('uses the current page path when the element has no form', () => {
        expect(classifySiteAction(sites, step, described({ name: 'Confirm payment', pageUrl: 'https://fixture.test/checkout' }))).toBe('requires-approval')
        expect(classifySiteAction(sites, step, described({ pageUrl: 'https://fixture.test/risky-submit' }))).toBe('requires-approval')
    })

    it('classifies only the submitting click on a risky form path, never fill or read-only steps', () => {
        const risky = described({ pageUrl: 'https://fixture.test/risky-submit' })
        const input = { ...risky, role: 'textbox' }
        expect(classifySiteAction(sites, { ...step, kind: 'fill', value: '5' }, input)).toBe('auto')
        expect(classifySiteAction(sites, { ...step, kind: 'observe' })).toBe('auto')
        expect(classifySiteAction(sites, { ...step, kind: 'waitFor', until: { kind: 'text', text: 'ready' } })).toBe('auto')
        expect(classifySiteAction(sites, { ...step, kind: 'screenshot' })).toBe('auto')
        expect(classifySiteAction(sites, step, input)).toBe('auto')
        expect(classifySiteAction(sites, step, risky)).toBe('requires-approval')
    })

    it('classifies fixture login and captcha paths for user waits', () => {
        expect(classifyUserWait('https://fixture.test/login')).toBe('login')
        expect(classifyUserWait('https://fixture.test/login/oauth')).toBe('login')
        expect(classifyUserWait('https://fixture.test/challenge/captcha')).toBe('captcha')
        expect(classifyUserWait('https://fixture.test/account')).toBeUndefined()
    })

    it('uses exact origins and strips URL secrets and canaries from nested values', () => {
        expect(assertAllowedOrigin('https://fixture.test/path?q=secret#fragment', { allowedOrigins: ['https://fixture.test'] })).toBe('https://fixture.test')
        expect(() => assertAllowedOrigin('https://fixture.test.evil/path', { allowedOrigins: ['https://fixture.test'] })).toThrowError(BrowserRuntimeError)
        expect(redact({ url: 'https://fixture.test/path?q=secret#x', password: 'ABP-CANARY-secret', text: 'ABP-CANARY-value', field: { name: 'Password', value: 'synthetic-secret' } })).toEqual({ url: 'https://fixture.test/path', text: '[REDACTED]', field: { name: 'Password' } })
    })

    it('binds approval to all input and browser generation fields', () => {
        const base = { principalId: 'p', workspaceId: 'w', taskId: 't', actionId: 'a', origin: 'https://fixture.test', payloadHash: 'hash', leaseEpoch: 1, browserInstanceId: 'b', documentGeneration: 1, expiresAtMs: 10 }
        expect(approvalBinding(base)).not.toBe(approvalBinding({ ...base, leaseEpoch: 2 }))
        expect(approvalBinding(base)).not.toBe(approvalBinding({ ...base, documentGeneration: 2 }))
    })
})

describe('form digest', () => {
    const base: FormSubmission = {
        action: 'https://fixture.test/order', method: 'post', enctype: 'application/x-www-form-urlencoded', target: '',
        fields: [['item', 'a'], ['item', 'b'], ['amount', '10'], ['pin', { password: 4 }]],
        submitter: { name: 'op', value: 'pay', formaction: null, formmethod: null, formenctype: null },
        opaque: false,
    }

    it('is a stable SHA-256 over every submitted part', () => {
        expect(formDigest(base)).toMatch(/^[0-9a-f]{64}$/)
        expect(formDigest(structuredClone(base))).toBe(formDigest(base))
    })

    it('changes with field order, duplicates, values, destination, method, enctype and submitter overrides', () => {
        const variants: FormSubmission[] = [
            { ...base, fields: [['item', 'b'], ['item', 'a'], ['amount', '10'], ['pin', { password: 4 }]] },
            { ...base, fields: [['item', 'a'], ['amount', '10'], ['pin', { password: 4 }]] },
            { ...base, fields: [['item', 'a'], ['item', 'b'], ['amount', '11'], ['pin', { password: 4 }]] },
            { ...base, fields: [['item', 'a'], ['item', 'b'], ['amount', '10'], ['pin', { password: 5 }]] },
            { ...base, action: 'https://fixture.test/other' },
            { ...base, method: 'get' },
            { ...base, enctype: 'text/plain' },
            { ...base, target: '_blank' },
            { ...base, submitter: { ...base.submitter!, value: 'refund' } },
            { ...base, submitter: { ...base.submitter!, formaction: '/other' } },
            { ...base, submitter: null },
            { ...base, opaque: true },
        ]
        const digests = new Set([formDigest(base), ...variants.map(formDigest)])
        expect(digests.size).toBe(variants.length + 1)
    })

    it('summarises without any value (it is persisted), while the digest binds every value', () => {
        const a = { ...base, fields: [['token', 'synthetic-secret-123']] as FormSubmission['fields'] }
        const b = { ...base, fields: [['token', 'synthetic-secret-124']] as FormSubmission['fields'] }
        expect(formSummary(a)).toBe(formSummary(b))
        expect(formSummary(a)).not.toContain('synthetic-secret')
        expect(formDigest(a)).not.toBe(formDigest(b))
        expect(formSummary(base)).toBe('POST https://fixture.test/order: item, item, amount, pin')
        expect(formSummary({ ...base, target: '_blank' })).toBe('POST https://fixture.test/order (new window): item, item, amount, pin')
        const many = { ...base, fields: Array.from({ length: 20 }, (_, i) => [`f${i}`, String(i)]) as FormSubmission['fields'] }
        expect(formSummary(many)).toMatch(/f11, \+8 more$/)
    })
})

describe('site action policy (D7)', () => {
    const origin = 'https://shop.test'
    const element = (over: Partial<ElementDescription> = {}): ElementDescription => ({ ref: '@e1' as ElementRef, role: 'button', name: 'Continue',
        frameOrigin: origin, pageUrl: `${origin}/cart`, formValues: {}, documentGeneration: 1, identity: 'id', currentRole: 'button', currentName: 'Continue', ...over })
    const form = (action: string, over: Partial<FormSubmission> = {}): FormSubmission & { digest: string } => {
        const submission: FormSubmission = { action, method: 'post', enctype: 'application/x-www-form-urlencoded', target: '', fields: [], submitter: null, opaque: false, ...over }
        return { ...submission, digest: formDigest(submission) }
    }
    const click: BatchStep = { ...step, kind: 'click' }
    const strict: SitePolicy[] = [{ origin, actions: [] }]

    it('holds every potentially effectful action the policy does not allow, and lets reads, plain links and navigation run', () => {
        expect(classifySiteAction(strict, click, element())).toBe('requires-approval')
        expect(classifySiteAction(strict, click, element({ form: form(`${origin}/cart/update`) }))).toBe('requires-approval')
        expect(classifySiteAction(strict, click, element({ form: form(`${origin}/checkout`), submitsForm: true }))).toBe('requires-approval')
        expect(classifySiteAction(strict, click, element({ role: 'link', currentRole: 'link', tag: 'a', linkUrl: `${origin}/help` }))).toBe('auto')
        // A fill can trigger autosave: approval unless the policy marks it automatic.
        expect(classifySiteAction(strict, { ...step, kind: 'fill', value: 'x' }, element({ role: 'textbox', currentRole: 'textbox' }))).toBe('requires-approval')
        expect(classifySiteAction(strict, { ...step, kind: 'navigate', url: `${origin}/cart` })).toBe('auto')
        expect(classifySiteAction(strict, { ...step, kind: 'observe' })).toBe('auto')
    })

    it('treats a link inside a form as a form click, and refuses executable or unsited link and form destinations outright', () => {
        const link = { role: 'link', currentRole: 'link', tag: 'a' }
        const permissive: SitePolicy[] = [{ origin, actions: [{ match: { kinds: ['link'] }, risk: 'auto' }] }]
        expect(classifySiteAction(permissive, click, element({ ...link, linkUrl: `${origin}/next`, form: form(`${origin}/order`) }))).toBe('requires-approval')
        for (const href of ['javascript:submitOrder()', 'JavaScript:void(0)', 'data:text/html,<p>x', 'vbscript:msgbox(1)', 'mailto:someone@shop.test']) {
            expect(classifySiteAction(permissive, click, element({ ...link, linkUrl: href })), href).toBe('deny')
        }
        expect(classifySiteAction(permissive, click, element({ ...link, linkUrl: 'https://elsewhere.test/x' }))).toBe('deny')
        expect(classifySiteAction(permissive, click, element({ submitsForm: true, form: form('javascript:alert(1)') }))).toBe('deny')
        expect(classifySiteAction(permissive, { ...step, kind: 'navigate', url: 'javascript:alert(1)' })).toBe('deny')
    })

    it('marks an explicitly automatic fill as automatic', () => {
        const sites: SitePolicy[] = [{ origin, actions: [{ match: { kinds: ['fill'], namePrefixes: ['search'] }, risk: 'auto' }] }]
        expect(classifySiteAction(sites, { ...step, kind: 'fill', value: 'x' }, element({ role: 'textbox', currentRole: 'textbox', name: 'Search', currentName: 'Search' }))).toBe('auto')
        expect(classifySiteAction(sites, { ...step, kind: 'fill', value: 'x' }, element({ role: 'textbox', currentRole: 'textbox', name: 'Amount', currentName: 'Amount' }))).toBe('requires-approval')
    })

    it('applies the first matching rule; a rule matches only when all of its conditions do', () => {
        const sites: SitePolicy[] = [{ origin, actions: [
            { match: { kinds: ['submit'], targetPaths: ['/checkout*'] }, risk: 'requires-approval' },
            { match: { kinds: ['submit', 'click'], namePrefixes: ['add to'] }, risk: 'auto' },
            { match: { kinds: ['navigate', 'link'], targetPaths: ['/api/delete'] }, risk: 'requires-approval' },
            { match: { kinds: ['fill'], roles: ['textbox'], pagePaths: ['/transfer'] }, risk: 'requires-approval' },
        ] }]
        expect(classifySiteAction(sites, click, element({ name: 'Add to cart', currentName: 'Add to cart' }))).toBe('auto')
        expect(classifySiteAction(sites, click, element({ name: 'Add to cart', currentName: 'Add to cart', submitsForm: true, form: form(`${origin}/checkout/now`) }))).toBe('requires-approval')
        expect(classifySiteAction(sites, click, element({ name: 'Remove', currentName: 'Remove' }))).toBe('requires-approval')
        expect(classifySiteAction(sites, { ...step, kind: 'navigate', url: `${origin}/api/delete?id=1` })).toBe('requires-approval')
        expect(classifySiteAction(sites, click, element({ role: 'link', currentRole: 'link', tag: 'a', linkUrl: `${origin}/api/delete?id=1` }))).toBe('requires-approval')
        expect(classifySiteAction(sites, { ...step, kind: 'fill', value: '1' }, element({ role: 'textbox', currentRole: 'textbox', pageUrl: `${origin}/transfer` }))).toBe('requires-approval')
        expect(classifySiteAction(sites, { ...step, kind: 'fill', value: '1' }, element({ role: 'textbox', currentRole: 'textbox' }))).toBe('requires-approval')
    })

    it('hands an action to the user when its effect cannot be bound, and refuses a destination outside the site list', () => {
        const permissive: SitePolicy[] = [{ origin, actions: [{ match: {}, risk: 'auto' }] }]
        expect(classifySiteAction(permissive, click, element())).toBe('auto')
        expect(classifySiteAction(permissive, click, element({ submitsForm: true, form: form('https://elsewhere.test/collect') }))).toBe('deny')
        expect(classifySiteAction(permissive, click, element({ submitsForm: true, form: form(`${origin}/x`, { opaque: true }) }))).toBe('handoff')
        expect(classifySiteAction(permissive, click, element({ form: form(`${origin}/x`, { opaque: true }) }))).toBe('handoff')
        // A restored ref carries no snapshot label: a relabel cannot be ruled out.
        expect(classifySiteAction(permissive, click, element({ role: '', name: '' }))).toBe('requires-approval')
        // An element of a frame whose site has no policy.
        expect(classifySiteAction(permissive, click, element({ frameOrigin: 'https://embed.test' }))).toBe('requires-approval')
    })

    it('validates the configuration strictly', () => {
        const valid = [{ origin, actions: [{ match: { kinds: ['submit'], targetPaths: ['/pay*'], namePrefixes: ['Pay'] }, risk: 'requires-approval' }],
            loginCompleteWhen: { urlPrefix: `${origin}/account`, text: 'Signed in' } }]
        expect(parseSitePolicies(valid)).toEqual(valid)
        // An origin-only site is allowed and has no automatic writes: every write needs approval.
        expect(parseSitePolicies([{ origin }])).toEqual([{ origin, actions: [] }])
        for (const bad of [
            [{ origin: `${origin}/path`, actions: [] }],
            [{ origin: 'ftp://shop.test', actions: [] }],
            [{ origin, actions: [{ match: {}, risk: 'maybe' }] }],
            [{ origin, actions: [{ match: { kinds: ['teleport'] }, risk: 'auto' }] }],
            [{ origin, actions: [{ match: { targetPaths: ['relative'] }, risk: 'auto' }] }],
            [{ origin, actions: [], extra: true }],
            [{ origin, actions: [] }, { origin, actions: [] }],
            [{ origin, actions: [], loginCompleteWhen: { urlPrefix: 'https://other.test/' } }],
            {},
        ]) expect(() => parseSitePolicies(bad), JSON.stringify(bad)).toThrow()
    })

    it('decides login completion from the site condition, not from leaving the login path', () => {
        const sites: SitePolicy[] = [{ origin, actions: [], loginCompleteWhen: { urlPrefix: `${origin}/account`, text: 'Signed in' } }]
        expect(loginCompleted(sites, { url: `${origin}/account`, text: 'Welcome. Signed in as synthetic', elements: [] }, '/login')).toBe(true)
        expect(loginCompleted(sites, { url: `${origin}/account`, text: 'Welcome', elements: [] }, '/login')).toBe(false)
        expect(loginCompleted(sites, { url: `${origin}/error`, text: 'Signed in', elements: [] }, '/login')).toBe(false)
        // Without a site condition the PoC rule applies: the page left the login path.
        expect(loginCompleted([{ origin, actions: [] }], { url: `${origin}/error`, text: '', elements: [] }, '/login')).toBe(true)
        expect(loginCompleted([{ origin, actions: [] }], { url: `${origin}/login/2fa`, text: '', elements: [] }, '/login')).toBe(false)
    })
})
