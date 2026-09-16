#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_INTERVAL_MS = 10_000;
const NPM_REGISTRY = 'https://registry.npmjs.org';

function positiveInteger(value, label) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`${label} must be a positive integer; received ${value}`);
    }
    return parsed;
}

function parseNpmValue(stdout) {
    const value = stdout.trim();
    if (!value) return null;

    try {
        const parsed = JSON.parse(value);
        return typeof parsed === 'string' ? parsed : null;
    } catch {
        return value;
    }
}

async function npmView(args) {
    try {
        const { stdout } = await execFileAsync('npm', [
            'view',
            ...args,
            '--json',
            `--registry=${NPM_REGISTRY}`,
        ], {
            encoding: 'utf8',
            timeout: 30_000,
        });
        return parseNpmValue(stdout);
    } catch {
        return null;
    }
}

export async function verifyNpmPublication({
    packageName,
    expectedVersion,
    tag = 'latest',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    intervalMs = DEFAULT_INTERVAL_MS,
    lookupExactVersion = () => npmView([`${packageName}@${expectedVersion}`, 'version']),
    lookupTagVersion = () => npmView([packageName, `dist-tags.${tag}`]),
    sleep = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)),
    now = Date.now,
    log = console.log,
} = {}) {
    if (!packageName) throw new Error('packageName is required');
    if (!expectedVersion) throw new Error('expectedVersion is required');
    if (!tag) throw new Error('tag is required');
    positiveInteger(timeoutMs, 'timeoutMs');
    positiveInteger(intervalMs, 'intervalMs');

    const startedAt = now();
    let attempts = 0;
    let exactVersion = null;
    let taggedVersion = null;

    while (true) {
        attempts += 1;
        [exactVersion, taggedVersion] = await Promise.all([
            lookupExactVersion(),
            lookupTagVersion(),
        ]);

        const elapsedMs = now() - startedAt;
        if (exactVersion === expectedVersion && taggedVersion === expectedVersion) {
            log(`Verified ${packageName}@${expectedVersion} and npm tag ${tag} after ${attempts} attempt(s).`);
            return { exactVersion, taggedVersion, elapsedMs, attempts };
        }

        if (elapsedMs >= timeoutMs) {
            throw new Error(
                `npm publication verification timed out after ${timeoutMs}ms `
                + `(exact version: ${exactVersion ?? 'missing'}; ${tag}: ${taggedVersion ?? 'missing'})`,
            );
        }

        const exactStatus = exactVersion === expectedVersion
            ? `exact version is ${exactVersion}`
            : 'exact version is not visible';
        const tagStatus = `${tag} is ${taggedVersion ?? 'missing'}`;
        const remainingMs = timeoutMs - elapsedMs;
        const delayMs = Math.min(intervalMs, remainingMs);
        log(`${packageName}@${expectedVersion}: ${exactStatus}; ${tagStatus}. Retrying in ${delayMs}ms.`);
        await sleep(delayMs);
    }
}

async function main() {
    const [packageName, expectedVersion, tag = 'latest'] = process.argv.slice(2);
    const timeoutMs = positiveInteger(
        process.env.NPM_VERIFY_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS,
        'NPM_VERIFY_TIMEOUT_MS',
    );
    const intervalMs = positiveInteger(
        process.env.NPM_VERIFY_INTERVAL_MS ?? DEFAULT_INTERVAL_MS,
        'NPM_VERIFY_INTERVAL_MS',
    );

    console.log(
        `Waiting up to ${timeoutMs}ms for ${packageName}@${expectedVersion} and npm tag ${tag}.`,
    );
    await verifyNpmPublication({ packageName, expectedVersion, tag, timeoutMs, intervalMs });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main().catch((error) => {
        console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    });
}
