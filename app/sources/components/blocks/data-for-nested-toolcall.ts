import { type ToolCall } from '@/sync/reducer';

// Fake tool call object with nested children for testing the design.
export const fakeTool: ToolCall = {
    name: 'FileOperations',
    state: 'completed',
    arguments: {
        operation: 'batch_process',
        files: ['src/components', 'src/utils'],
        options: { recursive: true, backup: true }
    },
    children: [
        {
            name: 'ReadFile',
            state: 'completed',
            arguments: {
                file_path: 'src/components/Button.tsx',
                encoding: 'utf8'
            },
            children: []
        },
        {
            name: 'ProcessDirectory',
            state: 'running',
            arguments: {
                directory: 'src/utils',
                pattern: '*.ts'
            },
            children: [
                {
                    name: 'ValidateFile',
                    state: 'completed',
                    arguments: {
                        file: 'src/utils/helpers.ts',
                        checks: ['syntax', 'types']
                    },
                    children: []
                },
                {
                    name: 'FormatFile',
                    state: 'error',
                    arguments: {
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
            arguments: {
                destination: './backup',
                timestamp: '2024-01-15T10:30:00Z'
            },
            children: []
        }
    ]
};