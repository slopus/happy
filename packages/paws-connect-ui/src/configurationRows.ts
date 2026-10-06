import type { CapabilityCatalog, ServiceReasoning, ServiceTarget } from '@wangjs-jacky/paws-agent/services/browser';

export interface ConfigurationRowValue {
    target?: ServiceTarget;
    modelId?: string | null;
    reasoning?: ServiceReasoning;
    permissionMode?: 'chat-only' | 'read-only' | 'yolo';
    serviceTier?: 'default' | 'fast';
}

export interface ConfigurationRow {
    id: string;
    name: string;
    description?: string;
    allowModelOverride?: boolean;
    allowReasoningOverride?: boolean;
    loading?: boolean;
    error?: string;
    value: ConfigurationRowValue;
    targets: { target: ServiceTarget; machineName: string; accountName: string }[];
    catalog: CapabilityCatalog | null;
}

export interface ServiceConfigurationRowsOptions {
    rows: ConfigurationRow[];
    onChange: (id: string, patch: Partial<ConfigurationRowValue>) => void;
    onRefresh: (id: string) => void;
}

type Choice = { value: string; label: string; disabled?: boolean };
const permissionNames = { 'chat-only': '问答', 'read-only': '只读', yolo: 'YOLO' };

function sameTarget(left: ServiceTarget, right: ServiceTarget): boolean {
    if (left.machineId !== right.machineId || left.engine !== right.engine) return false;
    if (left.accountRef.kind === 'codex-profile' && right.accountRef.kind === 'codex-profile') return left.accountRef.id === right.accountRef.id;
    return left.accountRef.kind === 'device-identity' && right.accountRef.kind === 'device-identity'
        && left.accountRef.machineId === right.accountRef.machineId && left.accountRef.identityId === right.accountRef.identityId;
}

