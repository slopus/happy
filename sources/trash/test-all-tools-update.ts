import { createReducer, reducer } from '../sync/reducer/reducer';
import { normalizeRawMessage } from '../sync/typesRaw';

// Test updates for different tools
const state = createReducer();

// Batch 1: Multiple tools
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
                        { type: 'text', text: 'Running multiple tools...' },
                        {
                            type: 'tool_use',
                            id: 'toolu_read',
                            name: 'Read',
                            input: { file_path: '/test.txt' }
                        },
                        {
                            type: 'tool_use', 
                            id: 'toolu_bash',
                            name: 'Bash',
                            input: { command: 'ls -la' }
                        },
                        {
                            type: 'tool_use',
                            id: 'toolu_task',
                            name: 'Task',
                            input: { prompt: 'Do something', description: 'Test task' }
                        }
                    ]
                }
            }
        }
    })
].filter((msg): msg is NonNullable<typeof msg> => msg !== null);

console.log('=== Batch 1: Initial tools ===');
const result1 = reducer(state, batch1);
console.log(`Messages returned: ${result1.length}`);
console.log('\nInitial tool states:');
for (const [id, msg] of state.messages) {
    if (msg.tool) {
        console.log(`  ${id}: ${msg.tool.name} (${msg.tool.state})`);
    }
}

// Batch 2: Tool results for Read and Bash
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
                            tool_use_id: 'toolu_read',
                            type: 'tool_result',
                            content: 'File contents here'
                        }
                    ]
                },
                toolUseResult: 'File contents here'
            }
        }
    }),
    normalizeRawMessage('toolresult2', null, 3100, {
        role: 'agent',
        content: {
            type: 'output',
            data: {
                type: 'user',
                uuid: 'tool-result-uuid-2',
                message: {
                    role: 'user',
                    content: [
                        {
                            tool_use_id: 'toolu_bash',
                            type: 'tool_result',
                            content: 'total 123\ndrwxr-xr-x  10 user  staff  320 Jan 1 12:00 .'
                        }
                    ]
                },
                toolUseResult: 'total 123\ndrwxr-xr-x  10 user  staff  320 Jan 1 12:00 .'
            }
        }
    })
].filter((msg): msg is NonNullable<typeof msg> => msg !== null);

console.log('\n=== Batch 2: Tool results ===');
const result2 = reducer(state, batch2);
console.log(`Messages returned: ${result2.length}`);
console.log('Returned messages:');
result2.forEach(msg => {
    if (msg.kind === 'tool-call') {
        console.log(`  ${msg.id}: ${msg.tool.name} (${msg.tool.state})`);
    }
});

console.log('\nTool states after batch 2:');
for (const [id, msg] of state.messages) {
    if (msg.tool) {
        console.log(`  ${id}: ${msg.tool.name} (${msg.tool.state}) - result: ${msg.tool.result ? 'yes' : 'no'}`);
    }
}

// Batch 3: More messages
const batch3 = [
    normalizeRawMessage('agent3', null, 4000, {
        role: 'agent',
        content: {
            type: 'output',
            data: {
                type: 'assistant',
                uuid: 'agent-uuid-3',
                message: {
                    role: 'assistant',
                    model: 'claude-3',
                    content: [
                        { type: 'text', text: 'Tools completed.' }
                    ]
                }
            }
        }
    })
].filter((msg): msg is NonNullable<typeof msg> => msg !== null);

console.log('\n=== Batch 3: Follow-up ===');
const result3 = reducer(state, batch3);
console.log(`Messages returned: ${result3.length}`);

// Final check
console.log('\n=== Final check ===');
console.log('All messages in state:');
for (const [id, msg] of state.messages) {
    if (msg.tool) {
        console.log(`  Tool ${id}: ${msg.tool.name} (${msg.tool.state})`);
    } else if (msg.text) {
        console.log(`  Text ${id}: ${msg.role} - "${msg.text.substring(0, 30)}..."`);
    }
}