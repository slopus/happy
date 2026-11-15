/**
 * Calls `stop` on SIGTERM or SIGINT; `stop` must tolerate repeat calls. The listeners stay
 * registered because libraries such as Composio's telemetry re-raise the signal after their own
 * cleanup: with no listener left, Node would die before `stop` hands back in-flight runs and
 * releases their computer leases.
 */
export function stopOnShutdownSignals(stop: () => unknown): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => void stop());
  }
}
