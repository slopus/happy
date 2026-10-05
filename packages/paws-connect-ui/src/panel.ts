import QRCode from 'qrcode';
import { AIServiceClientError, type BindingOverrides, type ClientErrorCode, type ServiceController, type ServiceControllerState, type ServiceSource } from '@wangjs-jacky/paws-agent/services/browser';

export interface ServicePanelAppearance {
    title?: string;
    theme?: 'auto' | 'light' | 'dark';
    /** Supply only sources for which the host has configured a client. */
    sources?: ServiceSource[];
    /** Trusted owner UI. Local forgetting does not revoke a remote grant. */
    ownerManagementUrl?: string;
}
export interface ServicePanelOptions {
    controller: ServiceController;
    appearance?: ServicePanelAppearance;
    onSourceSelected?: (source: ServiceSource) => void;
}
const errors: Record<ClientErrorCode, string> = {
    'authorization-expired': '授权已过期。请重新授权。',
    'authorization-revoked': '授权已撤销。请重新授权。',
    'machine-offline': '执行设备离线。请让设备上线，然后重新检查。',
    'account-login-required': '执行账号需要登录。请在原设备登录，然后重新检查。',
    'account-identity-changed': '执行账号身份已改变。请在服务管理中核对原账号。',
    'account-not-found': '找不到执行账号。请在服务管理中核对账号。',
    'service-not-found': '找不到服务。请联系服务所有者。',
    'service-disabled': '服务已停用。请联系服务所有者。',
    'model-unavailable': '所选模型不可用。请更新模型目录。',
    'parameter-unsupported': '执行端不支持所选参数。请更新模型目录。',
    'quota-exhausted': '执行账号的原生额度已用尽。请检查账号额度。',
    'execution-interrupted': '执行已中断。请检查原设备和账号。',
    'protocol-incompatible': '服务协议不兼容。请更新应用或执行端。',
    'consent-required': '需要服务授权。请连接并完成授权。',
    'revision-conflict': '服务配置已改变。请更新服务信息。',
    'permission-denied': '此操作未获授权。请在授权管理中检查权限。',
    'invalid-service-config': '服务配置无效。请联系服务所有者。',
    'invalid-request': '请求无效。请检查设置。',
    'resource-busy': '执行资源正忙。请稍后重试。',
    'internal-error': '服务发生错误。请稍后重试。',
    'transport-error': '无法连接服务。请检查网络后重试。',
    'context-mismatch': '响应与原连接不匹配。请重新连接原服务。',
    'storage-unavailable': '无法保存连接。请检查浏览器存储设置。',
    'disposed': '连接控制器已关闭。请重新打开此页面。',
    'aborted': '操作已取消。',
    'observation-expired': '观察已停止。请重新检查状态。',
};
const sourceNames: Record<ServiceSource, string> = { platform: '平台服务', personal: '个人服务' };
let nextId = 0;
function safeWebUrl(value?: string): string | null {
    if (!value) return null;
    try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
    catch { return null; }
}

