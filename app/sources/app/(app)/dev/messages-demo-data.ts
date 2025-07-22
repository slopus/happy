// TODO: Not sure where to put this demo data yet - temporary location
// This contains mock message data for development and testing purposes

import { Message } from '@/sync/typesMessage';

export const debugMessages: Message[] = [
    // User message
    {
        id: 'user-1',
        localId: null,
        createdAt: Date.now() - 200000,
        kind: 'user-text',
        text: 'Can you help me debug my application and make some improvements?'
    },
    
    // Agent message
    {
        id: 'agent-1',
        localId: null,
        createdAt: Date.now() - 190000,
        kind: 'agent-text',
        text: 'I\'ll help you debug and improve your application. Let me start by examining the codebase and running various analysis tools.'
    },

    // Bash tool - running
    {
        id: 'bash-running',
        localId: null,
        createdAt: Date.now() - 180000,
        kind: 'tool-call',
        tools: [
            {
                name: 'Bash',
                state: 'running',
                input: {
                    command: 'npm test -- --coverage'
                },
                children: []
            }
        ]
    },

    // Bash tool - completed
    {
        id: 'bash-completed',
        localId: null,
        createdAt: Date.now() - 170000,
        kind: 'tool-call',
        tools: [
            {
                name: 'Bash',
                state: 'completed',
                input: {
                    command: 'npm run build'
                },
                result: 'Successfully built the application\n\n> app@1.0.0 build\n> webpack --mode=production\n\nHash: 4f2b42c7bb332e42ef96\nVersion: webpack 5.74.0\nTime: 2347ms\nBuilt at: 12/07/2024 2:34:15 PM',
                children: []
            }
        ]
    },

    // Bash tool - error
    {
        id: 'bash-error',
        localId: null,
        createdAt: Date.now() - 160000,
        kind: 'tool-call',
        tools: [
            {
                name: 'Bash',
                state: 'error',
                input: {
                    command: 'npm run invalid-script'
                },
                result: 'Error: Missing script: "invalid-script"\n\nTo see a list of scripts, run:\n  npm run',
                children: []
            }
        ]
    },

    // Edit tool - running
    {
        id: 'edit-running',
        localId: null,
        createdAt: Date.now() - 150000,
        kind: 'tool-call',
        tools: [
            {
                name: 'Edit',
                state: 'running',
                input: {
                    file_path: '/src/components/App.tsx',
                    old_string: 'const oldValue = "test";',
                    new_string: 'const newValue = "updated";'
                },
                children: []
            }
        ]
    },

    // Edit tool - completed
    {
        id: 'edit-completed',
        localId: null,
        createdAt: Date.now() - 140000,
        kind: 'tool-call',
        tools: [
            {
                name: 'Edit',
                state: 'completed',
                input: {
                    file_path: '/src/utils/helpers.ts',
                    old_string: 'export const formatDate = (date) => {',
                    new_string: 'export const formatDate = (date: Date) => {'
                },
                result: 'Successfully updated 1 occurrence in /src/utils/helpers.ts',
                children: []
            }
        ]
    },

    // Edit tool - error
    {
        id: 'edit-error',
        localId: null,
        createdAt: Date.now() - 130000,
        kind: 'tool-call',
        tools: [
            {
                name: 'Edit',
                state: 'error',
                input: {
                    file_path: '/src/components/NonExistent.tsx',
                    old_string: 'const oldCode = true;',
                    new_string: 'const newCode = false;'
                },
                result: 'Error: File not found - /src/components/NonExistent.tsx does not exist',
                children: []
            }
        ]
    },

    // Read tool - running
    {
        id: 'read-running',
        localId: null,
        createdAt: Date.now() - 120000,
        kind: 'tool-call',
        tools: [
            {
                name: 'Read',
                state: 'running',
                input: {
                    file_path: '/src/components/App.tsx',
                    start_line: 1,
                    end_line: 50
                },
                children: []
            }
        ]
    },

    // Read tool - completed
    {
        id: 'read-completed',
        localId: null,
        createdAt: Date.now() - 110000,
        kind: 'tool-call',
        tools: [
            {
                name: 'Read',
                state: 'completed',
                input: {
                    file_path: '/src/utils/constants.ts',
                    start_line: 1,
                    end_line: 10
                },
                result: '1  export const API_URL = "https://api.example.com";\n2  export const VERSION = "1.0.0";\n3  export const TIMEOUT = 5000;\n4  \n5  export const COLORS = {\n6    primary: "#007AFF",\n7    secondary: "#8E8E93",\n8    success: "#34C759"\n9  };',
                children: []
            }
        ]
    },

    // Read tool - error
    {
        id: 'read-error',
        localId: null,
        createdAt: Date.now() - 100000,
        kind: 'tool-call',
        tools: [
            {
                name: 'Read',
                state: 'error',
                input: {
                    file_path: '/src/missing/file.ts',
                    start_line: 1,
                    end_line: 20
                },
                result: 'Error: ENOENT: no such file or directory, open \'/src/missing/file.ts\'',
                children: []
            }
        ]
    },

    // Write tool - completed
    {
        id: 'write-completed',
        localId: null,
        createdAt: Date.now() - 90000,
        kind: 'tool-call',
        tools: [
            {
                name: 'Write',
                state: 'completed',
                input: {
                    file_path: '/src/utils/logger.ts',
                    content: 'export class Logger {\n  static log(message: string) {\n    console.log(`[${new Date().toISOString()}] ${message}`);\n  }\n}'
                },
                result: 'File created successfully with 5 lines',
                children: []
            }
        ]
    },

    // Write tool - error
    {
        id: 'write-error',
        localId: null,
        createdAt: Date.now() - 80000,
        kind: 'tool-call',
        tools: [
            {
                name: 'Write',
                state: 'error',
                input: {
                    file_path: '/readonly/system/file.ts',
                    content: 'export const forbidden = true;'
                },
                result: 'Error: EACCES: permission denied, open \'/readonly/system/file.ts\'',
                children: []
            }
        ]
    },

    // Grep tool - completed
    {
        id: 'grep-completed',
        localId: null,
        createdAt: Date.now() - 70000,
        kind: 'tool-call',
        tools: [
            {
                name: 'Grep',
                state: 'completed',
                input: {
                    pattern: 'TODO',
                    include_pattern: '*.ts *.tsx'
                },
                result: 'src/components/App.tsx:15:// TODO: Add error handling\nsrc/utils/api.ts:23:// TODO: Implement retry logic\nsrc/hooks/useAuth.ts:45:// TODO: Add token refresh',
                children: []
            }
        ]
    },

    // TodoWrite tool - completed
    {
        id: 'todowrite-completed',
        localId: null,
        createdAt: Date.now() - 60000,
        kind: 'tool-call',
        tools: [
            {
                name: 'TodoWrite',
                state: 'completed',
                input: {
                    todos: [
                        { id: '1', content: 'Fix authentication bug', status: 'pending' },
                        { id: '2', content: 'Add unit tests', status: 'in_progress' },
                        { id: '3', content: 'Update documentation', status: 'completed' }
                    ]
                },
                result: 'Successfully updated 3 todo items',
                children: []
            }
        ]
    },

    // Task tool - running
    {
        id: 'task-running',
        localId: null,
        createdAt: Date.now() - 50000,
        kind: 'tool-call',
        tools: [
            {
                name: 'Task',
                state: 'running',
                input: {
                    description: 'Analyzing code quality and performance',
                    steps: ['Static analysis', 'Performance profiling', 'Security scan']
                },
                children: []
            }
        ]
    },

    // LS tool - completed
    {
        id: 'ls-completed',
        localId: null,
        createdAt: Date.now() - 40000,
        kind: 'tool-call',
        tools: [
            {
                name: 'LS',
                state: 'completed',
                input: {
                    path: '/src/components'
                },
                result: 'App.tsx\nButton.tsx\nHeader.tsx\nNavigation.tsx\nmodal/\n  Modal.tsx\n  ModalHeader.tsx\nforms/\n  Input.tsx\n  Form.tsx',
                children: []
            }
        ]
    },

    // MCP tool - completed
    {
        id: 'mcp-completed',
        localId: null,
        createdAt: Date.now() - 30000,
        kind: 'tool-call',
        tools: [
            {
                name: 'mcp__database_query',
                state: 'completed',
                input: {
                    query: 'SELECT * FROM users WHERE active = true LIMIT 10',
                    database: 'app_db'
                },
                result: 'Found 8 active users:\n1. john@example.com (John Doe)\n2. jane@example.com (Jane Smith)\n3. bob@example.com (Bob Johnson)',
                children: []
            }
        ]
    },

    // Tool call group
    {
        id: 'tool-group-1',
        localId: null,
        createdAt: Date.now() - 20000,
        kind: 'tool-call-group',
        messageIds: ['tool-group-grep', 'tool-group-bash']
    }
];

// Individual tool call messages for the group
export const debugToolCallMessages: Message[] = [
    {
        id: 'tool-group-grep',
        localId: null,
        createdAt: Date.now() - 25000,
        kind: 'tool-call',
        tools: [
            {
                name: 'Grep',
                state: 'completed',
                input: {
                    pattern: 'console\\.log',
                    include_pattern: '*.ts *.tsx'
                },
                result: 'src/utils/debug.ts:12:console.log("Debug mode enabled");\nsrc/components/App.tsx:34:console.log("Rendering App component");',
                children: []
            }
        ]
    },
    {
        id: 'tool-group-bash',
        localId: null,
        createdAt: Date.now() - 22000,
        kind: 'tool-call',
        tools: [
            {
                name: 'Bash',
                state: 'completed',
                input: {
                    command: 'npm run lint'
                },
                result: '✨ Code style looks good!\n\n> app@1.0.0 lint\n> eslint src/**/*.{ts,tsx}\n\nNo linting errors found.',
                children: []
            }
        ]
    }
]; 