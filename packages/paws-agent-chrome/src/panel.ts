import { PawsAgentClient, type AgentRequest, type Machine, type Message } from '@wangjs-jacky/paws-agent';
import {
    BrowserCredentialProvider,
    startBrowserAccountLink,
} from '@wangjs-jacky/paws-agent/browser';
import QRCode from 'qrcode';
import { createChromeStorage } from './chromeStorage';
import { composePrompt, type PageContext } from './pageContext';

type Phase = 'booting' | 'signedOut' | 'linking' | 'connecting' | 'ready';

type LocalConfig = {
    serverUrl: string;
    machineId: string;
    directory: string;
    sessionId: string;
};

const DEFAULT_SERVER_URL = 'http://47.115.228.20:3005';
const CONFIG_KEY = 'paws-agent.chrome.config';
const storage = createChromeStorage();
const credentials = new BrowserCredentialProvider(storage);
const rootElement = document.querySelector<HTMLElement>('#app');
if (!rootElement) throw new Error('Paws Agent panel root is missing');
const root: HTMLElement = rootElement;

let phase: Phase = 'booting';
let expanded = false;
let config: LocalConfig = {
    serverUrl: DEFAULT_SERVER_URL,
    machineId: '',
    directory: '',
    sessionId: '',
};
let client: PawsAgentClient | null = null;
let unsubscribe: (() => void) | null = null;
let machines: Machine[] = [];
let messages: Message[] = [];
let requests: AgentRequest[] = [];
let pageContext: PageContext | null = null;
let draft = '';
let includeContext = true;
let qrDataUrl = '';
let linkUrl = '';
let busy = false;
let pendingDirectoryApproval = false;
let statusText = '准备连接';
let errorText = '';
let linkController: AbortController | null = null;

window.addEventListener('message', event => {
    if (event.source !== window.parent) return;
    const message = event.data as { type?: unknown; context?: unknown } | null;
    if (message?.type !== 'paws:page-context' || !isPageContext(message.context)) return;
    pageContext = message.context;
    if (expanded) render();
});

window.addEventListener('beforeunload', () => {
    linkController?.abort();
    unsubscribe?.();
    void client?.dispose();
});

void initialize();

async function initialize(): Promise<void> {
    const saved = await storage.get(CONFIG_KEY);
    if (saved) {
        try {
            const parsed = JSON.parse(saved) as Partial<LocalConfig>;
            config = {
                serverUrl: typeof parsed.serverUrl === 'string' ? parsed.serverUrl : DEFAULT_SERVER_URL,
                machineId: typeof parsed.machineId === 'string' ? parsed.machineId : '',
                directory: typeof parsed.directory === 'string' ? parsed.directory : '',
                sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : '',
            };
        } catch {
            await storage.remove(CONFIG_KEY);
        }
    }

    phase = await credentials.getCredentials() ? 'connecting' : 'signedOut';
    render();
    if (phase === 'connecting') await connectClient();
}

function render(): void {
    root.replaceChildren(expanded ? renderPanel() : renderBubble());
}

function renderBubble(): HTMLElement {
    const button = element('button', 'bubble-button');
    button.type = 'button';
    button.setAttribute('aria-label', '打开 Paws Agent');
    button.title = '打开 Paws Agent';
    button.append(element('span', 'bubble-mark', '🐾'), element('span', `bubble-status ${phase === 'ready' ? 'is-ready' : ''}`));
    button.addEventListener('click', () => setExpanded(true));
    return button;
}

function renderPanel(): HTMLElement {
    const shell = element('section', 'panel-shell');
    shell.append(renderHeader());
    const body = element('div', 'panel-body');
    if (errorText) body.append(element('div', 'notice notice-error', errorText));

    if (phase === 'booting' || phase === 'connecting') body.append(renderLoading());
    if (phase === 'signedOut') body.append(renderSignedOut());
    if (phase === 'linking') body.append(renderLinking());
    if (phase === 'ready') body.append(renderConversation());
    shell.append(body);
    return shell;
}

function renderHeader(): HTMLElement {
    const header = element('header', 'panel-header');
    const identity = element('div', 'identity');
    identity.append(element('span', 'identity-mark', '🐾'));
    const labels = element('div');
    labels.append(element('strong', '', 'Paws Agent'), element('span', 'status-label', statusText));
    identity.append(labels);
    const close = element('button', 'icon-button', '×');
    close.type = 'button';
    close.setAttribute('aria-label', '收起 Paws Agent');
    close.addEventListener('click', () => setExpanded(false));
    header.append(identity, close);
    return header;
}

