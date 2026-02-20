import * as z from 'zod';

export const DooTaskProfileSchema = z.object({
    serverUrl: z.string(),
    token: z.string(),
    userId: z.number(),
    username: z.string(),
    avatar: z.string().nullable(),
    tokenExpiredAt: z.string().nullable().optional(),
    tokenRemainingSeconds: z.number().nullable().optional(),
    lastCheckedAt: z.string().nullable().optional(),
});

export type DooTaskProfile = z.infer<typeof DooTaskProfileSchema>;

export type DooTaskProject = {
    id: number;
    name: string;
};

export type DooTaskItem = {
    id: number;
    name: string;
    desc: string;
    project_id: number;
    project_name: string;
    p_level: number;
    p_name: string;
    p_color: string;
    flow_item_name: string;
    start_at: string | null;
    end_at: string | null;
    complete_at: string | null;
    overdue: boolean;
    taskUser: Array<{ userid: number; nickname: string; owner?: number }>;
};

export type DooTaskFilters = {
    projectId?: number;
    status?: 'all' | 'uncompleted' | 'completed';
    time?: string;
};

export type DooTaskPager = {
    page: number;
    pagesize: number;
    total: number;
    hasMore: boolean;
};
