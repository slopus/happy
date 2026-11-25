import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseHarnessArguments, parseSessionProtocolEnvelope, happyDelegationTool, createNativeParentProof, buildNativeParentPrompt } from './delegation-real-e2e-protocol.mjs';

const input = { parentSessionId: 'new-parent', localId: 'submitted-native-parent', roleId: 'saved-role', requestId: 'native-request', childMarker: 'CHILD_UNIQUE', parentMarker: 'PARENT_UNIQUE', previousTaskIds: ['lowlevel-task'] };
let sequence = 0;
const envelope = (ev, overrides = {}) => ({ id: `event-${++sequence}`, role: 'agent', turn: 'parent-root', time: sequence, ev, ...overrides });
const start = () => envelope({ t: 'turn-start', localIds: [input.localId] });
const task = () => ({ id: 'native-task', parentSessionId: input.parentSessionId, roleId: input.roleId, childSessionId: 'new-child', status: 'completed', resultAvailable: true });
function tools(proof, wrapper = value => value) {
    proof.observe(wrapper(envelope({ t: 'tool-call-start', call: 'list', name: 'McpTool', args: { server: 'happy', tool: 'agent_roles', arguments: { action: 'list' } } })));
    proof.observe(wrapper(envelope({ t: 'tool-call-end', call: 'list', status: 'completed' })));
    proof.observe(wrapper(envelope({ t: 'tool-call-start', call: 'delegate', name: 'mcp__happy__delegate_task', args: { roleId: input.roleId, requestId: input.requestId, prompt: `Return ${input.childMarker}` } })));
    proof.observe(wrapper(envelope({ t: 'tool-call-end', call: 'delegate' })));
}
function finish(proof) {
    proof.observe(envelope({ t: 'text', text: `${input.parentMarker} ${input.childMarker}` }));
    proof.observe(envelope({ t: 'turn-end', status: 'completed' }));
}

test('parses direct and legacy session containers without accepting output/tool-result imitations', () => {
    const value = start();
    for (const raw of [value, { role: 'session', content: value }, { role: 'session', content: { type: 'session', data: value } },
        { role: 'agent', content: { type: 'session', data: value } }, { type: 'session', data: value }]) assert.equal(parseSessionProtocolEnvelope(raw), value);
    for (const raw of [null, 'text', { role: 'agent', content: { type: 'output', data: value } }, { result: value }, { ...value, id: undefined }]) assert.equal(parseSessionProtocolEnvelope(raw), null);
});

test('accepts explicit Happy tools and rejects another MCP server, generic kind or misleading title', () => {
    assert.deepEqual(happyDelegationTool({ t: 'tool-call-start', name: 'McpTool', args: { server: 'happy', tool: 'agent_roles', arguments: { action: 'list' } } }), { name: 'agent_roles', input: { action: 'list' } });
    assert.equal(happyDelegationTool({ t: 'tool-call-start', name: 'McpTool', args: { server: 'other', tool: 'agent_roles', arguments: {} } }), null);
    assert.equal(happyDelegationTool({ t: 'tool-call-start', name: 'other', title: 'agent_roles', args: { action: 'list' } }), null);
});

test('accepts the exact observed native AGY MCP title and never infers identity from toolSummary', () => {
    for (const name of ['agent_roles', 'delegate_task']) {
        const args = { toolSummary: 'Synthetic human description' };
        assert.deepEqual(happyDelegationTool({ t: 'tool-call-start', name: 'other', title: `Run mcp_happy_${name}`, args }), { name, input: args });
    }
    for (const title of ['Run mcp_happy_delegate_task extra', 'Run mcp_happy_delegate_task\n', 'Run mcp_other_delegate_task', 'run mcp_happy_delegate_task', 'Delegate synthetic acceptance task', 'List configured agent roles']) {
        assert.equal(happyDelegationTool({ t: 'tool-call-start', name: 'other', title, args: { toolSummary: 'Run mcp_happy_delegate_task', roleId: input.roleId, requestId: input.requestId, prompt: input.childMarker } }), null);
    }
});

test('proves native AGY calls from preserved titles while retaining generic protocol names', () => {
    const proof = createNativeParentProof(input); proof.observe(start());
    proof.observe(envelope({ t: 'tool-call-start', name: 'other', title: 'Run mcp_happy_agent_roles', call: 'native-list', args: { action: 'list', toolSummary: 'List configured agent roles' } }));
    proof.observe(envelope({ t: 'tool-call-end', call: 'native-list' }));
    proof.observe(envelope({ t: 'tool-call-start', name: 'other', title: 'Run mcp_happy_delegate_task', call: 'native-delegate', args: { requestId: input.requestId, roleId: input.roleId, prompt: input.childMarker, toolSummary: 'Delegate synthetic acceptance task' } }));
    proof.observe(envelope({ t: 'tool-call-end', call: 'native-delegate' })); finish(proof);
    assert.deepEqual(proof.completed([task()]).toolCalls.map(call => call.name), ['agent_roles', 'delegate_task']);
});

test('requires successful native tools, the submitted root, both output markers and a new completed child', () => {
    for (const wrapper of [value => value, value => ({ role: 'session', content: { type: 'session', data: value } })]) {
        const proof = createNativeParentProof(input);
        proof.observe(wrapper(start())); tools(proof, wrapper);
        proof.observe(wrapper(envelope({ t: 'text', text: `${input.parentMarker} ${input.childMarker}` })));
        proof.observe(wrapper(envelope({ t: 'turn-end', status: 'completed' })));
        assert.equal(proof.completed([]), undefined);
        assert.equal(proof.completed([{ ...task(), status: 'running' }]), undefined);
        const result = proof.completed([task()]);
        assert.equal(result.task.id, 'native-task'); assert.equal(result.rootTurnId, 'parent-root');
        assert.deepEqual(result.toolCalls.map(call => call.name), ['agent_roles', 'delegate_task']);
    }
});

