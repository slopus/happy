import { pubsub } from "@/services/pubsub";
import { db } from "@/storage/db";
import { backoff, delay } from "@/utils/time";

export function startTimeout() {
    backoff(async () => {
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
                await db.session.update({
                    where: { id: session.id },
                    data: { active: false }
                });
                pubsub.emit('update-ephemeral', {
                    type: 'activity',
                    id: session.id,
                    active: false,
                    activeAt: session.lastActiveAt.getTime()
                });
            }

            // Wait for 1 minute
            await delay(1000 * 60);
        }
    });
}