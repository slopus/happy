import { redis } from '@/services/redis';
import { delay } from '@/utils/delay';
import { forever } from '@/utils/forever';
import { log, warn } from '@/utils/log';
import { shutdownSignal } from '@/utils/shutdown';

const CLEANUP_INTERVAL = 60000; // 1 minute
let started = false;

// Start cleanup worker for all streams
export async function startCleanupWorker() {
    if (started) {
        return;
    }
    started = true;
    log('Starting Redis cleanup worker');
    
    forever('redis-cleanup', async () => {
        try {
            const now = Date.now();
            
            // Find all active_consumers:* keys
            const keys = await redis.keys('active_consumers:*');
            
            let totalCleaned = 0;
            
            for (const key of keys) {
                // Extract stream name from key: active_consumers:streamname
                const stream = key.substring('active_consumers:'.length);
                
                // Get all consumers with their expiration times
                const consumers = await redis.hgetall(key);
                
                const expiredConsumers: string[] = [];
                
                // Check each consumer's expiration time
                for (const [consumerGroup, expirationTime] of Object.entries(consumers)) {
                    if (parseInt(expirationTime) < now) {
                        expiredConsumers.push(consumerGroup);
                    }
                }
                
                if (expiredConsumers.length === 0) {
                    continue;
                }
                
                // Delete expired consumer groups
                let cleanedCount = 0;
                for (const consumerGroup of expiredConsumers) {
                    try {
                        await redis.xgroup('DESTROY', stream, consumerGroup);
                        cleanedCount++;
                    } catch (err: any) {
                        // Group might already be deleted or doesn't exist
                        if (!err.message?.includes('NOGROUP')) {
                            warn(`Failed to cleanup group ${consumerGroup} from stream ${stream}:`, err);
                        }
                    }
                }
                
                // Remove all expired consumers from active list at once
                if (expiredConsumers.length > 0) {
                    await redis.hdel(key, ...expiredConsumers);
                }
                
                if (cleanedCount > 0) {
                    log(`Cleaned up ${cleanedCount} expired consumer groups from stream: ${stream}`);
                    totalCleaned += cleanedCount;
                }
            }
            
            if (totalCleaned > 0) {
                log(`Total cleaned up: ${totalCleaned} consumer groups across all streams`);
            }
        } catch (err) {
            warn('Error during cleanup cycle:', err);
        }
        
        // Wait before next cleanup cycle
        await delay(CLEANUP_INTERVAL, shutdownSignal);
    });
}

