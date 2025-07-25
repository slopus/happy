import * as React from 'react';
import { type Message, type ToolCallMessage } from '@/sync/typesMessage';
import { NotFoundView } from './NotFoundView';
import { ToolCallView } from './ToolCallView';
import { ToolGroupView } from './ToolGroupView';
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
            if (message.tools.length === 0) {
                return <EmptyToolsArrayView message={message} sessionId={sessionId} />;
            }
            if (message.tools.length > 1) {
                // TODO this should be a different view that explains that
                // something unexpected happened, and a request to report the
                // bug
                return <NotFoundView />;
            }
            switch (message.tools[0].name) {
                case 'edit':
                    return <EditDetailView message={message} metadata={null} />;
                default:
                    return <CatchAllView message={message} />;
            }

        // A tool call group is way to visually collapse a bunch of sequential
        // tools calls into a fixed height visual element.
        case 'tool-call-group':
            const toolCallMessages = message.messageIds
            .map(id => {
                const msg = useMessage(sessionId, id);
                return msg;
            })
            .filter((msg): msg is ToolCallMessage => msg !== null && msg.kind === 'tool-call');
            
            return <ToolGroupView toolCallMessages={toolCallMessages} sessionId={sessionId} />;

        default:
            return <CatchAllView message={message} />;
    }
}