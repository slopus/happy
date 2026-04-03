#!/usr/bin/env npx tsx

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { appendFile, cp, mkdir, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { UX_REVIEW_OUTPUT_DIR } from './walkthrough-flow';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const REPO_OUTPUT_DIR = join(REPO_ROOT, UX_REVIEW_OUTPUT_DIR);
const OUTPUT_DIR = process.env.HAPPY_WALKTHROUGH_OUTPUT_DIR
    ? resolvePath(REPO_ROOT, process.env.HAPPY_WALKTHROUGH_OUTPUT_DIR)
    : REPO_OUTPUT_DIR;
const SESSION_URL_FILE = join(OUTPUT_DIR, 'session-url.txt');
const DONE_MARKER_FILE = join(OUTPUT_DIR, 'walkthrough-driver.done');
const DRIVER_LOG_FILE = join(OUTPUT_DIR, 'walkthrough-driver.stdout.log');
const WEBREEL_LOG_FILE = join(OUTPUT_DIR, 'webreel-record.log');
const VERIFY_FILE = join(REPO_OUTPUT_DIR, 'walkthrough-verification.json');
const WEBREEL_BIN = process.env.HAPPY_WEBREEL_BIN;

function log(message: string): void {
    const ts = new Date().toISOString().slice(11, 23);
    console.log(`[${ts}] ${message}`);
}

async function reserveFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                server.close(() => reject(new Error('Failed to reserve a TCP port')));
                return;
            }
            const { port } = address;
            server.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(port);
            });
        });
    });
}

async function appendLogLine(path: string, chunk: string): Promise<void> {
    await mkdir(OUTPUT_DIR, { recursive: true });
    await appendFile(path, chunk).catch(() => {});
}

async function syncArtifactsToRepo(): Promise<string> {
    if (OUTPUT_DIR === REPO_OUTPUT_DIR) {
        return REPO_OUTPUT_DIR;
    }

    await rm(REPO_OUTPUT_DIR, { recursive: true, force: true }).catch(() => {});
    await mkdir(dirname(REPO_OUTPUT_DIR), { recursive: true });
    await cp(OUTPUT_DIR, REPO_OUTPUT_DIR, { recursive: true });
    return REPO_OUTPUT_DIR;
}

