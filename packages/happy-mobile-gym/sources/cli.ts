import { parseArgs } from 'node:util';
import { runCreate, runStart, runStatus } from './index.js';

const help = `happy-mobile-gym — private real mobile integration runtime

create --repository <root> --owner <label> --server-port <port> --metro-port <port>
start  --run <explicit run root>    foreground; Ctrl-C stops owned children
status --run <explicit run root>    file status, not a liveness claim

JSON output never contains credentials. There is no current-run pointer,
production target, simulator action, reset, or recursive-delete command.`;

async function main(): Promise<void> {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            repository: { type: 'string' }, owner: { type: 'string' },
            'server-port': { type: 'string' }, 'metro-port': { type: 'string' },
            run: { type: 'string' }, help: { type: 'boolean' },
        },
    });
    if (values.help || positionals.length === 0) { console.log(help); return; }
    if (positionals.length !== 1) throw new Error('Expected one command.');
    const [command] = positionals;
    if (command === 'create') {
        if (!values.repository || !values.owner || !values['server-port'] || !values['metro-port'] || values.run) throw new Error(help);
        console.log(JSON.stringify(await runCreate({
            repositoryRoot: values.repository, owner: values.owner,
            serverPort: Number(values['server-port']), metroPort: Number(values['metro-port']),
        })));
        return;
    }
    if (!values.run || values.repository || values.owner || values['server-port'] || values['metro-port']) throw new Error(help);
    if (command === 'status') { console.log(JSON.stringify(await runStatus(values.run))); return; }
    if (command !== 'start') throw new Error(help);
    const abort = new AbortController();
    const stop = () => abort.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
        const running = await runStart(values.run, { signal: abort.signal });
        console.log(JSON.stringify({ event: 'ready', manifest: running.manifest }));
        const completion = await running.finished;
        console.log(JSON.stringify({ event: 'finished', ...completion }));
        if (completion.reason === 'failed') process.exitCode = 1;
    } catch (error) {
        if (!abort.signal.aborted) throw error;
    } finally {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
    }
}

void main().catch((error: unknown) => {
    console.error(JSON.stringify({ event: 'error', message: error instanceof Error ? error.message : 'Mobile gym failed.' }));
    process.exitCode = 1;
});