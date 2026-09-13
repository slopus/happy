import React, { useSyncExternalStore } from 'react';
import { Text } from 'react-native';
import { appThemes } from '@/themePacks';
import { zhHans } from '@/text/translations/zh-Hans';
import type { ComponentObservation, EnvironmentComponentId, EnvironmentInspectRequest, EnvironmentApplyRequest } from '@slopus/happy-wire';
import type { Machine } from '@/sync/storageTypes';
const params = new URLSearchParams(location.search);
export const theme = appThemes[params.get('theme') === 'gingham' ? 'ginghamDark' : 'caramelDark'];
export const StyleSheet = { hairlineWidth: 1, create: (fn: any) => fn(theme) };
export const useUnistyles = () => ({ theme });
export const Ionicons = ({ name, color, size }: any) => <Text aria-hidden style={{color,fontSize:size}}>{name === 'refresh-outline' ? '↻' : '◇'}</Text>;
export const setStringAsync = async () => undefined;
export const t = (key: string, args: any) => { const value = key.split('.').reduce((o: any, k) => o?.[k], zhHans); return typeof value === 'function' ? value(args) : value ?? key; };
export const Modal = { confirm: async (title: string, message: string) => window.confirm(`${title}\n\n${message}`), alert: (title: string, message: string) => window.alert(`${title}\n${message}`) };
const credentials = { token: 'fixture-only', secret: 'fixture-only' };
export const useAuth = () => ({ credentials });
export const getCurrentAuth = () => ({ credentials });
export const getServerUrl = () => 'fixture://no-network';
const codexListeners = new Set<() => void>();
let codexBusy = false;
let codexProfiles = [{
    id: 'fixture-codex-account', displayName: 'Codex · Fixture', status: 'available', updatedAt: '2026-09-14T02:00:00.000Z', credentialVersion: 1,
    quota: { state: 'unknown', remainingPercent: null, weeklyResetsAt: null, observedAt: null },
}];
const codexBindings = fleetBindings();
function fleetBindings() { return ['device-1', 'device-2', 'device-3'].map(machineId => ({ machineId, profileId: 'fixture-codex-account', version: 1 })); }
let codexSnapshot: any;
function refreshCodexSnapshot() { codexSnapshot = {
    profiles: codexProfiles, bindings: codexBindings, migration: 'none', loading: false, busy: codexBusy, error: null,
    rename: async () => true, remove: async () => true, bind: async () => true,
    refresh: async () => {
        codexBusy = true; refreshCodexSnapshot(); notifyCodex();
        await delay(900);
        codexProfiles = codexProfiles.map(profile => ({ ...profile, updatedAt: '2026-09-14T02:15:00.000Z', quota: {
            state: 'current', remainingPercent: 87, weeklyResetsAt: '2026-09-19T08:15:00.000Z', observedAt: '2026-09-14T02:15:00.000Z',
        } }));
        codexBusy = false; refreshCodexSnapshot(); notifyCodex();
        calls.push({ machineId: 'device-1', componentId: 'codex-account', event: 'quota-refreshed', at: Date.now() });
        return true;
    },
}; }
function notifyCodex() { codexListeners.forEach(listener => listener()); }
refreshCodexSnapshot();
export function useCodexAccounts() {
    return useSyncExternalStore(listener => { codexListeners.add(listener); return () => codexListeners.delete(listener); }, () => codexSnapshot, () => codexSnapshot);
}
const listeners = new Set<() => void>();
let fleet = ['MacBook Pro', 'Mac mini', 'Linux 工作站'].map((displayName, i) => ({ id: `device-${i+1}`, active: true, createdAt: 3-i, metadata: { displayName } })) as Machine[];
export const storage = { getState: () => ({ machines: Object.fromEntries(fleet.map(m => [m.id, m])), socketStatus: 'connected' }) };
export const useSocketStatus = () => ({ status: 'connected' });
export const useAllMachines = () => useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => fleet);
const ids: EnvironmentComponentId[] = ['github-cli','paws-cli','ego-browser','cloudflare-wrangler','cloudflared'];
const versions = ['2.80.0','0.14.0','1.2.0','4.30.0','2026.8.0'];
const targets = ['2.81.0','0.15.0','1.2.0','4.32.0','2026.9.0'];
const observations = new Map(fleet.map((m, deviceIndex) => [m.id, ids.map((componentId, i) => ({
    componentId, platform: deviceIndex === 2 ? 'linux' : 'darwin', architecture: 'arm64', support: 'supported', installed: true,
    installedVersion: versions[i], resolvedExecutable: '/fixture/verified/tool', capability: 'alignable', inspectedAt: Date.now(),
    source: { kind: 'npm-global', ownership: 'verified', available: true, latestVersion: targets[i] },
    authentication: { provider: componentId === 'github-cli' ? 'github.com' : 'cloudflare', status: 'authenticated' },
    details: componentId === 'ego-browser' ? { kind: componentId, appVersion: versions[i], paired: true, pathReady: true, chromiumVersion: null, nodeVersion: null }
        : componentId === 'cloudflared' ? { kind: componentId, tunnelCertificatePresent: deviceIndex !== 1 } : { kind: componentId },
} as ComponentObservation))]));
export const calls: {machineId:string; componentId:string; event:string; at:number}[] = [];
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function inspectMachineEnvironment(machineId: string, request: EnvironmentInspectRequest) {
    calls.push({machineId,componentId:request.desired?.componentId ?? '*',event:'inspect',at:Date.now()});
    await delay(request.desired ? 350 : 800);
    const found = observations.get(machineId)!.filter(o => request.componentIds.includes(o.componentId));
    return { observations: structuredClone(found), ...(request.desired ? { plans: [{ componentId: request.desired.componentId, action: 'upgrade', fromVersion: found[0].installedVersion, targetVersion: request.desired.targetVersion, planFingerprint: 'a'.repeat(64), expiresAt: Date.now()+600000 }] } : {}) };
}
let failed = false;
export async function applyMachineEnvironment(machineId: string, request: EnvironmentApplyRequest) {
    const componentId = request.desired.componentId;
    calls.push({machineId,componentId,event:'start',at:Date.now()});
    await delay(1800);
    const row = observations.get(machineId)!;
    const before = structuredClone(row.find(o => o.componentId === componentId)!);
    if (params.get('scenario') === 'uncertain' && machineId === 'device-1' && !failed) { failed=true; calls.push({machineId,componentId,event:'uncertain',at:Date.now()}); throw Error('Fixture transport lost'); }
    if (params.get('scenario') === 'failure' && machineId === 'device-2' && !failed) { failed=true; calls.push({machineId,componentId,event:'failed',at:Date.now()}); return {result:{componentId,status:'failed',before,after:before,changed:false,reasonCode:'install-failed'}}; }
    const after = { ...before, installedVersion: request.desired.targetVersion };
    observations.set(machineId, row.map(o => o.componentId === componentId ? after : o));
    calls.push({machineId,componentId,event:'end',at:Date.now()});
    return { result: { componentId, status: 'succeeded', before, after, changed:true } };
}
export function toggleOffline() { fleet = fleet.map((m,i) => i===2 ? {...m,active:!m.active} : m); listeners.forEach(fn=>fn()); }
(window as any).fixture = { calls, toggleOffline };
