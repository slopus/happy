import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getState: vi.fn(), subscribe: vi.fn(), push: vi.fn(), request: vi.fn(), focus: vi.fn() }));
vi.mock('./storage', () => ({ storage: { getState: mocks.getState, subscribe: mocks.subscribe } }));
vi.mock('expo-router', () => ({ router: { push: mocks.push } }));
vi.mock('@/text', () => ({ getCurrentLanguage: () => 'zh-Hans' }));
vi.mock('@/utils/sessionUtils', () => ({
    getSessionName: (session: { name?: string }) => session.name ?? 'New chat',
}));
let permission: NotificationPermission;
let failConstruction: boolean;
let notifications: { title: string; options: NotificationOptions; onclick?: () => void; close: ReturnType<typeof vi.fn> }[];
let api: typeof import('./webCompletionNotifications.web');
let values: Map<string, string>;

beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    permission = 'granted';
    failConstruction = false;
    notifications = [];
    values = new Map();
    mocks.getState.mockReturnValue({ localSettings: { webCompletionNotificationsEnabled: true, webSound: { enabled: false, volume: 0 } } });
    vi.stubGlobal('window', { isSecureContext: true, focus: mocks.focus });
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
    vi.stubGlobal('Notification', class {
        static get permission() { return permission; }
        static requestPermission = mocks.request;
        close = vi.fn();
        constructor(public title: string, public options: NotificationOptions) {
            if (failConstruction) throw new Error('Unavailable');
            notifications.push(this);
        }
    });
    api = await import('./webCompletionNotifications.web');
});

function transition(before = 'running', after = 'completed', turnId = 'one', id = 'session a') {
    api.startWebCompletionNotifications();
    const onChange = mocks.subscribe.mock.calls[0][0];
    const session = (state: string) => ({ state, name: 'My task', updatedAt: 10, agentState: { turnStatus: { status: state, turnId, updatedAt: 20 } } });
    onChange(
        { isDataReady: true, localSettings: mocks.getState().localSettings, sessions: { [id]: session(after) } },
        { isDataReady: true, sessions: { [id]: session(before) } },
    );
}

