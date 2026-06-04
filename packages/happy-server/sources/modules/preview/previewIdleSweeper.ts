import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '@/utils/log';

export type DockerCommandResult = {
    ok: boolean;
    stdout: string;
    stderr: string;
};

export type DockerCommandRunner = (args: string[]) => Promise<DockerCommandResult>;

export type SweepIdlePreviewContainersOptions = {
    idleTimeoutMs: number;
    docker?: DockerCommandRunner;
    now?: () => number;
};

export type SweepIdlePreviewContainersResult = {
    ok: boolean;
    scannedContainerIds: string[];
    stoppedContainerIds: string[];
};

export type PreviewIdleSweeperOptions = {
    enabled: boolean;
    intervalMs?: number;
    idleTimeoutMs?: number;
    docker?: DockerCommandRunner;
    now?: () => number;
    sweep?: () => Promise<unknown>;
    setIntervalFn?: (
        callback: () => Promise<void>,
        ms: number,
    ) => ReturnType<typeof setInterval>;
    clearIntervalFn?: (timer: ReturnType<typeof setInterval>) => void;
    logger?: Pick<typeof logger, 'warn' | 'info'>;
};

export type PreviewIdleSweeperController = {
    stop: () => void;
};

const execFileAsync = promisify(execFile);
const ACCESS_MARKER_PATH = '/tmp/aplus-preview-last-accessed-at';
const DEFAULT_SWEEP_INTERVAL_MS = 300_000;
const DEFAULT_IDLE_TIMEOUT_MS = 1_800_000;

function previewLabelFilter(): string[] {
    return [
        '--filter',
        'label=aplus.preview=true',
        '--filter',
        'label=aplus.managedBy=aplus-preview',
    ];
}

function splitIds(stdout: string): string[] {
    return stdout.trim().split(/\s+/).filter(Boolean);
}

function readAccessMarkerCommand(): string {
    return `cat ${ACCESS_MARKER_PATH} 2>/dev/null || true`;
}

function positiveNumber(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? value
        : fallback;
}

export async function runDocker(args: string[]): Promise<DockerCommandResult> {
    try {
        const { stdout, stderr } = await execFileAsync('docker', args, {
            maxBuffer: 1024 * 1024,
        });
        return { ok: true, stdout, stderr };
    } catch (error) {
        const e = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
        return {
            ok: false,
            stdout: typeof e.stdout === 'string' ? e.stdout : '',
            stderr:
                typeof e.stderr === 'string'
                    ? e.stderr
                    : typeof e.message === 'string'
                        ? e.message
                        : 'docker command failed',
        };
    }
}

export async function sweepIdlePreviewContainers(
    options: SweepIdlePreviewContainersOptions,
): Promise<SweepIdlePreviewContainersResult> {
    const docker = options.docker ?? runDocker;
    const now = options.now ? options.now() : Date.now();
    const list = await docker(['ps', '-q', ...previewLabelFilter()]);
    if (!list.ok) {
        return { ok: false, scannedContainerIds: [], stoppedContainerIds: [] };
    }

    const scannedContainerIds = splitIds(list.stdout);
    const stoppedContainerIds: string[] = [];

    for (const containerId of scannedContainerIds) {
        const marker = await docker([
            'exec',
            containerId,
            'sh',
            '-lc',
            readAccessMarkerCommand(),
        ]);
        if (!marker.ok) continue;
        const raw = marker.stdout.trim();
        if (!raw) continue;
        const lastAccessedAt = Number(raw);
        if (
            Number.isFinite(lastAccessedAt) &&
            now - lastAccessedAt >= options.idleTimeoutMs
        ) {
            stoppedContainerIds.push(containerId);
        }
    }

    if (stoppedContainerIds.length === 0) {
        return { ok: true, scannedContainerIds, stoppedContainerIds: [] };
    }

    const stop = await docker(['stop', ...stoppedContainerIds]);
    return {
        ok: stop.ok,
        scannedContainerIds,
        stoppedContainerIds,
    };
}

export function startPreviewIdleSweeper(
    options: PreviewIdleSweeperOptions,
): PreviewIdleSweeperController | null {
    if (!options.enabled) return null;

    const log = options.logger ?? logger;
    const intervalMs = positiveNumber(options.intervalMs, DEFAULT_SWEEP_INTERVAL_MS);
    const idleTimeoutMs = positiveNumber(options.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS);
    const setIntervalFn = options.setIntervalFn ?? setInterval;
    const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
    let isSweeping = false;

    const sweep = options.sweep ?? (() =>
        sweepIdlePreviewContainers({
            idleTimeoutMs,
            docker: options.docker,
            now: options.now,
        }));

    const timer = setIntervalFn(async () => {
        if (isSweeping) return;
        isSweeping = true;
        try {
            await sweep();
        } catch (error) {
            log.warn({ module: 'preview-idle-sweeper', error }, 'preview idle sweep failed');
        } finally {
            isSweeping = false;
        }
    }, intervalMs);

    if (typeof (timer as { unref?: () => void }).unref === 'function') {
        (timer as { unref: () => void }).unref();
    }

    log.info({ module: 'preview-idle-sweeper', intervalMs, idleTimeoutMs }, 'preview idle sweeper started');

    return {
        stop: () => {
            clearIntervalFn(timer);
        },
    };
}
