import type { DecryptedArtifact } from '@/sync/artifactTypes';
import type { QuickPrompt } from '@/sync/settings';
import type { Session } from '@/sync/storageTypes';
import type { Message } from '@/sync/typesMessage';
import {
    projectTaskResourceEvents,
    type TaskResourceEvent,
} from '@/utils/taskResourceEvents';

export type CapabilityKey = 'outputs' | 'sources' | 'skills' | 'quickPrompts' | 'images' | 'artifacts' | 'files';

export type SkillCapabilityItem = {
    id: string;
    kind: 'skill';
    title: string;
    meta: 'available';
};

export type ImageCapabilityItem = {
    id: string;
    kind: 'image';
    title: string;
    meta: 'session';
    ref: string;
    source?: 'user' | 'generated';
    prompt?: string;
    batchId?: string;
    localPath?: string;
    messageId: string;
    createdAt: number;
    width?: number;
    height?: number;
    thumbhash?: string;
};

export type ArtifactCapabilityItem = {
    id: string;
    kind: 'artifact';
    title: string;
    meta: 'session';
    artifactId: string;
    createdAt: number;
    updatedAt: number;
};

export type FileCapabilityItem = {
    id: string;
    kind: 'file';
    title: string;
    meta: 'session';
    path: string;
    toolName: string;
    messageId: string;
    createdAt: number;
};

export type QuickPromptCapabilityItem = {
    id: string;
    kind: 'quickPrompt';
    title: string;
    meta: 'custom';
    prompt: string;
    createdAt?: number;
    updatedAt?: number;
};

export type TaskResourceCapabilityItem = {
    id: string;
    kind: 'taskResource';
    title: string;
    meta: 'session';
    event: TaskResourceEvent;
};

export type CapabilityItem =
    | TaskResourceCapabilityItem
    | SkillCapabilityItem
    | QuickPromptCapabilityItem
    | ImageCapabilityItem
    | ArtifactCapabilityItem
    | FileCapabilityItem;

export type CapabilityItemsByKey = {
    outputs: TaskResourceCapabilityItem;
    sources: TaskResourceCapabilityItem;
    skills: SkillCapabilityItem;
    quickPrompts: QuickPromptCapabilityItem;
    images: ImageCapabilityItem;
    artifacts: ArtifactCapabilityItem;
    files: FileCapabilityItem;
};

export type CapabilityDetails = {
    [K in CapabilityKey]: CapabilityItemsByKey[K][];
};

export type CapabilityBlock = {
    key: CapabilityKey;
    count: number;
    preview: string | null;
    empty: boolean;
};

export type SessionCapabilityHubModel = {
    blocks: CapabilityBlock[];
    details: CapabilityDetails;
};

type BuildArgs = {
    session: Session | null;
    messages: Message[];
    artifacts: DecryptedArtifact[];
    quickPrompts?: QuickPrompt[] | null;
    skillNames?: string[] | null;
    limits?: {
        details?: number;
    };
};

const DETAIL_KEYS: CapabilityKey[] = ['outputs', 'sources', 'skills', 'quickPrompts', 'images', 'artifacts', 'files'];
const DEFAULT_DETAIL_LIMIT = Number.POSITIVE_INFINITY;

function getMetadataSkills(session: Session | null): string[] {
    const skills = session?.metadata?.skills;
    return Array.isArray(skills) ? skills.filter((value): value is string => typeof value === 'string' && value.length > 0) : [];
}

function getResourceEvents(args: BuildArgs): TaskResourceEvent[] {
    if (!args.session) return [];
    return projectTaskResourceEvents({
        sessionId: args.session.id,
        messages: args.messages,
        artifacts: args.artifacts,
    });
}

function getTaskResourceItems(
    events: TaskResourceEvent[],
    type: 'outputs' | 'sources',
    limit: number,
): TaskResourceCapabilityItem[] {
    return events
        .filter((event) => type === 'sources' ? event.kind === 'source_used' : event.kind !== 'source_used')
        .slice(0, limit)
        .map((event) => ({
            id: `${type}:${event.id}`,
            kind: 'taskResource',
            title: event.title,
            meta: 'session',
            event,
        }));
}

function getImageItems(events: TaskResourceEvent[], limit: number): ImageCapabilityItem[] {
    return events
        .flatMap((event) => event.resourceType === 'image' ? [event] : [])
        .slice(0, limit)
        .map((event) => ({
            id: event.messageId,
            kind: 'image',
            title: event.title,
            meta: 'session',
            ref: event.uri,
            ...(event.source ? { source: event.source } : {}),
            ...(event.prompt ? { prompt: event.prompt } : {}),
            ...(event.batchId ? { batchId: event.batchId } : {}),
            ...(event.localPath ? { localPath: event.localPath } : {}),
            messageId: event.messageId,
            createdAt: event.createdAt,
            ...(event.width !== undefined ? { width: event.width } : {}),
            ...(event.height !== undefined ? { height: event.height } : {}),
            ...(event.thumbhash !== undefined ? { thumbhash: event.thumbhash } : {}),
        }));
}

