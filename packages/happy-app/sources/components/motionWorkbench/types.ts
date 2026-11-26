export type MotionWorkbenchHandle = { prepareClose(): Promise<boolean> };
export type MotionWorkbenchProps = { sessionId: string; projectPath: string; visible: boolean; onClose(): void; onProjectTitleChange?(title: string): void };
