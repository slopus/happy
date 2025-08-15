const crypto = require('crypto');
const fs = require('fs');

// Disable autoupdater (never works really)
process.env.DISABLE_AUTOUPDATER = '1';

// Helper to write JSON messages to fd 3
function writeMessage(message) {
    try {
        fs.writeSync(3, JSON.stringify(message) + '\n');
    } catch (err) {
        // fd 3 not available, ignore
    }
}

// Intercept crypto.randomUUID
const originalRandomUUID = crypto.randomUUID;
Object.defineProperty(global, 'crypto', {
    configurable: true,
    enumerable: true,
    get() {
        return {
            randomUUID: () => {
                const uuid = originalRandomUUID();
                writeMessage({ type: 'uuid', value: uuid });
                return uuid;
            }
        };
    }
});
Object.defineProperty(crypto, 'randomUUID', {
    configurable: true,
    enumerable: true,
    get() {
        return () => {
            const uuid = originalRandomUUID();
            writeMessage({ type: 'uuid', value: uuid });
            return uuid;
        }
    }
});

// Intercept fetch to track activity
const originalFetch = global.fetch;
let fetchCounter = 0;

global.fetch = function(...args) {
    const id = ++fetchCounter;
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    const method = args[1]?.method || 'GET';
    
    // Parse URL for privacy
    let hostname = '';
    let path = '';
    try {
        const urlObj = new URL(url, 'http://localhost');
        hostname = urlObj.hostname;
        path = urlObj.pathname;
    } catch (e) {
        // If URL parsing fails, use defaults
        hostname = 'unknown';
        path = url;
    }
    
    // Send fetch start event
    writeMessage({
        type: 'fetch-start',
        id,
        hostname,
        path,
        method,
        timestamp: Date.now()
    });

    // Execute the original fetch immediately
    const fetchPromise = originalFetch(...args);
    
    // Attach handlers to send fetch end event
    const sendEnd = () => {
        writeMessage({
            type: 'fetch-end',
            id,
            timestamp: Date.now()
        });
    };
    
    // Send end event on both success and failure
    fetchPromise.then(sendEnd, sendEnd);
    
    // Return the original promise unchanged
    return fetchPromise;
};

// Preserve fetch properties
Object.defineProperty(global.fetch, 'name', { value: 'fetch' });
Object.defineProperty(global.fetch, 'length', { value: originalFetch.length });

import('@anthropic-ai/claude-code/cli.js')