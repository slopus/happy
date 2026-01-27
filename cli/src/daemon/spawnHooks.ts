export type DaemonSpawnValidationResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; errorMessage: string }>;

export type DaemonSpawnAuthEnvResult = Readonly<{
  env: Record<string, string>;
  /**
   * Cleanup to run when we fail BEFORE the child is successfully spawned.
   */
  cleanupOnFailure?: (() => void) | null;
  /**
   * Cleanup to run when the spawned child exits (tracked by PID).
   */
  cleanupOnExit?: (() => void) | null;
}>;

export type DaemonSpawnHooks = Readonly<{
  buildAuthEnv?: (params: Readonly<{ token: string }>) => Promise<DaemonSpawnAuthEnvResult>;
  validateSpawn?: (params: Readonly<{ experimentalCodexResume?: boolean; experimentalCodexAcp?: boolean }>) => Promise<DaemonSpawnValidationResult>;
  buildExtraEnvForChild?: (params: Readonly<{ experimentalCodexResume?: boolean; experimentalCodexAcp?: boolean }>) => Record<string, string>;
}>;

