import { type ToolCall } from '@/sync/typesMessage';

// Fake tool call object for testing the design.
// Note: In the new architecture, children are at the message level, not the tool level
export const fakeTool: ToolCall = {
    name: 'FileOperations',
    state: 'completed',
    input: {
        operation: 'batch_process',
        files: ['src/components', 'src/utils'],
        options: { recursive: true, backup: true }
    },
    createdAt: Date.now() - 10000,
    startedAt: Date.now() - 9000,
    completedAt: Date.now() - 5000,
    description: 'Batch process files',
    result: 'Successfully processed 5 files'
};