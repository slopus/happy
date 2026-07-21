import { describe, expect, it } from 'vitest';

import { appendDaemonSpawnModeArgs } from './spawnModeArgs';

describe('appendDaemonSpawnModeArgs', () => {
  it('forwards bypassPermissions for Claude daemon-started sessions', () => {
    const args = ['claude', '--happy-starting-mode', 'remote'];

    appendDaemonSpawnModeArgs(args, { directory: '.', permissionMode: 'bypassPermissions' }, 'claude');

    expect(args).toEqual([
      'claude',
      '--happy-starting-mode',
      'remote',
      '--permission-mode',
      'bypassPermissions',
    ]);
  });

  it('forwards plan for Claude daemon-started sessions', () => {
    const args = ['claude', '--happy-starting-mode', 'remote'];

    appendDaemonSpawnModeArgs(args, { directory: '.', permissionMode: 'plan' }, 'claude');

    expect(args).toEqual([
      'claude',
      '--happy-starting-mode',
      'remote',
      '--permission-mode',
      'plan',
    ]);
  });

  it('does not forward ambient Claude default so the CLI launch default is inherited', () => {
    const args = ['claude', '--happy-starting-mode', 'remote'];

    appendDaemonSpawnModeArgs(args, { directory: '.', permissionMode: 'default' }, 'claude');

    expect(args).toEqual(['claude', '--happy-starting-mode', 'remote']);
  });

  it('forwards explicit Codex default because it is ask-first, not ambient', () => {
    const args = ['codex', '--happy-starting-mode', 'remote'];

    appendDaemonSpawnModeArgs(args, { directory: '.', permissionMode: 'default' }, 'codex');

    expect(args).toEqual([
      'codex',
      '--happy-starting-mode',
      'remote',
      '--permission-mode',
      'default',
    ]);
  });

  it('forwards model and effort overrides without forwarding ambient default model', () => {
    const args = ['claude'];

    appendDaemonSpawnModeArgs(args, {
      directory: '.',
      permissionMode: 'bypassPermissions',
      modelMode: 'default',
      effortLevel: 'high',
    }, 'claude');

    expect(args).toEqual(['claude', '--permission-mode', 'bypassPermissions', '--effort', 'high']);
  });
});
