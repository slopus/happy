import { describe, expect, it } from 'vitest';
import { appendDaemonSpawnModeArgs, shouldForwardDaemonPermissionMode } from './spawnModeArgs';

describe('daemon spawn mode arguments', () => {
  it('forwards Codex default because it is a concrete ask-first policy', () => {
    const args: string[] = [];

    appendDaemonSpawnModeArgs(args, { directory: '/repo', permissionMode: 'default' }, 'codex');

    expect(args).toEqual(['--permission-mode', 'default']);
  });

  it('leaves Claude default ambient', () => {
    const args: string[] = [];

    appendDaemonSpawnModeArgs(args, { directory: '/repo', permissionMode: 'default' }, 'claude');

    expect(args).toEqual([]);
  });

  it('forwards explicit Codex permission, model, and effort selections', () => {
    const args: string[] = [];

    appendDaemonSpawnModeArgs(args, {
      directory: '/repo',
      permissionMode: 'yolo',
      modelMode: 'gpt-5.6-sol',
      effortLevel: 'medium',
    }, 'codex');

    expect(args).toEqual([
      '--permission-mode', 'yolo',
      '--model', 'gpt-5.6-sol',
      '--effort', 'medium',
    ]);
  });

  it('uses the same Codex default rule for resume launches', () => {
    expect(shouldForwardDaemonPermissionMode('codex', 'default')).toBe(true);
    expect(shouldForwardDaemonPermissionMode('claude', 'default')).toBe(false);
    expect(shouldForwardDaemonPermissionMode('agy', 'default')).toBe(false);
  });

  it('forwards explicit agy model, effort, and non-default permission selections', () => {
    const args: string[] = [];

    appendDaemonSpawnModeArgs(args, {
      directory: '/repo',
      permissionMode: 'bypassPermissions',
      modelMode: 'Gemini 4 Argon',
      effortLevel: 'high',
    }, 'agy');

    expect(args).toEqual([
      '--permission-mode', 'bypassPermissions',
      '--model', 'Gemini 4 Argon',
      '--effort', 'high',
    ]);
  });
});