function spawnLoggedProcess(opts: {
    command: string;
    args: string[];
    label: string;
    logFile: string;
    env?: NodeJS.ProcessEnv;
}): ChildProcess {
    const child = spawn(opts.command, opts.args, {
        cwd: REPO_ROOT,
        env: opts.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', (chunk) => {
        const text = String(chunk);
        process.stdout.write(text);
        void appendLogLine(opts.logFile, text);
    });
    child.stderr?.on('data', (chunk) => {
        const text = String(chunk);
        process.stderr.write(text);
        void appendLogLine(opts.logFile, text);
    });
    child.on('exit', (code, signal) => {
        log(`${opts.label} exited with code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    });

    return child;
}

async function waitForFile(path: string, timeoutMs: number, child?: ChildProcess): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (existsSync(path)) {
            return;
        }
        if (child && child.exitCode !== null) {
            throw new Error(`Process exited before creating ${path}: code=${child.exitCode}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Timed out waiting for file: ${path}`);
}

async function waitForExit(child: ChildProcess): Promise<number> {
    if (child.exitCode !== null) {
        return child.exitCode;
    }
    return new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? 0));
    });
}

async function runCommandCapture(
    command: string,
    args: string[],
    logFile: string,
    env?: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: REPO_ROOT,
            env: env ?? process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk) => {
            const text = String(chunk);
            stdout += text;
            process.stdout.write(text);
            void appendLogLine(logFile, text);
        });
        child.stderr?.on('data', (chunk) => {
            const text = String(chunk);
            stderr += text;
            process.stderr.write(text);
            void appendLogLine(logFile, text);
        });
        child.on('error', reject);
        child.on('exit', (code) => {
            resolve({ code: code ?? 0, stdout, stderr });
        });
    });
}

function collectScreenshots(dir: string): string[] {
    if (!existsSync(dir)) {
        return [];
    }

    return readdirSync(dir)
        .filter((f: string) => /^(step-|component-).*\.png$/.test(f))
        .sort();
}

async function ffmpegGenerateVideo(
    screenshotDir: string,
    outputFile: string,
    logFile: string,
    env: NodeJS.ProcessEnv,
): Promise<boolean> {
    const pngs = collectScreenshots(screenshotDir);
    if (pngs.length === 0) {
        log('No screenshots found for ffmpeg video generation');
        return false;
    }

    const concatListFile = join(screenshotDir, 'ffmpeg-concat.txt');
    const concatLines = pngs.map(
        (f) => `file '${join(screenshotDir, f)}'\nduration 1`,
    );
    // Repeat the last frame so ffmpeg doesn't drop it
    concatLines.push(`file '${join(screenshotDir, pngs[pngs.length - 1]!)}'`);
    await writeFile(concatListFile, concatLines.join('\n'));

    log(`Generating MP4 from ${pngs.length} screenshots via ffmpeg...`);
    const result = await runCommandCapture(
        'ffmpeg',
        [
            '-y',
            '-f', 'concat',
            '-safe', '0',
            '-i', concatListFile,
            '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
            '-c:v', 'mjpeg',
            '-q:v', '15',
            '-r', '1',
            outputFile,
        ],
        logFile,
        env,
    );

    await unlink(concatListFile).catch(() => {});

    if (result.code !== 0) {
        log(`ffmpeg video generation failed with code ${result.code}`);
        return false;
    }

    log(`ffmpeg video generated: ${outputFile}`);
    return true;
}

async function main(): Promise<void> {
    const serverPort = process.env.HAPPY_TEST_SERVER_PORT ?? `${await reserveFreePort()}`;
    const webPort = process.env.HAPPY_WALKTHROUGH_WEB_PORT ?? `${await reserveFreePort()}`;
    const redirectPort = process.env.HAPPY_WALKTHROUGH_REDIRECT_PORT ?? `${await reserveFreePort()}`;
    const sharedEnv: NodeJS.ProcessEnv = {
        ...process.env,
        HAPPY_TEST_SERVER_PORT: serverPort,
        HAPPY_WALKTHROUGH_WEB_PORT: webPort,
        HAPPY_WALKTHROUGH_REDIRECT_PORT: redirectPort,
    };

    await rm(OUTPUT_DIR, { recursive: true, force: true }).catch(() => {});
    if (OUTPUT_DIR !== REPO_OUTPUT_DIR) {
        await rm(REPO_OUTPUT_DIR, { recursive: true, force: true }).catch(() => {});
    }

    log(`Reserved ports: server=${serverPort} web=${webPort} redirect=${redirectPort}`);
    log('Starting walkthrough driver...');
    const driver = spawnLoggedProcess({
        command: 'npx',
        args: ['tsx', 'packages/happy-sync/src/e2e/walkthrough-driver.ts'],
        label: 'walkthrough-driver',
        logFile: DRIVER_LOG_FILE,
        env: sharedEnv,
    });

    try {
        await waitForFile(SESSION_URL_FILE, 600000, driver);
        log(`Session URL ready: ${SESSION_URL_FILE}`);

        const webreelCommand = WEBREEL_BIN ?? 'npx';
        const webreelArgs = WEBREEL_BIN
            ? []
            : ['webreel'];

        log('Validating webreel config...');
        const validateResult = await runCommandCapture(
            webreelCommand,
            [...webreelArgs, 'validate', '-c', 'webreel.config.ts'],
            WEBREEL_LOG_FILE,
            sharedEnv,
        );
        if (validateResult.code !== 0) {
            throw new Error(`webreel validate failed with code ${validateResult.code}`);
        }

        log('Recording walkthrough with webreel...');
        const recordResult = await runCommandCapture(
            webreelCommand,
            [...webreelArgs, 'record', '-c', 'webreel.config.ts', '--verbose'],
            WEBREEL_LOG_FILE,
            sharedEnv,
        );

        // Webreel v0.1.4 has a known EPIPE bug during overlay compositing that
        // causes late-run failures (WebSocket connection closed, corrupt moov atom).
        // The screenshots are still captured successfully before the compositing
        // phase fails, so we treat a non-zero exit as non-fatal if PNGs exist.
        const webreelScreenshots = collectScreenshots(OUTPUT_DIR);
        if (recordResult.code !== 0) {
            if (webreelScreenshots.length > 0) {
                log(`webreel record exited with code ${recordResult.code} but ${webreelScreenshots.length} screenshots were captured — continuing with ffmpeg fallback`);
            } else {
                throw new Error(`webreel record failed with code ${recordResult.code} and no screenshots were captured`);
            }
        }

        await waitForFile(DONE_MARKER_FILE, 600000, driver);
        const driverExitCode = await waitForExit(driver);
        if (driverExitCode !== 0) {
            throw new Error(`walkthrough driver exited with code ${driverExitCode}`);
        }

        const finalOutputDir = await syncArtifactsToRepo();
        const finalVideoFile = join(finalOutputDir, 'happy-walkthrough.mp4');

        // Always generate the MP4 from captured PNGs via ffmpeg. This is more
        // reliable than webreel's CDP-based recording which consistently fails
        // during overlay compositing (EPIPE / corrupt moov atom).
        const webreelVideoExists = existsSync(finalVideoFile);
        const webreelVideoUsable = webreelVideoExists
            && (await stat(finalVideoFile)).size > 500_000;

        if (!webreelVideoUsable) {
            if (webreelVideoExists) {
                log('Webreel video is too small (likely corrupt) — regenerating with ffmpeg');
            }
            const ffmpegOk = await ffmpegGenerateVideo(
                finalOutputDir,
                finalVideoFile,
                WEBREEL_LOG_FILE,
                sharedEnv,
            );
            if (!ffmpegOk && !webreelVideoExists) {
                log('WARNING: No video artifact produced (both webreel and ffmpeg failed)');
            }
        } else {
            log('Webreel video looks usable — skipping ffmpeg regeneration');
        }

        let videoSizeBytes = 0;
        if (existsSync(finalVideoFile)) {
            videoSizeBytes = (await stat(finalVideoFile)).size;
        }

        let ffprobe: { code: number; stdout: string; stderr: string } | null = null;
        if (existsSync(finalVideoFile)) {
            try {
                ffprobe = await runCommandCapture(
                    'ffprobe',
                    ['-v', 'error', '-show_entries', 'format=duration,size', '-of', 'json', finalVideoFile],
                    WEBREEL_LOG_FILE,
                    sharedEnv,
                );
            } catch (error) {
                log(`ffprobe unavailable: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        const screenshotFiles = (await readdir(finalOutputDir))
            .filter((file) => file.endsWith('.png'))
            .sort();

        await writeFile(VERIFY_FILE, JSON.stringify({
            recordedAt: new Date().toISOString(),
            videoFile: existsSync(finalVideoFile) ? finalVideoFile : null,
            videoSizeBytes,
            videoSource: webreelVideoUsable ? 'webreel' : 'ffmpeg-from-screenshots',
            webreelExitCode: recordResult.code,
            screenshotCount: screenshotFiles.length,
            screenshots: screenshotFiles,
            ffprobe: ffprobe?.stdout ? JSON.parse(ffprobe.stdout) : null,
        }, null, 2));

        log(`Video: ${existsSync(finalVideoFile) ? finalVideoFile : 'NONE'} (${videoSizeBytes} bytes)`);
        log(`Video source: ${webreelVideoUsable ? 'webreel' : 'ffmpeg-from-screenshots'}`);
        log(`Screenshots: ${screenshotFiles.length}`);
        if (ffprobe?.stdout) {
            log(`ffprobe: ${ffprobe.stdout.trim()}`);
        }
        log(`Verification summary: ${VERIFY_FILE}`);
    } finally {
        if (driver.exitCode === null) {
            driver.kill('SIGTERM');
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    }
}

main().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exit(1);
});