function renderLoading(): HTMLElement {
    const section = element('section', 'center-state');
    section.append(element('span', 'spinner'), element('strong', '', phase === 'booting' ? '正在准备' : '正在连接远端会话'), element('p', '', '连接建立后，会话会同步显示在现有 Paws 客户端中。'));
    return section;
}

function renderSignedOut(): HTMLElement {
    const section = element('section', 'setup-card');
    section.append(element('span', 'eyebrow', '设备绑定'), element('h1', '', '把这个浏览器连接到 Paws'), element('p', 'muted', '二维码只用于绑定当前扩展；账号密钥保存在浏览器扩展存储中，不会暴露给网页。'));
    const label = element('label', 'field');
    label.append(element('span', '', 'Server URL'));
    const input = element('input') as HTMLInputElement;
    input.type = 'url';
    input.value = config.serverUrl;
    input.placeholder = DEFAULT_SERVER_URL;
    input.addEventListener('input', () => { config.serverUrl = input.value; });
    label.append(input);
    const button = primaryButton('生成绑定二维码', () => void beginLink());
    button.disabled = busy;
    section.append(label, button);
    return section;
}

function renderLinking(): HTMLElement {
    const section = element('section', 'setup-card linking-card');
    section.append(
        element('span', 'eyebrow', qrDataUrl ? '等待手机确认' : '正在准备'),
        element('h1', '', qrDataUrl ? '扫描二维码连接' : '正在生成绑定二维码'),
    );
    if (qrDataUrl) {
        const image = document.createElement('img');
        image.className = 'qr-code';
        image.src = qrDataUrl;
        image.alt = 'Paws 设备绑定二维码';
        section.append(image);
    }
    section.append(element('p', 'muted', qrDataUrl ? '在 Paws 客户端中进入“设置 → 账号 → 连接新设备”，扫码后本页会自动继续。' : '正在向 Paws 服务申请一次性绑定码，你可以随时取消。'));
    if (linkUrl) {
        const open = document.createElement('a');
        open.className = 'text-link';
        open.href = linkUrl;
        open.textContent = '在已安装 Paws 的设备上打开';
        section.append(open);
    }
    const cancel = secondaryButton('取消', () => cancelLink());
    section.append(cancel);
    return section;
}

function renderConversation(): HTMLElement {
    const container = element('div', 'conversation');
    container.append(renderTargetPicker(), renderMessages());
    if (requests.length > 0) container.append(renderRequests());
    if (pendingDirectoryApproval) {
        const approval = element('div', 'notice notice-warning');
        approval.append(element('span', '', `远端目录不存在：${config.directory}`), primaryButton('允许创建并继续', () => void sendDraft(true)));
        container.append(approval);
    }
    container.append(renderComposer());
    return container;
}

function renderTargetPicker(): HTMLElement {
    const section = element('section', 'target-card');
    const row = element('div', 'target-row');
    const machine = document.createElement('select');
    machine.setAttribute('aria-label', '远端机器');
    if (machines.length === 0) machine.append(new Option('没有在线机器', ''));
    for (const item of machines) machine.append(new Option(machineLabel(item), item.id));
    machine.value = config.machineId;
    machine.addEventListener('change', () => { config.machineId = machine.value; void saveConfig(); });
    const reset = secondaryButton('新会话', () => void resetSession());
    row.append(machine, reset);

    const directory = document.createElement('input');
    directory.type = 'text';
    directory.setAttribute('aria-label', '远端工作目录');
    directory.placeholder = '/Users/you/project';
    directory.value = config.directory;
    directory.addEventListener('change', () => { config.directory = directory.value.trim(); void saveConfig(); });
    section.append(row, directory);
    return section;
}

