const {
    closeSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    writeFileSync,
} = require('node:fs');
const { spawnSync } = require('node:child_process');
const { dirname, join, relative, resolve, sep } = require('node:path');

function listFiles(root, current = root) {
    if (!existsSync(current)) return [];

    return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
        const absolutePath = join(current, entry.name);
        if (entry.isDirectory()) return listFiles(root, absolutePath);
        if (!entry.isFile()) return [];
        return [relative(root, absolutePath).split(sep).join('/')];
    });
}

function replaceFile(source, destination) {
    try {
        renameSync(source, destination);
        return;
    } catch (error) {
        const canUseWindowsFallback = process.platform === 'win32'
            && error instanceof Error
            && 'code' in error
            && (error.code === 'EEXIST' || error.code === 'EPERM');
        if (!canUseWindowsFallback) throw error;
    }

    const previous = `${destination}.previous-${process.pid}`;
    if (existsSync(destination)) renameSync(destination, previous);
    try {
        renameSync(source, destination);
    } catch (error) {
        if (existsSync(previous)) renameSync(previous, destination);
        throw error;
    }
    rmSync(previous, { force: true });
}

function promoteBuild(stagingDist, liveDist, requiredOutputs) {
    const required = new Set(requiredOutputs);
    for (const output of required) {
        if (!existsSync(join(stagingDist, output))) {
            throw new Error(`Build output is missing: ${output}`);
        }
    }

    mkdirSync(liveDist, { recursive: true });
    const files = listFiles(stagingDist).sort((left, right) => {
        const leftIsEntry = required.has(left) ? 1 : 0;
        const rightIsEntry = required.has(right) ? 1 : 0;
        return leftIsEntry - rightIsEntry || left.localeCompare(right);
    });

    for (const file of files) {
        const source = join(stagingDist, file);
        const destination = join(liveDist, file);
        mkdirSync(dirname(destination), { recursive: true });
        // Staging lives beside dist on the same filesystem. POSIX rename replaces
        // each complete file atomically, so dist/index.mjs is never removed first.
        replaceFile(source, destination);
    }
}

function runAtomicBuild({ packageDir, requiredOutputs, runTypecheck, runBundler }) {
    const liveDist = join(packageDir, 'dist');
    const lockPath = join(packageDir, '.paws-build.lock');
    const lockFd = openSync(lockPath, 'wx');
    let stagingRoot;

    try {
        writeFileSync(lockFd, `${process.pid}\n`);
        stagingRoot = mkdtempSync(join(packageDir, '.dist-build-'));
        const stagingDist = join(stagingRoot, 'dist');
        runTypecheck();
        runBundler(stagingDist);
        promoteBuild(stagingDist, liveDist, requiredOutputs);
    } finally {
        closeSync(lockFd);
        rmSync(lockPath, { force: true });
        if (stagingRoot) rmSync(stagingRoot, { recursive: true, force: true });
    }
}

function collectDistOutputs(packageJson) {
    const outputs = new Set();
    const visit = (value) => {
        if (typeof value === 'string') {
            if (value.startsWith('./dist/')) outputs.add(value.slice('./dist/'.length));
            return;
        }
        if (Array.isArray(value)) {
            value.forEach(visit);
            return;
        }
        if (value && typeof value === 'object') {
            Object.values(value).forEach(visit);
        }
    };

    visit(packageJson.main);
    visit(packageJson.module);
    visit(packageJson.types);
    visit(packageJson.exports);
    return [...outputs].sort();
}

function runCommand(command, args, cwd) {
    const result = spawnSync(command, args, {
        cwd,
        stdio: 'inherit',
        shell: process.platform === 'win32',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
    }
}

function main() {
    const packageDir = resolve(__dirname, '..');
    const packageJson = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
    const requiredOutputs = collectDistOutputs(packageJson);

    runAtomicBuild({
        packageDir,
        requiredOutputs,
        runTypecheck: () => runCommand('pnpm', ['exec', 'tsc', '--noEmit'], packageDir),
        runBundler: (stagingDist) => {
            const stagingRoot = dirname(stagingDist);
            const pkgrollPackage = require.resolve('pkgroll/package.json');
            const pkgrollCli = join(dirname(pkgrollPackage), 'dist/cli.mjs');
            const sourceRelative = relative(stagingRoot, join(packageDir, 'src')).split(sep).join('/');
            writeFileSync(join(stagingRoot, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
            runCommand(process.execPath, [
                pkgrollCli,
                '--srcdist', `${sourceRelative}:dist`,
                '--tsconfig', join(packageDir, 'tsconfig.json'),
            ], stagingRoot);
        },
    });
}

module.exports = { collectDistOutputs, promoteBuild, runAtomicBuild };

if (require.main === module) {
    main();
}
