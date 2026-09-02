import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('./deploy-web.sh', import.meta.url));
const revision = '1234567890abcdef1234567890abcdef12345678';

async function createFixture() {
    const directory = await mkdtemp(join(tmpdir(), 'paws-web-deploy-test-'));
    const dist = join(directory, 'dist');
    const fakeBin = join(directory, 'bin');
    const logPath = join(directory, 'commands.log');
    const outputPath = join(directory, 'github-output');
    await mkdir(dist, { recursive: true });
    await mkdir(fakeBin, { recursive: true });
    await writeFile(join(dist, '.paws-release-revision'), `${revision}\n`);
    await writeFile(join(dist, 'index.html'), `<html><head><meta name="paws-release-revision" content="${revision}"></head></html>`);
    await writeFile(join(fakeBin, 'git'), `#!/usr/bin/env bash
printf 'git %s\\n' "$*" >> "$FAKE_COMMAND_LOG"
case "$*" in
  *"branch --show-current"*) printf 'main\\n' ;;
  *"status --short"*) ;;
  *"rev-parse HEAD"*) printf '%s\\n' "$FAKE_REVISION" ;;
  *"rev-parse refs/remotes/origin/main"*) printf '%s\\n' "$FAKE_REVISION" ;;
  *"show -s --format=%cI"*) printf '2026-09-02T00:00:00+00:00\\n' ;;
esac
exit 0
`);
    await writeFile(join(fakeBin, 'pnpm'), `#!/usr/bin/env bash\nprintf 'pnpm %s\\n' "$*" >> "$FAKE_COMMAND_LOG"\nexit 0\n`);
    await writeFile(join(fakeBin, 'curl'), `#!/usr/bin/env bash
printf 'curl %s\\n' "$*" >> "$FAKE_COMMAND_LOG"
printf '200'
exit 0
`);
    await writeFile(join(fakeBin, 'aliyun'), `#!/usr/bin/env bash
printf 'aliyun %s\\n' "$*" >> "$FAKE_COMMAND_LOG"
if [[ "$*" == "ossutil stat "* ]]; then
  exit 97
fi
if [[ "$FAKE_FAIL_FINAL_SWITCH" = "1" && "$*" == *"web/releases/$FAKE_REVISION/index.html oss://test-web-bucket/web/current/index.html"* ]]; then
  exit 42
fi
exit 0
`);
    await Promise.all(['git', 'pnpm', 'curl', 'aliyun'].map((name) => chmod(join(fakeBin, name), 0o755)));
    return { directory, dist, fakeBin, logPath, outputPath };
}

async function runDeploy(args = [], extraEnv = {}) {
    const fixture = await createFixture();
    try {
        const result = spawnSync('bash', [scriptPath, ...args], {
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: `${fixture.fakeBin}:${process.env.PATH}`,
                FAKE_COMMAND_LOG: fixture.logPath,
                FAKE_REVISION: revision,
                FAKE_FAIL_FINAL_SWITCH: '0',
                GITHUB_OUTPUT: fixture.outputPath,
                PAWS_SKIP_BUILD: '1',
                PAWS_WEB_DIST_DIR: fixture.dist,
                PAWS_WEB_ORIGIN: 'https://47.115.228.20:8443',
                PAWS_WEB_OSS_BUCKET: 'test-web-bucket',
                PAWS_WEB_OSS_ORIGIN: 'https://test-web-bucket.example.com',
                PAWS_WEB_RELEASE_ID: 'test-release',
                ...extraEnv,
            },
        });
        return {
            ...result,
            log: await readFile(fixture.logPath, 'utf8').catch(() => ''),
            githubOutput: await readFile(fixture.outputPath, 'utf8').catch(() => ''),
        };
    } finally {
        await rm(fixture.directory, { recursive: true, force: true });
    }
}

function cpLines(log) {
    return log.split('\n').filter((line) => line.startsWith('aliyun ossutil cp '));
}

test('backs up current and switches the verified HTML entry last', async () => {
    const result = await runDeploy();

    assert.equal(result.status, 0, result.stderr);
    const copies = cpLines(result.log);
    assert.match(copies[0], /web\/current\/\.paws-release-revision oss:\/\/test-web-bucket\/web\/rollback\/test-release\/\.paws-release-revision/);
    assert.match(copies[1], /web\/current\/index\.html oss:\/\/test-web-bucket\/web\/rollback\/test-release\/index\.html/);
    assert.match(copies[2], new RegExp(`web/releases/${revision}/\\.paws-release-revision oss://test-web-bucket/web/current/\\.paws-release-revision`));
    assert.match(copies[3], new RegExp(`web/releases/${revision}/index.html oss://test-web-bucket/web/current/index.html`));
    assert.equal(copies.length, 4, result.log);
    assert.equal(result.githubOutput, 'rollback_prefix=web/rollback/test-release\n');
    assert.doesNotMatch(result.log, /ossutil stat/);
    assert.match(result.log, /curl .*web\/releases\/.*\.paws-release-revision/);
});

test('restores the previous marker when the final HTML switch fails', async () => {
    const result = await runDeploy([], { FAKE_FAIL_FINAL_SWITCH: '1' });

    assert.notEqual(result.status, 0);
    const copies = cpLines(result.log);
    assert.match(copies.at(-2), new RegExp(`web/releases/${revision}/index.html oss://test-web-bucket/web/current/index.html`));
    assert.match(copies.at(-1), /web\/rollback\/test-release\/\.paws-release-revision oss:\/\/test-web-bucket\/web\/current\/\.paws-release-revision/);
});

test('rollback restores the marker first and HTML entry last', async () => {
    const result = await runDeploy(['--rollback', 'web/rollback/test-release']);

    assert.equal(result.status, 0, result.stderr);
    const copies = cpLines(result.log);
    assert.equal(copies.length, 2, result.log);
    assert.match(copies[0], /web\/rollback\/test-release\/\.paws-release-revision oss:\/\/test-web-bucket\/web\/current\/\.paws-release-revision/);
    assert.match(copies[1], /web\/rollback\/test-release\/index\.html oss:\/\/test-web-bucket\/web\/current\/index\.html/);
});
