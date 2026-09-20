import os from 'os'
import { execSync } from 'child_process'
import {
    getMacCapabilityState,
    releaseMacCapabilityMonitor,
    retainMacCapabilityMonitor,
} from './macCapability'

export function hasNetworkConnectivity(): boolean {
    const interfaces = os.networkInterfaces()
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name] || []) {
            if (!iface.internal && iface.family === 'IPv4') return true
        }
    }
    return false
}

export function isLidClosed(): boolean {
    if (process.platform !== 'darwin') return false
    try {
        const output = execSync('ioreg -r -k AppleClamshellState -d 4', {
            timeout: 5000,
            encoding: 'utf-8',
        })
        return output.includes('"AppleClamshellState" = Yes')
    } catch {
        return false
    }
}

export function hasExternalDisplay(): boolean {
    if (process.platform !== 'darwin') return false
    try {
        const output = execSync('system_profiler SPDisplaysDataType -json 2>/dev/null', {
            timeout: 10000,
            encoding: 'utf-8',
        })
        const data = JSON.parse(output)
        const gpus: any[] = data.SPDisplaysDataType || []
        for (const gpu of gpus) {
            const displays: any[] = gpu.spdisplays_ndrvs || []
            for (const display of displays) {
                const isBuiltIn =
                    display.spdisplays_builtin === 'spdisplays_yes' ||
                    display.spdisplays_connection_type === 'spdisplays_internal'
                if (!isBuiltIn) return true
            }
        }
        return false
    } catch {
        return false
    }
}

export function shouldReconnect(): boolean {
    if (!hasNetworkConnectivity()) return false

    const capability = getMacCapabilityState()
    if (capability.status === 'ready') {
        return capability.fullWake === true
    }
    if (capability.status === 'pending') {
        return false
    }

    // Older installs may not have the helper yet, and a failed helper must
    // preserve the previous conservative macOS behavior rather than treating
    // network reachability alone as proof of a full wake.
    if (capability.status === 'unavailable') {
        if (process.platform !== 'darwin') return true
        return !isLidClosed() || hasExternalDisplay()
    }

    return true
}

export function retainReconnectCapabilityMonitor(): void {
    retainMacCapabilityMonitor()
}

export function releaseReconnectCapabilityMonitor(): void {
    releaseMacCapabilityMonitor()
}
