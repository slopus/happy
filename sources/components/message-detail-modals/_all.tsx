import * as React from 'react';
import { type Message, type ToolCallMessage } from '@/sync/typesMessage';
import { NotFoundView } from './NotFoundView';
import { ToolCallView } from './ToolCallView';
import { CatchAllView } from './CatchAllView';
import { EmptyToolsArrayView } from './problems/EmptyToolsArrayView';
import { EditDetailView } from './tools/EditDetailView';
import { useMessage } from '@/sync/storage';

export interface MessageDetailModalProps {
    message: Message | null;
    sessionId: string;
}

export function MessageDetailModalComponent({message, sessionId}: MessageDetailModalProps) {
    if (message === null) {
        return <NotFoundView />
    }

    switch (message.kind) {
        case 'tool-call':
            if (!message.tool) {
                return <EmptyToolsArrayView message={message} sessionId={sessionId} />;
            }
            switch (message.tool.name) {
                case 'edit':
                case 'Edit':
                    return <EditDetailView message={message} metadata={null} />;
                default:
                    return <CatchAllView message={message} />;
            }

        default:
            return <CatchAllView message={message} />;
    }
}