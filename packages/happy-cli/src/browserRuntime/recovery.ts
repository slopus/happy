import type { ActionId } from './contracts'
import type { StoredTask } from './taskStore'

export function inFlightWriteActions(task: StoredTask): ActionId[] {
    return Object.entries(task.actions)
        .filter(([, action]) => ['navigate', 'click', 'fill'].includes(String(action.kind)))
        .filter(([, action]) => action.state === 'intent-committed' || action.state === 'dispatched')
        .map(([id]) => id as ActionId)
}

export function browserInstanceMatches(task: StoredTask, currentInstance: string | undefined): boolean {
    return Boolean(currentInstance && task.browserInstanceId && task.browserInstanceId === currentInstance)
}
