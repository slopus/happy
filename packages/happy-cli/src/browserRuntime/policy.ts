import { createHash } from 'node:crypto'
import { z } from 'zod'
import { BrowserRuntimeError, type AgentGrant, type BatchStep, type ElementDescription, type FormSubmission, type Observation } from './contracts'

export function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`
}

export function payloadHash(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex') }

/**
 * SHA-256 over the canonical form submission: destination, method, enctype, target,
 * every field in submission order and the submitter with its overrides. Approvals
 * bind this, so any change to what would be sent invalidates them.
 */
export function formDigest(form: FormSubmission): string {
    const { action, method, enctype, target, fields, submitter, opaque } = form
    return payloadHash({ action, method, enctype, target, fields, submitter, opaque })
}

const SUMMARY_NAME_CHARS = 40
const SUMMARY_FIELDS = 12

/**
 * Human-readable approval summary: method, destination (query stripped), a new
 * browsing context if targeted, and field names. It is persisted with the approval,
 * so it never contains a value; the digest binds the values. The user sees the
 * values themselves in the viewer.
 */
export function formSummary(form: FormSubmission): string {
    const names = form.fields.slice(0, SUMMARY_FIELDS).map(([name]) => redact(name).slice(0, SUMMARY_NAME_CHARS))
    if (form.fields.length > SUMMARY_FIELDS) names.push(`+${form.fields.length - SUMMARY_FIELDS} more`)
    const target = ['', '_self'].includes(form.target) ? '' : ' (new window)'
    return `${form.method.toUpperCase()} ${redact(form.action)}${target}: ${names.join(', ')}`
}

export function assertAllowedOrigin(url: string, grant: Pick<AgentGrant, 'allowedOrigins'>): string {
    let origin: string
    try { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('unsupported URL'); origin = parsed.origin } catch { throw new BrowserRuntimeError('ORIGIN_DENIED', 'Invalid navigation URL') }
    if (!grant.allowedOrigins.includes(origin)) throw new BrowserRuntimeError('ORIGIN_DENIED', 'Origin is not in the task grant')
    return origin
}

// ---------------------------------------------------------------------------
// Site policy (D7): which origins may be opened and what each action there may
// do without the user. Configured per deployment; the harness supplies the
// synthetic fixture's policy.
// ---------------------------------------------------------------------------

/**
 * What an action would do, from the step and a fresh describeRef:
 * navigate (agent URL), link (click on/in a[href]), submit (click on the
 * button that submits its form), form-click (any other click inside a form),
 * click (any other click), fill.
 */
export type SiteActionKind = 'navigate' | 'link' | 'submit' | 'form-click' | 'click' | 'fill'
export type SiteActionRisk = 'auto' | 'requires-approval'

export interface SiteActionMatch {
    kinds?: SiteActionKind[]
    /** Paths of the destination (navigate URL, link href, form action): exact, or a prefix ending in '*' */
    targetPaths?: string[]
    /** Paths of the element's document, same syntax */
    pagePaths?: string[]
    /** Case-insensitive prefixes of the element's accessible name (no regular expressions: config must not cost CPU) */
    namePrefixes?: string[]
    roles?: string[]
}

export interface SitePolicy {
    origin: string
    /** First matching rule wins; a rule matches when every condition it names matches. */
    actions: Array<{ match: SiteActionMatch; risk: SiteActionRisk }>
    /** Login is complete when the page URL starts with urlPrefix and the optional text / element is present. */
    loginCompleteWhen?: { urlPrefix: string; text?: string; elementName?: string }
}

/** Potentially effectful kinds: without a rule saying otherwise they need the user. */
const WRITE_CAPABLE: ReadonlySet<SiteActionKind> = new Set(['submit', 'form-click', 'click', 'fill'])

/**
 * The outcome of classifying one action: run it, ask the user to approve it, hand it
 * to the user (it cannot be bound for approval), or refuse it outright.
 */
export type SiteDecision = SiteActionRisk | 'handoff' | 'deny'

function isOrigin(value: string): boolean {
    try {
        const url = new URL(value)
        return ['http:', 'https:'].includes(url.protocol) && url.origin === value
    } catch {
        return false
    }
}

const pathPattern = z.string().max(512).regex(/^\/\S*$/)
const siteSchema = z.object({
    origin: z.string().refine(isOrigin, 'origin must be scheme://host[:port]'),
    actions: z.array(z.object({
        match: z.object({
            kinds: z.array(z.enum(['navigate', 'link', 'submit', 'form-click', 'click', 'fill'])).min(1).optional(),
            targetPaths: z.array(pathPattern).min(1).optional(),
            pagePaths: z.array(pathPattern).min(1).optional(),
            namePrefixes: z.array(z.string().min(1).max(120)).min(1).optional(),
            roles: z.array(z.string().min(1).max(40)).min(1).optional(),
        }).strict(),
        risk: z.enum(['auto', 'requires-approval']),
    }).strict()).max(200).default([]),
    loginCompleteWhen: z.object({
        urlPrefix: z.string().max(1024),
        text: z.string().min(1).max(200).optional(),
        elementName: z.string().min(1).max(120).optional(),
    }).strict().optional(),
}).strict().refine((site) => !site.loginCompleteWhen || originOf(site.loginCompleteWhen.urlPrefix) === site.origin,
    'loginCompleteWhen.urlPrefix must be on the site origin')

/** Validates a deployment's `sites` configuration; throws on anything unexpected. */
export function parseSitePolicies(value: unknown): SitePolicy[] {
    const sites = z.array(siteSchema).max(100).parse(value) as SitePolicy[]
    if (new Set(sites.map((site) => site.origin)).size !== sites.length) throw new Error('sites: duplicate origin')
    return sites
}

export function originOf(url: string | undefined): string {
    if (!url) return ''
    try {
        const origin = new URL(url).origin
        return origin === 'null' ? '' : origin
    } catch {
        return ''
    }
}

function pathOf(url: string | undefined): string | undefined {
    if (!url) return undefined
    try {
        return new URL(url).pathname
    } catch {
        return undefined
    }
}

function pathMatches(patterns: string[] | undefined, path: string | undefined): boolean {
    if (!patterns) return true
    if (path === undefined) return false
    return patterns.some((pattern) => pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : path === pattern)
}

export function siteFor(sites: SitePolicy[], origin: string): SitePolicy | undefined {
    return sites.find((site) => site.origin === origin)
}

/** Refuses an origin that has no site policy (openPage, navigate). */
export function assertSiteAllowed(sites: SitePolicy[], url: string): void {
    if (!siteFor(sites, originOf(url))) throw new BrowserRuntimeError('ORIGIN_DENIED', 'Origin has no site policy')
}

export function siteActionKind(step: BatchStep, element?: ElementDescription): SiteActionKind | undefined {
    if (step.kind === 'navigate') return 'navigate'
    if (step.kind === 'fill') return 'fill'
    if (step.kind !== 'click') return undefined
    if (element?.submitsForm) return 'submit'
    // Inside a form any click (a link too) may drive the form: it is a form click.
    if (element?.form || element?.formAction) return 'form-click'
    if (element?.linkUrl) return 'link'
    return 'click'
}

function isWebUrl(url: string | undefined): boolean {
    try {
        return !!url && ['http:', 'https:'].includes(new URL(url).protocol)
    } catch {
        return false
    }
}

/**
 * Classifies one step against the site policy. Reads are always automatic.
 * Refused outright: destinations (navigation, link, form) that are not http(s)
 * — javascript:, data:, vbscript:, mailto: … — or not on a sited origin.
 * Handed to the user: a submit or form click whose form the digest cannot bind
 * (opaque: unreadable control, password or file content).
 * Held for approval whatever a rule says: an element without a snapshot label (a
 * relabel cannot be detected) or in a frame whose site has no policy.
 * Otherwise the first matching rule decides; unmatched submits, clicks and fills
 * need approval, links and navigation do not.
 */
export function classifySiteAction(sites: SitePolicy[], step: BatchStep, element?: ElementDescription): SiteDecision {
    const kind = siteActionKind(step, element)
    if (!kind) return 'auto'
    const target = kind === 'navigate' ? step.url
        : kind === 'link' ? element?.linkUrl
            : kind === 'submit' || kind === 'form-click' ? element?.form?.action ?? element?.formAction
                : undefined
    const destinations = [target, ...(kind !== 'navigate' && element?.linkUrl ? [element.linkUrl] : [])].filter((url): url is string => url !== undefined)
    if (destinations.some((url) => !isWebUrl(url) || !siteFor(sites, originOf(url)))) return 'deny'
    const site = siteFor(sites, kind === 'navigate' ? originOf(step.url) : element?.frameOrigin ?? '')
    if (kind !== 'navigate') {
        if (!element || !site) return 'requires-approval'
        if (!element.role && !element.name) return 'requires-approval'
        if (element.form?.opaque && (kind === 'submit' || kind === 'form-click')) return 'handoff'
    }
    const name = (element?.currentName ?? element?.name ?? '').toLowerCase()
    const role = (element?.currentRole ?? element?.role ?? '').toLowerCase()
    const rule = site?.actions.find(({ match }) =>
        (!match.kinds || match.kinds.includes(kind))
        && pathMatches(match.targetPaths, pathOf(target))
        && pathMatches(match.pagePaths, pathOf(element?.pageUrl))
        && (!match.namePrefixes || match.namePrefixes.some((prefix) => name.startsWith(prefix.toLowerCase())))
        && (!match.roles || match.roles.some((candidate) => candidate.toLowerCase() === role)))
    if (rule) return rule.risk
    return WRITE_CAPABLE.has(kind) ? 'requires-approval' : 'auto'
}

/**
 * Login is complete per the site's loginCompleteWhen (URL prefix + optional
 * text/element); without one, the PoC rule applies (the page left the login path).
 */
export function loginCompleted(sites: SitePolicy[], observation: Pick<Observation, 'url' | 'text' | 'elements'>, notPathPrefix: string,
    loginOrigin = originOf(observation.url)): boolean {
    const condition = siteFor(sites, loginOrigin)?.loginCompleteWhen
    if (!condition) return !(pathOf(observation.url) ?? '').startsWith(notPathPrefix)
    return observation.url.startsWith(condition.urlPrefix)
        && (!condition.text || observation.text.includes(condition.text))
        && (!condition.elementName || observation.elements.some((element) => element.name === condition.elementName))
}

export function classifyUserWait(url: string): 'login' | 'captcha' | undefined {
    try {
        const path = new URL(url).pathname
        if (path.startsWith('/login'))
            return 'login'
        if (path.startsWith('/challenge'))
            return 'captcha'
    } catch {
        return undefined
    }
    return undefined
}

export function approvalBinding(input: { principalId: string; workspaceId: string; taskId: string; actionId: string; origin: string; payloadHash: string; leaseEpoch: number; browserInstanceId: string; documentGeneration: number; expiresAtMs: number; frameOrigin?: string }): string {
    return payloadHashHex(input)
}
function payloadHashHex(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex') }

const CANARY = /ABP-CANARY-[A-Za-z0-9]+/g
export function redact<T>(value: T): T {
    if (typeof value === 'string') {
        const scrubUrl = (text: string) => text.replace(/(https?:\/\/[^\s?#]+)(?:[?#][^\s]*)?/g, '$1').replace(/(^|\s)(\/[^\s?#]+)(?:[?#][^\s]*)?/g, '$1$2')
        return scrubUrl(value).replace(CANARY, '[REDACTED]') as T
    }
    if (Array.isArray(value)) return value.map((item) => redact(item)) as T
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {}
        const record = value as Record<string, unknown>
        const passwordField = /password/i.test(String(record.name ?? '')) || /password/i.test(String(record.type ?? ''))
        for (const [key, item] of Object.entries(record)) {
            if (/password/i.test(key)) continue
            if (passwordField && key === 'value') continue
            out[key] = redact(item)
        }
        return out as T
    }
    return value
}
