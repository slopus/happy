import { createReducer, reducer } from '../sync/reducer';
import { normalizeRawMessage } from '../sync/typesRaw';

// Create a simple test case with a tool call and its result
const state = createReducer();

// First batch: User message + tool call
const batch1 = [
    normalizeRawMessage('user1', 'local1', 1000, {
        role: 'user',
        content: { type: 'text', text: 'Test message' }
    }),
    normalizeRawMessage('agent1', null, 2000, {
        role: 'agent',
        content: {
            type: 'output',
            data: {
                type: 'assistant',
                uuid: 'agent-uuid-1',
                message: {
                    role: 'assistant',
                    model: 'claude-3',
                    content: [
                        { type: 'text', text: 'Running a test tool...' },
                        {
                            type: 'tool_use',
                            id: 'toolu_123456',
                            name: 'TestTool',
                            input: { test: 'data' }
                        }
                    ]
                }
            }
        }
    })
].filter((msg): msg is NonNullable<typeof msg> => msg !== null);

console.log('=== Batch 1: Initial tool call ===');
const result1 = reducer(state, batch1);
console.log(`Messages returned: ${result1.length}`);
result1.forEach(msg => {
    if (msg.kind === 'tool-call') {
        console.log(`Tool: ${msg.tool.name}, State: ${msg.tool.state}, Has result: ${!!msg.tool.result}`);
    } else {
        console.log(`${msg.kind}: ${msg.kind === 'user-text' || msg.kind === 'agent-text' ? msg.text : ''}`);
    }
});

// Second batch: Tool result (comes as "user" type in real logs)
const batch2 = [
    normalizeRawMessage('toolresult1', null, 3000, {
        role: 'agent',
        content: {
            type: 'output',
            data: {
                type: 'user',
                uuid: 'tool-result-uuid-1',
                message: {
                    role: 'user',
                    content: [
                        {
                            tool_use_id: 'toolu_123456',
                            type: 'tool_result',
                            content: 'Tool completed successfully!'
                        }
                    ]
                },
                toolUseResult: 'Tool completed successfully!'
            }
        }
    })
].filter((msg): msg is NonNullable<typeof msg> => msg !== null);

console.log('\n=== Batch 2: Tool result ===');
console.log('State before batch 2:');
for (const [id, msg] of state.messages) {
    if (msg.tool) {
        console.log(`  ${id}: ${msg.tool.name} (${msg.tool.state})`);
    }
}
console.log(`Batch 2 messages: ${batch2.length}`);
const result2 = reducer(state, batch2);
console.log(`Messages returned: ${result2.length}`);
result2.forEach(msg => {
    if (msg.kind === 'tool-call') {
        console.log(`Tool: ${msg.tool.name}, State: ${msg.tool.state}, Has result: ${!!msg.tool.result}`);
        if (msg.tool.result) {
            console.log(`  Result: ${msg.tool.result}`);
        }
    } else {
        console.log(`${msg.kind}: ${msg.kind === 'user-text' || msg.kind === 'agent-text' ? msg.text : ''}`);
    }
});

// Check final state
console.log('\n=== Final state check ===');
console.log(`Total messages in state: ${state.messages.size}`);
console.log(`Tool ID mappings: ${state.toolIdToMessageId.size}`);
for (const [id, msg] of state.messages) {
    if (msg.tool) {
        console.log(`  ${id}: ${msg.tool.name} (${msg.tool.state}) - result: ${msg.tool.result || 'none'}`);
    }
}