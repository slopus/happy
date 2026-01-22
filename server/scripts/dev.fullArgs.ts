export type DevFullArgs = {
    port: number;
    killPort: boolean;
};

function parsePort(raw: string): number {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0 || n > 65535) {
        throw new Error(`Invalid port: ${raw}`);
    }
    return n;
}

export function parseDevFullArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): DevFullArgs {
    let port: number | null = env.PORT ? parsePort(env.PORT) : null;
    let killPort = false;

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];

        if (a === '--kill-port') {
            killPort = true;
            continue;
        }

        if (a === '--port') {
            const next = argv[i + 1];
            if (!next) {
                throw new Error(`Missing value for --port`);
            }
            port = parsePort(next);
            i++;
            continue;
        }

        if (a.startsWith('--port=')) {
            port = parsePort(a.slice('--port='.length));
            continue;
        }
    }

    return {
        port: port ?? 3005,
        killPort,
    };
}

