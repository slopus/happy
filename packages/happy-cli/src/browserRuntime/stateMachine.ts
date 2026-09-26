import { BrowserRuntimeError, PAUSE_REASONS, type PauseReason, type TaskStatus, type WaitReason } from './contracts'

export interface TaskState { status: TaskStatus; pauseReason?: PauseReason; waitReason?: WaitReason }
export type TaskEvent =
    | { type: 'start' | 'resume' }
    | { type: 'batch-finished' }
    | { type: 'wait'; reason: WaitReason }
    | { type: 'pause'; reason: PauseReason }
    | { type: 'approval-expired' }
    | { type: 'cancel' }
    | { type: 'finish' }
    | { type: 'fail' }

export function transitionTask(state: TaskState, event: TaskEvent): TaskState {
    if (event.type === 'pause' && !(PAUSE_REASONS as readonly string[]).includes(event.reason)) {
        throw new BrowserRuntimeError('INVALID_REQUEST', 'Unknown pause reason')
    }
    switch (event.type) {
        case 'start':
            if (state.status !== 'queued' && !(state.status === 'paused' && state.pauseReason === 'awaiting-agent')) break
            return { status: 'running' }
        case 'resume':
            if (state.status !== 'paused' || !['awaiting-agent', 'user-input-complete', 'user-wait-expired', 'approval-expired', 'grant-expired', 'browser-replaced'].includes(state.pauseReason ?? '')) break
            return { status: 'running' }
        case 'batch-finished':
            if (state.status !== 'running') break
            return { status: 'paused', pauseReason: 'awaiting-agent' }
        case 'wait':
            if (state.status !== 'running') break
            return { status: 'awaiting-user', waitReason: event.reason }
        case 'pause':
            if (!['queued', 'running', 'awaiting-user', 'recovering', 'paused'].includes(state.status)) break
            return { status: 'paused', pauseReason: event.reason, ...(state.waitReason ? { waitReason: state.waitReason } : {}) }
        case 'approval-expired':
            if (state.status !== 'awaiting-user' || state.waitReason !== 'approval') break
            return { status: 'paused', pauseReason: 'approval-expired' }
        case 'cancel':
            if (['succeeded', 'failed', 'cancelled'].includes(state.status)) break
            return { status: 'cancelled' }
        case 'finish':
            if (state.status !== 'paused' || state.pauseReason !== 'awaiting-agent') break
            return { status: 'succeeded' }
        case 'fail':
            if (state.status !== 'running') break
            return { status: 'failed' }
    }
    throw new BrowserRuntimeError('CONFLICT', `Invalid task transition: ${state.status} + ${event.type}`)
}