/** Controlled draft editor. The host owns connections, capability reads, and saving. */
export function mountServiceConfigurationRows(
    element: HTMLElement, options: ServiceConfigurationRowsOptions,
): { update(rows: ConfigurationRow[]): void; destroy(): void } {
    const doc = element.ownerDocument;
    const root = doc.createElement('section');
    root.className = 'paws-service-rows'; root.setAttribute('aria-label', '应用服务设置'); element.append(root);
    let rows = options.rows, destroyed = false, renderVersion = 0;

    function node<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
        const el = doc.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el;
    }
    function icon(kind: 'device' | 'fast' | 'refresh') {
        const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
        svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.7');
        svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
        const path = doc.createElementNS(svg.namespaceURI, 'path');
        path.setAttribute('d', {
            device: 'M4 4h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1ZM8 21h8m-4-4v4',
            fast: 'm13 2-9 12h7l-1 8 10-13h-7l1-7Z',
            refresh: 'M20 7v5h-5M4 17v-5h5M6.1 6.1a8 8 0 0 1 13.3 3.1M4.6 14.8a8 8 0 0 0 13.3 3.1',
        }[kind]); svg.append(path); return svg;
    }
    function controlIdentity(el: HTMLElement, row: ConfigurationRow, key: string, label: string) {
        el.dataset.rowId = row.id; el.dataset.control = key; el.setAttribute('aria-label', `${row.name} ${label}`);
    }
    function field(row: ConfigurationRow, key: string, label: string, choices: Choice[], value: string, unavailableLabel: string, disabled: boolean, action: (value: string) => void) {
        const wrap = node('div', `paws-service-rows-field paws-service-rows-${key}`);
        const select = node('select'); controlIdentity(select, row, key, label); select.disabled = disabled;
        const available = choices.some(choice => choice.value === value);
        const displayed = available ? choices : [{ value, label: `${unavailableLabel} · 不可用`, disabled: true }, ...choices];
        for (const choice of displayed) {
            const option = node('option', undefined, choice.label); option.value = choice.value; option.disabled = choice.disabled ?? false; select.append(option);
        }
        select.value = value;
        select.title = `${label}：${select.selectedOptions[0]?.textContent ?? unavailableLabel}`;
        if (select.selectedOptions[0]?.disabled) select.setAttribute('aria-invalid', 'true');
        const version = renderVersion;
        select.addEventListener('change', () => {
            if (destroyed || version !== renderVersion || select.disabled) return;
            if (!choices.some(choice => choice.value === select.value && !choice.disabled)) { select.value = value; return; }
            action(select.value);
        });
        wrap.append(select); return wrap;
    }
    function button(row: ConfigurationRow, key: string, label: string, disabled: boolean, action: () => void) {
        const el = node('button'); el.type = 'button'; el.disabled = disabled; controlIdentity(el, row, key, label); el.title = label;
        const version = renderVersion;
        el.addEventListener('click', () => { if (!destroyed && version === renderVersion && !el.disabled) action(); }); return el;
    }
    function renderRow(row: ConfigurationRow) {
        const section = node('section', 'paws-service-rows-row'); section.setAttribute('aria-label', row.name);
        section.setAttribute('aria-busy', String(!!row.loading));
        const heading = node('div', 'paws-service-rows-heading'); heading.append(node('strong', undefined, row.name));
        if (row.description) heading.append(node('p', undefined, row.description));
        const controls = node('div', 'paws-service-rows-controls'); controls.setAttribute('role', 'group'); controls.setAttribute('aria-label', `${row.name} 执行设置`);
        const target = row.value.target ?? row.catalog ?? undefined;
        const catalog = row.catalog && (!target || sameTarget(target, row.catalog)) ? row.catalog : null;
        const disabled = !!row.loading || !catalog || catalog.availability !== 'online';
        const emit = (patch: Partial<ConfigurationRowValue>) => options.onChange(row.id, patch);
        const modelId = row.value.modelId ?? '';
        const effectiveModel = catalog?.models.find(model => model.id === (modelId || catalog.defaultModelId));
        const supportsFast = (id: string) => !!catalog?.execution?.serviceTiers.includes('fast')
            && !!catalog.models.find(model => model.id === (id || catalog.defaultModelId))?.serviceTiers?.includes('fast');
        const permissions = catalog?.execution?.permissionModes ?? [];
        const permission = row.value.permissionMode ?? 'chat-only';
        if (permissions.length) {
            controls.append(field(row, 'permission', '权限', permissions.map(value => ({ value, label: permissionNames[value] })), permission, permissionNames[permission], disabled,
                value => emit({ permissionMode: value as ConfigurationRowValue['permissionMode'] })));
        }
        const defaultModel = catalog?.models.find(model => model.id === catalog.defaultModelId);
        const defaultLabel = catalog?.defaultModelId ? `默认 · ${defaultModel?.name ?? catalog.defaultModelId}` : '默认模型';
        const modelChoices: Choice[] = [{ value: '', label: defaultLabel }, ...(catalog?.models.map(model => ({ value: model.id, label: model.name })) ?? [])];
        controls.append(field(row, 'model', '模型', modelChoices, modelId, modelId, disabled || row.allowModelOverride === false, value => emit({
            modelId: value || null, ...(row.allowReasoningOverride === false ? {} : {reasoning: { mode: 'default' as const }}),
            serviceTier: supportsFast(value) ? row.value.serviceTier ?? 'default' : 'default',
        })));
        const reasoning = row.value.reasoning?.mode === 'explicit' ? row.value.reasoning.value : '';
        const reasoningChoices: Choice[] = [];
        if (effectiveModel?.reasoning.supportsDefault || !effectiveModel) {
            reasoningChoices.push({ value: '', label: effectiveModel?.reasoning.defaultValue ? `默认 · ${effectiveModel.reasoning.defaultValue}` : '默认推理' });
        }
        reasoningChoices.push(...(effectiveModel?.reasoning.values.map(value => ({ value, label: value })) ?? []));
        if (!reasoningChoices.length) reasoningChoices.push({ value: '', label: '默认 · 不可用', disabled: true });
        controls.append(field(row, 'reasoning', '推理强度', reasoningChoices, reasoning, reasoning || '默认', disabled || !effectiveModel || row.allowReasoningOverride === false,
            value => emit({ reasoning: value ? { mode: 'explicit', value } : { mode: 'default' } })));
        const fastSupported = supportsFast(modelId);
        if (fastSupported) {
            const active = row.value.serviceTier === 'fast';
            const fast = button(row, 'fast', 'Fast', disabled, () => emit({ serviceTier: active ? 'default' : 'fast' }));
            fast.setAttribute('aria-pressed', String(active)); fast.append(icon('fast'), node('span', undefined, 'Fast')); controls.append(fast);
        }
        const refresh = button(row, 'refresh', '更新模型目录', !!row.loading, () => options.onRefresh(row.id));
        refresh.className = 'paws-service-rows-refresh'; refresh.append(icon('refresh')); controls.append(refresh);

        const targetIndex = target ? row.targets.findIndex(item => sameTarget(item.target, target)) : -1;
        const targetChoices: Choice[] = row.targets.map((item, index) => ({
            value: String(index), label: `${item.machineName} · ${item.accountName} · ${item.target.engine}`,
        }));
        if (!target) targetChoices.unshift({ value: '', label: row.targets.length ? '选择执行设备' : '暂无执行设备', disabled: true });
        const targetValue = targetIndex >= 0 ? String(targetIndex) : target ? 'unavailable' : '';
        const targetField = field(row, 'device', '执行设备与账号', targetChoices, targetValue, target?.machineId ?? '执行设备', !!row.loading || !row.targets.length, value => {
            const selected = row.targets[Number(value)];
            if (selected) emit({ target: selected.target, ...(row.allowModelOverride === false ? {} : {modelId: null}), ...(row.allowReasoningOverride === false ? {} : {reasoning: {mode:'default' as const}}), permissionMode: 'chat-only', serviceTier: 'default' });
        });
        const targetName = targetIndex >= 0 ? row.targets[targetIndex].machineName : target ? `${target.machineId} · 不可用` : row.targets.length ? '选择执行设备' : '暂无执行设备';
        const deviceLabel = node('span', 'paws-service-rows-device-label'); deviceLabel.setAttribute('aria-hidden', 'true');
        deviceLabel.append(icon('device'), node('span', undefined, targetName), node('span', 'paws-service-rows-chevron', '⌄'));
        targetField.prepend(deviceLabel);
        section.append(heading, controls, targetField);

        const messages: string[] = [];
        if (row.loading) messages.push('正在读取模型目录…');
        else if (!catalog) messages.push('请更新模型目录。');
        else if (catalog.availability === 'offline') messages.push('执行设备离线。');
        else if (catalog.completeness === 'limited') messages.push('模型目录不完整。');
        if (!permissions.length && row.value.permissionMode && row.value.permissionMode !== 'chat-only') messages.push(`${permissionNames[row.value.permissionMode]} 权限不可用。`);
        if (row.value.serviceTier === 'fast' && !fastSupported) messages.push('Fast 不可用。');
        if (row.error) { const error = node('p', 'paws-service-rows-message', row.error); error.setAttribute('role', 'alert'); section.append(error); }
        if (messages.length) { const status = node('p', 'paws-service-rows-message', messages.join(' ')); status.setAttribute('role', 'status'); section.append(status); }
        return section;
    }
    function render() {
        if (destroyed) return;
        const focused = root.contains(doc.activeElement) ? doc.activeElement as HTMLElement : null;
        const focusId = focused?.dataset.rowId, focusControl = focused?.dataset.control;
        renderVersion++;
        root.replaceChildren(...rows.map(renderRow));
        if (focusId !== undefined && focusControl) {
            const next = [...root.querySelectorAll<HTMLElement>('[data-control]')].find(el => el.dataset.rowId === focusId && el.dataset.control === focusControl);
            next?.focus();
        }
    }
    render();
    return {
        update(nextRows) { if (!destroyed) { rows = nextRows; render(); } },
        destroy() { destroyed = true; root.remove(); },
    };
}
