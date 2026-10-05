import * as React from 'react';
import { Text, View } from 'react-native';
import type { CapabilityCatalog, ServiceGrantScope, ServiceTarget } from '@slopus/happy-wire';
import type { CodexAccountProfile } from '@/sync/apiCodexAccounts';
import type { AIServicesAPI, AIServiceWorker, ServicePairing, ServiceSnapshot } from '@/sync/apiAIServices';
import { AuthorizationChoice, AuthorizationNotice, AuthorizationSection, authorizationStyles as styles } from '@/components/appAuthorization/AppAuthorizationLayout';
import { RoundButton } from '@/components/RoundButton';
import { availableServiceTargets, sameTarget, targetDescription, targetOf, type ServiceMachine } from './ServiceEditor';

export function ServiceConsent({ pairing, services, workers, accounts, machines, api, onApprove, onManage }: {
    pairing: ServicePairing; services: ServiceSnapshot[]; workers: AIServiceWorker[]; accounts: CodexAccountProfile[]; machines: ServiceMachine[]; api: AIServicesAPI;
    onApprove: (service: ServiceSnapshot, scope: ServiceGrantScope) => Promise<void>; onManage: () => void;
}) {
    const [selected, setSelected] = React.useState(() => services.find(s => s.service.enabled)?.service.id ?? '');
    const [days, setDays] = React.useState<number | null>(1);
    const [images, setImages] = React.useState(false);
    const [catalog, setCatalog] = React.useState<CapabilityCatalog | null>(null);
    const [error, setError] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [approved, setApproved] = React.useState(false);
    const [now, setNow] = React.useState(Date.now());
    const [extras, setExtras] = React.useState<ServiceTarget[]>([]);
    const [observations, setObservations] = React.useState<Record<string, { catalog?: CapabilityCatalog; error?: string }>>({});
    const [checking, setChecking] = React.useState(false);
    const probeGeneration = React.useRef(0);
    const probeLock = React.useRef(false);
    const lock = React.useRef(false);
    const chosen = services.find(s => s.service.id === selected);
    React.useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
    React.useEffect(() => {
        let live = true; setCatalog(null); setImages(false); setError(''); setExtras([]); setObservations({}); setChecking(false); probeLock.current = false; probeGeneration.current++;
        if (chosen) void api.capabilities(targetOf(chosen.revision.config)).then(r => { if (live && sameTarget(r.catalog, chosen.revision.config)) setCatalog(r.catalog); }).catch(e => { if (live) setError(e instanceof Error ? e.message : '无法验证设备能力。'); });
        return () => { live = false; probeGeneration.current++; };
    }, [api, chosen]);
    const model = catalog?.models.find(m => m.id === (chosen?.revision.config.modelId ?? catalog.defaultModelId));
    const candidates = availableServiceTargets(workers, accounts).filter(t => !chosen || !sameTarget(t, chosen.revision.config));
    const keyOf = (target: ServiceTarget) => JSON.stringify(target);
    const usable = (target: ServiceTarget, observed?: CapabilityCatalog) => !!observed && sameTarget(target, observed) && observed.availability === 'online' && observed.models.some(m => m.reasoning.supportsDefault || m.reasoning.values.length > 0);
    const supportsImages = (target: ServiceTarget) => observations[keyOf(target)]?.catalog?.models.some(m => m.supportsImages) === true;
    const extrasReady = extras.every(t => candidates.some(c => sameTarget(c, t)) && usable(t, observations[keyOf(t)]?.catalog));
    const canImages = pairing.app.capabilities.includes('images') && model?.supportsImages === true && extras.every(supportsImages);
    async function checkExtras() {
        if (probeLock.current || busy || !catalog || !chosen) return;
        probeLock.current = true; setChecking(true);
        const generation = probeGeneration.current;
        // T4 allows one observation per machine. Check serially, not with Promise.all.
        for (const target of candidates) {
            if (generation !== probeGeneration.current) return;
            try {
                const result = await api.capabilities(target);
                if (generation === probeGeneration.current) setObservations(values => ({ ...values, [keyOf(target)]: { catalog: result.catalog } }));
            } catch (e) {
                if (generation === probeGeneration.current) setObservations(values => ({ ...values, [keyOf(target)]: { error: e instanceof Error ? e.message : '无法验证此目标。' } }));
            }
        }
        if (generation === probeGeneration.current) { probeLock.current = false; setChecking(false); }
    }
    const config = chosen?.revision.config;
    const ready = !!chosen?.service.enabled && !!config && !!model && catalog?.availability === 'online' && sameTarget(catalog, config) &&
        workers.some(w => w.machineId === config.machineId && !!w.servicePublicKey) && pairing.app.capabilities.includes('chat') &&
        (config.reasoning.mode === 'default' ? model.reasoning.supportsDefault : model.reasoning.values.includes(config.reasoning.value));
    async function approve() {
        if (!chosen || !ready || !extrasReady || (images && !canImages) || checking || pairing.expiresAt <= Date.now() || lock.current) return;
        lock.current = true; setBusy(true); setError('');
        try {
            await onApprove(chosen, { appId: pairing.app.appId, serviceId: chosen.service.id, targets: [targetOf(chosen.revision.config), ...extras], permissions: images && canImages ? ['chat', 'images'] : ['chat'], expiresAt: days === null ? null : Date.now() + days * 86400_000 });
            setApproved(true);
        } catch (e) { setError(e instanceof Error ? e.message : '授权失败。请重试。'); }
        finally { lock.current = false; setBusy(false); }
    }
    if (approved) return <AuthorizationNotice title="已允许连接" message="请返回应用继续。可在 AI 服务设置中撤销授权。" />;
    return <View style={styles.section}>
        <View style={styles.card}>
            <Text style={styles.heading}>{pairing.app.name}</Text>
            <Text style={styles.small}>{pairing.app.origins.join('\n')}</Text>
            <Text style={styles.body}>应用申请使用你的 AI 服务。费用与原生订阅用量由所选账号承担。</Text>
        </View>
        <AuthorizationSection title="选择 AI 服务" hint="已预填服务的默认配置。授权不会修改默认配置。" radio>
            {services.map(s => <AuthorizationChoice key={s.service.id} title={s.service.name} subtitle={targetDescription(s.revision.config, machines, accounts)} selected={selected === s.service.id} disabled={busy || checking || !s.service.enabled} onPress={() => setSelected(s.service.id)} />)}
            {!services.length ? <AuthorizationNotice title="请先创建 AI 服务" message="使用已有设备和账号创建服务后，再从应用重新发起连接。" /> : null}
        </AuthorizationSection>
        {chosen ? <View style={styles.card}>
            <Text style={styles.title}>本次授权范围</Text>
            {[targetOf(chosen.revision.config), ...extras].map(target => <Text key={keyOf(target)} style={styles.body}>{targetDescription(target, machines, accounts)}</Text>)}
            <Text style={styles.body}>默认模型：{chosen.revision.config.modelId ?? '原生默认'}</Text>
            <Text style={styles.body}>思考设置：{chosen.revision.config.reasoning.mode === 'default' ? '原生默认' : chosen.revision.config.reasoning.value}</Text>
            <Text style={styles.small}>应用可在此设备、账号和引擎范围内选择受支持的模型与思考设置。切换到其他范围需要重新授权。</Text>
            <Text style={styles.small}>实际模型：执行后按设备报告显示。未报告时为未知。</Text>
            <Text style={styles.small}>额度：{chosen.revision.config.engine === 'claude' ? '未知' : '以账号管理页的最新观测为准'}</Text>
        </View> : null}
        {chosen && candidates.length ? <AuthorizationSection title="额外授权范围（可选）" hint="当前服务目标已选中。可同时批准其他已验证的设备、账号或引擎。额外目标默认不选，不会改变服务默认模型或思考设置。">
            <RoundButton title="检查其他可用目标" display="inverted" disabled={busy || checking || !catalog} loading={checking} onPress={() => void checkExtras()} />
            {candidates.map(target => {
                const observation = observations[keyOf(target)];
                const selectedExtra = extras.some(t => sameTarget(t, target));
                const available = usable(target, observation?.catalog);
                const disabled = busy || checking || (!selectedExtra && (!available || (images && !supportsImages(target)) || extras.length >= 63));
                const subtitle = observation?.error ?? (!observation ? '尚未验证。请先检查可用目标。' : !available ? '离线或问答能力未验证，暂不可选。' : images && !supportsImages(target) ? '未验证图片能力。请先取消图片权限。' : selectedExtra ? '已加入本次授权范围。' : '可用。选择后加入本次授权范围。');
                return <AuthorizationChoice key={keyOf(target)} role="checkbox" testID={`consent-target-${target.engine}-${target.machineId}${target.accountRef.kind === 'codex-profile' ? `-${target.accountRef.id}` : ''}`} title={targetDescription(target, machines, accounts)} subtitle={subtitle} selected={selectedExtra} disabled={disabled}
                    onPress={() => { if (!disabled) setExtras(values => values.some(t => sameTarget(t, target)) ? values.filter(t => !sameTarget(t, target)) : [...values, target]); }} />;
            })}
        </AuthorizationSection> : null}
        <AuthorizationSection title="权限" hint="仅允许问答。不包含终端、文件系统或浏览器操作。">
            <Text style={styles.body}>文字问答：允许</Text>
            {pairing.app.capabilities.includes('images') ? <AuthorizationChoice testID="consent-images" role="checkbox" title="允许图片输入" subtitle={canImages ? '可选。点击后加入本次授权。' : '图片能力未验证或不支持。'} selected={images} disabled={busy || (!images && !canImages)} onPress={() => setImages(v => !v)} /> : null}
        </AuthorizationSection>
        <AuthorizationSection title="授权有效期" radio>
            {([1, 7, null] as const).map(d => <AuthorizationChoice key={String(d)} title={d === null ? '直到撤销' : `${d} 天`} selected={days === d} disabled={busy} onPress={() => setDays(d)} />)}
        </AuthorizationSection>
        <Text style={styles.body}>记住连接由发起应用的浏览器单独选择。它只决定是否在此浏览器保存连接，不会延长授权有效期。公共设备请勿记住连接。</Text>
        {pairing.expiresAt <= now ? <AuthorizationNotice title="请求已过期" message="请从应用重新发起连接。" error /> : null}
        {error ? <AuthorizationNotice title="无法授权" message={error} error /> : null}
        {chosen && !ready && !error ? <Text style={styles.body}>正在验证能力，或当前默认配置尚不可用。可在 AI 服务设置中检查。</Text> : null}
        <View style={styles.actions}><RoundButton title="管理 AI 服务" display="inverted" disabled={busy} onPress={onManage} /><RoundButton title="允许连接" disabled={!ready || !extrasReady || (images && !canImages) || checking || busy || pairing.expiresAt <= now} loading={busy} onPress={() => void approve()} /></View>
    </View>;
}
