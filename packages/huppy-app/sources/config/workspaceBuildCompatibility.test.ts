import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Workspace build compatibility', () => {
    it('keeps the root postinstall script aligned with the checked-in huppy-wire workspace name', () => {
        const rootPackageJson = JSON.parse(readFileSync(resolve(process.cwd(), '../../package.json'), 'utf8')) as {
            workspaces: {
                packages: string[];
            };
        };
        const wirePackageJson = JSON.parse(readFileSync(resolve(process.cwd(), '../../packages/huppy-wire/package.json'), 'utf8')) as {
            name: string;
        };
        const postinstallScript = readFileSync(resolve(process.cwd(), '../../scripts/postinstall.cjs'), 'utf8');

        expect(rootPackageJson.workspaces.packages).toContain('packages/huppy-wire');
        expect(postinstallScript).toContain("require('../packages/huppy-wire/package.json').name");
        expect(postinstallScript).toContain('execSync(`yarn workspace ${wireWorkspaceName} build`');
        expect(wirePackageJson.name).toBe('@liangsili/huppy-wire');
        expect(postinstallScript).not.toContain('yarn workspace @slopus/happy-wire build');
    });
});