/** Mount one native DOM panel. The host keeps ownership of the controller. */
export function mountServicePanel(element: HTMLElement, { controller, appearance = {}, onSourceSelected }: ServicePanelOptions): { destroy(): void } {
    const doc = element.ownerDocument;
    const id = `paws-service-panel-${++nextId}`;
    const sources = [...new Set<ServiceSource>(appearance.sources ?? ['platform', 'personal'])];
    const root = doc.createElement('section'); root.className = 'paws-service-panel'; root.dataset.theme = appearance.theme ?? 'auto';
    root.setAttribute('aria-label', appearance.title ?? 'AI 服务');
    element.append(root);
    let state = controller.getState(), destroyed = false, busy = false, epoch = 0, remember = false;
    let localError: ClientErrorCode | null = null, notice = '', modal: 'advanced' | 'details' | null = null, opener = '';
    let focusRecovery: string | null = null;
    let connectAbort: AbortController | null = null;

    function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
        const el = doc.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el;
    }
    function button(text: string, key: string, action: () => void, disabled = false) {
        const el = node('button', text); el.type = 'button'; el.dataset.focus = key; el.disabled = disabled;
        el.addEventListener('click', action); return el;
    }
    function link(text: string, href: string) { const el = node('a', text); el.href = href; el.target = '_blank'; el.rel = 'noopener noreferrer'; return el; }
    function field(label: string, key: string, choices: { value: string; label: string }[], value: string, disabled: boolean, action: (value: string) => void) {
        const wrap = node('label', label, 'paws-service-field'), select = node('select');
        select.setAttribute('aria-label', label); select.dataset.focus = key; select.disabled = disabled;
        for (const choice of choices) { const option = node('option', choice.label); option.value = choice.value; select.append(option); }
        select.value = value; select.addEventListener('change', () => action(select.value)); wrap.append(select); return wrap;
    }
    function findFocus(key: string) { return [...root.querySelectorAll<HTMLElement>('[data-focus]')].find(el => el.dataset.focus === key); }
    function openModal(value: 'advanced' | 'details') { focusRecovery = null; opener = value; modal = value; render(true); findFocus('close')?.focus(); }
    function closeModal() { focusRecovery = null; const key = opener; modal = null; render(true); findFocus(key)?.focus(); }
    function reconcile(next: ServiceControllerState): boolean {
        if (!next.catalog) return false;
        const overrides: BindingOverrides = { ...next.overrides };
        const modelId = overrides.modelId;
        const model = next.catalog.models.find(m => m.id === modelId);
        let changed = false;
        if (overrides.modelId && !model) { delete overrides.modelId; changed = true; }
        // Without an explicit model, the service's configured model is unknown.
        if (modelId && overrides.reasoning?.mode === 'explicit' && (!model || !model.reasoning.values.includes(overrides.reasoning.value))) {
            delete overrides.reasoning; changed = true;
        }
        if (changed) { notice = '模型目录已改变。已清除失效的覆盖设置。'; controller.setOverrides(overrides); }
        return changed;
    }
    function run(action: () => Promise<unknown>) {
        if (destroyed || busy) return;
        if (modal) focusRecovery = (doc.activeElement as HTMLElement | null)?.dataset?.focus ?? null;
        const current = epoch; busy = true; localError = null; notice = ''; render();
        void Promise.resolve().then(() => {
            if (destroyed || current !== epoch) return;
            return action();
        }).catch(error => {
            if (!destroyed && current === epoch) localError = error instanceof AIServiceClientError ? error.code : 'transport-error';
        }).finally(() => { if (!destroyed && current === epoch) { busy = false; render(); } });
    }
    function connect() {
        connectAbort?.abort(); connectAbort = new AbortController();
        const signal = connectAbort.signal;
        run(() => controller.connect({ remember, signal }));
    }
    function switchSource(value: string) {
        if (!sources.includes(value as ServiceSource) || value === state.source) return;
        epoch++; busy = false; localError = null; notice = ''; modal = null; focusRecovery = null;
        try { controller.selectSource(value as ServiceSource); onSourceSelected?.(value as ServiceSource); }
        catch (error) { localError = error instanceof AIServiceClientError ? error.code : 'transport-error'; render(); }
    }
    function setModel(value: string) {
        if (value && !state.catalog?.models.some(m => m.id === value)) { render(); return; }
        const overrides = { ...state.overrides }; delete overrides.reasoning;
        if (value) overrides.modelId = value; else delete overrides.modelId;
        controller.setOverrides(overrides);
    }
    function setReasoning(value: string) {
        const model = state.catalog?.models.find(m => m.id === state.overrides.modelId);
        if (value && !model?.reasoning.values.includes(value)) { render(); return; }
        const overrides = { ...state.overrides };
        if (value) overrides.reasoning = { mode: 'explicit', value }; else delete overrides.reasoning;
        controller.setOverrides(overrides);
    }
    function qr(payload: string) {
        // qrUrl is a deep-link payload, never an image URL.
        const url = new URL(payload); if (!['paws:', 'https:', 'http:'].includes(url.protocol) || payload.length > 2048) throw new Error('invalid QR URL');
        const code = QRCode.create(payload, { errorCorrectionLevel: 'M' });
        const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', `0 0 ${code.modules.size + 8} ${code.modules.size + 8}`); svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', '授权二维码'); svg.classList.add('paws-service-qr');
        const path = doc.createElementNS(svg.namespaceURI, 'path'); let d = '';
        for (let y = 0; y < code.modules.size; y++) for (let x = 0; x < code.modules.size; x++) {
            if (code.modules.get(y, x)) d += `M${x + 4},${y + 4}h1v1h-1z`;
        }
        path.setAttribute('d', d); path.setAttribute('fill', 'currentColor'); svg.append(path); return svg;
    }
    function details(dialog: HTMLElement) {
        const list = node('dl');
        const rows = [
            ['来源', sourceNames[state.source]], ['服务标识', state.connection?.serviceId ?? '尚未连接'],
            ['授权到期', state.connection?.expiresAt ? new Date(state.connection.expiresAt).toLocaleString() : '未提供到期时间'],
            ['执行引擎', state.catalog?.engine ?? '尚未读取'], ['执行设备', state.catalog?.machineId ?? '尚未读取'],
            ['目录状态', state.catalog ? `${state.catalog.availability === 'online' ? '在线' : '离线'} / ${state.catalog.completeness === 'complete' ? '完整' : '有限'}` : '尚未读取'],
            ['目录观测时间', state.catalog ? new Date(state.catalog.observedAt).toLocaleString() : '尚未读取'],
            ['实际模型', '未知。请读取原对话的执行记录。'], ['实际推理强度', '未知。请读取原对话的执行记录。'],
            ['连接存储', state.storage.mode === 'remember' ? '已记住' : state.storage.mode === 'session' ? '当前浏览器会话' : '当前页面内存'],
        ];
        for (const [label, value] of rows) list.append(node('dt', label), node('dd', value));
        dialog.append(list, node('p', '来源和覆盖设置只影响新对话。原对话保留原绑定。'));
    }
    function advanced(dialog: HTMLElement) {
        dialog.append(node('p', '只影响新对话。连接时无需重新选择模型或推理强度。'));
        const available = state.connection !== null && state.catalog?.availability === 'online' && !busy;
        const selectedModel = state.catalog?.models.find(m => m.id === state.overrides.modelId);
        const reasoningValue = state.overrides.reasoning?.mode === 'explicit' ? state.overrides.reasoning.value : '';
        const unverifiedReasoning = !selectedModel && reasoningValue ? [{ value: reasoningValue, label: `当前覆盖：${reasoningValue}（未验证）` }] : [];
        dialog.append(field('模型', 'model', [{ value: '', label: '跟随服务默认配置' }, ...(state.catalog?.models ?? []).map(m => ({ value: m.id, label: m.name }))], state.overrides.modelId ?? '', !available, setModel));
        dialog.append(field('推理强度', 'reasoning', [{ value: '', label: '跟随服务默认配置' }, ...unverifiedReasoning, ...(selectedModel?.reasoning.values ?? []).map(value => ({ value, label: value }))], reasoningValue, !available || !selectedModel?.reasoning.values.length, setReasoning));
        if (unverifiedReasoning.length) dialog.append(node('p', `保留推理强度覆盖：${reasoningValue}。服务模型未提供，尚未验证支持情况。`));
        if (!state.catalog) dialog.append(node('p', '先连接服务，再更新模型目录。'));
        else if (!selectedModel) dialog.append(node('p', '选择明确的模型后，可查看它支持的原生推理强度。服务默认模型尚未提供。'));
        else if (!selectedModel.reasoning.values.length) dialog.append(node('p', '此模型未提供可选推理强度。'));
        if (state.catalog?.availability === 'offline') dialog.append(node('p', '设备离线。目录仅供查看。'));
        if (state.catalog?.completeness === 'limited') dialog.append(node('p', '目录信息有限。执行时仍需检查模型和参数。'));
        dialog.append(button('更新模型目录', 'refresh-catalog', () => run(() => controller.refresh()), busy || !state.connection));
        dialog.append(button('恢复服务默认配置', 'reset-overrides', () => controller.setOverrides({}), busy));
        dialog.append(node('p', '问答授权不包含终端、文件系统或浏览器操作。'));
    }
    function render(preserveContent = false) {
        if (destroyed) return;
        const activeElement = doc.activeElement as HTMLElement | null;
        const active = activeElement && root.contains(activeElement) ? activeElement.dataset?.focus : undefined;
        const content = node('div', undefined, 'paws-service-content'); content.inert = Boolean(modal);
        if (modal) content.setAttribute('aria-hidden', 'true');
        const heading = node('h2', appearance.title ?? 'AI 服务');
        content.append(heading, field('服务来源', 'source', sources.map(source => ({ value: source, label: sourceNames[source] })), state.source, false, switchSource));
        content.append(node('p', state.source === 'platform' ? '由平台提供执行服务。' : '由你授权的设备和账号提供执行服务。'));
        const status = node('div', undefined, 'paws-service-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
        const errorCode = localError ?? state.error?.code;
        if (errorCode) { status.dataset.errorCode = errorCode; status.append(node('strong', errors[errorCode])); }
        else status.append(node('strong', state.status === 'ready' ? '已授权连接' : state.status === 'authorizing' ? '等待授权' : state.status === 'disconnected' ? '尚未连接' : errors[state.status as ClientErrorCode] ?? '请检查服务状态。'));
        if (state.status === 'ready') status.append(node('p', '已授权连接不代表执行端当前可用。可重新检查状态。'));
        if (busy && state.status !== 'authorizing') status.append(node('p', '正在处理…'));
        if (notice) status.append(node('p', notice));
        content.append(status);
        if (state.pending) {
            const approvalUrl = safeWebUrl(state.pending.approvalUrl);
            if (approvalUrl) content.append(link('在此设备授权', approvalUrl));
            try { content.append(qr(state.pending.qrUrl), node('p', '用 Paws 扫描二维码，在原设备确认授权。')); }
            catch { content.append(node('p', '二维码不可用。请使用同设备授权链接。')); }
            content.append(node('p', `授权请求到期：${new Date(state.pending.expiresAt).toLocaleString()}`));
        }
        const actions = node('div', undefined, 'paws-service-actions');
        if (state.status === 'authorizing') actions.append(button('取消授权', 'cancel', () => { epoch++; busy = false; run(() => controller.disconnect()); }));
        else if (state.status !== 'ready' && !state.connection) actions.append(button(errorCode ? '重新连接' : '连接', 'connect', connect, busy || errorCode === 'disposed'));
        if (state.connection) actions.append(button('重新检查状态', 'refresh', () => run(() => controller.refresh()), busy), button('断开连接', 'disconnect', () => run(() => controller.disconnect()), busy));
        actions.append(button('忘记此连接', 'forget', () => run(async () => { await controller.disconnect('forget'); notice = '已忘记本地连接。远端授权仍需在授权管理中撤销。'; }), busy));
        const ownerUrl = safeWebUrl(appearance.ownerManagementUrl);
        if (ownerUrl) actions.append(link('管理授权', ownerUrl));
        else content.append(node('p', '如需撤销远端授权，请打开服务所有者的授权管理页。'));
        content.append(actions, node('p', '断开连接会保留本地授权。忘记此连接不会撤销远端授权。'));
        if (state.source === 'personal' && state.status !== 'authorizing') {
            const label = node('label', undefined, 'paws-service-remember'), input = node('input'); input.type = 'checkbox'; input.checked = remember; input.disabled = busy; input.dataset.focus = 'remember';
            input.addEventListener('change', () => { remember = input.checked; }); label.append(input, doc.createTextNode('下次连接时记住此设备的授权')); content.append(label);
        }
        if (state.storage.warning) content.append(node('p', state.storage.warning === 'remember-unavailable' ? '无法记住授权。仅保留在当前浏览器会话或页面中。未确认旧持久数据已删除。' : '浏览器会话存储不可用。连接仅保留在当前页面内存中。', 'paws-service-warning'));
        const summary = node('div', undefined, 'paws-service-defaults');
        summary.append(node('h3', '新对话设置'), node('p', state.overrides.modelId ? `模型覆盖：${state.catalog?.models.find(m => m.id === state.overrides.modelId)?.name ?? state.overrides.modelId}` : '模型：跟随服务默认配置'), node('p', state.overrides.reasoning?.mode === 'explicit' ? `推理强度覆盖：${state.overrides.reasoning.value}` : '推理强度：跟随服务默认配置'), node('p', '服务默认值由服务所有者管理。实际值以执行记录为准。'));
        summary.append(button('高级设置', 'advanced', () => openModal('advanced')), button('状态与详情', 'details', () => openModal('details'))); content.append(summary);
        const previous = preserveContent ? root.querySelector<HTMLElement>('.paws-service-content') : null;
        if (previous) {
            previous.inert = Boolean(modal);
            if (modal) previous.setAttribute('aria-hidden', 'true'); else previous.removeAttribute('aria-hidden');
        }
        root.replaceChildren(previous ?? content);
        if (modal) {
            const backdrop = node('div', undefined, 'paws-service-backdrop'), dialog = node('div', undefined, 'paws-service-dialog');
            dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', `${id}-dialog-title`);
            const title = node('h3', modal === 'advanced' ? '高级设置' : '状态与详情'); title.id = `${id}-dialog-title`;
            const header = node('div', undefined, 'paws-service-dialog-header'); header.append(title, button('关闭', 'close', closeModal)); dialog.append(header);
            if (errorCode || notice) {
                const message = node('div', undefined, 'paws-service-status'); message.setAttribute('role', 'status');
                if (errorCode) { message.dataset.errorCode = errorCode; message.append(node('p', errors[errorCode])); }
                if (notice) message.append(node('p', notice));
                dialog.append(message);
            }
            if (modal === 'advanced') advanced(dialog); else details(dialog);
            backdrop.addEventListener('click', event => { if (event.target === backdrop) closeModal(); }); backdrop.append(dialog); root.append(backdrop);
        }
        const target = findFocus(focusRecovery ?? active ?? '');
        if (target && !target.hasAttribute('disabled')) {
            target.focus();
            if (!busy) focusRecovery = null;
        } else if (modal) findFocus('close')?.focus();
    }
    function keydown(event: KeyboardEvent) {
        if (!modal) return;
        if (event.key === 'Escape') { event.preventDefault(); closeModal(); return; }
        if (event.key !== 'Tab') return;
        // A user navigation choice takes precedence over automatic focus recovery.
        focusRecovery = null;
        const focusable = [...root.querySelectorAll<HTMLElement>('[role="dialog"] button:not(:disabled), [role="dialog"] select:not(:disabled), [role="dialog"] a[href]')];
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && (doc.activeElement === first || !root.querySelector('[role="dialog"]')?.contains(doc.activeElement))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (doc.activeElement === last || !root.querySelector('[role="dialog"]')?.contains(doc.activeElement))) { event.preventDefault(); first?.focus(); }
    }
    doc.addEventListener('keydown', keydown);
    root.addEventListener('pointerdown', () => { focusRecovery = null; });
    const unsubscribe = controller.subscribe(event => {
        if (destroyed) return;
        if (event.type === 'state') {
            if (state.source !== event.state.source) { epoch++; busy = false; localError = null; modal = null; focusRecovery = null; }
            state = event.state;
            localError = null;
            if (reconcile(state)) return;
            render();
        } else { notice = '本地授权已被清除。请重新连接。'; render(); }
    });
    return { destroy() {
        if (destroyed) return;
        destroyed = true; epoch++; unsubscribe(); connectAbort?.abort(); doc.removeEventListener('keydown', keydown); root.remove();
    } };
}
