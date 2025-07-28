import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createReducer, reducer } from '../sync/reducer';
import { normalizeRawMessage } from '../sync/typesRaw';

const testDataDir = join(__dirname, '..');
const logFiles = readdirSync(testDataDir).filter(f => f.startsWith('log_') && f.endsWith('.json'));

console.log(`Testing ${logFiles.length} log files...\n`);

// Collect all results
const allResults: any = {};

for (const logFile of logFiles) {
    console.log(`\n========== Testing ${logFile} ==========`);
    
    const result: any = {
        fileName: logFile,
        totalRawMessages: 0,
        normalizedMessages: 0,
        rootMessages: 0,
        totalTools: 0,
        messagesWithTools: 0,
        messagesWithChildren: 0,
        textMessagesWithParentId: 0,
        messageTree: [],
        errors: []
    };
    
    try {
        // Read and parse log file
        const logPath = join(testDataDir, logFile);
        const logContent = readFileSync(logPath, 'utf-8');
        const rawMessages = JSON.parse(logContent); // The file is the array directly
        
        result.totalRawMessages = rawMessages.length;
        console.log(`Total raw messages: ${rawMessages.length}`);
        
        // Normalize each message
        const normalizedMessages = [];
        for (let i = 0; i < rawMessages.length; i++) {
            try {
                const raw = rawMessages[i];
                const normalized = normalizeRawMessage(
                    raw.id, 
                    raw.content?.localKey || null,
                    Date.now(), // We don't have timestamp in the raw data
                    raw.content
                );
                if (normalized) {
                    normalizedMessages.push(normalized);
                }
            } catch (err) {
                const errorMsg = `Failed to normalize message ${i}: ${err}`;
                console.error(errorMsg);
                console.error('Raw message:', JSON.stringify(rawMessages[i], null, 2));
                result.errors.push(errorMsg);
            }
        }
        
        result.normalizedMessages = normalizedMessages.length;
        console.log(`Successfully normalized: ${normalizedMessages.length}/${rawMessages.length} messages`);
        
        // Process through reducer
        const state = createReducer();
        const reducerMessages = reducer(state, normalizedMessages);
        result.rootMessages = reducerMessages.length;
        console.log(`Reducer output: ${reducerMessages.length} root messages`);
        
        // Count tools and analyze structure
        let totalTools = 0;
        let messagesWithTools = 0;
        let messagesWithChildren = 0;
        let textMessagesWithParentId = 0;
        
        function analyzeMessage(msg: any, depth = 0) {
            const treeNode: any = {};
            
            if (msg.tool) {
                totalTools++;
                messagesWithTools++;
                console.log(`${'  '.repeat(depth)}- ${msg.tool.name} (${msg.tool.state})`);
                treeNode.type = 'tool';
                treeNode.name = msg.tool.name;
                treeNode.state = msg.tool.state;
            } else if (msg.text) {
                console.log(`${'  '.repeat(depth)}- Text: "${msg.text.substring(0, 50)}..."`);
                treeNode.type = 'text';
                treeNode.preview = msg.text.substring(0, 50) + '...';
            }
            
            if (msg.children && msg.children.length > 0) {
                messagesWithChildren++;
                treeNode.children = [];
                for (const child of msg.children) {
                    const childNode = analyzeMessage(child, depth + 1);
                    if (childNode) {
                        treeNode.children.push(childNode);
                    }
                }
            }
            
            return treeNode;
        }
        
        // Check for text messages with parent_id
        for (const normalized of normalizedMessages) {
            if (normalized.role === 'agent' && normalized.content) {
                for (const content of normalized.content) {
                    if (content.type === 'text' && content.parentUUID) {
                        textMessagesWithParentId++;
                    }
                }
            }
        }
        
        console.log('\nMessage tree structure:');
        for (const msg of reducerMessages) {
            const treeNode = analyzeMessage(msg);
            if (treeNode) {
                result.messageTree.push(treeNode);
            }
        }
        
        result.totalTools = totalTools;
        result.messagesWithTools = messagesWithTools;
        result.messagesWithChildren = messagesWithChildren;
        result.textMessagesWithParentId = textMessagesWithParentId;
        
        console.log(`\nStatistics:
- Total tools: ${totalTools}
- Messages with tools: ${messagesWithTools}
- Messages with children: ${messagesWithChildren}
- Text messages with parent_id: ${textMessagesWithParentId}`);
        
        // Specific check for Task tool with children
        for (const msg of reducerMessages) {
            function checkTaskTool(m: any) {
                if (m.tool && m.tool.name === 'Task' && m.children && m.children.length > 0) {
                    console.log(`\nFound Task tool with ${m.children.length} children`);
                    result.taskToolWithChildren = m.children.length;
                }
                if (m.children) {
                    for (const child of m.children) {
                        checkTaskTool(child);
                    }
                }
            }
            checkTaskTool(msg);
        }
        
    } catch (error) {
        const errorMsg = `Error processing ${logFile}: ${error}`;
        console.error(errorMsg);
        result.errors.push(errorMsg);
    }
    
    // Save result for this log file
    allResults[logFile] = result;
    
    // Write result next to log file
    const resultPath = join(testDataDir, logFile.replace('.json', '_result.json'));
    writeFileSync(resultPath, JSON.stringify(result, null, 2));
    console.log(`\nResults written to: ${resultPath}`);
}

// Write summary of all results
const summaryPath = join(testDataDir, 'test_summary.json');
writeFileSync(summaryPath, JSON.stringify(allResults, null, 2));
console.log(`\n\nSummary written to: ${summaryPath}`);