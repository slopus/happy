// Node 24, offline. Executes happy-app's actual TS helpers after stripping types
// and imports. Only sync.ts's final record assembly is minimally transliterated.
import { readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
const sources = new URL('../../happy-app/sources/', import.meta.url);
const read = path => readFileSync(new URL(path, sources), 'utf8');
const clean = source => stripTypeScriptTypes(source.replace(/^import[\s\S]*?;\s*/gm, '').replace(/\bexport\s+/g, ''), { mode: 'transform' });
const defaults = read('sync/agentDefaults.ts').slice(read('sync/agentDefaults.ts').indexOf('const codeAgentDefaults'));
const options = read('components/modelModeOptions.ts');
const start = options.indexOf('export function modeSupportedByCli(');
const end = options.indexOf('/**\n * Drops modes', start);
const source = [read('utils/versionUtils.ts'), read('utils/trimIdent.ts'), defaults,
    read('sync/rig.ts'), read('sync/agentCommunications.ts'), read('sync/sessionState.ts'),
    options.slice(start, end), read('sync/messageMeta.ts'), read('sync/prompt/systemPrompt.ts')].map(clean).join('\n');
const { resolveMessageDeliveryMeta, resolveMessageModeMeta, systemPrompt } = new Function(source + '\nreturn {resolveMessageDeliveryMeta,resolveMessageModeMeta,systemPrompt};')();
const cases = [
    { name: 'plain', metadata: {}, composer: {}, text: 'hello', displayText: '' },
    { name: 'codex-default', metadata: { flavor: 'codex', version: '1.2.6' }, composer: {}, text: 'fix' },
    { name: 'codex-old', metadata: { flavor: 'codex', version: '1.2.1-beta.1' }, composer: {}, text: 'old' },
    { name: 'agy', metadata: { flavor: 'agy' }, composer: {}, text: 'do' },
    { name: 'null-model-retired', metadata: { flavor: 'claude', version: '1.2.6' }, composer: { permissionMode: 'dontAsk', modelMode: 'default', effortLevel: 'high' }, text: '"\n☀️', displayText: 'shown', sentFrom: 'mac' },
    { name: 'overrides', metadata: {}, composer: {}, settings: { agentDefaultOverrides: { claude: { permissionMode: 'auto', modelMode: 'claude-opus-5-5[1m]', effortLevel: 'max' } } }, text: 'default' },
    { name: 'rig-busy', metadata: { client: { id: 'rig' }, rigMetadataVersion: 1, capabilities: { messageReceipts: true }, lastMode: { providerId: 'p', modelId: 'm', permissionMode: 'ask', effort: 'high', serviceTier: null }, models: [{ id: 'm', providerId: 'p', thinkingLevels: ['low','high'], defaultThinkingLevel: 'low' }] }, composer: { effortLevel: 'invalid' }, thinking: true, text: 'continue' },
    { name: 'rig-question', metadata: { client: { id: 'rig' }, rigMetadataVersion: 1, capabilities: { messageReceipts: true }, model: { providerId: 'q', id: 'missing' } }, composer: { serviceTier: null }, thinking: true, agentState: { communications: { question: { kind: 'unknown' } } }, text: 'answer' },
    { name: 'rig-pending', metadata: { client: { id: 'rig' }, rigMetadataVersion: 1, capabilities: { messageReceipts: true } }, composer: { modelMode: 'provider:model:variant' }, pending: true, text: 'next' },
    { name: 'rig-startup', metadata: { client: { id: 'rig' }, rigMetadataVersion: 1, capabilities: { messageReceipts: true } }, composer: {}, pending: true, thinking: true, source: 'new_session', text: 'start' },
    // messageMeta.test.ts's resolveMessageDeliveryMeta cases. The idle pair
    // also pins what acceptance derives from the store (SendingDeliveryMetaTests).
    { name: 'rig-idle', metadata: { client: { id: 'rig' }, rigMetadataVersion: 1, capabilities: { messageReceipts: true } }, composer: {}, text: 'idle' },
    { name: 'rig-idle-pending', metadata: { client: { id: 'rig' }, rigMetadataVersion: 1, capabilities: { messageReceipts: true } }, composer: {}, pending: true, text: 'idle' },
    { name: 'rig-permission', metadata: { client: { id: 'rig' }, rigMetadataVersion: 1, capabilities: { messageReceipts: true } }, composer: {}, agentState: { requests: { permission: { tool: 'Bash', arguments: {} } } }, text: 'blocked' },
    { name: 'rig-question-pending', metadata: { client: { id: 'rig' }, rigMetadataVersion: 1, capabilities: { messageReceipts: true } }, composer: {}, thinking: true, pending: true, agentState: { requests: {}, communications: { question: { kind: 'form', form: { questions: [{ id: 'choice', header: 'Choice', question: 'Pick one', options: [{ label: 'One' }] }] } } } }, text: 'answer' },
    { name: 'rig-no-receipts', metadata: { client: { id: 'rig' }, rigMetadataVersion: 1 }, composer: {}, thinking: true, pending: true, text: 'plain' },
    { name: 'refuse-auto', metadata: { flavor: 'claude', version: '1.2.1-beta.1' }, composer: { permissionMode: 'auto' }, text: 'refuse' },
    { name: 'build-version', metadata: { flavor: 'codex', version: '1.2.1-beta.2+abc' }, composer: {}, text: 'build' },
];
const canonical = value => JSON.stringify(sort(value));
function sort(value) {
    if (Array.isArray(value)) return value.map(sort);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, sort(value[k])]));
    return value;
}
for (const test of cases) {
    const session = { metadata: test.metadata, thinking: test.thinking ?? false, agentState: test.agentState, ...test.composer };
    try {
        const mode = resolveMessageModeMeta(session, test.settings);
        const record = { role: 'user', content: { type: 'text', text: test.text }, meta: {
            sentFrom: test.sentFrom ?? 'ios',
            ...resolveMessageDeliveryMeta(session, test.source === 'new_session', test.pending ?? false),
            appendSystemPrompt: systemPrompt,
            ...(mode.permissionMode !== undefined ? { permissionMode: mode.permissionMode } : {}),
            ...(mode.model !== undefined ? { model: mode.model } : {}),
            ...(mode.modelProviderId !== undefined ? { modelProviderId: mode.modelProviderId } : {}),
            ...(mode.effort !== undefined ? { effort: mode.effort } : {}),
            ...(mode.serviceTier !== undefined ? { serviceTier: mode.serviceTier } : {}),
            ...(test.displayText && { displayText: test.displayText }),
        } };
        test.canonical = canonical(record);
        test.wire = JSON.stringify(record);
    } catch (error) { test.error = error.message; }
}
const target = new URL('../Tests/HappyCoreTests/Fixtures/sending.json', import.meta.url);
writeFileSync(target, JSON.stringify(cases, null, 2) + '\n');
console.log(`Wrote ${cases.length} cases to ${fileURLToPath(target)}`);
const files = [
    { name: 'photo.png', size: 7, width: 10, height: 20, thumbhash: 'hash' },
    { name: 'without-hash.png', size: 8, width: 10, height: 20, thumbhash: '' },
    { name: 'document.txt', size: 9, width: 0, height: 0 },
].map(att => {
    // Verbatim file-record construction from sync.ts, deterministic id/time.
    const record = { role: 'session', content: { type: 'session', data: {
        id: 'event-id', time: 123, role: 'user', ev: {
            t: 'file', ref: 'blob-ref', name: att.name, size: att.size,
            ...(att.width > 0 && att.height > 0 ? { image: {
                width: att.width, height: att.height, ...(att.thumbhash ? { thumbhash: att.thumbhash } : {}),
            } } : {}),
        },
    } } };
    return { ...att, canonical: canonical(record), wire: JSON.stringify(record) };
});
writeFileSync(new URL('../Tests/HappyCoreTests/Fixtures/file-events.json', import.meta.url), JSON.stringify(files, null, 2) + '\n');
