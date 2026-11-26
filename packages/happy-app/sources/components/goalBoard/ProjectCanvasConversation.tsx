import type { ProjectCanvasWorkspaceProps } from './ProjectCanvas';

export type ProjectCanvasConversationProps = ProjectCanvasWorkspaceProps & { sessionId?: string };

/** Project canvas is currently a Web workspace. */
export function ProjectCanvasConversation(_props: ProjectCanvasConversationProps) {
    return null;
}
