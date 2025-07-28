import fs from 'fs';
import path from 'path';
import { normalizeRawMessage } from '../../typesRaw';
import { createReducer, reducer } from '../../reducer';

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

// Create reducer and process messages
const state = createReducer();
const processedMessages = reducer(state, normalizedMessages);

console.log(`\nProcessed to ${processedMessages.length} root messages`);
console.log(`Task tools tracked: ${state.tracerState.taskTools.size}`);
console.log(`Total messages in state: ${state.messages.size}`);

// Debug sidechains
console.log('\nSidechain prompts:');
for (let [prompt, info] of state.sidechainMessages) {
    console.log(`  - "${prompt.substring(0, 50)}..." -> UUID: ${info.uuid}`);
}

// Check messages with matching parent UUIDs
console.log('\nChecking sidechain linkage:');
for (let [prompt, sidechain] of state.sidechainMessages) {
    console.log(`\nSidechain: "${prompt.substring(0, 40)}..."`);
    console.log(`  Root UUID: ${sidechain.uuid}`);
    
    // Find all messages in this chain
    let chainMessages = [];
    for (let msg of state.messages.values()) {
        if (msg.uuid === sidechain.uuid || msg.parentUUID === sidechain.uuid) {
            chainMessages.push(msg);
        }
    }
    
    console.log(`  Direct children found: ${chainMessages.length}`);
    for (let msg of chainMessages) {
        console.log(`    - ${msg.role} (uuid: ${msg.uuid}, parent: ${msg.parentUUID})`);
        if (msg.text) console.log(`      Text: "${msg.text.substring(0, 40)}..."`);
        if (msg.tool) console.log(`      Tool: ${msg.tool.name}`);
    }
}

// Find Task tools and show their children
let taskCount = 0;
for (const msg of processedMessages) {
    if (msg.kind === 'tool-call' && msg.tool.name === 'Task') {
        taskCount++;
        console.log(`\nTask ${taskCount}: "${msg.tool.description}"`);
        console.log(`  Prompt: "${msg.tool.input.prompt}"`);
        console.log(`  Children: ${msg.children.length}`);
        
        // Show all children recursively
        function showChildren(children: any[], indent: string = '    ') {
            for (let i = 0; i < children.length; i++) {
                const child = children[i];
                if (child.kind === 'user-text') {
                    console.log(`${indent}[${i}] User: ${child.text.substring(0, 50)}...`);
                } else if (child.kind === 'agent-text') {
                    console.log(`${indent}[${i}] Agent: ${child.text.substring(0, 50)}...`);
                } else if (child.kind === 'tool-call') {
                    console.log(`${indent}[${i}] Tool: ${child.tool.name} (${child.tool.state})`);
                    if (child.children && child.children.length > 0) {
                        showChildren(child.children, indent + '  ');
                    }
                }
            }
        }
        showChildren(msg.children);
    }
}

console.log(`\nTotal Task tools found: ${taskCount}`);

// Debug: Check what's in the first task's children in detail
if (processedMessages.length > 0) {
    const firstTask = processedMessages.find(m => m.kind === 'tool-call' && m.tool.name === 'Task');
    if (firstTask) {
        console.log('\n\nDetailed children of first Task:');
        console.log(`Task prompt: "${firstTask.tool.input.prompt}"`);
        console.log(`Total children: ${firstTask.children.length}`);
        
        // Check state for all messages with matching UUID chain
        const sidechainInfo = Array.from(state.sidechainMessages.values()).find(s => s.prompt === firstTask.tool.input.prompt);
        if (sidechainInfo) {
            console.log(`\nTracking chain from UUID: ${sidechainInfo.uuid}`);
            
            // Manually trace the chain
            let visited = new Set();
            let queue = [sidechainInfo.uuid];
            let chainLength = 0;
            
            while (queue.length > 0) {
                let currentUuid = queue.shift();
                if (visited.has(currentUuid)) continue;
                visited.add(currentUuid);
                
                for (let msg of state.messages.values()) {
                    if (msg.parentUUID === currentUuid && !visited.has(msg.uuid)) {
                        chainLength++;
                        console.log(`  Found child: ${msg.role} - ${msg.text?.substring(0, 30) || msg.tool?.name || 'unknown'} (uuid: ${msg.uuid})`);
                        if (msg.uuid) queue.push(msg.uuid);
                    }
                }
            }
            console.log(`\nTotal messages found in chain: ${chainLength}`);
            
            // Check what's actually in the Task's children
            console.log('\nActual Task children:');
            firstTask.children.forEach((child, i) => {
                //@ts-ignore
                const childInternal = child as any;
                console.log(`  [${i}] ${child.kind} - uuid: ${childInternal.uuid || 'none'} - parent: ${childInternal.parentUUID || 'none'}`);
                if (child.kind === 'user-text') {
                    console.log(`       Text: "${child.text.substring(0, 40)}..."`);
                } else if (child.kind === 'agent-text') {
                    console.log(`       Text: "${child.text.substring(0, 40)}..."`);
                } else if (child.kind === 'tool-call') {
                    console.log(`       Tool: ${child.tool.name}`);
                }
            });
        }
    }
}