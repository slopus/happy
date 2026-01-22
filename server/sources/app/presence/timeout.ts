import { db } from "@/storage/db";
import { delay } from "@/utils/delay";
import { forever } from "@/utils/forever";
import { shutdownSignal } from "@/utils/shutdown";
import { buildMachineActivityEphemeral, buildSessionActivityEphemeral, eventRouter } from "@/app/events/eventRouter";

export function startTimeout() {
    forever('session-timeout', async () => {
        while (true) {
            // Find timed out sessions
            const sessions = await db.session.findMany({
                where: {
                    active: true,
                    lastActiveAt: {
                        lte: new Date(Date.now() - 1000 * 60 * 10) // 10 minutes
                    }
                }
            });
            for (const session of sessions) {
                const { count } = await db.session.updateMany({
                    where: { id: session.id, active: true },
                    data: { active: false }
                });
                if (count === 0) {
                    continue;
                }
                eventRouter.emitEphemeral({
                    userId: session.accountId,
                    payload: buildSessionActivityEphemeral(session.id, false, session.lastActiveAt.getTime(), false),
                    recipientFilter: { type: 'user-scoped-only' }
                });
            }

            // Find timed out machines
            const machines = await db.machine.findMany({
                where: {
                    active: true,
                    lastActiveAt: {
                        lte: new Date(Date.now() - 1000 * 60 * 10) // 10 minutes
                    }
                }
            });
            for (const machine of machines) {
                const { count } = await db.machine.updateMany({
                    where: { id: machine.id, active: true },
                    data: { active: false }
                });
                if (count === 0) {
                    continue;
                }
                eventRouter.emitEphemeral({
                    userId: machine.accountId,
                    payload: buildMachineActivityEphemeral(machine.id, false, machine.lastActiveAt.getTime()),
                    recipientFilter: { type: 'user-scoped-only' }
                });
            }

            // Wait for 1 minute
            await delay(1000 * 60, shutdownSignal);
        }
    });
}
