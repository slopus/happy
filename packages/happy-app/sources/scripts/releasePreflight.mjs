#!/usr/bin/env node
/**
 * Refuses to release from anywhere but a local `main` that is `origin/main`.
 *
 * Every mobile release command runs this first: the preview and production
 * OTA scripts, and the native build scripts. It exists because of what
 * happened on 2026-09-20. A preview OTA was published from a worktree commit
 * that had branched off `main` hours earlier. That commit was fine on its
 * own, and it was later rebased and pushed, so `git log` looked right. But
 * expo-updates serves whatever was published last on a branch, not whatever
 * is on `main`, so for the next several hours every phone on the preview
 * channel ran a bundle missing four fixes that `main` already had. Nothing
 * failed. It just quietly shipped the past.
 *
 * The invariant is simple to state and cheap to check, so it is checked
 * rather than remembered: HEAD is `main`, `main` is exactly `origin/main`
 * as of a fetch made right now, and the tree is clean. If the release notes
 * changed, the generated `changelog.json` must already be committed too,
 * so the commit EAS records is the commit whose bytes ship.
 *
 * A release from anywhere else is a special case the user has to ask for by
 * name in the current conversation. Then, and only then, set
 * `HAPPY_RELEASE_ALLOW_OFF_MAIN=1`: the checks still run and still print
 * what is off, but they let the release through.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const allowOffMain = process.env.HAPPY_RELEASE_ALLOW_OFF_MAIN === '1';

function git(...args) {
    return execFileSync('git', args, { cwd: appDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const problems = [];

let fetched = true;
try {
    git('fetch', 'origin', 'main', '--quiet');
} catch (error) {
    fetched = false;
    problems.push(`could not fetch origin/main, so there is nothing to compare against (${String(error.stderr || error.message).trim()})`);
}

const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== 'main') {
    problems.push(`HEAD is "${branch}", not main`);
}

const head = git('rev-parse', 'HEAD');
const remote = fetched ? git('rev-parse', 'origin/main') : null;
if (remote && head !== remote) {
    const ahead = git('rev-list', '--count', 'origin/main..HEAD');
    const behind = git('rev-list', '--count', 'HEAD..origin/main');
    const missing = behind === '0' ? '' : `\n    commits on origin/main that this release would not include:\n${
        git('log', '--oneline', 'HEAD..origin/main').split('\n').map((line) => `      ${line}`).join('\n')}`;
    problems.push(`HEAD ${head.slice(0, 9)} is not origin/main ${remote.slice(0, 9)} (${ahead} ahead, ${behind} behind)${missing}`);
}

const dirtyBefore = git('status', '--porcelain');
if (dirtyBefore) {
    problems.push(`the working tree has uncommitted changes:\n${dirtyBefore.split('\n').map((line) => `      ${line}`).join('\n')}`);
}

// The in-app release notes are generated from CHANGELOG.md. Regenerate and
// insist the result is already committed: otherwise the bundle that ships
// carries notes that no commit on main does.
try {
    execFileSync('pnpm', ['exec', 'tsx', 'sources/scripts/parseChangelog.ts'], { cwd: appDir, stdio: ['ignore', 'ignore', 'pipe'] });
    const dirtyAfter = git('status', '--porcelain', '--', 'sources/changelog/changelog.json');
    if (dirtyAfter) {
        problems.push('CHANGELOG.md changed but sources/changelog/changelog.json was not regenerated and committed. Commit the regenerated file, push, then release.');
    }
} catch (error) {
    problems.push(`could not regenerate the changelog (${String(error.stderr || error.message).trim()})`);
}

if (problems.length === 0) {
    console.log(`Release preflight: main @ ${head.slice(0, 9)} is origin/main, tree clean, changelog committed.`);
    process.exit(0);
}

const header = allowOffMain
    ? 'Release preflight: proceeding OFF MAIN because HAPPY_RELEASE_ALLOW_OFF_MAIN=1 was set. Say so in the report.'
    : 'Release preflight: refusing to release.';
console.error(header);
for (const problem of problems) console.error(`  - ${problem}`);
if (!allowOffMain) {
    console.error('');
    console.error('Release from a local main that matches origin/main:');
    console.error('  git checkout main && git fetch origin main && git merge --ff-only origin/main');
    console.error('If the user asked, in this conversation, for a release from somewhere else, rerun with HAPPY_RELEASE_ALLOW_OFF_MAIN=1.');
    process.exit(1);
}
