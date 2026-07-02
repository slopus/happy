import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { resolveHappyCliSpawnCommand } from './spawnHappyCLI';

describe('resolveHappyCliSpawnCommand', () => {
  it('uses the source entrypoint when the current CLI is running from source', () => {
    const projectRoot = '/repo/packages/happy-cli';
    const result = resolveHappyCliSpawnCommand(['daemon', 'start-sync'], {
      projectRoot,
      execPath: '/node',
      execArgv: ['--import', '/repo/node_modules/tsx/loader.mjs'],
      argv: ['/node', join(projectRoot, 'src', 'index.ts'), 'daemon', 'start-sync'],
      isBunRuntime: false,
    });

    expect(result.runtime).toBe('/node');
    expect(result.entrypoint).toBe(join(projectRoot, 'src', 'index.ts'));
    expect(result.tsconfigPath).toBe(join(projectRoot, 'tsconfig.json'));
    expect(result.args).toEqual([
      '--no-warnings',
      '--no-deprecation',
      '--import',
      '/repo/node_modules/tsx/loader.mjs',
      join(projectRoot, 'src', 'index.ts'),
      'daemon',
      'start-sync',
    ]);
  });

  it('uses the bundled dist entrypoint for production CLI processes', () => {
    const projectRoot = '/repo/packages/happy-cli';
    const result = resolveHappyCliSpawnCommand(['claude'], {
      projectRoot,
      execPath: '/node',
      execArgv: [],
      argv: ['/node', join(projectRoot, 'dist', 'index.mjs'), 'daemon', 'start-sync'],
      isBunRuntime: false,
    });

    expect(result.runtime).toBe('node');
    expect(result.entrypoint).toBe(join(projectRoot, 'dist', 'index.mjs'));
    expect(result.tsconfigPath).toBeUndefined();
    expect(result.args).toEqual([
      '--no-warnings',
      '--no-deprecation',
      join(projectRoot, 'dist', 'index.mjs'),
      'claude',
    ]);
  });
});
