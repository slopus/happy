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
    column_name?: string;
    p_level: number;
    p_name: string;
    p_color: string;
    flow_item_name: string;
    start_at: string | null;
    end_at: string | null;
    complete_at: string | null;
    overdue: boolean;
    task_user: Array<{ userid: number; nickname: string; owner?: number }>;
    task_tag?: Array<{ id: number; name: string; color: string }>;
    sub_num?: number;
    sub_complete?: number;
};

export type DooTaskFile = {
    id: number;
    name: string;
    size: number;
    ext: string;
    path: string;
    thumb: string | null;
    userid: number;
};

export type DooTaskFilters = {
    projectId?: number;
    status?: 'all' | 'uncompleted' | 'completed';
    search?: string;
    time?: string;
    role?: 'all' | 'owner' | 'assist';
};

export type DooTaskPager = {
    page: number;
    pagesize: number;
    total: number;
    hasMore: boolean;
};

export type DooTaskDialogMsg = {
    id: number;
    dialog_id: number;
    userid: number;
    type: 'text' | 'image' | 'file' | 'record' | 'notice' | 'meeting' | 'longtext' | 'template';
    msg: any;
    reply_id: number | null;
    reply_num: number;
    created_at: string;
    emoji: Record<string, any>;
    bot: number;
    modify: number;
    forward_id: number | null;
    forward_num: number;
};

export type DooTaskDialog = {
    id: number;
    name: string;
    type: string;
    group_type: string;
};
