import { Redis, RedisOptions } from "ioredis";
import { log, warn } from "@/utils/log";
import { Backplane, BackplaneHandler, createProcessId } from "./backplane";

interface RedisBackplaneEnvelope {
    payload: string;
}

const REDIS_CONNECT_TIMEOUT_MS = 1_000;

function createRedisOptions(): RedisOptions {
    return {
        lazyConnect: true,
        connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 0,
        retryStrategy: () => null,
    };
}

export class RedisBackplane implements Backplane {
    private readonly processId = createProcessId();
    private readonly publisher: Redis;
    private readonly subscriber: Redis;
    private readonly subscriptions = new Map<string, BackplaneHandler>();
    private destroyed = false;
    private ready = false;

    private constructor(redisUrl: string) {
        const redisOptions = createRedisOptions();
        this.publisher = new Redis(redisUrl, redisOptions);
        this.subscriber = new Redis(redisUrl, redisOptions);

        const handleRedisError = (client: 'publisher' | 'subscriber') => (error: Error) => {
            if (this.destroyed || !this.ready) {
                return;
            }
            warn({ module: 'backplane', client, error }, 'Redis backplane connection error');
        };

        this.publisher.on('error', handleRedisError('publisher'));
        this.subscriber.on('error', handleRedisError('subscriber'));

        this.subscriber.on('message', (channel, message) => {
            const handler = this.subscriptions.get(channel);
            if (!handler) {
                return;
            }

            try {
                const envelope = JSON.parse(message) as RedisBackplaneEnvelope;
                if (!envelope || typeof envelope.payload !== 'string') {
                    warn({ module: 'backplane', channel }, 'Received invalid Redis backplane payload');
                    return;
                }

                handler(Buffer.from(envelope.payload, 'base64'));
            } catch (error) {
                warn({ module: 'backplane', channel, error }, 'Failed to parse Redis backplane payload');
            }
        });
    }

    static async create(redisUrl: string): Promise<RedisBackplane> {
        const backplane = new RedisBackplane(redisUrl);
        try {
            await Promise.all([
                backplane.publisher.connect(),
                backplane.subscriber.connect()
            ]);
            await Promise.all([
                backplane.publisher.ping(),
                backplane.subscriber.ping()
            ]);
            backplane.ready = true;
            return backplane;
        } catch (error) {
            backplane.destroyed = true;
            backplane.publisher.disconnect();
            backplane.subscriber.disconnect();
            throw error;
        }
    }

    async publish(channel: string, payload: Buffer): Promise<void> {
        this.assertNotDestroyed();
        const envelope: RedisBackplaneEnvelope = {
            payload: payload.toString('base64')
        };
        await this.publisher.publish(channel, JSON.stringify(envelope));
    }

    async subscribe(channel: string, handler: BackplaneHandler): Promise<void> {
        this.assertNotDestroyed();

        const alreadySubscribed = this.subscriptions.has(channel);
        this.subscriptions.set(channel, handler);

        if (!alreadySubscribed) {
            await this.subscriber.subscribe(channel);
        }
    }

    async unsubscribe(channel: string): Promise<void> {
        const hadSubscription = this.subscriptions.delete(channel);
        if (!hadSubscription) {
            return;
        }

        if (!this.destroyed) {
            await this.subscriber.unsubscribe(channel);
        }
    }

    async destroy(): Promise<void> {
        if (this.destroyed) {
            return;
        }

        this.destroyed = true;
        const channels = Array.from(this.subscriptions.keys());
        this.subscriptions.clear();

        if (channels.length > 0) {
            try {
                await this.subscriber.unsubscribe(...channels);
            } catch (error) {
                warn({ module: 'backplane', error }, 'Failed to unsubscribe Redis backplane channels during shutdown');
            }
        }

        await Promise.allSettled([
            this.publisher.quit(),
            this.subscriber.quit()
        ]);
    }

    async isHealthy(): Promise<boolean> {
        if (this.destroyed) {
            return false;
        }

        try {
            await Promise.all([
                this.publisher.ping(),
                this.subscriber.ping()
            ]);
            return true;
        } catch (error) {
            log({ module: 'backplane', error }, 'Redis backplane health check failed');
            return false;
        }
    }

    getProcessId(): string {
        return this.processId;
    }

    getRedis(): Redis {
        return this.publisher;
    }

    private assertNotDestroyed(): void {
        if (this.destroyed) {
            throw new Error('Backplane has been destroyed');
        }
    }
}
