import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
    mockExecSync,
    mockNetworkInterfaces,
    mockGetMacCapabilityState,
} = vi.hoisted(() => ({
    mockExecSync: vi.fn(),
    mockNetworkInterfaces: vi.fn(),
    mockGetMacCapabilityState: vi.fn(),
}))

vi.mock('child_process', () => ({ execSync: mockExecSync }))
vi.mock('os', () => ({ default: { networkInterfaces: mockNetworkInterfaces } }))
vi.mock('./macCapability', () => ({
    getMacCapabilityState: mockGetMacCapabilityState,
    retainMacCapabilityMonitor: vi.fn(),
    releaseMacCapabilityMonitor: vi.fn(),
}))

import { hasExternalDisplay, isLidClosed, shouldReconnect } from './lidState'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

const connectedInterfaces = {
    en0: [{ internal: false, family: 'IPv4' }],
}

describe('shouldReconnect', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'darwin' })
        mockGetMacCapabilityState.mockReturnValue({ status: 'unavailable', fullWake: null })
    })

    afterEach(() => {
        Object.defineProperty(process, 'platform', originalPlatform)
    })

    it('stays false without a network interface and does not inspect power state', () => {
        mockNetworkInterfaces.mockReturnValue({
            en0: [{ internal: true, family: 'IPv4' }],
        })

        expect(shouldReconnect()).toBe(false)
        expect(mockGetMacCapabilityState).not.toHaveBeenCalled()
        expect(mockExecSync).not.toHaveBeenCalled()
    })

    it('waits while the native monitor is still pending its initial snapshot', () => {
        mockNetworkInterfaces.mockReturnValue(connectedInterfaces)
        mockGetMacCapabilityState.mockReturnValue({ status: 'pending', fullWake: null })

        expect(shouldReconnect()).toBe(false)
        expect(mockExecSync).not.toHaveBeenCalled()
    })

    it('allows reconnect after the native monitor reports full wake', () => {
        mockNetworkInterfaces.mockReturnValue(connectedInterfaces)
        mockGetMacCapabilityState.mockReturnValue({ status: 'ready', fullWake: true })

        expect(shouldReconnect()).toBe(true)
        expect(mockExecSync).not.toHaveBeenCalled()
    })

    it('blocks reconnect during native dark wake even with an external display', () => {
        mockNetworkInterfaces.mockReturnValue(connectedInterfaces)
        mockGetMacCapabilityState.mockReturnValue({ status: 'ready', fullWake: false })

        expect(shouldReconnect()).toBe(false)
        expect(mockExecSync).not.toHaveBeenCalled()
    })

    it('falls back to the previous lid/display guard when the helper is unavailable', () => {
        mockNetworkInterfaces.mockReturnValue(connectedInterfaces)
        mockExecSync.mockReturnValueOnce('"AppleClamshellState" = Yes')
            .mockReturnValueOnce(JSON.stringify({
                SPDisplaysDataType: [{
                    spdisplays_ndrvs: [{ spdisplays_builtin: 'spdisplays_yes' }],
                }],
            }))

        expect(shouldReconnect()).toBe(false)
        expect(mockExecSync).toHaveBeenCalledTimes(2)
    })

    it('keeps non-macOS network behavior unchanged', () => {
        Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'linux' })
        mockNetworkInterfaces.mockReturnValue(connectedInterfaces)

        expect(shouldReconnect()).toBe(true)
        expect(mockGetMacCapabilityState).toHaveBeenCalledOnce()
    })
})

describe('legacy macOS probes', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'darwin' })
    })

    afterEach(() => {
        Object.defineProperty(process, 'platform', originalPlatform)
    })

    it('reports lid state from ioreg', () => {
        mockExecSync.mockReturnValue('"AppleClamshellState" = No')

        expect(isLidClosed()).toBe(false)
        expect(mockExecSync).toHaveBeenCalledOnce()
    })

    it('reports a non-built-in display from system_profiler', () => {
        mockExecSync.mockReturnValue(JSON.stringify({
            SPDisplaysDataType: [{
                spdisplays_ndrvs: [{ spdisplays_builtin: 'spdisplays_no' }],
            }],
        }))

        expect(hasExternalDisplay()).toBe(true)
    })
})