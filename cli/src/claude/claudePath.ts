import * as fs from 'node:fs';

export function claudePath(): string {
    if (fs.existsSync(process.env.HOME + '/.claude/local/claude')) {
        return process.env.HOME + '/.claude/local/claude';
    } else {
        return 'claude';
    }
}