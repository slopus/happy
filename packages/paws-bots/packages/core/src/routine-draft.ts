import type { Routine, RoutineEmailSenders } from "@rakazo/contracts";
import type { CronPreset } from "./cron.js";
import { presetFromCron } from "./cron.js";

/** The fields every routine editor changes; an editor that offers more triggers adds its own. */
export type RoutineDraft = {
  name: string;
  prompt: string;
  schedules: CronPreset[];
  /** Whose mail starts the routine; null without an email trigger. */
  emailSenders: RoutineEmailSenders | null;
  active: boolean;
};

export function emptyRoutineDraft(): RoutineDraft {
  return { name: "", prompt: "", schedules: [], emailSenders: null, active: true };
}

export function draftFromRoutine(
  routine: Pick<Routine, "name" | "prompt" | "crons" | "emailSenders" | "active">,
): RoutineDraft {
  return {
    name: routine.name,
    prompt: routine.prompt,
    schedules: routine.crons.map(presetFromCron),
    emailSenders: routine.emailSenders,
    active: routine.active,
  };
}
