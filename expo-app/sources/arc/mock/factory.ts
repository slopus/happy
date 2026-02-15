/**
 * Factory functions for creating mock sessions, machines, and agent configs.
 */

import { Session, Machine, AgentState } from '@/sync/storageTypes';
import { ArcConfig } from '@/arc/agent/types';
import { NormalizedMessage } from '@/sync/typesRaw';

let idCounter = 0;
function nextId(prefix: string) {
    return `${prefix}-${++idCounter}`;
}

// =============================================================================
// Session Factory
// =============================================================================

interface SessionFactoryOptions {
    id?: string;
    active?: boolean;
    thinking?: boolean;
    hasPermissionRequest?: boolean;
    path?: string;
    host?: string;
    machineId?: string;
    homeDir?: string;
    name?: string;
    summary?: string;
    flavor?: string | null;
    draft?: string | null;
    createdAt?: number;
    updatedAt?: number;
    activeAt?: number;
}

export function createMockSession(options: SessionFactoryOptions = {}): Session {
    const now = Date.now();
    const id = options.id ?? nextId('session');
    const active = options.active ?? false;
    const thinking = options.thinking ?? false;

    let agentState: AgentState | null = null;
    if (options.hasPermissionRequest) {
        agentState = {
            requests: {
                'req-1': {
                    tool: 'Bash',
                    arguments: { command: 'rm -rf /tmp/old-build' },
                    createdAt: now,
                },
            },
        };
    }

    return {
        id,
        seq: 1,
        createdAt: options.createdAt ?? now - 3600_000,
        updatedAt: options.updatedAt ?? now,
        active,
        activeAt: options.activeAt ?? now,
        metadata: {
            path: options.path ?? '/Users/test/project',
            host: options.host ?? 'test-machine',
            machineId: options.machineId ?? 'machine-1',
            homeDir: options.homeDir ?? '/Users/test',
            name: options.name,
            summary: options.summary ? { text: options.summary, updatedAt: now } : undefined,
            flavor: options.flavor ?? 'claude',
        },
        metadataVersion: 1,
        agentState,
        agentStateVersion: agentState ? 1 : 0,
        thinking,
        thinkingAt: thinking ? now : 0,
        presence: active ? 'online' : (options.activeAt ?? now - 600_000),
        draft: options.draft,
    };
}

// =============================================================================
// Machine Factory
// =============================================================================

interface MachineFactoryOptions {
    id?: string;
    active?: boolean;
    host?: string;
    platform?: string;
    displayName?: string;
    homeDir?: string;
}

export function createMockMachine(options: MachineFactoryOptions = {}): Machine {
    const now = Date.now();
    return {
        id: options.id ?? 'machine-1',
        seq: 1,
        createdAt: now - 86400_000,
        updatedAt: now,
        active: options.active ?? true,
        activeAt: now,
        metadata: {
            host: options.host ?? 'test-machine',
            platform: options.platform ?? 'darwin',
            happyCliVersion: '1.0.0',
            happyHomeDir: `${options.homeDir ?? '/Users/test'}/.happy`,
            homeDir: options.homeDir ?? '/Users/test',
            displayName: options.displayName,
        },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 0,
    };
}

// =============================================================================
// Agent Config Factory
// =============================================================================

interface AgentConfigOptions {
    name?: string;
    tagline?: string;
    avatar?: string;
    primaryColor?: string;
    voiceId?: string;
}

export function createMockAgentConfig(options: AgentConfigOptions = {}): ArcConfig {
    return {
        agent: {
            name: options.name ?? '',
            tagline: options.tagline,
            avatar: options.avatar ?? 'generated',
            primaryColor: options.primaryColor,
        },
        voice: options.voiceId ? { elevenlabs_agent_id: options.voiceId } : undefined,
    };
}

// =============================================================================
// Message Factories
// =============================================================================

let uuidCounter = 0;
function nextUuid() {
    return `uuid-${++uuidCounter}`;
}

/**
 * Create a user text message.
 */
export function createUserMessage(text: string, options: {
    id?: string;
    createdAt?: number;
} = {}): NormalizedMessage {
    return {
        role: 'user',
        content: { type: 'text', text },
        id: options.id ?? nextId('msg-user'),
        localId: null,
        createdAt: options.createdAt ?? Date.now(),
        isSidechain: false,
    };
}

/**
 * Create an agent text response.
 */
export function createAgentMessage(text: string, options: {
    id?: string;
    createdAt?: number;
    usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number };
} = {}): NormalizedMessage {
    return {
        role: 'agent',
        content: [{
            type: 'text',
            text,
            uuid: nextUuid(),
            parentUUID: null,
        }],
        id: options.id ?? nextId('msg-agent'),
        localId: null,
        createdAt: options.createdAt ?? Date.now(),
        isSidechain: false,
        usage: options.usage,
    };
}

/**
 * Create a tool call message.
 */
export function createToolCall(toolName: string, input: any, options: {
    id?: string;
    toolId?: string;
    createdAt?: number;
    description?: string | null;
} = {}): NormalizedMessage {
    const toolId = options.toolId ?? nextId('tool');
    return {
        role: 'agent',
        content: [{
            type: 'tool-call',
            id: toolId,
            name: toolName,
            input,
            description: options.description ?? null,
            uuid: nextUuid(),
            parentUUID: null,
        }],
        id: options.id ?? nextId('msg-tool'),
        localId: null,
        createdAt: options.createdAt ?? Date.now(),
        isSidechain: false,
    };
}

/**
 * Create a tool result message.
 */
export function createToolResult(toolUseId: string, content: any, options: {
    id?: string;
    createdAt?: number;
    isError?: boolean;
    approved?: boolean;
} = {}): NormalizedMessage {
    return {
        role: 'agent',
        content: [{
            type: 'tool-result',
            tool_use_id: toolUseId,
            content,
            is_error: options.isError ?? false,
            uuid: nextUuid(),
            parentUUID: null,
            permissions: {
                date: options.createdAt ?? Date.now(),
                result: (options.approved ?? true) ? 'approved' : 'denied',
                decision: (options.approved ?? true) ? 'approved' : 'denied',
            },
        }],
        id: options.id ?? nextId('msg-result'),
        localId: null,
        createdAt: options.createdAt ?? Date.now(),
        isSidechain: false,
    };
}

/**
 * Create a thinking block message.
 */
export function createThinkingMessage(thinking: string, options: {
    id?: string;
    createdAt?: number;
} = {}): NormalizedMessage {
    return {
        role: 'agent',
        content: [{
            type: 'thinking',
            thinking,
            uuid: nextUuid(),
            parentUUID: null,
        }],
        id: options.id ?? nextId('msg-thinking'),
        localId: null,
        createdAt: options.createdAt ?? Date.now(),
        isSidechain: false,
    };
}
