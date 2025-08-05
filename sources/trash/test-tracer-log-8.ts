import fs from 'fs';
import path from 'path';
import { normalizeRawMessage } from '../sync/typesRaw';
import { createTracer, traceMessages } from '../sync/reducer/reducerTracer';

// Load and process log_8.json
const logPath = path.join(__dirname, '../log_8.json');
const logContent = fs.readFileSync(logPath, 'utf-8');
const rawMessages = JSON.parse(logContent);

console.log(`Processing ${rawMessages.length} raw messages from log_8.json...`);

// Normalize messages
const normalizedMessages = rawMessages
    .map((raw: any) => normalizeRawMessage(raw.id, raw.localId, raw.createdAt, raw.content))
    .filter(Boolean);

console.log(`Normalized to ${normalizedMessages.length} messages`);

// Create tracer and process messages
const tracerState = createTracer();
const tracedMessages = traceMessages(tracerState, normalizedMessages);

console.log(`\nTraced ${tracedMessages.length} messages`);
console.log(`Task tools found: ${tracerState.taskTools.size}`);
console.log(`Orphan buffers remaining: ${tracerState.orphanMessages.size}`);

// Analyze results
const sidechainMessages = tracedMessages.filter((msg: any) => msg.sidechainId);
const nonSidechainMessages = tracedMessages.filter((msg: any) => !msg.sidechainId);

console.log(`\nSidechain messages: ${sidechainMessages.length}`);
console.log(`Non-sidechain messages: ${nonSidechainMessages.length}`);

// Group by sidechain
const sidechainGroups = new Map<string, any[]>();
for (const msg of sidechainMessages) {
    if (msg.sidechainId) {
        const group = sidechainGroups.get(msg.sidechainId) || [];
        group.push(msg);
        sidechainGroups.set(msg.sidechainId, group);
    }
}

console.log(`\nSidechain groups: ${sidechainGroups.size}`);

// Show details for each sidechain
for (const [taskId, messages] of sidechainGroups) {
    const taskInfo = Array.from(tracerState.taskTools.values()).find((t: any) => t.messageId === taskId);
    console.log(`\nSidechain for Task "${taskInfo?.prompt?.substring(0, 50)}...":`);
    console.log(`  Task message ID: ${taskId}`);
    console.log(`  Messages in sidechain: ${messages.length}`);
    
    // Show first few messages
    for (let i = 0; i < Math.min(5, messages.length); i++) {
        const msg = messages[i];
        if (msg.role === 'user') {
            console.log(`    [${i}] User: ${msg.content.text?.substring(0, 40)}...`);
        } else if (msg.role === 'agent') {
            const firstContent = msg.content[0];
            if (firstContent.type === 'text') {
                console.log(`    [${i}] Agent text: ${firstContent.text.substring(0, 40)}...`);
            } else if (firstContent.type === 'tool-call') {
                console.log(`    [${i}] Agent tool: ${firstContent.name}`);
            } else if (firstContent.type === 'sidechain') {
                console.log(`    [${i}] Sidechain root: ${firstContent.prompt.substring(0, 40)}...`);
            } else if (firstContent.type === 'tool-result') {
                console.log(`    [${i}] Tool result for: ${firstContent.tool_use_id}`);
            }
        }
    }
    if (messages.length > 5) {
        console.log(`    ... and ${messages.length - 5} more messages`);
    }
}

// Check for any unprocessed orphans
if (tracerState.orphanMessages.size > 0) {
    console.log('\n⚠️  Warning: Unprocessed orphan messages:');
    for (const [parentUuid, orphans] of tracerState.orphanMessages) {
        console.log(`  Parent UUID ${parentUuid}: ${orphans.length} orphans`);
    }
}