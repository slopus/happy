import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { extractToolTraceFixturesFromJsonlLines } from '../src/toolTrace/extractToolTraceFixtures';

function parseArgs(argv: string[]): { inputs: string[]; outFile: string | null } {
    const inputs: string[] = [];
    let outFile: string | null = null;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--out' || arg === '-o') {
            const next = argv[i + 1];
            if (!next) throw new Error('Missing value for --out');
            outFile = next;
            i++;
            continue;
        }
        inputs.push(arg);
    }

    return { inputs, outFile };
}

function readJsonlLines(filePath: string): string[] {
    const raw = readFileSync(filePath, 'utf8');
    return raw.split('\n').filter((l) => l.trim().length > 0);
}

function main() {
    const { inputs, outFile } = parseArgs(process.argv.slice(2));
    if (inputs.length === 0) {
        // eslint-disable-next-line no-console
        console.error('Usage: tsx scripts/tool-trace-extract.ts [--out out.json] <trace.jsonl...>');
        process.exit(1);
    }

    const allLines: string[] = [];
    for (const input of inputs) {
        allLines.push(...readJsonlLines(resolve(input)));
    }

    const fixtures = extractToolTraceFixturesFromJsonlLines(allLines);
    const json = `${JSON.stringify(fixtures, null, 2)}\n`;

    if (outFile) {
        writeFileSync(resolve(outFile), json, 'utf8');
    } else {
        process.stdout.write(json);
    }
}

main();

