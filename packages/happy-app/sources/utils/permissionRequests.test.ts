import { describe, expect, it } from 'vitest';
import { getPendingPermissionRequestIds, hasPendingPermissionRequests } from './permissionRequests';

describe('permission request state helpers', () => {
    it('treats requests that also exist in completedRequests as resolved', () => {
        const agentState = {
            requests: {
                req1: {
                    tool: 'Edit',
                    arguments: {},
                    createdAt: 1,
                },
                req2: {
                    tool: 'Bash',
                    arguments: {},
                    createdAt: 2,
                },
            },
            completedRequests: {
                req1: {
                    tool: 'Edit',
                    arguments: {},
                    createdAt: 1,
                    completedAt: 3,
                    status: 'approved' as const,
                },
            },
        };

        expect(getPendingPermissionRequestIds(agentState)).toEqual(['req2']);
        expect(hasPendingPermissionRequests(agentState)).toBe(true);
    });

    it('returns no pending permissions when all requests are completed', () => {
        const agentState = {
            requests: {
                req1: {
                    tool: 'Edit',
                    arguments: {},
                },
            },
            completedRequests: {
                req1: {
                    tool: 'Edit',
                    arguments: {},
                    status: 'approved' as const,
                },
            },
        };

        expect(getPendingPermissionRequestIds(agentState)).toEqual([]);
        expect(hasPendingPermissionRequests(agentState)).toBe(false);
    });
});
