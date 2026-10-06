import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { Text, View } from 'react-native';
import { theme } from './theme';
import { AppAuthorizationLayout } from '../../../sources/components/appAuthorization/AppAuthorizationLayout';
import { ServiceEditor } from '../../../sources/components/aiServices/ServiceEditor';
import { ServiceList } from '../../../sources/components/aiServices/ServiceList';
import { ServiceConsent } from '../../../sources/components/aiServices/ServiceConsent';
import { AIServiceAPIError, type AIServicesAPI, type ServiceSnapshot } from '../../../sources/sync/apiAIServices';
import type { CodexAccountProfile } from '../../../sources/sync/apiCodexAccounts';
import type { ServiceGrant, ServiceTarget, ExecutionBinding } from '@slopus/happy-wire';

const scenario = new URLSearchParams(location.search).get('case') ?? 'list';
const target: ServiceTarget = { machineId: 'synthetic-mac', engine: 'codex', accountRef: { kind: 'codex-profile', id: 'synthetic-account' } };
const snapshot: ServiceSnapshot = { service: { id: 'synthetic-service', ownerId: 'synthetic-owner', name: '我的问答服务', enabled: true, revision: 3 }, revision: { serviceId: 'synthetic-service', revision: 3, createdAt: 1, config: { ...target, modelId: null, reasoning: { mode: 'default' } } } };
const workers = [{ machineId: target.machineId, serviceProtocol: 'ai-services/1' as const, servicePublicKey: 'synthetic-not-a-key', serviceClaudeIdentity: `claude:${'a'.repeat(64)}`, serviceClaudeObservedAt: new Date().toISOString() }, { machineId: 'synthetic-offline', serviceProtocol: 'ai-services/1' as const, servicePublicKey: 'synthetic-not-a-key', serviceClaudeIdentity: null, serviceClaudeObservedAt: null }];
const accounts: CodexAccountProfile[] = [{ id: 'synthetic-account', displayName: '工作账号', status: 'available', credentialVersion: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastValidatedAt: null, quota: { state: 'unknown', remainingPercent: null, weeklyResetsAt: null, observedAt: null } }];
const machines = [{ id: target.machineId, name: '我的 Mac（合成设备）' }, { id: 'synthetic-offline', name: '离线设备（合成）' }];
const grant: ServiceGrant = { id: 'synthetic-grant', ownerId: 'synthetic-owner', kind: 'personal-grant', protocol: 'ai-services/1', createdAt: 1, revokedAt: null, scope: { appId: 'advisor', serviceId: 'synthetic-service', targets: [target], permissions: ['chat'], expiresAt: null } };
const pairing = { id: 'synthetic-pairing', protocol: 'ai-services/1' as const, publicKey: 'synthetic-not-a-key', expiresAt: scenario === 'expired' ? 1 : Date.now() + 600000, app: { appId: 'advisor', name: '狗头军师', origins: ['https://advisor.example'], capabilities: ['chat' as const, 'images' as const], businessPrompt: { id: 'synthetic', version: '1' } } };
const binding: ExecutionBinding = { ...target, id: 'synthetic-binding', appId: 'advisor', serviceId: 'synthetic-service', revision: 2, requestedModel: 'model-one', reasoning: { mode: 'explicit', value: 'high' }, permissions: ['chat'] };
let conflict = scenario === 'conflict';
const actions: unknown[] = [];
const api = {
    capabilities: async (selected: ServiceTarget) => ({ catalog: { ...selected, protocol: 'ai-services/1', observedAt: Date.now(), availability: selected.machineId === 'synthetic-offline' ? 'offline' : 'online', completeness: selected.engine === 'claude' ? 'limited' : 'complete', defaultModelId: selected.engine === 'claude' ? null : 'model-one', models: [{ id: 'model-one', name: 'Model One', supportsImages: selected.engine !== 'claude', reasoning: { supportsDefault: true, values: ['low', 'high'], defaultValue: null } }, ...(selected.engine === 'codex' ? [{ id: 'model-two', name: 'Model Two', supportsImages: false, reasoning: { supportsDefault: true, values: ['medium', 'high'], defaultValue: 'medium' } }] : [])] } }),
    update: async (id: string, expectedRevision: number, config: unknown) => { actions.push({ id, expectedRevision, config }); if (conflict) { conflict = false; throw new AIServiceAPIError('revision-conflict'); } return { revision: snapshot.revision }; },
    create: async (name: string, config: unknown) => { actions.push({ name, config }); return { service: snapshot.service }; },
    read: async () => ({ ...snapshot, service: { ...snapshot.service, revision: 4 }, revision: { ...snapshot.revision, revision: 4 } }),
} as unknown as AIServicesAPI;
function Fixture() {
    const [message, setMessage] = React.useState('');
    const [page, setPage] = React.useState(scenario);
    const done = () => { setMessage('合成操作成功。没有请求服务器。'); };
    return <View style={{ flex: 1, backgroundColor: theme.colors.groupped.background }}>
        <nav style={{ padding: 12, color: theme.colors.text, fontFamily: 'system-ui', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <strong>Task 7 · 合成验收</strong>
            {['list', 'editor', 'new', 'conflict', 'consent', 'expired'].map(c => <a key={c} style={{ color: theme.colors.textLink }} href={`?case=${c}&theme=${theme.dark ? 'dark' : 'light'}`}>{c}</a>)}
            <a style={{ color: theme.colors.textLink }} href={`?case=${scenario}&theme=${theme.dark ? 'light' : 'dark'}`}>切换主题</a>
        </nav>
        <AppAuthorizationLayout>
            {message ? <Text style={{ color: theme.colors.text }}>{message}</Text> : null}
            {['editor', 'new', 'conflict'].includes(page) ? <ServiceEditor snapshot={page === 'new' ? null : snapshot} api={api} workers={workers} accounts={accounts} machines={machines} grants={page === 'new' ? [] : [grant]} onSaved={done} onClose={() => setPage('list')} onManageAccounts={() => setMessage('此处在完整应用中打开现有设备环境页。')} onManageDevices={() => setMessage('此处在完整应用中打开现有设备环境页。')} /> : ['consent', 'expired'].includes(page) ? <ServiceConsent pairing={pairing} services={[snapshot]} workers={workers} accounts={accounts} machines={machines} api={api} onApprove={async (service, scope) => { actions.push({ service: service.service.id, scope }); done(); }} onManage={() => setPage('list')} /> : <ServiceList services={[snapshot]} selected={snapshot.service.id} grants={[grant]} apps={{ advisor: '狗头军师' }} turns={[{ id: 'synthetic-turn', bindingId: binding.id, state: 'completed', actual: { modelId: null, reasoning: null }, createdAt: new Date().toISOString(), startedAt: null, completedAt: new Date().toISOString(), serviceError: null }]} bindings={{ [binding.id]: binding }} accounts={accounts} machines={machines} busy={false} onSelect={() => {}} onCreate={() => setPage('new')} onEdit={() => setPage('editor')} onMetadata={async () => { done(); }} onRemove={async () => { done(); }} onRevoke={async () => { done(); }} />}
            <details style={{ color: theme.colors.textSecondary, fontFamily: 'monospace' }}><summary>合成请求记录（无密钥）</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(actions, null, 2)}</pre></details>
        </AppAuthorizationLayout>
    </View>;
}
document.body.style.margin = '0'; document.body.style.background = theme.colors.groupped.background;
createRoot(document.getElementById('root')!).render(<Fixture />);
