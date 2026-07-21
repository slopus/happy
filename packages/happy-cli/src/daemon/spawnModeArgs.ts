import type { SpawnSessionOptions } from '@/modules/common/registerCommonHandlers';

export function appendDaemonSpawnModeArgs(args: string[], options: SpawnSessionOptions, agent: string): void {
  if (agent !== 'claude' && agent !== 'codex') {
    return;
  }
  // For Claude, 'default' is the app's ambient "no override" value. Forwarding
  // it would pin daemon-started sessions to prompting mode and lose the CLI
  // default (for example a yolo setup where sessions must bypass permissions).
  // For Codex, 'default' is a concrete ask-first mode distinct from Codex's
  // launch default ('yolo'), so explicit app picks must be forwarded.
  if (options.permissionMode && (agent === 'codex' || options.permissionMode !== 'default')) {
    args.push('--permission-mode', options.permissionMode);
  }
  if (options.modelMode && options.modelMode !== 'default') {
    args.push('--model', options.modelMode);
  }
  if (options.effortLevel) {
    args.push('--effort', options.effortLevel);
  }
}
