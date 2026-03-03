import { AuthCredentials } from '@/auth/tokenStorage';
import { getServerUrl } from './serverConfig';
import { FeedResponseSchema, FeedItem } from './feedTypes';
import { log } from '@/log';
import { backoff } from '@/utils/time';

/**
 * Fetch user's feed with pagination
 */
export async function fetchFeed(
    credentials: AuthCredentials,
    options?: {
        limit?: number;
        before?: string;
        after?: string;
    }
): Promise<{ items: FeedItem[]; hasMore: boolean }> {
    const API_ENDPOINT = getServerUrl();
    
    return await backoff(async () => {
        const params = new URLSearchParams();
        if (options?.limit) params.set('limit', options.limit.toString());
        if (options?.before) params.set('before', options.before);
        if (options?.after) params.set('after', options.after);
        
        const url = `${API_ENDPOINT}/v1/feed${params.toString() ? `?${params}` : ''}`;
        log.log(`📰 Fetching feed: ${url}`);
        
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${credentials.token}`
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch feed: ${response.status}`);
        }

        const data = await response.json();
        const parsed = FeedResponseSchema.safeParse(data);
        
        if (!parsed.success) {
            console.error('Failed to parse feed response:', parsed.error);
            throw new Error('Invalid feed response format');
        }

        // Add counter field from cursor
        const itemsWithCounter: FeedItem[] = parsed.data.items.map(item => ({
            ...item,
            counter: parseInt(item.cursor.substring(2), 10) // Extract counter from cursor format "0-{counter}"
        }));

        return {
            items: itemsWithCounter,
            hasMore: parsed.data.hasMore
        };
    });
}

export async function deleteFeedItem(
    credentials: AuthCredentials,
    itemId: string
): Promise<void> {
    const API_ENDPOINT = getServerUrl();
    const response = await fetch(`${API_ENDPOINT}/v1/feed/${itemId}`, {
        method: 'DELETE',
        headers: {
            'Authorization': `Bearer ${credentials.token}`
        }
    });
    if (!response.ok) {
        throw new Error(`Failed to delete feed item: ${response.status}`);
    }
}