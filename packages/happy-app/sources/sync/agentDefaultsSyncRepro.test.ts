import { describe, it, expect } from 'vitest';
import {
    applySettings,
    settingsParse,
    settingsToSyncPayload,
    settingsDefaults,
    type Settings,
} from './settings';
import { isEmptyAgentDefaultOverrides } from './agentDefaults';

// High-fidelity offline reproduction of the FULL settings-sync lifecycle for
// agentDefaultOverrides across app restarts. Transcribes the real algorithms:
//   - sync.ts syncSettings()        (POST-with-version-check loop + trailing GET)
//   - sync.ts applyServerSettings() (re-layer pending over server copy)
//   - storage.ts applySettings()    (version guard: only apply if strictly newer)
//   - persistence.ts saveSettings() (settingsToSyncPayload before MMKV write)
//   - happy-server accountRoutes    (optimistic-concurrency store of opaque blob)
// using the REAL settings helpers. Encryption is identity (server stores the
// JSON string verbatim, exactly as the opaque z.string() blob it really is).

// ---- Fake server (mirrors happy-server accountRoutes verbatim) -------------
class FakeServer {
    settings: string | null = null;
    settingsVersion = 0;

    get() {
        return { settings: this.settings, settingsVersion: this.settingsVersion };
    }
    post(body: { settings: string | null; expectedVersion: number }) {
        if (this.settingsVersion !== body.expectedVersion) {
            return {
                success: false as const,
                error: 'version-mismatch' as const,
                currentVersion: this.settingsVersion,
                currentSettings: this.settings,
            };
        }
        this.settings = body.settings;
        this.settingsVersion = body.expectedVersion + 1;
        return { success: true as const, version: this.settingsVersion };
    }
}

// ---- Fake MMKV (mirrors persistence.ts) ------------------------------------
class FakeMMKV {
    store = new Map<string, string>();
    saveSettings(settings: Settings, version: number) {
        this.store.set('settings', JSON.stringify({ settings: settingsToSyncPayload(settings), version }));
    }
    loadSettings(): { settings: Settings; version: number | null } {
        const raw = this.store.get('settings');
        if (!raw) return { settings: { ...settingsDefaults }, version: null };
        const parsed = JSON.parse(raw);
        return { settings: settingsParse(parsed.settings), version: parsed.version };
    }
    savePending(p: Partial<Settings>) { this.store.set('pending', JSON.stringify(p)); }
    loadPending(): Partial<Settings> {
        const raw = this.store.get('pending');
        return raw ? JSON.parse(raw) : {};
    }
}

// ---- Client (mirrors storage.ts state + sync.ts orchestration) -------------
class Client {
    settings: Settings;
    settingsVersion: number | null;
    pending: Partial<Settings>;

    constructor(private mmkv: FakeMMKV, private server: FakeServer) {
        const loaded = mmkv.loadSettings();
        this.settings = loaded.settings;
        this.settingsVersion = loaded.version;
        this.pending = mmkv.loadPending();
    }

    // storage.ts applySettings (version guard)
    private storageApplyServer(settings: Settings, version: number) {
        if (this.settingsVersion === null || this.settingsVersion < version) {
            this.mmkv.saveSettings(settings, version);
            this.settings = settings;
            this.settingsVersion = version;
        }
    }
    // storage.ts applySettingsLocal (optimistic local write, no version bump)
    private storageApplyLocal(delta: Partial<Settings>) {
        this.mmkv.saveSettings(applySettings(this.settings, delta), this.settingsVersion ?? 0);
        this.settings = applySettings(this.settings, delta);
    }
    // sync.ts applyServerSettings (incl. the empty-override clobber guard)
    private applyServerSettings(serverSettings: Settings, version: number) {
        let merged = Object.keys(this.pending).length > 0
            ? applySettings(serverSettings, this.pending)
            : serverSettings;
        const localOverrides = this.settings.agentDefaultOverrides;
        if (isEmptyAgentDefaultOverrides(merged.agentDefaultOverrides) && !isEmptyAgentDefaultOverrides(localOverrides)) {
            merged = { ...merged, agentDefaultOverrides: localOverrides };
        }
        this.storageApplyServer(merged, version);
    }

    // Mirrors the socket 'update-account' path: applies a server settings
    // snapshot directly, bypassing the POST loop.
    receiveAccountUpdate(snapshot: Partial<Settings>, version: number) {
        const parsed = settingsParse(snapshot);
        this.applyServerSettings(parsed, version);
    }

    // sync.ts applySettings (user edits a setting)
    setSetting(delta: Partial<Settings>) {
        this.storageApplyLocal(delta);
        this.pending = { ...this.pending, ...delta };
        this.mmkv.savePending(this.pending);
        this.syncSettings();
    }