describe('browser completion notifications', () => {
    it('notifies in the background independently of sound, and clicks focus and open the session', () => {
        transition();
        expect(notifications).toHaveLength(1);
        expect(notifications[0].title).toBe('Paws · 已完成');
        expect(notifications[0].options.body).toBe('My task');
        notifications[0].onclick?.();
        expect(mocks.focus).toHaveBeenCalledOnce();
        expect(mocks.push).toHaveBeenCalledWith('/session/session%20a');
        expect(notifications[0].close).toHaveBeenCalledOnce();
        expect(mocks.request).not.toHaveBeenCalled();
    });
    it('deduplicates one turn and allows another completed turn', () => {
        transition(); transition(); transition('running', 'completed', 'two');
        expect(notifications).toHaveLength(2);
        expect(new Set(notifications.map((notification) => notification.options.tag)).size).toBe(2);
        expect(mocks.subscribe).toHaveBeenCalledOnce();
    });
    it('does not notify failed, running, or already completed states', () => {
        transition('running', 'failed'); transition('idle', 'running'); transition('completed', 'completed');
        expect(notifications).toHaveLength(0);
    });
    it('does not replay newly hydrated history or run on unrelated updates', () => {
        api.startWebCompletionNotifications();
        const onChange = mocks.subscribe.mock.calls[0][0];
        const next = { isDataReady: true, localSettings: mocks.getState().localSettings, sessions: { a: { state: 'completed' } } };
        onChange(next, { isDataReady: false, sessions: {} });
        onChange(next, { isDataReady: true, sessions: {} });
        onChange(next, next);
        expect(notifications).toHaveLength(0);
    });
    it('never mistakes a disconnect or thinking change for a new durable completion', () => {
        api.startWebCompletionNotifications();
        const onChange = mocks.subscribe.mock.calls[0][0];
        const turn = { status: 'completed', turnId: 'old', updatedAt: 10 };
        const prior = { presence: 'online', thinking: true, agentState: { turnStatus: turn } };
        for (const next of [{ ...prior, presence: 'offline' }, { ...prior, thinking: false }]) {
            onChange({ isDataReady: true, localSettings: mocks.getState().localSettings, sessions: { a: next } },
                { isDataReady: true, sessions: { a: prior } });
        }
        expect(notifications).toHaveLength(0);
    });
    it('notifies a new completed turn even when reconnect skips the running state', () => {
        api.startWebCompletionNotifications();
        const onChange = mocks.subscribe.mock.calls[0][0];
        const completed = (turnId: string, updatedAt: number) => ({ name: 'Task', agentState: { turnStatus: { status: 'completed', turnId, updatedAt } } });
        onChange({ isDataReady: true, localSettings: mocks.getState().localSettings, sessions: { a: completed('new', 20) } },
            { isDataReady: true, sessions: { a: completed('old', 10) } });
        expect(notifications).toHaveLength(1);
    });
    it('does not treat a late outcome hydration onto an idle shell as a fresh completion', () => {
        api.startWebCompletionNotifications();
        const onChange = mocks.subscribe.mock.calls[0][0];
        onChange({ isDataReady: true, localSettings: mocks.getState().localSettings, sessions: { a: { agentState: { turnStatus: { status: 'completed', updatedAt: 10 } } } } },
            { isDataReady: true, sessions: { a: { thinking: false } } });
        expect(notifications).toHaveLength(0);
    });
    it('honors the independent notification setting', () => {
        mocks.getState().localSettings.webCompletionNotificationsEnabled = false;
        transition();
        expect(notifications).toHaveLength(0);
    });
    it.each(['denied', 'default'] as const)('does not prompt or notify with %s permission', (status) => {
        permission = status;
        transition();
        expect(notifications).toHaveLength(0);
        expect(mocks.request).not.toHaveBeenCalled();
    });
    it('requests permission only through the explicit permission action', async () => {
        permission = 'default';
        mocks.request.mockResolvedValue('granted');
        expect(await api.requestBrowserNotificationPermission()).toBe('granted');
        expect(mocks.request).toHaveBeenCalledOnce();
        permission = 'denied';
        expect(await api.requestBrowserNotificationPermission()).toBe('denied');
        expect(mocks.request).toHaveBeenCalledOnce();
    });
    it('handles unsupported, insecure, and throwing browsers', async () => {
        failConstruction = true;
        transition();
        expect(api.previewBrowserNotification()).toBe(false);
        failConstruction = false;
        transition();
        expect(notifications).toHaveLength(1);
        window.isSecureContext = false;
        expect(await api.requestBrowserNotificationPermission()).toBe('insecure');
        vi.stubGlobal('Notification', undefined);
        expect(await api.requestBrowserNotificationPermission()).toBe('unsupported');
    });
    it('suppresses duplicate deliveries across module instances/tabs with Web Locks', async () => {
        let chain = Promise.resolve();
        vi.stubGlobal('navigator', { locks: { request: vi.fn((_name, send) => {
            chain = chain.then(send);
            return chain;
        }) } });
        transition();
        vi.resetModules();
        api = await import('./webCompletionNotifications.web');
        // Rebind the recorded callback to the second instance, sharing localStorage.
        mocks.subscribe.mockClear();
        transition();
        await chain;
        expect(notifications).toHaveLength(1);
    });
    it('rechecks disabled settings while waiting for a cross-tab lock', async () => {
        let send: () => void = () => {};
        vi.stubGlobal('navigator', { locks: { request: vi.fn((_name, callback) => { send = callback; return Promise.resolve(); }) } });
        transition();
        mocks.getState().localSettings.webCompletionNotificationsEnabled = false;
        send();
        expect(notifications).toHaveLength(0);
    });
    it('can send a test notification without enabling task notifications', () => {
        mocks.getState().localSettings.webCompletionNotificationsEnabled = false;
        expect(api.previewBrowserNotification()).toBe(true);
        expect(notifications[0].title).toBe('Paws · 测试通知');
    });
    it('still sends when storage is blocked or malformed', () => {
        values.set('paws:web-completion-notifications', '{broken');
        transition();
        vi.stubGlobal('localStorage', { getItem: () => { throw new Error('Blocked'); }, setItem: () => { throw new Error('Blocked'); } });
        transition('running', 'completed', 'two');
        expect(notifications).toHaveLength(2);
    });
});
