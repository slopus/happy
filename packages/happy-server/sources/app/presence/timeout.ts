import { db } from "@/storage/db";
import { delay } from "@/utils/delay";
import { forever } from "@/utils/forever";
import { shutdownSignal } from "@/utils/shutdown";
import { buildMachineActivityEphemeral, buildSessionActivityEphemeral, eventRouter } from "@/app/events/eventRouter";

export function startTimeout() {
    // Session and machine timeout is disabled.
    // Cleanup happens via daemon restart (cron at 4 AM)
    // which kills zombie processes and recovers active sessions.
}