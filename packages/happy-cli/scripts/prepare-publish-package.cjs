#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');

const BUNDLED_DEPENDENCIES = [
    '@slopus/happy-wire',
    '@paralleldrive/cuid2',
    '@noble/hashes',
    'zod'
];

function parseArgs(argv) {
    const args = { out: undefined };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];

        if (arg === '--out') {
            args.out = argv[index + 1];
            index += 1;
        } else if (arg.startsWith('--out=')) {
            args.out = arg.slice('--out='.length);
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    return args;
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function copyPath(source, destination) {
    if (!fs.existsSync(source)) {
        throw new Error(`Required publish input is missing: ${source}`);
    }

    fs.cpSync(source, destination, {
        dereference: true,
        force: true,
        recursive: true
    });
}

function cleanDirectory(directory) {
    fs.rmSync(directory, { force: true, recursive: true });
    fs.mkdirSync(directory, { recursive: true });
}

function dependencyPath(packageRoot, packageName) {
    return path.join(packageRoot, 'node_modules', ...packageName.split('/'));
}

function copyDependency(cliDir, packageName, destinationRoot) {
    const source = dependencyPath(cliDir, packageName);

    if (!fs.existsSync(source)) {
        throw new Error(`Installed dependency is missing: ${source}`);
    }

    const destination = path.join(destinationRoot, 'node_modules', ...packageName.split('/'));
    copyPath(fs.realpathSync(source), destination);

    return destination;
}

function copyPackageFiles(packageDir, destination, files) {
    fs.mkdirSync(destination, { recursive: true });

    for (const file of files) {
        copyPath(path.join(packageDir, file), path.join(destination, file));
    }
}

function preparePublishPackage() {
    const args = parseArgs(process.argv.slice(2));
    const cliDir = path.resolve(__dirname, '..');
    const packagesDir = path.resolve(cliDir, '..');
    const wireDir = path.join(packagesDir, 'happy-wire');
    const outputDir = args.out
        ? path.resolve(args.out)
        : fs.mkdtempSync(path.join(os.tmpdir(), 'happy-cli-publish-'));

    cleanDirectory(outputDir);

    const cliPackage = readJson(path.join(cliDir, 'package.json'));
    const wirePackage = readJson(path.join(wireDir, 'package.json'));

    if (fs.existsSync(path.join(cliDir, 'README.md'))) {
        copyPath(path.join(cliDir, 'README.md'), path.join(outputDir, 'README.md'));
    }

    for (const entry of cliPackage.files || []) {
        if (entry === 'package.json') {
            continue;
        }

        copyPath(path.join(cliDir, entry), path.join(outputDir, entry));
    }

    const publishPackage = {
        ...cliPackage,
        dependencies: {
            ...cliPackage.dependencies,
            '@slopus/happy-wire': wirePackage.version
        },
        scripts: {
            ...cliPackage.scripts,
            prepublishOnly: 'node scripts/guard-publish-artifact.cjs . --install-smoke'
        },
        bundledDependencies: BUNDLED_DEPENDENCIES
    };

    fs.writeFileSync(
        path.join(outputDir, 'package.json'),
        `${JSON.stringify(publishPackage, null, 2)}\n`
    );

    copyPackageFiles(
        wireDir,
        path.join(outputDir, 'node_modules', '@slopus', 'happy-wire'),
        ['README.md', 'package.json', 'dist']
    );

    const cuid2Destination = copyDependency(cliDir, '@paralleldrive/cuid2', outputDir);
    copyDependency(cliDir, '@noble/hashes', outputDir);
    copyDependency(cliDir, 'zod', outputDir);

    const cuid2Source = fs.realpathSync(dependencyPath(cliDir, '@paralleldrive/cuid2'));
    const cuid2NestedNoble = path.resolve(cuid2Source, '..', '..', '@noble', 'hashes');

    if (!fs.existsSync(cuid2NestedNoble)) {
        throw new Error(`Nested @noble/hashes dependency for @paralleldrive/cuid2 is missing: ${cuid2NestedNoble}`);
    }

    copyPath(
        cuid2NestedNoble,
        path.join(cuid2Destination, 'node_modules', '@noble', 'hashes')
    );

    console.log(`Prepared ${cliPackage.name}@${cliPackage.version}`);
    console.log(`Output: ${outputDir}`);
    console.log(`@slopus/happy-wire dependency: ${wirePackage.version}`);
    console.log(`Bundled dependencies: ${BUNDLED_DEPENDENCIES.join(', ')}`);
}

try {
    preparePublishPackage();
} catch (error) {
    console.error(error.message);
    process.exit(1);
}
