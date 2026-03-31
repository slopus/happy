/**
 * PartView — dispatches a v3 Part to the correct renderer.
 *
 * text     → TextPartView
 * reasoning → ReasoningPartView
 * tool     → ToolPartView
 * subtask  → SubtaskPartView
 * compaction → CompactionPartView
 * decision/answer → hidden (system-level parts)
 * step-start/step-finish → hidden (lifecycle, not rendered)
 * snapshot/patch/retry/agent/file → hidden or minimal
 */
import * as React from 'react';
import { type v3 } from '@slopus/happy-sync';
import { TextPartView } from './TextPartView';
import { ReasoningPartView } from './ReasoningPartView';
import { ToolPartView } from './ToolPartView';
import { SubtaskPartView } from './SubtaskPartView';
import { CompactionPartView } from './CompactionPartView';
import { FilePartView } from './FilePartView';

export const PartView = React.memo((props: {
    part: v3.Part;
    sessionId: string;
    messageId: string;
}) => {
    const { part } = props;

    switch (part.type) {
        case 'text':
            return <TextPartView part={part} sessionId={props.sessionId} />;

        case 'reasoning':
            return <ReasoningPartView part={part} />;

        case 'tool':
            return <ToolPartView part={part} sessionId={props.sessionId} messageId={props.messageId} />;

        case 'subtask':
            return <SubtaskPartView part={part} sessionId={props.sessionId} />;

        case 'compaction':
            return <CompactionPartView part={part} />;

        case 'file':
            return <FilePartView part={part} sessionId={props.sessionId} />;

        // System / lifecycle parts — not rendered
        case 'step-start':
        case 'step-finish':
        case 'decision':
        case 'answer':
        case 'snapshot':
        case 'patch':
        case 'retry':
        case 'agent':
            return null;

        default:
            return null;
    }
});
