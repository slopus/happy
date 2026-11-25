import assert from 'node:assert/strict';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function parseHarnessArguments(argv) {
    const args = new Map();
    for (let i = 0; i < argv.length; i += 1) {
        const flag = argv[i];
        assert(typeof flag === 'string' && flag.startsWith('--'), 'Use named arguments');
        const key = flag.slice(2);
        assert(!args.has(key), 'An argument was supplied more than once');
        if (key === 'run') args.set(key, true);
        else {
            const value = argv[++i];
            assert(typeof value === 'string' && !value.startsWith('--'), 'A named argument has no value');
            if (key === 'native-parent') {
                assert(value === 'true' || value === 'false', '--native-parent expects true or false');
                args.set(key, value === 'true');
            } else args.set(key, value);
        }
    }
    return args;
}

/** Only protocol containers are unwrapped; model output and tool results cannot impersonate envelopes. */
export function parseSessionProtocolEnvelope(raw) {
    if (!record(raw)) return null;
    let envelope = raw;
    if (raw.role === 'session' && record(raw.content)) envelope = raw.content.type === 'session' ? raw.content.data : raw.content;
    else if (record(raw.content) && raw.content.type === 'session') envelope = raw.content.data;
    else if (raw.type === 'session') envelope = raw.data;
    if (!record(envelope) || typeof envelope.id !== 'string' || !envelope.id || !record(envelope.ev)
        || !['agent', 'user'].includes(envelope.role) || typeof envelope.ev.t !== 'string') return null;
    return envelope;
}

/** Codex emits explicit server/tool arguments; ACP can emit an explicit namespaced name. */
export function happyDelegationTool(event) {
    if (!record(event) || event.t !== 'tool-call-start' || !record(event.args)) return null;
    if (event.name === 'McpTool') {
        if (event.args.server !== 'happy' || !['agent_roles', 'delegate_task'].includes(event.args.tool) || !record(event.args.arguments)) return null;
        return { name: event.args.tool, input: event.args.arguments };
    }
    for (const name of ['agent_roles', 'delegate_task']) {
        if ([name, `happy.${name}`, `happy__${name}`, `mcp__happy__${name}`].includes(event.name)) return { name, input: event.args };
    }
    const nativeTitle = typeof event.title === 'string' ? /^Run mcp_happy_(agent_roles|delegate_task)$/.exec(event.title) : null;
    if (nativeTitle && nativeTitle[0] === event.title) return { name: nativeTitle[1], input: event.args };
    return null;
}

export function buildNativeParentPrompt({ roleId, requestId, childMarker, parentMarker }) {
    const prompt = `Reply exactly ${childMarker}. Do not use tools, modify files, access external services, or delegate further.`;
    return [
        'This is an explicit request to delegate one synthetic acceptance task using the existing configured role. Do not modify any files.',
        'First call the Happy agent_roles tool with {"action":"list"} and confirm the existing role ID below. Do not save, change, or delete roles.',
        `Then call the Happy delegate_task tool with exactly ${JSON.stringify({ requestId, roleId, intent: 'explicit', prompt })}.`,
        'Create a new task using that roleId. Do not reuse any previous taskId, switch executor/model, or repeatedly query status. The tool waits for its outcome.',
        `Only after that tool succeeds and its child result contains ${childMarker}, reply exactly: ${parentMarker} ${childMarker}`,
        'If a tool or the child fails, report the actual failure and do not print the success markers.',
    ].join('\n\n');
}

/** Proof comes from this submitted parent root's native events plus its newly published child task. */
export function createNativeParentProof({ parentSessionId, localId, roleId, requestId, childMarker, parentMarker, previousTaskIds }) {
    const previous = new Set(previousTaskIds);
    const seen = new Set();
    const calls = new Map();
    let rootTurnId;
    let rootStatus;
    let text = '';
    return {
        observe(raw) {
            const envelope = parseSessionProtocolEnvelope(raw);
            if (!envelope || envelope.role !== 'agent' || envelope.subagent || seen.has(envelope.id)) return;
            seen.add(envelope.id);
            const event = envelope.ev;
            if (event.t === 'turn-start') {
                if (!Array.isArray(event.localIds) || event.localIds.length !== 1 || event.localIds[0] !== localId || typeof envelope.turn !== 'string') return;
                assert(!rootTurnId || rootTurnId === envelope.turn, 'Submitted input was associated with multiple parent roots');
                rootTurnId = envelope.turn;
            }
            if (!rootTurnId || envelope.turn !== rootTurnId) return;
            if (event.t === 'tool-call-start' && typeof event.call === 'string') {
                const tool = happyDelegationTool(event);
                const list = tool?.name === 'agent_roles' && tool.input.action === 'list';
                const delegate = tool?.name === 'delegate_task' && tool.input.roleId === roleId && tool.input.requestId === requestId
                    && tool.input.taskId === undefined && typeof tool.input.prompt === 'string' && tool.input.prompt.includes(childMarker);
                if (list || delegate) calls.set(event.call, { name: tool.name, callId: event.call, completed: false });
            } else if (event.t === 'tool-call-end' && calls.has(event.call)) {
                assert(!event.error && (event.status === undefined || event.status === 'completed'), 'A required native Happy tool call did not complete successfully');
                calls.get(event.call).completed = true;
            } else if (event.t === 'text' && !event.thinking && typeof event.text === 'string') {
                assert(text.length + event.text.length <= 64_000, 'Synthetic parent output exceeded the evidence limit');
                text += event.text;
            } else if (event.t === 'turn-end') {
                rootStatus = event.status;
            }
        },
        completed(summaries) {
            if (rootStatus === undefined) return;
            assert.equal(rootStatus, 'completed', 'The submitted native parent root did not complete');
            const successful = [...calls.values()].filter(call => call.completed);
            assert(successful.some(call => call.name === 'agent_roles'), 'No successful native agent_roles(list) call was observed');
            assert(successful.some(call => call.name === 'delegate_task'), 'No successful native delegate_task call with the submitted identity was observed');
            assert(text.includes(parentMarker) && text.includes(childMarker), 'The native parent final output did not contain both result markers');
            const tasks = (summaries ?? []).filter(task => task.parentSessionId === parentSessionId && task.roleId === roleId && !previous.has(task.id));
            assert(tasks.length <= 1, 'The native parent created more than one new delegated task');
            const task = tasks[0];
            if (!task || task.status === 'starting' || task.status === 'running') return;
            assert.equal(task.status, 'completed', 'The native parent child task did not complete');
            assert(task.childSessionId && task.childSessionId !== parentSessionId && task.resultAvailable, 'The native parent result lacks an independent completed child');
            return { task, rootTurnId, toolCalls: successful.map(call => ({ ...call })) };
        },
    };
}
