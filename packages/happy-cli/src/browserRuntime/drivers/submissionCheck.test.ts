import { describe, expect, it } from 'vitest'
import type { FormSubmission } from '../contracts'
import { verifySubmissionRequest, type PausedRequest } from './submissionCheck'

const base: FormSubmission = {
    action: 'https://shop.test/order?src=cart', method: 'post', enctype: 'application/x-www-form-urlencoded', target: '',
    fields: [['item', 'a b'], ['item', 'c&d'], ['note', 'line1\nline2'], ['op', 'pay']],
    submitter: { name: 'op', value: 'pay', formaction: null, formmethod: null, formenctype: null },
    opaque: false,
}
const post = (body: string, over: Partial<PausedRequest> = {}): PausedRequest => ({ method: 'POST', url: base.action,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, hasPostData: true, postData: body, ...over })

describe('verifySubmissionRequest', () => {
    it('matches the urlencoded POST the browser sends (newlines normalized to CRLF)', () => {
        expect(verifySubmissionRequest(base, post('item=a+b&item=c%26d&note=line1%0D%0Aline2&op=pay'))).toBe('match')
    })

    it('rejects a changed, added, removed or reordered POST entry, and another method or URL', () => {
        for (const body of ['item=a+b&item=c%26d&note=line1%0D%0Aline2&op=refund', 'item=a+b&item=c%26d&note=line1%0D%0Aline2&op=pay&amount=999',
            'item=a+b&note=line1%0D%0Aline2&op=pay', 'item=c%26d&item=a+b&note=line1%0D%0Aline2&op=pay']) {
            expect(verifySubmissionRequest(base, post(body)), body).toBe('mismatch')
        }
        expect(verifySubmissionRequest(base, post('item=a+b&item=c%26d&note=line1%0D%0Aline2&op=pay', { url: 'https://shop.test/order' }))).toBe('mismatch')
        expect(verifySubmissionRequest(base, post('item=a+b&item=c%26d&note=line1%0D%0Aline2&op=pay', { url: 'https://shop.test/refund?src=cart' }))).toBe('mismatch')
        expect(verifySubmissionRequest(base, post('item=a+b&item=c%26d&note=line1%0D%0Aline2&op=pay', { method: 'PUT' }))).toBe('mismatch')
    })

    it('matches a GET whose query is the entry list (the action query replaced), and rejects a mutated query', () => {
        const get: FormSubmission = { ...base, method: 'get' }
        const request = (query: string): PausedRequest => ({ method: 'GET', url: `https://shop.test/order?${query}`, headers: {} })
        expect(verifySubmissionRequest(get, request('item=a+b&item=c%26d&note=line1%0D%0Aline2&op=pay'))).toBe('match')
        expect(verifySubmissionRequest(get, request('item=a+b&item=c%26d&note=line1%0D%0Aline2&op=pay&amount=999'))).toBe('mismatch')
        expect(verifySubmissionRequest(get, request('item=a+b&item=c%26d&note=changed&op=pay'))).toBe('mismatch')
        expect(verifySubmissionRequest(get, { ...request('item=a+b&item=c%26d&note=line1%0D%0Aline2&op=pay'), url: 'https://shop.test/other?item=a+b&item=c%26d&note=line1%0D%0Aline2&op=pay' })).toBe('mismatch')
    })

    it('matches a multipart body part by part, including an empty file input, and rejects a changed part', () => {
        const multipart: FormSubmission = { ...base, enctype: 'multipart/form-data', fields: [['q', 'x "y"'], ['doc', { file: '', size: 0, type: 'application/octet-stream' }], ['op', 'pay']] }
        const boundary = '----WebKitFormBoundaryAbC123'
        const body = (q: string) => [`--${boundary}`, 'Content-Disposition: form-data; name="q"', '', q,
            `--${boundary}`, 'Content-Disposition: form-data; name="doc"; filename=""', 'Content-Type: application/octet-stream', '', '',
            `--${boundary}`, 'Content-Disposition: form-data; name="op"', '', 'pay', `--${boundary}--`, ''].join('\r\n')
        const request = (q: string): PausedRequest => post(body(q), { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } })
        expect(verifySubmissionRequest(multipart, request('x "y"'))).toBe('match')
        expect(verifySubmissionRequest(multipart, request('x "z"'))).toBe('mismatch')
    })

    it('matches a text/plain body exactly', () => {
        const text: FormSubmission = { ...base, enctype: 'text/plain' }
        const request = (body: string) => post(body, { headers: { 'Content-Type': 'text/plain' } })
        expect(verifySubmissionRequest(text, request('item=a b\r\nitem=c&d\r\nnote=line1\r\nline2\r\nop=pay\r\n'))).toBe('match')
        expect(verifySubmissionRequest(text, request('item=a b\r\nitem=c&d\r\nnote=line1\r\nline2\r\nop=paid\r\n'))).toBe('mismatch')
    })

    it('reads the body from postDataEntries when postData is absent', () => {
        const bytes = Buffer.from('item=a+b&item=c%26d&note=line1%0D%0Aline2&op=pay').toString('base64')
        expect(verifySubmissionRequest(base, post('', { postData: undefined, postDataEntries: [{ bytes }] }))).toBe('match')
    })

    it('accepts any image-submitter coordinates but nothing else as a wildcard', () => {
        const image: FormSubmission = { ...base, fields: [['q', '1'], ['go.x', 'centre'], ['go.y', 'centre']] }
        expect(verifySubmissionRequest(image, post('q=1&go.x=12&go.y=7'))).toBe('match')
        expect(verifySubmissionRequest(image, post('q=2&go.x=12&go.y=7'))).toBe('mismatch')
    })

    it('reports what it cannot verify: a missing body, a filled password or chosen file, an unknown encoding', () => {
        expect(verifySubmissionRequest(base, post('', { postData: undefined }))).toBe('unverifiable')
        expect(verifySubmissionRequest({ ...base, fields: [['pw', { password: 4 }]] }, post('pw=abcd'))).toBe('unverifiable')
        expect(verifySubmissionRequest({ ...base, fields: [['f', { file: 'a.txt', size: 3, type: 'text/plain' }]] }, post('f=a.txt'))).toBe('unverifiable')
        expect(verifySubmissionRequest({ ...base, enctype: 'application/json' }, post('{}'))).toBe('unverifiable')
        expect(verifySubmissionRequest({ ...base, method: 'dialog' }, post(''))).toBe('unverifiable')
    })
})
