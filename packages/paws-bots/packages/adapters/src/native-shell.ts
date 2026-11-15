/** Computers whose commands run in the host's own shell rather than bash on Linux. */
export function usesNativeShell(kind: string): boolean {
  return kind === "desktop" || kind === "wuying";
}

/** Interpreter arguments for commands on a native host, independent of the backend's OS. */
export function nativeShellCommandArgv(
  command: string,
  environment: { platform: string; shell: string },
): string[] {
  return environment.platform === "win32"
    ? [environment.shell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]
    : [environment.shell, "-lc", command];
}