function getArtifactItems(events: TaskResourceEvent[], limit: number): ArtifactCapabilityItem[] {
    return events
        .filter((event) => event.resourceType === 'artifact' && event.artifactId)
        .slice(0, limit)
        .map((event) => ({
            id: event.artifactId!,
            kind: 'artifact',
            title: event.title,
            meta: 'session',
            artifactId: event.artifactId!,
            createdAt: event.resourceCreatedAt ?? event.firstSeenAt,
            updatedAt: event.resourceUpdatedAt ?? event.createdAt,
        }));
}

function getFileItems(events: TaskResourceEvent[], limit: number): FileCapabilityItem[] {
    return events
        .filter((event) => event.resourceType === 'file')
        .slice(0, limit)
        .map((event) => ({
            id: event.id,
            kind: 'file',
            title: event.title,
            meta: 'session',
            path: event.path,
            toolName: event.toolName ?? '',
            messageId: event.messageId,
            createdAt: event.createdAt,
        }));
}

function getSkillItems(session: Session | null, skillNames: string[] | null | undefined, limit: number): SkillCapabilityItem[] {
    const skills = skillNames && skillNames.length > 0 ? skillNames : getMetadataSkills(session);
    return skills
        .slice(0, limit)
        .map((skill) => ({
            id: skill,
            kind: 'skill',
            title: skill,
            meta: 'available',
        }));
}

function getQuickPromptItems(quickPrompts: QuickPrompt[] | null | undefined, limit: number): QuickPromptCapabilityItem[] {
    if (!Array.isArray(quickPrompts)) return [];
    return quickPrompts
        .filter((item) => item.title.trim().length > 0 && item.prompt.trim().length > 0)
        .slice()
        .sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))
        .slice(0, limit)
        .map((item) => ({
            id: item.id,
            kind: 'quickPrompt',
            title: item.title,
            meta: 'custom',
            prompt: item.prompt,
            ...(item.createdAt !== undefined ? { createdAt: item.createdAt } : {}),
            ...(item.updatedAt !== undefined ? { updatedAt: item.updatedAt } : {}),
        }));
}

function getPreview(items: CapabilityItem[]): string | null {
    if (items.length === 0) return null;
    return items[0]?.title ?? null;
}

export function getCapabilityDetailItems<K extends CapabilityKey>(key: K, args: BuildArgs): CapabilityItemsByKey[K][] {
    const limit = args.limits?.details ?? DEFAULT_DETAIL_LIMIT;
    const resourceEvents = getResourceEvents(args);

    switch (key) {
        case 'outputs':
            return getTaskResourceItems(resourceEvents, 'outputs', limit) as CapabilityItemsByKey[K][];
        case 'sources':
            return getTaskResourceItems(resourceEvents, 'sources', limit) as CapabilityItemsByKey[K][];
        case 'skills':
            return getSkillItems(args.session, args.skillNames, limit) as CapabilityItemsByKey[K][];
        case 'quickPrompts':
            return getQuickPromptItems(args.quickPrompts, limit) as CapabilityItemsByKey[K][];
        case 'images':
            return getImageItems(resourceEvents, limit) as CapabilityItemsByKey[K][];
        case 'artifacts':
            return getArtifactItems(resourceEvents, limit) as CapabilityItemsByKey[K][];
        case 'files':
            return getFileItems(resourceEvents, limit) as CapabilityItemsByKey[K][];
    }
}

export function buildSessionCapabilityHubModel(args: BuildArgs): SessionCapabilityHubModel {
    const resourceEvents = getResourceEvents(args);
    const limit = args.limits?.details ?? DEFAULT_DETAIL_LIMIT;
    const details: CapabilityDetails = {
        outputs: getTaskResourceItems(resourceEvents, 'outputs', limit),
        sources: getTaskResourceItems(resourceEvents, 'sources', limit),
        skills: getSkillItems(args.session, args.skillNames, limit),
        quickPrompts: getQuickPromptItems(args.quickPrompts, limit),
        images: getImageItems(resourceEvents, limit),
        artifacts: getArtifactItems(resourceEvents, limit),
        files: getFileItems(resourceEvents, limit),
    };

    const blocks = DETAIL_KEYS.map((key) => {
        const items = details[key];
        return {
            key,
            count: items.length,
            preview: getPreview(items),
            empty: items.length === 0,
        };
    });

    return {
        blocks,
        details,
    };
}
