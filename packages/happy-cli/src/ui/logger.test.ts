import { describe, expect, it, vi } from 'vitest'
import { inspect } from 'node:util'
import { redactSensitiveLogString, redactSensitiveLogValue } from './logger'

describe('logger redaction', () => {
  it('redacts nested headers, raw requests, and query parameters', () => {
    const value = {
      config: {
        headers: {
          Authorization: 'Bearer fake-access-token',
          Cookie: 'session=fake-cookie',
          'x-api-key': 'fake-api-key',
          Accept: 'application/json',
        },
        url: 'https://example.test/api?access_token=fake-query-token&safe=yes',
      },
      request: {
        _header: 'GET /api HTTP/1.1\r\nAuthorization: Bearer fake-raw-token\r\nHost: example.test\r\n',
      },
    }

    const output = inspect(redactSensitiveLogValue(value), { depth: 10 })

    expect(output).not.toContain('fake-access-token')
    expect(output).not.toContain('fake-cookie')
    expect(output).not.toContain('fake-api-key')
    expect(output).not.toContain('fake-query-token')
    expect(output).not.toContain('fake-raw-token')
    expect(output).toContain('[REDACTED]')
    expect(output).toContain('application/json')
    expect(output).toContain('safe=yes')
  })

  it('handles Error properties and circular references without invoking getters', () => {
    const error = new Error('request failed with Bearer fake-message-token') as Error & Record<string, unknown>
    error.config = {
      headers: {
        authorization: 'Bearer fake-error-token',
      },
    }
    error.self = error

    const getter = vi.fn(() => 'fake-getter-secret')
    Object.defineProperty(error, 'response', {
      enumerable: true,
      get: getter,
    })

    const output = inspect(redactSensitiveLogValue(error), { depth: 10 })

    expect(output).toContain('request failed')
    expect(output).toContain('[REDACTED]')
    expect(output).toContain('[Circular]')
    expect(output).toContain('[Getter]')
    expect(output).not.toContain('fake-message-token')
    expect(output).not.toContain('fake-error-token')
    expect(output).not.toContain('fake-getter-secret')
    expect(getter).not.toHaveBeenCalled()
  })

  it('preserves non-sensitive token usage metadata', () => {
    const value = {
      tokenUsage: 42,
      model: 'example-model',
      nested: ['safe-value'],
    }

    expect(redactSensitiveLogValue(value)).toEqual(value)
  })

  it('redacts credentials embedded in unstructured strings', () => {
    const value = [
      'Proxy-Authorization: Basic fake-basic-value',
      "'Authorization', 'Bearer fake-tuple-token'",
      'https://example.test/?api_key=fake-url-key&mode=safe',
    ].join('\n')

    const output = redactSensitiveLogString(value)

    expect(output).not.toContain('fake-basic-value')
    expect(output).not.toContain('fake-tuple-token')
    expect(output).not.toContain('fake-url-key')
    expect(output.match(/\[REDACTED\]/g)).toHaveLength(3)
    expect(output).toContain('mode=safe')
  })
})
