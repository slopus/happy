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
    msg_num?: number;
    dialog_id?: number;
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

export type EmojiReaction = { symbol: string; userids: number[] };

export type DooTaskDialogMsg = {
    id: number;
    dialog_id: number;
    userid: number;
    type: 'text' | 'image' | 'file' | 'record' | 'notice' | 'tag' | 'top' | 'todo' | 'meeting' | 'longtext' | 'template' | 'vote' | 'word-chain';
    msg: any;
    reply_id: number | null;
    reply_num: number;
    created_at: string;
    emoji: EmojiReaction[];
    bot: number;
    modify: number;
    forward_id: number | null;
    forward_num: number;
};

export type PendingMessageStatus = 'sending' | 'sending-quiet' | 'error';

export type PendingMessage = {
    _pendingId: string;
    _pending: PendingMessageStatus;
    _errorMsg?: string;
    dialog_id: number;
    userid: number;
    type: 'text' | 'image' | 'file';
    msg: any;
    reply_id: number | null;
    created_at: string;
};

export type DisplayMessage = DooTaskDialogMsg | PendingMessage;

export type DooTaskDialog = {
    id: number;
    name: string;
    type: string;
    group_type: string;
    avatar: string | null;
    owner_id: number;
};

export type DooTaskDialogUser = {
    userid: number;
    nickname: string;
    userimg: string | null;
    profession: string | null;
    department: string | null;
    bot: number;
    online: boolean;
    disable_at: string | null;
};

// --- Create Types ---

export type DooTaskColumn = {
    id: number;
    name: string;
    sort: number;
};

export type DooTaskPriority = {
    priority: number;
    name: string;
    color: string;
    days: number;
    is_default?: number;
};

export type DooTaskProjectMember = {
    userid: number;
    nickname: string;
    userimg: string | null;
    owner: number; // 1=owner, 0=member
};

export type DooTaskColumnTemplate = {
    name: string;
    columns: string[];
};

export type CreateTaskParams = {
    project_id: number;
    column_id: number;
    name: string;
    content?: string;
    owner?: number[];
    times?: [string, string]; // [start_at, end_at] format: "YYYY-MM-DD HH:mm:ss"
    p_level?: number;
    p_name?: string;
    p_color?: string;
};

export type CreateProjectParams = {
    name: string;
    desc?: string;
    columns?: string; // comma-separated column names
    flow?: 'open' | 'close';
};
