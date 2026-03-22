import { useEffect } from 'react';
import { ToolCall } from '@/sync/typesMessage';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { create } from 'zustand';
import { MMKV } from 'react-native-mmkv';
import { parseMcpResult } from '../parseMcpResult';

const mmkv = new MMKV();
const TITLE_CACHE_KEY = 'orchestrator-title-cache';

function snakeToPascalWithSpaces(str: string): string {
    return str
        .split('_')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
}

interface OrchestratorTitleState {
    titles: Record<string, string>;
}

function loadTitleCache(): Record<string, string> {
    try {
        const raw = mmkv.getString(TITLE_CACHE_KEY);
        if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }
    return {};
}

const useOrchestratorTitleStore = create<OrchestratorTitleState>()(() => ({
    titles: loadTitleCache(),
}));

useOrchestratorTitleStore.subscribe((state) => {
    mmkv.set(TITLE_CACHE_KEY, JSON.stringify(state.titles));
});

function cacheTitle(id: string, title: string) {
    useOrchestratorTitleStore.setState((state) => {
        if (state.titles[id]) return state;
        return { titles: { ...state.titles, [id]: title } };
    });
}

function stripMCPPrefix(name: string): string {
    return name.replace(/__/g, ':').replace(/^mcp:/, '').replace(/^happy:/, '');
}

/**
 * Formats MCP tool name to display title
 * Example: "mcp__linear__create_issue" -> "MCP: Linear Create Issue"
 */
export function formatMCPTitle(tool: ToolCall): string {
    const withoutPrefix = stripMCPPrefix(tool.name);

    let prefix = "MCP: ";
    if (/^orchestrator_/.test(withoutPrefix) || /^preview_html$/.test(withoutPrefix)) {
        prefix = "";
    }

    const parts = withoutPrefix.split(':');

    if (parts.length >= 2) {
        const serverName = snakeToPascalWithSpaces(parts[0]);
        const toolNamePart = snakeToPascalWithSpaces(parts.slice(1).join('_'));
        return `${prefix}${serverName} ${toolNamePart}`;
    }

    return `${prefix}${snakeToPascalWithSpaces(withoutPrefix)}`;
}

/**
 * Hook that returns the MCP tool subtitle.
 *
 * For orchestrator_submit: caches runId→title and taskId→title from the result.
 * For orchestrator_pend/cancel/send_message: reactively resolves title from cache,
 * falls back to displaying the raw ID.
 */
export function useMCPSubtitle(tool: ToolCall): string {
    const isMCP = tool.name.startsWith('mcp__') || tool.name.startsWith('mcp:');
    const toolName = isMCP ? stripMCPPrefix(tool.name) : '';

    // Cache titles when orchestrator_submit result arrives
    const isSubmit = toolName === 'orchestrator_submit';
    useEffect(() => {
        if (!isSubmit) return;
        const runTitle = tool.input?.title;
        if (!runTitle || typeof runTitle !== 'string' || !tool.result) return;
        try {
            const parsed = parseMcpResult(tool.result);
            const data = parsed?.data;
            if (!data) return;

            if (data.runId) cacheTitle(data.runId, runTitle);

            if (Array.isArray(data.tasks)) {
                for (const task of data.tasks) {
                    if (task.taskId) cacheTitle(task.taskId, task.title ?? runTitle);
                }
            }
        } catch {
            // ignore parse errors
        }
    }, [isSubmit, tool.input?.title, tool.result]);

    // Subscribe to cached title for pend/cancel/send_message
    const lookupId =
        toolName === 'orchestrator_pend' || toolName === 'orchestrator_cancel'
            ? tool.input?.runId
            : toolName === 'orchestrator_send_message'
              ? tool.input?.taskId
              : undefined;

    const cachedTitle = useOrchestratorTitleStore((state) => lookupId ? state.titles[lookupId] : undefined);

    if (!isMCP) return '';

    if (toolName === "preview_html" && tool.input?.title) {
        return tool.input.title;
    }
    if (isSubmit) {
        return tool.input?.title ?? '';
    }
    if (toolName === "orchestrator_pend" || toolName === "orchestrator_cancel") {
        return cachedTitle ?? (tool.input?.runId ? `Run ID: ${tool.input.runId}` : '');
    }
    if (toolName === "orchestrator_send_message") {
        return cachedTitle ?? (tool.input?.taskId ? `Task ID: ${tool.input.taskId}` : '');
    }

    return '';
}

export function formatMCPIcon(tool: ToolCall, size: number = 18, color: string = '#000', secondaryColor: string = '') {
    const withoutPrefix = stripMCPPrefix(tool.name);

    if (/^orchestrator_/.test(withoutPrefix)) {
        return <MaterialCommunityIcons name="robot-outline" size={size} color={color} />;
    }

    if (withoutPrefix === "preview_html") {
        return <Ionicons name="earth-outline" size={size} color={color} />;
    }

    return <Ionicons name="extension-puzzle-outline" size={size} color={secondaryColor || color} />;
}