    // sync.ts syncSettings (verbatim transcription)
    syncSettings() {
        const maxRetries = 3;
        let retryCount = 0;

        if (Object.keys(this.pending).length > 0) {
            while (retryCount < maxRetries) {
                const sentPending = { ...this.pending };
                const version = this.settingsVersion;
                const settings = applySettings(this.settings, this.pending);
                const data = this.server.post({
                    settings: JSON.stringify(settingsToSyncPayload(settings)),
                    expectedVersion: version ?? 0,
                });
                if (data.success) {
                    const newPending: Partial<Settings> = {};
                    for (const key of Object.keys(this.pending) as (keyof Settings)[]) {
                        if (!(key in sentPending) || this.pending[key] !== sentPending[key]) {
                            (newPending as any)[key] = this.pending[key];
                        }
                    }
                    this.pending = newPending;
                    this.mmkv.savePending(this.pending);
                    break;
                }
                if (data.error === 'version-mismatch') {
                    const serverSettings = data.currentSettings
                        ? settingsParse(JSON.parse(data.currentSettings))
                        : { ...settingsDefaults };
                    const mergedSettings = applySettings(serverSettings, this.pending);
                    this.applyServerSettings(mergedSettings, data.currentVersion);
                    retryCount++;
                    continue;
                }
            }
        }
        if (retryCount >= maxRetries) throw new Error('exhausted');

        // trailing GET
        const data = this.server.get();
        const parsedSettings: Settings = data.settings
            ? settingsParse(JSON.parse(data.settings))
            : { ...settingsDefaults };
        this.applyServerSettings(parsedSettings, data.settingsVersion);
    }
}

const OVERRIDE: Partial<Settings> = {
    agentDefaultOverrides: { claude: { modelMode: 'sonnet' } },
};

function restart(mmkv: FakeMMKV, server: FakeServer): Client {
    const c = new Client(mmkv, server);
    c.syncSettings(); // boot-time settingsSync.invalidate()
    return c;
}

describe('agent defaults sync lifecycle (full fidelity)', () => {
    it('survives a clean set then restart', () => {
        const mmkv = new FakeMMKV();
        const server = new FakeServer();
        // initial boot, no settings yet
        let c = restart(mmkv, server);
        c.setSetting(OVERRIDE);
        expect(c.settings.agentDefaultOverrides).toEqual({ claude: { modelMode: 'sonnet' } });
        // restart
        c = restart(mmkv, server);
        expect(c.settings.agentDefaultOverrides).toEqual({ claude: { modelMode: 'sonnet' } });
    });

    it('survives set then MULTIPLE restarts', () => {
        const mmkv = new FakeMMKV();
        const server = new FakeServer();
        let c = restart(mmkv, server);
        c.setSetting(OVERRIDE);
        for (let i = 0; i < 5; i++) {
            c = restart(mmkv, server);
        }
        expect(c.settings.agentDefaultOverrides).toEqual({ claude: { modelMode: 'sonnet' } });
    });

    it('survives when another (non-override) setting is changed after, then restart', () => {
        const mmkv = new FakeMMKV();
        const server = new FakeServer();
        let c = restart(mmkv, server);
        c.setSetting(OVERRIDE);
        c.setSetting({ viewInline: true }); // unrelated later edit -> POSTs full payload
        c = restart(mmkv, server);
        expect(c.settings.agentDefaultOverrides).toEqual({ claude: { modelMode: 'sonnet' } });
        expect(c.settings.viewInline).toBe(true);
    });

    // The reported bug: whatever the (runtime-only) trigger, the field reverts
    // to EMPTY. These reproduce that final state — an empty server override
    // arriving at a higher version while local holds a non-empty one — and
    // assert the guard keeps the local value (loss-proof, mechanism-independent).
    it('GUARD: an empty server snapshot at a higher version does NOT erase a non-empty local override', () => {
        const mmkv = new FakeMMKV();
        const server = new FakeServer();
        let c = restart(mmkv, server);
        c.setSetting(OVERRIDE);
        // Simulate the clobber: a server settings snapshot with NO override at a
        // newer version (e.g. a socket update-account, or a stale trailing GET).
        c.receiveAccountUpdate({ ...settingsDefaults, viewInline: true }, 999);
        expect(c.settings.agentDefaultOverrides).toEqual({ claude: { modelMode: 'sonnet' } });
        // ...and it survives the subsequent restart.
        c = restart(mmkv, server);
        expect(c.settings.agentDefaultOverrides).toEqual({ claude: { modelMode: 'sonnet' } });
    });

    it('survives when server is already ahead (forces version-mismatch on the override POST)', () => {
        const mmkv = new FakeMMKV();
        const server = new FakeServer();
        // Simulate the account already having a higher server version with NO override
        // (e.g. earlier writes from this same device that local lost track of).
        server.settings = JSON.stringify(settingsToSyncPayload({ ...settingsDefaults, viewInline: true }));
        server.settingsVersion = 7;
        let c = restart(mmkv, server); // local catches up to v7
        c.setSetting(OVERRIDE);
        c = restart(mmkv, server);
        expect(c.settings.agentDefaultOverrides).toEqual({ claude: { modelMode: 'sonnet' } });
    });
});
