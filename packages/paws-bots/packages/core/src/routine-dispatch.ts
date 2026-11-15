/** A stale dispatch time is not proof that the worker is offline or the previous run failed. */
export function routineScheduleDelayed(
  routine: { active: boolean; nextRunAt: number | null },
  now = Date.now(),
): boolean {
  // Allow normal dispatch latency and a short deployment/startup gap.
  const graceMs = 5 * 60_000;
  return (
    routine.active &&
    routine.nextRunAt !== null &&
    Number.isFinite(routine.nextRunAt) &&
    Number.isFinite(now) &&
    now - routine.nextRunAt > graceMs
  );
}
