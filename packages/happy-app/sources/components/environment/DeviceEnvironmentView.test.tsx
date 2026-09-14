import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error renderer harness has no separate typings
import TestRenderer from 'react-test-renderer';
import type { ComponentObservation } from '@slopus/happy-wire';
import { FLEET_COMPONENT_IDS } from '@/environment/fleetModel';
import type { EnvironmentDashboardController } from '@/hooks/useEnvironmentDashboard';
import type { EnvironmentRow } from '@/environment/environmentDashboard';
import { describeEnvironmentCell } from '@/environment/environmentDashboard';

const mocks = vi.hoisted(() => ({ confirm: vi.fn(), hook: vi.fn(), width: 1365,
    accounts: { profiles: [], bindings: ['a', 'b', 'c'].map(machineId => ({ machineId, profileId: null, version: 1 })), migration: 'none', loading: false, busy: false, error: null, rename: vi.fn(), remove: vi.fn(), bind: vi.fn() } }));
vi.mock('@/hooks/useCodexAccounts', () => ({ useCodexAccounts: () => mocks.accounts }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('react-native', () => ({ View: 'View', Text: 'Text', Pressable: 'Pressable', ScrollView: 'ScrollView', ActivityIndicator: 'ActivityIndicator',
    Platform: { OS: 'web', select: (options: any) => options.web ?? options.default }, useWindowDimensions: () => ({ width: mocks.width, height: 768 }) }));
vi.mock('react-native-unistyles', async () => { const { appThemes } = await import('@/themePacks'); return {
    StyleSheet: { hairlineWidth: 1, create: (factory: any) => factory(appThemes.ginghamDark) }, useUnistyles: () => ({ theme: appThemes.ginghamDark }),
}; });
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}), mono: () => ({}) } }));
vi.mock('@/components/layout', () => ({ layout: { maxWidth: 800 } }));
vi.mock('@/hooks/useEnvironmentDashboard', () => ({ useEnvironmentDashboard: mocks.hook }));
vi.mock('@/hooks/useHappyAction', () => ({ useHappyAction: (action: unknown) => [false, action] }));
vi.mock('@/modal', () => ({ Modal: { confirm: mocks.confirm } }));
vi.mock('@/text', async () => { const { en } = await import('@/text/_default'); return { t: (key: string, params: unknown) => {
    const value = key.split('.').reduce((v: any, part) => v?.[part], en); return typeof value === 'function' ? value(params) : value ?? key;
} }; });
import { DeviceEnvironmentView } from './DeviceEnvironmentView';

