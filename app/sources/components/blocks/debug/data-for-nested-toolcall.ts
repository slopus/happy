import { type ToolCall } from '@/sync/typesMessage';

// Fake tool call object with nested children for testing the design.
export const fakeTool: ToolCall = {
    name: 'FileOperations',
    state: 'completed',
    input: {
        operation: 'batch_process',
        files: ['src/components', 'src/utils'],
        options: { recursive: true, backup: true }
    },
    children: [
        {
            name: 'ReadFile',
            state: 'completed',
            input: {
                file_path: 'src/components/Button.tsx',
                encoding: 'utf8'
            },
            children: []
        },
        {
            name: 'ProcessDirectory',
            state: 'running',
            input: {
                directory: 'src/utils',
                pattern: '*.ts'
            },
            children: [
                {
                    name: 'ValidateFile',
                    state: 'completed',
                    input: {
                        file: 'src/utils/helpers.ts',
                        checks: ['syntax', 'types']
                    },
                    children: []
                },
                {
                    name: 'FormatFile',
                    state: 'error',
                    input: {
                        file: 'src/utils/api.ts',
                        formatter: 'prettier'
                    },
                    children: []
                }
            ]
        },
        {
            name: 'BackupFiles',
            state: 'completed',
            input: {
                destination: './backup',
                timestamp: '2024-01-15T10:30:00Z'
            },
            children: []
        }
    ]
};