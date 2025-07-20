const crypto = require('crypto');
const fs = require('fs');
const original = crypto.randomUUID;
Object.defineProperty(global, 'crypto', {
    configurable: true,
    enumerable: true,
    get() {
        return {
            randomUUID: () => {
                const uuid = original();
                try {
                    fs.writeSync(3, `${uuid}\n`);
                } catch (err) {
                    // fd 3 not available, ignore
                }
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
            const uuid = original();
            try {
                fs.writeSync(3, `${uuid}\n`);
            } catch (err) {
                // fd 3 not available, ignore
            }
            return uuid;
        }
    }
});
import('@anthropic-ai/claude-code/cli.js')