import {
    BrowserRuntimeError,
    type AgentGrant,
    type BatchStep,
    type BrowserDriver,
    type DispatchExpectation,
    type ElementRef,
    type Observation,
} from './contracts'
import { assertAllowedOrigin } from './policy'

/** One validated driver dispatch; the runtime owns fencing and durable intents. */
export async function dispatchStep(
    driver: BrowserDriver,
    step: BatchStep,
    grant: AgentGrant,
    signal: AbortSignal,
    /** click: what was classified/approved, re-verified by the driver right before input */
    expect?: DispatchExpectation,
): Promise<Observation | { url: string; documentGeneration: number } | void> {
    const options = { signal, timeoutMs: step.timeoutMs }
    switch (step.kind) {
        case 'navigate': {
            if (!step.url) throw new BrowserRuntimeError('INVALID_REQUEST', 'navigate requires url')
            assertAllowedOrigin(step.url, grant)
            const result = await driver.navigate(step.tabId, step.url, grant.allowedOrigins, options)
            assertAllowedOrigin(result.url, grant)
            return result
        }
        case 'click':
            if (!step.ref || typeof step.ref === 'string' && step.ref.startsWith('$')) {
                throw new BrowserRuntimeError('INVALID_REQUEST', 'click needs a resolved ref')
            }
            if (!step.snapshotId) throw new BrowserRuntimeError('STALE_REF', 'click has no agent-visible snapshot', false, false)
            return driver.click(step.tabId, step.ref as ElementRef, step.snapshotId, { ...options, ...(expect ? { expect } : {}) })
        case 'fill':
            if (!step.ref || step.value === undefined) {
                throw new BrowserRuntimeError('INVALID_REQUEST', 'fill needs ref and value')
            }
            if (!step.snapshotId) throw new BrowserRuntimeError('STALE_REF', 'fill has no agent-visible snapshot', false, false)
            return driver.fill(step.tabId, step.ref as ElementRef, step.snapshotId, step.value, options)
        case 'observe':
            return driver.observe(step.tabId, grant.allowedOrigins, options)
        case 'screenshot':
            await driver.screenshot(step.tabId, grant.allowedOrigins, options)
            return
        case 'waitFor':
            if (!step.until) throw new BrowserRuntimeError('INVALID_REQUEST', 'waitFor needs a predicate')
            return driver.waitFor(step.tabId, step.until, grant.allowedOrigins, options)
    }
}
