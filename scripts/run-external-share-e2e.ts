import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    createEnvironment,
    getEnvironmentConfig,
    getEnvironmentDir,
    startEnvironmentServices,
    startEnvironmentWeb,
    stopEnvironment,
} from '../environments/environments';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const armHomebrewBin = '/opt/homebrew/bin';
const packageVersion = '0.1.0-beta.0';

if (process.platform === 'darwin' && process.arch === 'arm64' && fs.existsSync(armHomebrewBin)) {
    process.env.PATH = `${process.env.PATH ?? ''}:${armHomebrewBin}`;
}

function run(command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }): void {
    const result = spawnSync(command, args, {
        cwd: options?.cwd ?? repoRoot,
        env: { ...process.env, ...options?.env },
        stdio: 'inherit',
    });
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}`);
    }
}

function installPackedCli(temporaryDirectory: string): string {
    const packDirectory = path.join(repoRoot, 'artifacts', 'paws-share-pack');
    const tarball = path.join(packDirectory, `wangjs-jacky-paws-share-${packageVersion}.tgz`);
    if (process.env.HAPPY_EXTERNAL_SHARE_SKIP_PACK !== '1' || !fs.existsSync(tarball)) {
        run('pnpm', ['--filter', '@wangjs-jacky/paws-share', 'verify:pack']);
    }
    if (!fs.statSync(tarball, { throwIfNoEntry: false })?.isFile()) {
        throw new Error(`Packed paws-share artifact is missing: ${tarball}`);
    }
    const installDirectory = path.join(temporaryDirectory, 'packed-cli');
    fs.mkdirSync(installDirectory, { recursive: true });
    run('npm', ['init', '-y'], { cwd: installDirectory });
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], { cwd: installDirectory });
    const cli = path.join(installDirectory, 'node_modules', '.bin', 'paws-share');
    if (!fs.statSync(cli, { throwIfNoEntry: false })?.isFile()) {
        throw new Error('Packed paws-share CLI was not installed');
    }
    return cli;
}

function prepareFixtures(temporaryDirectory: string): { codex: string; codexReplacement: string; claude: string; attachment: string } {
    const sourceDirectory = path.join(repoRoot, 'packages', 'paws-share', 'test', 'fixtures');
    const fixtureDirectory = path.join(temporaryDirectory, 'fixtures');
    fs.mkdirSync(fixtureDirectory, { recursive: true });
    const codex = path.join(fixtureDirectory, 'codex-session.jsonl');
    const codexReplacement = path.join(fixtureDirectory, 'codex-replacement-session.jsonl');
    const claude = path.join(fixtureDirectory, 'claude-code-session.jsonl');
    const attachment = path.join(fixtureDirectory, 'attachment.png');
    fs.writeFileSync(
        codex,
        fs.readFileSync(path.join(sourceDirectory, 'codex-session.jsonl'), 'utf8').replaceAll('attachment.svg', 'attachment.png'),
    );
    fs.writeFileSync(
        codexReplacement,
        fs.readFileSync(path.join(sourceDirectory, 'codex-session.jsonl'), 'utf8')
            .replaceAll('attachment.svg', 'attachment.png')
            .replace('The illustration is ready and keeps the same aspect ratio.', 'The updated illustration is ready on the same public link.'),
    );
    fs.writeFileSync(
        claude,
        fs.readFileSync(path.join(sourceDirectory, 'claude-code-session.jsonl'), 'utf8').replaceAll('attachment.svg', 'attachment.png'),
    );
    fs.copyFileSync(
        path.join(repoRoot, 'packages', 'happy-app', 'sources', 'assets', 'images', 'icon-adaptive.png'),
        attachment,
    );
    return { codex, codexReplacement, claude, attachment };
}

function collectFiles(directory: string, suffix: string): string[] {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) return collectFiles(target, suffix);
        return entry.isFile() && entry.name.endsWith(suffix) ? [target] : [];
    });
}

function convertRecordedVideo(playwrightOutput: string, artifactRoot: string): void {
    const candidates = collectFiles(playwrightOutput, '.webm')
        .sort((left, right) => fs.statSync(right).size - fs.statSync(left).size);
    if (candidates.length === 0) throw new Error('Playwright did not produce an E2E video');
    const output = path.join(artifactRoot, 'external-session-sharing-e2e.mp4');
    run('ffmpeg', [
        '-y',
        '-i', candidates[0],
        '-an',
        '-c:v', 'libx264',
        '-crf', '20',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        output,
    ]);
    process.stdout.write(`E2E video: ${output}\n`);
}

async function main(): Promise<void> {
    let environmentName: string | null = null;
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'paws-share-external-e2e-'));
    const artifactRoot = path.join(repoRoot, 'artifacts', 'external-session-share-e2e');
    const phase = process.env.HAPPY_E2E_RECORD === '1' ? 'recorded' : 'normal';
    const phaseDirectory = path.join(artifactRoot, phase);
    const playwrightOutput = path.join(phaseDirectory, 'playwright');
    const screenshots = path.join(phaseDirectory, 'screenshots');
    const playwrightArgs = process.argv.slice(2).filter((argument) => argument !== '--');

    fs.rmSync(phaseDirectory, { recursive: true, force: true });
    fs.mkdirSync(screenshots, { recursive: true });

    try {
        const cliPath = installPackedCli(temporaryDirectory);
        const fixtures = prepareFixtures(temporaryDirectory);
        run('pnpm', ['--filter', 'happy-server-self-host', 'generate']);
        environmentName = await createEnvironment({ noSwitch: true });

        await startEnvironmentServices(environmentName, {
            startWeb: false,
            waitForWebBundle: true,
        });
        await startEnvironmentWeb(environmentName, { warmBundle: true });

        const config = getEnvironmentConfig(environmentName);
        run(
            'pnpm',
            [
                '--filter', 'happy-app', 'exec', 'playwright', 'test',
                'e2e/external-session-sharing-evidence.spec.ts',
                ...playwrightArgs,
            ],
            {
                env: {
                    HAPPY_E2E_SERVER_URL: `http://localhost:${config.serverPort}`,
                    HAPPY_E2E_WEB_URL: `http://localhost:${config.expoPort}`,
                    HAPPY_E2E_OUTPUT_DIR: playwrightOutput,
                    HAPPY_EXTERNAL_SHARE_CLI_PATH: cliPath,
                    HAPPY_EXTERNAL_SHARE_HOME: path.join(temporaryDirectory, 'share-home'),
                    HAPPY_EXTERNAL_SHARE_CODEX_FIXTURE: fixtures.codex,
                    HAPPY_EXTERNAL_SHARE_CODEX_REPLACEMENT_FIXTURE: fixtures.codexReplacement,
                    HAPPY_EXTERNAL_SHARE_CLAUDE_FIXTURE: fixtures.claude,
                    HAPPY_EXTERNAL_SHARE_ATTACHMENT_FIXTURE: fixtures.attachment,
                    HAPPY_EXTERNAL_SHARE_EVIDENCE_DIR: screenshots,
                },
            },
        );

        if (process.env.HAPPY_E2E_RECORD === '1') {
            convertRecordedVideo(playwrightOutput, artifactRoot);
        }
    } catch (error) {
        if (environmentName) {
            for (const service of ['server', 'web']) {
                const logPath = path.join(getEnvironmentDir(environmentName), service, 'stdout.log');
                if (fs.existsSync(logPath)) {
                    process.stderr.write(`\n${service} log:\n${fs.readFileSync(logPath, 'utf8')}\n`);
                }
            }
        }
        throw error;
    } finally {
        if (environmentName) {
            stopEnvironment(environmentName);
            run('pnpm', ['exec', 'tsx', 'environments/environments.ts', 'remove', environmentName]);
        }
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