function renderMessages(): HTMLElement {
    const list = element('section', 'message-list');
    list.setAttribute('aria-label', '会话消息');
    if (messages.length === 0) {
        const empty = element('div', 'empty-state');
        empty.append(element('strong', '', '从当前网页开始一条远端会话'), element('p', '', pageContext?.selection ? '已捕获选中内容，发送时可以一并带给 Agent。' : '你可以直接提问，也可以先在网页中选中一段内容。'));
        list.append(empty);
    } else {
        for (const message of messages) {
            const item = element('article', 'message');
            item.append(element('p', '', messageText(message.content)));
            list.append(item);
        }
    }
    queueMicrotask(() => { list.scrollTop = list.scrollHeight; });
    return list;
}

function renderRequests(): HTMLElement {
    const section = element('section', 'request-list');
    section.setAttribute('aria-label', '待审批的 Agent 请求');
    for (const request of requests) {
        const card = element('article', 'request-card');
        card.append(
            element('strong', '', `Agent 请求：${request.type}`),
            element('pre', 'request-payload', requestPayloadText(request.payload)),
            element('p', 'request-boundary', '为防止网页点击劫持，请在 Paws 自有客户端中审批。此悬浮球不会执行审批操作。'),
        );
        section.append(card);
    }
    return section;
}

function renderComposer(): HTMLElement {
    const form = element('form', 'composer') as HTMLFormElement;
    const textarea = document.createElement('textarea');
    const send = primaryButton(busy ? '发送中…' : '发送', () => undefined);
    send.type = 'submit';
    send.disabled = busy || !draft.trim();
    textarea.placeholder = '告诉远端 Agent 你想做什么…';
    textarea.value = draft;
    textarea.rows = 3;
    textarea.addEventListener('input', () => {
        draft = textarea.value;
        send.disabled = busy || !draft.trim();
    });
    textarea.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            form.requestSubmit();
        }
    });
    const footer = element('div', 'composer-footer');
    const contextLabel = element('label', 'context-toggle');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = includeContext;
    checkbox.addEventListener('change', () => { includeContext = checkbox.checked; });
    contextLabel.append(checkbox, element('span', '', pageContext?.selection ? '带上选中内容' : '带上当前网页'));
    footer.append(contextLabel, send);
    form.append(textarea, footer);
    form.addEventListener('submit', event => { event.preventDefault(); void sendDraft(false); });
    return form;
}

async function beginLink(): Promise<void> {
    if (!config.serverUrl.trim()) return;
    busy = true;
    errorText = '';
    await saveConfig();
    linkController?.abort();
    const controller = new AbortController();
    linkController = controller;
    try {
        qrDataUrl = '';
        linkUrl = '';
        phase = 'linking';
        statusText = '正在生成绑定码';
        busy = false;
        render();
        const link = await startBrowserAccountLink({
            serverUrl: config.serverUrl,
            credentials,
            signal: controller.signal,
        });
        linkUrl = link.qrUrl;
        qrDataUrl = await QRCode.toDataURL(link.qrUrl, { width: 220, margin: 1, color: { dark: '#1c1917', light: '#fffaf2' } });
        phase = 'linking';
        statusText = '等待扫码';
        busy = false;
        render();
        await link.waitForAuthorization({ signal: controller.signal });
        if (linkController === controller) linkController = null;
        phase = 'connecting';
        statusText = '正在连接';
        render();
        await connectClient();
    } catch (cause) {
        if (controller.signal.aborted) return;
        busy = false;
        phase = 'signedOut';
        errorText = errorMessage(cause);
        statusText = '连接失败';
        render();
    }
}

function cancelLink(): void {
    linkController?.abort(new Error('Account linking cancelled'));
    linkController = null;
    phase = 'signedOut';
    statusText = '未连接';
    busy = false;
    render();
}

async function connectClient(): Promise<void> {
    try {
        unsubscribe?.();
        await client?.dispose();
        client = new PawsAgentClient({ serverUrl: config.serverUrl, credentials, storage });
        unsubscribe = client.subscribe(event => {
            if (event.type === 'connection') {
                statusText = event.state === 'ready' ? '已连接' : event.state === 'reconnecting' ? '正在重连' : '连接中';
                render();
            }
            if (event.type === 'message' && event.sessionId === config.sessionId) {
                if (!messages.some(item => item.id === event.message.id)) messages.push(event.message);
                render();
            }
            if (event.type === 'request' && event.sessionId === config.sessionId) {
                requests = [...requests.filter(item => item.id !== event.request.id), event.request];
                render();
            }
            if (event.type === 'error') {
                errorText = event.error.message;
                render();
            }
        });
        await client.connect();
        machines = await client.machines.list({ active: true });
        if (!machines.some(item => item.id === config.machineId)) config.machineId = machines[0]?.id ?? '';
        if (config.sessionId) messages = await client.messages.history(config.sessionId, { limit: 50 });
        await saveConfig();
        phase = 'ready';
        statusText = '已连接';
        errorText = '';
        render();
    } catch (cause) {
        phase = 'signedOut';
        statusText = '需要重新连接';
        errorText = errorMessage(cause);
        render();
    }
}

