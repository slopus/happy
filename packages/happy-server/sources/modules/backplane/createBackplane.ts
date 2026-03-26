import { Backplane } from "./backplane";
import { MemoryBackplane } from "./memoryBackplane";
import { RedisBackplane } from "./redisBackplane";
import { log } from "@/utils/log";

export async function createBackplane(): Promise<Backplane> {
    if (process.env.REDIS_URL) {
        const backplane = await RedisBackplane.create(process.env.REDIS_URL);
        log({ module: 'backplane', processId: backplane.getProcessId() }, `Backplane: redis (processId: ${backplane.getProcessId()})`);
        return backplane;
    }

    const backplane = new MemoryBackplane();
    log({ module: 'backplane', processId: backplane.getProcessId() }, `Backplane: memory (processId: ${backplane.getProcessId()}, single-process mode)`);
    return backplane;
}
