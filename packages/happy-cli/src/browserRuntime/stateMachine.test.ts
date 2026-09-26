import { describe, expect, it } from 'vitest'
import { BrowserRuntimeError } from './contracts'
import { transitionTask } from './stateMachine'

describe('task transition contract', () => {
    it.each([
        ['queued', { type: 'start' }, 'running'],
        ['running', { type: 'batch-finished' }, 'paused'],
        ['running', { type: 'wait', reason: 'approval' }, 'awaiting-user'],
        ['running', { type: 'cancel' }, 'cancelled'],
    ] as const)('%s + %o -> %s', (status, event, expected) => {
        expect(transitionTask({ status }, event).status).toBe(expected)
    })

    it('expires an approval wait to the approval-expired pause', () => {
        expect(transitionTask({ status: 'awaiting-user', waitReason: 'approval' }, { type: 'approval-expired' }))
            .toEqual({ status: 'paused', pauseReason: 'approval-expired' })
    })

    it('resumes only contract-approved paused reasons', () => {
        expect(transitionTask({ status: 'paused', pauseReason: 'user-input-complete' }, { type: 'resume' }).status).toBe('running')
        expect(() => transitionTask({ status: 'paused', pauseReason: 'quota' }, { type: 'resume' })).toThrowError(BrowserRuntimeError)
    })

    it('fails closed for unknown pause reasons and invalid transitions', () => {
        expect(() => transitionTask({ status: 'running' }, { type: 'pause', reason: 'mystery' as never }))
            .toThrowError(BrowserRuntimeError)
        expect(() => transitionTask({ status: 'succeeded' }, { type: 'start' }))
            .toThrowError(BrowserRuntimeError)
    })
})