async function sendDraft(approvedNewDirectoryCreation: boolean): Promise<void> {
    if (!client || busy || !draft.trim() || !config.machineId || !config.directory.trim()) {
        if (!config.machineId) errorText = '没有可用的在线机器。';
        else if (!config.directory.trim()) errorText = '请先填写远端工作目录。';
        render();
        return;
    }
    busy = true;
    errorText = '';
    pendingDirectoryApproval = false;
    render();
    try {
        if (!config.sessionId) {
            const result = await client.sessions.spawn({
                machineId: config.machineId,
                directory: config.directory.trim(),
                approvedNewDirectoryCreation,
                agent: 'codex',
            });
            if (result.type === 'requestToApproveDirectoryCreation') {
                pendingDirectoryApproval = true;
                busy = false;
                render();
                return;
            }
            if (result.type === 'error') throw new Error(result.errorMessage);
            config.sessionId = result.sessionId;
            await saveConfig();
        }
        await client.messages.send({
            sessionId: config.sessionId,
            text: composePrompt(draft, pageContext, includeContext),
            meta: pageContext ? { source: 'paws-agent-chrome', pageUrl: pageContext.url } : { source: 'paws-agent-chrome' },
        });
        draft = '';
        messages = await client.messages.history(config.sessionId, { limit: 50 });
        busy = false;
        render();
    } catch (cause) {
        busy = false;
        errorText = errorMessage(cause);
        render();
    }
}

async function resetSession(): Promise<void> {
    config.sessionId = '';
    messages = [];
    requests = [];
    pendingDirectoryApproval = false;
    await saveConfig();
    render();
}

function setExpanded(value: boolean): void {
    expanded = value;
    window.parent.postMessage({ type: 'paws:bubble:resize', expanded }, '*');
    if (expanded) window.parent.postMessage({ type: 'paws:bubble:request-context' }, '*');
    render();
}

function saveConfig(): Promise<void> {
    return storage.set(CONFIG_KEY, JSON.stringify(config));
}

function isPageContext(value: unknown): value is PageContext {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<PageContext>;
    return typeof candidate.title === 'string' && typeof candidate.url === 'string' && typeof candidate.selection === 'string';
}

function machineLabel(machine: Machine): string {
    const metadata = machine.metadata as Record<string, unknown> | null;
    for (const key of ['displayName', 'name', 'hostname']) {
        if (typeof metadata?.[key] === 'string' && metadata[key]) return String(metadata[key]);
    }
    return `机器 ${machine.id.slice(0, 8)}`;
}

function messageText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(messageText).filter(Boolean).join('\n');
    if (content && typeof content === 'object') {
        const value = content as Record<string, unknown>;
        for (const key of ['text', 'message', 'content', 'data']) {
            if (key in value) {
                const result = messageText(value[key]);
                if (result) return result;
            }
        }
        try { return JSON.stringify(content, null, 2); } catch { return '收到一条新消息'; }
    }
    return content == null ? '' : String(content);
}

function requestPayloadText(payload: unknown): string {
    if (typeof payload === 'string') return payload;
    try { return JSON.stringify(payload, null, 2); } catch { return String(payload); }
}

function errorMessage(cause: unknown): string {
    return cause instanceof Error ? cause.message : '发生了未知错误，请重试。';
}

function primaryButton(label: string, handler: () => void): HTMLButtonElement {
    const button = element('button', 'button button-primary', label) as HTMLButtonElement;
    button.type = 'button';
    button.addEventListener('click', handler);
    return button;
}

function secondaryButton(label: string, handler: () => void): HTMLButtonElement {
    const button = element('button', 'button button-secondary', label) as HTMLButtonElement;
    button.type = 'button';
    button.addEventListener('click', handler);
    return button;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}
