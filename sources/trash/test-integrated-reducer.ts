import fs from 'fs';
import path from 'path';
import { normalizeRawMessage } from '../sync/typesRaw';
import { createReducer, reducer } from '../sync/reducer';

// Load and process trace_0.json
const logPath = path.join(__dirname, '../trace_0.json');
const logContent = fs.readFileSync(logPath, 'utf-8');
const rawMessages = JSON.parse(logContent);

console.log(`Processing ${rawMessages.length} raw messages from trace_0.json...`);

// Normalize messages
const normalizedMessages = rawMessages
    .map((raw: any) => normalizeRawMessage(raw.id, raw.localId, raw.createdAt, raw.content))
    .filter(Boolean);

console.log(`Normalized to ${normalizedMessages.length} messages`);

// Create reducer and process messages
const state = createReducer();
const processedMessages = reducer(state, normalizedMessages);

console.log(`\nProcessed to ${processedMessages.length} root messages`);
console.log(`Task tools tracked: ${state.tracerState.taskTools.size}`);
console.log(`Total messages in state: ${state.messages.size}`);
console.log(`Sidechains in state: ${state.sidechains.size}`);

// Debug: Show what's in sidechains
console.log('\nSidechain keys:');
for (const [key, value] of state.sidechains) {
    console.log(`  ${key}: ${value.length} messages`);
}

// Find Task tools and show their children
let taskCount = 0;
for (const msg of processedMessages) {
    if (msg.kind === 'tool-call' && msg.tool.name === 'Task') {
        taskCount++;
        console.log(`\nTask ${taskCount}: "${msg.tool.description}"`);
        console.log(`  Internal ID: ${msg.id}`);
        console.log(`  Prompt: "${msg.tool.input.prompt}"`);
        console.log(`  State: ${msg.tool.state}`);
        console.log(`  Children: ${msg.children.length}`);
        
        // Show first few children
        for (let i = 0; i < Math.min(10, msg.children.length); i++) {
            const child = msg.children[i];
            if (child.kind === 'user-text') {
                console.log(`    [${i}] User: ${child.text.substring(0, 50)}...`);
            } else if (child.kind === 'agent-text') {
                console.log(`    [${i}] Agent: ${child.text.substring(0, 50)}...`);
            } else if (child.kind === 'tool-call') {
                console.log(`    [${i}] Tool: ${child.tool.name} (${child.tool.state})`);
            }
        }
        if (msg.children.length > 10) {
            console.log(`    ... and ${msg.children.length - 10} more`);
        }
    }
}

console.log(`\nTotal Task tools found: ${taskCount}`);

// Show non-task messages
console.log(`\nNon-Task messages:`);
for (const msg of processedMessages) {
    if (msg.kind === 'user-text') {
        console.log(`  User: "${msg.text.substring(0, 50)}..."`);
    } else if (msg.kind === 'agent-text') {
        console.log(`  Agent: "${msg.text.substring(0, 50)}..."`);
    } else if (msg.kind === 'tool-call' && msg.tool.name !== 'Task') {
        console.log(`  Tool: ${msg.tool.name} (${msg.tool.state})`);
    }
}