function row(id: string, active = true): EnvironmentRow {
    return { machine: { id, active, metadata: { displayName: id } } as any,
        cells: Object.fromEntries(FLEET_COMPONENT_IDS.map(componentId => [componentId, { componentId, phase: 'idle', observation: {
            componentId, installed: true, installedVersion: '1.0.0', support: 'supported', capability: 'alignable', platform: 'darwin', architecture: 'arm64',
            resolvedExecutable: '/verified/tool', inspectedAt: 1, source: { kind: 'npm-global', latestVersion: '1.1.0', ownership: 'verified', available: true },
            authentication: { provider: 'cloudflare', status: 'authenticated' },
            details: componentId === 'ego-browser' ? { kind: componentId, appVersion: '1.0.0', paired: true, pathReady: true, chromiumVersion: null, nodeVersion: null }
                : componentId === 'cloudflared' ? { kind: componentId, tunnelCertificatePresent: true } : { kind: componentId },
        } as ComponentObservation }])) as EnvironmentRow['cells'] };
}
function controller(rows = [row('a'), row('b'), row('c', false)]): EnvironmentDashboardController {
    return { rows, scanning: false, running: false, scan: vi.fn(), update: vi.fn(), runSingle: vi.fn(), confirmStopped: vi.fn(),
        getCandidates: (scope = {}) => rows.filter(row => row.machine.active && (!scope.machineId || scope.machineId === row.machine.id))
            .flatMap(row => FLEET_COMPONENT_IDS.filter(id => (!scope.componentId || scope.componentId === id) && describeEnvironmentCell(row.cells[id]).action === 'upgrade')
                .map(componentId => ({ machineId: row.machine.id, componentId }))),
    };
}
const textOf = (node: any): string => typeof node === 'string' ? node : (node.children ?? []).map(textOf).join(' ');
describe('DeviceEnvironment matrix', () => {
    let renderer: any;
    beforeEach(() => { vi.clearAllMocks(); mocks.width = 1365; (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 0; }; });
    afterEach(() => act(() => renderer?.unmount()));
    function render(c: EnvironmentDashboardController) { act(() => { renderer = TestRenderer.create(<DeviceEnvironmentView controller={c} />); }); }
    async function press(id: string) { await act(async () => { await renderer.root.findByProps({ testID: id }).props.onPress(); }); }
    it('shows three device columns, five tool rows, persistent scan, and no preview flow', () => {
        render(controller());
        for (const id of ['a', 'b', 'c']) expect(renderer.root.findByProps({ testID: `environment-device-${id}` })).toBeDefined();
        for (const id of FLEET_COMPONENT_IDS) expect(renderer.root.findByProps({ testID: `environment-tool-${id}` })).toBeDefined();
        expect(renderer.root.findByProps({ testID: 'environment-scan-all' })).toBeDefined();
        expect(renderer.root.findAllByProps({ testID: 'environment-preview-alignment' })).toHaveLength(0);
        expect(textOf(renderer.toJSON())).not.toContain('Development environment health');
    });
    it('dispatches exactly the single, tool and all scopes without a preview or confirmation', async () => {
        const c = controller(); render(c);
        await press('environment-action-b-github-cli'); expect(c.update).toHaveBeenLastCalledWith({ machineId: 'b', componentId: 'github-cli' });
        await press('environment-update-type-github-cli'); expect(c.update).toHaveBeenLastCalledWith({ componentId: 'github-cli' });
        await press('environment-update-all'); expect(c.update).toHaveBeenLastCalledWith({});
        expect(mocks.confirm).not.toHaveBeenCalled();
    });
    it('keeps scan visible and disables duplicate changes while running', () => {
        const c = controller(); c.running = true; render(c);
        expect(renderer.root.findByProps({ testID: 'environment-scan-all' }).props.disabled).toBe(true);
        expect(renderer.root.findByProps({ testID: 'environment-update-all' }).props.disabled).toBe(true);
        expect(renderer.root.findByProps({ testID: 'environment-action-a-github-cli' }).props.disabled).toBe(true);
    });
    it('preserves offline versions without an update action', () => {
        render(controller());
        const cell = renderer.root.findByProps({ testID: 'environment-component-c-github-cli' });
        expect(textOf(cell)).toContain('1.0.0'); expect(textOf(cell)).toContain('Offline');
        expect(renderer.root.findAllByProps({ testID: 'environment-action-c-github-cli' })).toHaveLength(0);
    });
    it('requires explicit confirmation for a separate Cloudflare login', async () => {
        const c = controller(); const o = c.rows[0].cells['cloudflare-wrangler'].observation!;
        o.installedVersion = '1.1.0'; o.authentication!.status = 'missing'; mocks.confirm.mockResolvedValue(true); render(c);
        await press('environment-action-a-cloudflare-wrangler');
        expect(mocks.confirm).toHaveBeenCalledOnce(); expect(c.runSingle).toHaveBeenCalledWith('a', 'cloudflare-wrangler');
        expect(c.update).not.toHaveBeenCalled();
    });
    it('does not execute setup after the inspected cell changed while confirming', async () => {
        const c = controller(); const o = c.rows[0].cells['cloudflare-wrangler'].observation!;
        o.installedVersion = '1.1.0'; o.authentication!.status = 'missing';
        mocks.confirm.mockImplementation(async () => { c.rows[0].cells['cloudflare-wrangler'] = { ...c.rows[0].cells['cloudflare-wrangler'] }; return true; });
        render(c); await press('environment-action-a-cloudflare-wrangler'); expect(c.runSingle).not.toHaveBeenCalled();
    });
    it('shows component-specific Ego instructions rather than a global Homebrew banner', async () => {
        const c = controller(); const o = c.rows[0].cells['ego-browser'].observation!;
        if (o.details.kind !== 'ego-browser') throw Error('fixture'); o.details.pathReady = false; render(c);
        await press('environment-action-a-ego-browser');
        expect(textOf(renderer.root.findByProps({ testID: 'environment-details' }))).toContain('Add ~/.local/bin to PATH');
        expect(textOf(renderer.root.findByProps({ testID: 'environment-details' }))).not.toContain('Homebrew');
    });
    it('retains tool identities outside the horizontally scrollable device columns', () => {
        mocks.width = 390; render(controller());
        const columns = renderer.root.findByProps({ testID: 'environment-device-columns' });
        expect(columns.props.horizontal).toBe(true); expect(columns.findAllByProps({ testID: 'environment-tool-github-cli' })).toHaveLength(0);
    });
    it('lets a narrow screen identify and focus every device without relying on an undiscoverable swipe', async () => {
        mocks.width = 390; render(controller());
        const picker = renderer.root.findByProps({ testID: 'environment-device-picker' });
        expect(textOf(picker)).toContain('a'); expect(textOf(picker)).toContain('b'); expect(textOf(picker)).toContain('c');
        const b = renderer.root.findByProps({ testID: 'environment-device-picker-b' });
        expect(b.props.accessibilityState.selected).toBe(false);
        await act(async () => { b.props.onPress(); });
        expect(renderer.root.findByProps({ testID: 'environment-device-picker-b' }).props.accessibilityState.selected).toBe(true);
    });
    it('places account cards above the matrix and aligns the default account cells inside each device column', () => {
        mocks.width = 390; render(controller());
        const scroller = renderer.root.findAllByType('ScrollView').find((node: any) => !node.props.horizontal);
        expect(scroller.children[0].findByProps({ testID: 'codex-account-section' })).toBeDefined();
        const columns = renderer.root.findByProps({ testID: 'environment-device-columns' });
        for (const id of ['a', 'b', 'c']) {
            const cell = columns.findByProps({ testID: `codex-binding-cell-${id}` });
            const widthOf = (node: any) => Object.assign({}, ...node.props.style).width;
            expect(widthOf(cell)).toBe(widthOf(columns.findByProps({ testID: `environment-device-${id}` })));
        }
        expect(columns.findAllByProps({ testID: 'environment-codex-account-label' })).toHaveLength(0);
        expect(renderer.root.findByProps({ testID: 'codex-binding-c' }).props.disabled).toBe(false);
        expect(mocks.accounts.bind).not.toHaveBeenCalled();
    });
    it('uses the non-default theme for selected and interactive surfaces', async () => {
        const { appThemes } = await import('@/themePacks'); render(controller());
        const button = renderer.root.findByProps({ testID: 'environment-update-all' }).findByType('Pressable');
        const style = Object.assign({}, ...button.props.style({ pressed: true }));
        expect(style.backgroundColor).toBe(appThemes.ginghamDark.colors.button.primary.background);
    });
    it('does not claim an empty fleet is healthy', () => {
        render(controller([])); expect(renderer.root.findByProps({ testID: 'environment-update-all' }).props.disabled).toBe(true);
        expect(textOf(renderer.toJSON())).toContain('No machines');
        expect(textOf(renderer.toJSON())).not.toContain('All tools are up to date');
    });
    it('does not summarize a failed inspection as no available updates', () => {
        const c = controller([row('a')]);
        for (const cell of Object.values(c.rows[0].cells)) cell.phase = 'unknown';
        render(c);
        const footer = textOf(renderer.root.findByProps({ testID: 'environment-footer' }));
        expect(footer).not.toContain('No updates available');
        expect(footer).toMatch(/unverified|incompleteSummary/);
        expect(footer.match(/unverified/g)).toHaveLength(1);
        expect(renderer.root.findByProps({ testID: 'environment-update-all' }).props.disabled).toBe(true);
    });
    it('never claims no updates while the fleet is still being inspected', () => {
        const c = controller([row('a')]); c.scanning = true;
        render(c);
        const footer = textOf(renderer.root.findByProps({ testID: 'environment-footer' }));
        expect(footer).toContain('Checking');
        expect(footer).not.toContain('updates available across');
    });
    it('distinguishes an offline-only fleet from a fully inspected fleet', () => {
        render(controller([row('a', false)]));
        const footer = textOf(renderer.root.findByProps({ testID: 'environment-footer' }));
        expect(footer).toMatch(/No devices are online|noOnline/);
    });
    it('keeps cached versions visible but disables all mutations without a server connection', () => {
        const c = controller(); c.connectionReady = false; render(c);
        expect(textOf(renderer.toJSON())).toContain('Waiting for connection');
        expect(textOf(renderer.toJSON())).not.toContain('Online');
        expect(textOf(renderer.toJSON())).not.toContain('Up to date');
        expect(textOf(renderer.toJSON())).toContain('Previous inspection result');
        expect(textOf(renderer.root.findByProps({ testID: 'environment-summary' }))).toContain('disconnected');
        expect(textOf(renderer.root.findByProps({ testID: 'environment-component-a-github-cli' }))).toContain('1.0.0');
        for (const id of ['environment-scan-all', 'environment-update-all', 'environment-action-a-github-cli'])
            expect(renderer.root.findByProps({ testID: id }).props.disabled).toBe(true);
    });
    it('does not show a successful result when verification is uncertain', async () => {
        const c = controller(); const cell = c.rows[0].cells['github-cli'];
        cell.phase = 'uncertain';
        cell.result = { componentId: 'github-cli', status: 'succeeded', before: cell.observation!, after: cell.observation!, changed: true };
        render(c);
        await act(async () => { renderer.root.findByProps({ testID: 'environment-component-a-github-cli' }).findAllByType('Pressable')[0].props.onPress(); });
        expect(textOf(renderer.root.findByProps({ testID: 'environment-details' }))).not.toContain('Completed');
    });
    it('disables every machine action while a remote result is unresolved', () => {
        const c = controller(); c.rows[0].unresolved = true; render(c);
        expect(renderer.root.findByProps({ testID: 'environment-action-a-paws-cli' }).props.disabled).toBe(true);
    });
    it('requires explicit confirmation to release an unresolved device and never retries directly', async () => {
        const c = controller(); c.rows[0].unresolved = true; render(c);
        mocks.confirm.mockResolvedValue(false); await press('environment-confirm-stopped-a');
        expect(c.confirmStopped).not.toHaveBeenCalled();
        mocks.confirm.mockResolvedValue(true); await press('environment-confirm-stopped-a');
        expect(c.confirmStopped).toHaveBeenCalledWith('a');
        expect(c.update).not.toHaveBeenCalled(); expect(c.runSingle).not.toHaveBeenCalled();
    });
});
