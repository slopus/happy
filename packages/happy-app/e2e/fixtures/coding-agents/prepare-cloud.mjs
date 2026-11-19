import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const out = path.join(root, 'packages/happy-app/test-results/coding-agent-cloud');
const pack = path.join(out, 'pack');
await fs.mkdir(path.join(pack, 'server'), { recursive: true });
for (const file of ['sources', 'prisma', 'tsconfig.json']) await fs.cp(path.join(root, 'packages/happy-server', file), path.join(pack, 'server', file), { recursive: true });
const pkg = JSON.parse(await fs.readFile(path.join(root, 'packages/happy-server/package.json'), 'utf8'));
const dependencies = {};
for (const [name, version] of Object.entries(pkg.dependencies)) {
    if (name === '@slopus/happy-wire' || name === '@paws/plugins') continue;
    const own = path.join(root, 'packages/happy-server/node_modules', name, 'package.json');
    const source = await fs.access(own).then(() => own, () => path.join(root, 'node_modules', name, 'package.json'));
    const resolved = JSON.parse(await fs.readFile(source, 'utf8'));
    dependencies[name] = resolved.version;
}
dependencies.tsx = JSON.parse(await fs.readFile(path.join(root, 'node_modules/tsx/package.json'), 'utf8')).version;
for (const [name, directory, archive] of [['@slopus/happy-wire', 'packages/happy-wire', 'wire'], ['@paws/plugins', 'node_modules/@paws/plugins', 'plugins']]) {
    const stage = path.join(out, archive, 'package');
    await fs.mkdir(stage, { recursive: true });
    for (const file of ['package.json', 'dist']) await fs.cp(path.join(root, directory, file), path.join(stage, file), { recursive: true, dereference: true });
    execFileSync('tar', ['-czf', path.join(pack, `${archive}.tgz`), '-C', path.dirname(stage), 'package']);
    dependencies[name] = `file:../${archive}.tgz`;
}
await fs.writeFile(path.join(pack, 'server/package.json'), JSON.stringify({ name: 'paws-coding-agent-cloud-e2e', private: true, type: 'module', dependencies }, null, 2));
console.log(JSON.stringify({ pack, dependencies: Object.keys(dependencies).length }));