test('metadata and echoed markers cannot substitute for native tool calls', () => {
    const proof = createNativeParentProof(input); proof.observe(start()); finish(proof);
    assert.throws(() => proof.completed([task()]), /native agent_roles/);
});

test('thinking markers or another root output cannot substitute for the native parent final answer', () => {
    const proof = createNativeParentProof(input); proof.observe(start()); tools(proof);
    proof.observe(envelope({ t: 'text', text: `${input.parentMarker} ${input.childMarker}`, thinking: true }));
    proof.observe(envelope({ t: 'text', text: `${input.parentMarker} ${input.childMarker}` }, { turn: 'unrelated-root' }));
    proof.observe(envelope({ t: 'turn-end', status: 'completed' }));
    assert.throws(() => proof.completed([task()]), /final output did not contain/);
});

test('ignores unrelated roots, subagents, thinking text, stale task versions and duplicate envelopes', () => {
    const proof = createNativeParentProof(input);
    proof.observe(envelope({ t: 'turn-start', localIds: ['older-input'] }, { turn: 'older-root' }));
    proof.observe(envelope({ t: 'text', text: `${input.parentMarker} ${input.childMarker}` }, { turn: 'older-root' }));
    proof.observe(start()); tools(proof);
    proof.observe(envelope({ t: 'text', text: `${input.parentMarker} ${input.childMarker}`, thinking: true }));
    proof.observe(envelope({ t: 'text', text: `${input.parentMarker} ${input.childMarker}` }, { subagent: 'child' }));
    const answer = envelope({ t: 'text', text: `${input.parentMarker} ${input.childMarker}` }); proof.observe(answer); proof.observe(answer);
    proof.observe(envelope({ t: 'turn-end', status: 'completed' }));
    assert.equal(proof.completed([{ ...task(), id: 'lowlevel-task' }]), undefined);
    assert.equal(proof.completed([task()]).task.id, 'native-task');
});

test('rejects failed tools, failed roots, duplicate new tasks and wrong delegate identity', () => {
    const failedTool = createNativeParentProof(input); failedTool.observe(start());
    failedTool.observe(envelope({ t: 'tool-call-start', call: 'list', name: 'agent_roles', args: { action: 'list' } }));
    assert.throws(() => failedTool.observe(envelope({ t: 'tool-call-end', call: 'list', status: 'failed' })), /did not complete successfully/);
    const failedRoot = createNativeParentProof(input); failedRoot.observe(start()); failedRoot.observe(envelope({ t: 'turn-end', status: 'cancelled' }));
    assert.throws(() => failedRoot.completed([task()]), /parent root did not complete/);
    const duplicates = createNativeParentProof(input); duplicates.observe(start()); tools(duplicates); finish(duplicates);
    assert.throws(() => duplicates.completed([task(), { ...task(), id: 'second-new-task' }]), /more than one/);
    const wrongIdentity = createNativeParentProof(input); wrongIdentity.observe(start());
    wrongIdentity.observe(envelope({ t: 'tool-call-start', call: 'list', name: 'agent_roles', args: { action: 'list' } }));
    wrongIdentity.observe(envelope({ t: 'tool-call-end', call: 'list' }));
    wrongIdentity.observe(envelope({ t: 'tool-call-start', call: 'wrong', name: 'delegate_task', args: { roleId: input.roleId, requestId: 'old-request', prompt: input.childMarker } }));
    wrongIdentity.observe(envelope({ t: 'tool-call-end', call: 'wrong' })); finish(wrongIdentity);
    assert.throws(() => wrongIdentity.completed([task()]), /native delegate_task/);
});

test('native-parent requires an explicit boolean and preserves default dry-run execution', () => {
    assert.equal(parseHarnessArguments([]).get('native-parent'), undefined);
    assert.equal(parseHarnessArguments(['--native-parent', 'true']).get('native-parent'), true);
    assert.equal(parseHarnessArguments(['--native-parent', 'false']).get('native-parent'), false);
    assert.equal(parseHarnessArguments(['--run', '--native-parent', 'true']).get('run'), true);
    for (const args of [['--native-parent'], ['--native-parent', 'yes'], ['--native-parent', 'true', '--native-parent', 'false']]) assert.throws(() => parseHarnessArguments(args));
    const script = fileURLToPath(new URL('./delegation-real-e2e.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, '--native-parent', 'true', '--credentials', '/nonexistent/private.json'], { encoding: 'utf8' });
    assert.equal(result.status, 0); assert.equal(result.stderr, '');
    const plan = JSON.parse(result.stdout); assert.equal(plan.mode, 'dry-run'); assert.equal(plan.connects, false); assert.equal(plan.nativeParentRequested, true);
});

test('native prompt explicitly selects the saved role and preserves unique task/result markers', () => {
    const prompt = buildNativeParentPrompt(input);
    for (const marker of [input.roleId, input.requestId, input.childMarker, input.parentMarker]) assert(prompt.includes(marker));
    assert(prompt.includes('Do not save, change, or delete roles'));
    assert(prompt.includes('Create a new task using that roleId'));
    assert(prompt.includes('Do not modify any files'));
});
