import type { ComponentType } from 'react';
import { McpAppHostError, type FrameMountInput, type McpAppFrameAdapter } from './types';

export interface McpAppFrameViewAdapter extends McpAppFrameAdapter {}

export class UnsupportedMcpAppFrameAdapter implements McpAppFrameViewAdapter {
    readonly support = 'unsupported' as const;
    readonly originScoped = false;
    async mount(_input: FrameMountInput): Promise<never> {
        throw new McpAppHostError('MCP_APP_UNSUPPORTED', false, 'MCP Apps are not supported on this platform.');
    }
}

export function createMcpAppFrameAdapter(): McpAppFrameViewAdapter {
    return new UnsupportedMcpAppFrameAdapter();
}

export function createUnsupportedMcpAppFrameAdapter(): UnsupportedMcpAppFrameAdapter {
    return new UnsupportedMcpAppFrameAdapter();
}

export const McpAppFrameView: ComponentType<{ adapter: McpAppFrameViewAdapter }> = () => null;
