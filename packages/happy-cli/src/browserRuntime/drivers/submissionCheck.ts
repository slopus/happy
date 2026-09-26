/**
 * Verifies the request a form submission actually produced — method, URL with
 * query, and body — against the submission that was classified/approved
 * (FormSubmission). Runs at request interception time, after every page handler
 * (submit, formdata, including late or ancestor listeners) has had its chance to
 * change the data, so what is checked is exactly what would be sent.
 *
 * 'unverifiable' covers what this check cannot bind (a missing body, a filled
 * password, a chosen file, an unknown encoding): such a request is not sent.
 */
import type { FormFieldValue, FormSubmission } from '../contracts'

/** The parts of a CDP Fetch.requestPaused request this check reads. */
export interface PausedRequest {
    method: string
    url: string
    headers: Record<string, string>
    hasPostData?: boolean
    postData?: string
    postDataEntries?: Array<{ bytes?: string }>
}

export type SubmissionVerdict = 'match' | 'mismatch' | 'unverifiable'

/** An entry the request must carry: a text value, a file input (by file name), or any value (image-submitter coordinates). */
type ExpectedEntry = [string, { text: string } | { file: string } | { any: true }]

class Unverifiable extends Error {}

/** Entry-list values are normalized to CRLF line breaks before they are encoded (HTML form submission). */
function crlf(value: string): string {
    return value.replace(/\r\n|\r|\n/g, '\r\n')
}

function expectedEntries(form: FormSubmission): ExpectedEntry[] {
    return form.fields.map(([name, value]: [string, FormFieldValue]) => {
        if (typeof value === 'string') return [crlf(name), value === 'centre' && /(^|\.)[xy]$/.test(name) ? { any: true } : { text: crlf(value) }]
        if ('password' in value) {
            if (value.password !== 0) throw new Unverifiable('a filled password cannot be bound')
            return [crlf(name), { text: '' }]
        }
        if (value.file !== '' || value.size !== 0) throw new Unverifiable('a chosen file cannot be bound')
        return [crlf(name), { file: '' }]
    })
}

function sameEntries(expected: ExpectedEntry[], actual: Array<[string, { text: string } | { file: string }]>): boolean {
    return expected.length === actual.length && expected.every(([name, value], i) => {
        const [actualName, actualValue] = actual[i]
        if (crlf(actualName) !== name) return false
        if ('any' in value) return 'text' in actualValue
        if ('file' in value) return 'file' in actualValue ? actualValue.file === value.file : actualValue.text === value.file
        return 'text' in actualValue && crlf(actualValue.text) === value.text
    })
}

function withoutFragment(url: string): string {
    const parsed = new URL(url)
    parsed.hash = ''
    return parsed.toString()
}

function header(headers: Record<string, string>, name: string): string {
    const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name)
    return key ? headers[key] : ''
}

function body(request: PausedRequest): string {
    if (request.postData !== undefined && request.postData !== '') return request.postData
    const entries = request.postDataEntries ?? []
    if (entries.length) return Buffer.concat(entries.map((entry) => Buffer.from(entry.bytes ?? '', 'base64'))).toString('utf8')
    if (request.hasPostData) throw new Unverifiable('the request body is not available')
    return ''
}

function urlencoded(text: string): Array<[string, { text: string }]> {
    return [...new URLSearchParams(text)].map(([name, value]) => [name, { text: value }])
}

function unquote(value: string): string {
    return value.replace(/%22/g, '"').replace(/%0D/gi, '\r').replace(/%0A/gi, '\n')
}

function multipart(text: string, contentType: string): Array<[string, { text: string } | { file: string }]> {
    const boundary = /boundary=("?)([^";]+)\1/i.exec(contentType)?.[2]
    if (!boundary) throw new Unverifiable('multipart body without a boundary')
    const parts = text.split(`--${boundary}`)
    if (parts.length < 2 || !parts[parts.length - 1].startsWith('--')) throw new Unverifiable('malformed multipart body')
    return parts.slice(1, -1).map((part) => {
        if (!part.startsWith('\r\n') || !part.endsWith('\r\n')) throw new Unverifiable('malformed multipart part')
        const content = part.slice(2, -2)
        const split = content.indexOf('\r\n\r\n')
        if (split < 0) throw new Unverifiable('malformed multipart part')
        const headers = content.slice(0, split)
        const value = content.slice(split + 4)
        const disposition = headers.split('\r\n').find((line) => /^content-disposition:/i.test(line)) ?? ''
        const name = /;\s*name="([^"]*)"/i.exec(disposition)?.[1]
        if (name === undefined) throw new Unverifiable('multipart part without a name')
        const filename = /;\s*filename="([^"]*)"/i.exec(disposition)?.[1]
        if (filename !== undefined) {
            if (value !== '') throw new Unverifiable('a file part carries content')
            return [unquote(name), { file: unquote(filename) }]
        }
        return [unquote(name), { text: value }]
    })
}

export function verifySubmissionRequest(expected: FormSubmission, request: PausedRequest): SubmissionVerdict {
    try {
        const entries = expectedEntries(expected)
        const method = request.method.toUpperCase()
        if (expected.method === 'get') {
            if (method !== 'GET') return 'mismatch'
            const actual = new URL(request.url)
            const action = new URL(expected.action)
            if (actual.origin !== action.origin || actual.pathname !== action.pathname) return 'mismatch'
            return sameEntries(entries, urlencoded(actual.search.slice(1))) ? 'match' : 'mismatch'
        }
        if (expected.method !== 'post') throw new Unverifiable(`method ${expected.method} is not verified`)
        if (method !== 'POST' || withoutFragment(request.url) !== withoutFragment(expected.action)) return 'mismatch'
        const text = body(request)
        if (expected.enctype === 'application/x-www-form-urlencoded') return sameEntries(entries, urlencoded(text)) ? 'match' : 'mismatch'
        if (expected.enctype === 'multipart/form-data') return sameEntries(entries, multipart(text, header(request.headers, 'content-type'))) ? 'match' : 'mismatch'
        if (expected.enctype === 'text/plain') {
            const serialized = entries.map(([name, value]) => {
                if ('any' in value) throw new Unverifiable('image coordinates in a text/plain body')
                return `${name}=${'file' in value ? value.file : value.text}\r\n`
            }).join('')
            return text === serialized ? 'match' : 'mismatch'
        }
        return 'unverifiable'
    } catch (error) {
        if (error instanceof Unverifiable || error instanceof TypeError) return 'unverifiable'
        throw error
    }
}
