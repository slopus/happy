import { AgentState, Metadata } from '../storageTypes';
import { DecryptedMessage } from '../storageTypes';

interface CacheEntry<T> {
    data: T;
    accessTime: number;
}

/**
 * In-memory cache for decrypted session data to avoid expensive re-decryption
 * Uses sessionId + version as keys for agent state and metadata
 * Uses messageId as key for messages (immutable)
 */
export class EncryptionCache {
    private agentStateCache = new Map<string, CacheEntry<AgentState>>();
    private metadataCache = new Map<string, CacheEntry<Metadata>>();
    private messageCache = new Map<string, CacheEntry<DecryptedMessage>>();
    
    // Configuration
    private readonly maxAgentStates = 1000;
    private readonly maxMetadata = 1000;
    private readonly maxMessages = 1000;

    /**
     * Get cached agent state for a session
     */
    getCachedAgentState(sessionId: string, version: number): AgentState | null {
        const key = `${sessionId}:${version}`;
        const entry = this.agentStateCache.get(key);
        if (entry) {
            entry.accessTime = Date.now();
            return entry.data;
        }
        return null;
    }

    /**
     * Cache agent state for a session
     */
    setCachedAgentState(sessionId: string, version: number, data: AgentState): void {
        const key = `${sessionId}:${version}`;
        this.agentStateCache.set(key, {
            data,
            accessTime: Date.now()
        });
        
        // Evict if over limit
        this.evictOldest(this.agentStateCache, this.maxAgentStates);
    }

    /**
     * Get cached metadata for a session
     */
    getCachedMetadata(sessionId: string, version: number): Metadata | null {
        const key = `${sessionId}:${version}`;
        const entry = this.metadataCache.get(key);
        if (entry) {
            entry.accessTime = Date.now();
            return entry.data;
        }
        return null;
    }

    /**
     * Cache metadata for a session
     */
    setCachedMetadata(sessionId: string, version: number, data: Metadata): void {
        const key = `${sessionId}:${version}`;
        this.metadataCache.set(key, {
            data,
            accessTime: Date.now()
        });
        
        // Evict if over limit
        this.evictOldest(this.metadataCache, this.maxMetadata);
    }

    /**
     * Get cached decrypted message
     */
    getCachedMessage(messageId: string): DecryptedMessage | null {
        const entry = this.messageCache.get(messageId);
        if (entry) {
            entry.accessTime = Date.now();
            return entry.data;
        }
        return null;
    }

    /**
     * Cache decrypted message
     */
    setCachedMessage(messageId: string, data: DecryptedMessage): void {
        this.messageCache.set(messageId, {
            data,
            accessTime: Date.now()
        });
        
        // Evict if over limit
        this.evictOldest(this.messageCache, this.maxMessages);
    }

    /**
     * Clear all cache entries for a specific session
     */
    clearSessionCache(sessionId: string): void {
        // Clear agent state and metadata for this session (all versions)
        for (const key of this.agentStateCache.keys()) {
            if (key.startsWith(`${sessionId}:`)) {
                this.agentStateCache.delete(key);
            }
        }
        
        for (const key of this.metadataCache.keys()) {
            if (key.startsWith(`${sessionId}:`)) {
                this.metadataCache.delete(key);
            }
        }
        
        // Note: We don't clear messages as they're immutable and session-agnostic
    }

    /**
     * Clear all cached data
     */
    clearAll(): void {
        this.agentStateCache.clear();
        this.metadataCache.clear();
        this.messageCache.clear();
    }

    /**
     * Get cache statistics for debugging
     */
    getStats() {
        return {
            agentStates: this.agentStateCache.size,
            metadata: this.metadataCache.size,
            messages: this.messageCache.size,
            totalEntries: this.agentStateCache.size + this.metadataCache.size + this.messageCache.size
        };
    }

    /**
     * Evict oldest entries when cache exceeds limit (LRU eviction)
     */
    private evictOldest<T>(cache: Map<string, CacheEntry<T>>, maxSize: number): void {
        if (cache.size <= maxSize) {
            return;
        }

        // Find oldest entry by access time
        let oldestKey: string | null = null;
        let oldestTime = Infinity;
        
        for (const [key, entry] of cache.entries()) {
            if (entry.accessTime < oldestTime) {
                oldestTime = entry.accessTime;
                oldestKey = key;
            }
        }
        
        if (oldestKey) {
            cache.delete(oldestKey);
        }
    }
}