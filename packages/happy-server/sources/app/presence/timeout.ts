import { db } from "@/storage/db";
import { delay } from "@/utils/delay";
import { forever } from "@/utils/forever";
import { shutdownSignal } from "@/utils/shutdown";
import { buildMachineActivityEphemeral, buildSessionActivityEphemeral, eventRouter } from "@/app/events/eventRouter";

export function startTimeout() {
    // Get timeout values from environment or use defaults
    const sessionTimeoutMinutes = parseInt(process.env.SESSION_TIMEOUT_MINUTES || '30', 10);
    const machineTimeoutMinutes = parseInt(process.env.MACHINE_TIMEOUT_MINUTES || '30', 10);

    console.log(`[Timeout] Session timeout: ${sessionTimeoutMinutes} minutes`);
    console.log(`[Timeout] Machine timeout: ${machineTimeoutMinutes} minutes`);

    forever('session-timeout', async () => {
        while (true) {
            // Find timed out sessions
            const sessions = await db.session.findMany({
                where: {
                    active: true,
                    lastActiveAt: {
                        lte: new Date(Date.now() - 1000 * 60 * sessionTimeoutMinutes)
                    }
                }
            });
            for (const session of sessions) {
                const updated = await db.session.updateManyAndReturn({
                    where: { id: session.id, active: true },
                    data: { active: false }
                });
                if (updated.length === 0) {
                    continue;
                }
                eventRouter.emitEphemeral({
                    userId: session.accountId,
                    payload: buildSessionActivityEphemeral(session.id, false, updated[0].lastActiveAt.getTime(), false),
                    recipientFilter: { type: 'user-scoped-only' }
                });
            }

            // Find timed out machines
            const machines = await db.machine.findMany({
                where: {
                    active: true,
                    lastActiveAt: {
                        lte: new Date(Date.now() - 1000 * 60 * machineTimeoutMinutes)
                    }
                }
            });
            for (const machine of machines) {
                const updated = await db.machine.updateManyAndReturn({
                    where: { id: machine.id, active: true },
                    data: { active: false }
                });
                if (updated.length === 0) {
                    continue;
                }
                eventRouter.emitEphemeral({
                    userId: machine.accountId,
                    payload: buildMachineActivityEphemeral(machine.id, false, updated[0].lastActiveAt.getTime()),
                    recipientFilter: { type: 'user-scoped-only' }
                });
            }

            // Wait for 1 minute
            await delay(1000 * 60, shutdownSignal);
        }
    });
}