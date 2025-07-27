// TODO: Not sure where to put this demo data yet - temporary location
// This contains mock message data for development and testing purposes

import { Message, ToolCall } from '@/sync/typesMessage';

// Helper to create a tool call with proper timestamps
const createToolCall = (name: string, state: ToolCall['state'], input: any, result?: any, description?: string | null): ToolCall => ({
    name,
    state,
    input,
    createdAt: Date.now() - Math.random() * 10000,
    startedAt: state !== 'running' ? Date.now() - Math.random() * 10000 : null,
    completedAt: state === 'completed' || state === 'error' ? Date.now() - Math.random() * 5000 : null,
    description: description || null,
    result
});

// Reusable Read tool call constant
const createReadToolCall = (id: string, filePath: string, startLine: number, endLine: number, result: string): Message => ({
    id,
    localId: null,
    createdAt: Date.now() - Math.random() * 10000,
    kind: 'tool-call' as const,
    tool: createToolCall('Read', 'completed', {
        file_path: filePath,
        start_line: startLine,
        end_line: endLine
    }, result),
    children: []
});

// Helper function to create user messages that serve as descriptions
function createSectionTitle(id: string, text: string, timeOffset: number = 0): Message {
    return { id, localId: null, createdAt: Date.now() - timeOffset, kind: 'user-text', text }
}

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
    createSectionTitle('missing-tool-call-title', 'What happens when a tool call Message has zero tools? If the empty tools array would render anything, it would show up between these two messages\nvvvvvvvvvvvvvvvvvvvv'),
    
    // Note: This message type is no longer valid - a tool-call message must have a tool
    // Keeping for reference but should be removed or converted to agent-text
    createSectionTitle('missing-tool-call-after', '^^^^^^^^^^^^^^^^^^^^'),

    // Bash tool - running
    {
        id: 'bash-running',
        localId: null,
        createdAt: Date.now() - 180000,
        kind: 'tool-call',
        tool: createToolCall('Bash', 'running', {
            description: 'Running the tests',
            command: 'npm test -- --coverage'
        }, undefined, 'Running the tests'),
        children: []
    },

    // Bash tool - completed
    {
        id: 'bash-completed',
        localId: null,
        createdAt: Date.now() - 170000,
        kind: 'tool-call',
        tool: createToolCall('Bash', 'completed', {
            command: 'npm run build'
        }, 'Successfully built the application\n\n> app@1.0.0 build\n> webpack --mode=production\n\nHash: 4f2b42c7bb332e42ef96\nVersion: webpack 5.74.0\nTime: 2347ms\nBuilt at: 12/07/2024 2:34:15 PM'),
        children: []
    },

    // Bash tool - error
    {
        id: 'bash-error',
        localId: null,
        createdAt: Date.now() - 160000,
        kind: 'tool-call',
        tool: createToolCall('Bash', 'error', {
            description: 'Check for TypeScript errors',
            command: 'npx tsc --noEmit'
        }, 'Error: TypeScript compilation failed\n\nsrc/components/Button.tsx(23,5): error TS2322: Type \'string\' is not assignable to type \'number\'.\nsrc/utils/helpers.ts(45,10): error TS2554: Expected 2 arguments, but got 1.', 'Check for TypeScript errors'),
        children: []
    },

    // Edit tool - running
    {
        id: 'edit-running',
        localId: null,
        createdAt: Date.now() - 150000,
        kind: 'tool-call',
        tool: createToolCall('Edit', 'running', {
            file_path: '/src/components/Button.tsx',
            old_string: 'const count: number = "0";',
            new_string: 'const count: number = 0;'
        }),
        children: []
    },

    // Edit tool - completed
    {
        id: 'edit-completed',
        localId: null,
        createdAt: Date.now() - 140000,
        kind: 'tool-call',
        tool: createToolCall('Edit', 'completed', {
            file_path: '/src/components/Button.tsx',
            old_string: 'const count: number = "0";',
            new_string: 'const count: number = 0;'
        }, 'File updated successfully'),
        children: []
    },

    // Edit tool - completed (larger diff)
    {
        id: 'edit-large',
        localId: null,
        createdAt: Date.now() - 130000,
        kind: 'tool-call',
        tool: createToolCall('Edit', 'completed', {
            file_path: '/src/utils/helpers.ts',
            old_string: 'export function calculateTotal(items) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}',
            new_string: 'export function calculateTotal(items: Item[]): number {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}'
        }, 'File updated successfully'),
        children: []
    },

    // Edit tool - error
    {
        id: 'edit-error',
        localId: null,
        createdAt: Date.now() - 120000,
        kind: 'tool-call',
        tool: createToolCall('Edit', 'error', {
            file_path: '/src/utils/nonexistent.ts',
            old_string: 'something',
            new_string: 'something else'
        }, 'Error: File not found: /src/utils/nonexistent.ts'),
        children: []
    },

    // Read tool - running
    {
        id: 'read-running',
        localId: null,
        createdAt: Date.now() - 110000,
        kind: 'tool-call',
        tool: createToolCall('Read', 'running', {
            file_path: '/src/index.tsx',
            start_line: 1,
            end_line: 50
        }),
        children: []
    },

    // Read tool examples
    createReadToolCall('read-1', '/src/index.tsx', 1, 20, 
`import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);

root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);`),

    createReadToolCall('read-2', '/src/App.tsx', 10, 30,
`function App() {
  const [count, setCount] = useState(0);
  
  return (
    <div className="App">
      <header className="App-header">
        <p>Count: {count}</p>
        <button onClick={() => setCount(count + 1)}>
          Increment
        </button>
      </header>
    </div>
  );
}`),

    // Write tool
    {
        id: 'write-completed',
        localId: null,
        createdAt: Date.now() - 80000,
        kind: 'tool-call',
        tool: createToolCall('Write', 'completed', {
            file_path: '/src/components/NewComponent.tsx',
            content: `import React from 'react';

interface NewComponentProps {
  title: string;
  description?: string;
}

export const NewComponent: React.FC<NewComponentProps> = ({ title, description }) => {
  return (
    <div className="new-component">
      <h2>{title}</h2>
      {description && <p>{description}</p>}
    </div>
  );
};`
        }, 'File created successfully'),
        children: []
    },

    // Write tool - error
    {
        id: 'write-error',
        localId: null,
        createdAt: Date.now() - 70000,
        kind: 'tool-call',
        tool: createToolCall('Write', 'error', {
            file_path: '/restricted/file.txt',
            content: 'Some content'
        }, 'Error: Permission denied: Cannot write to /restricted/file.txt'),
        children: []
    },

    // Grep tool - running
    {
        id: 'grep-running',
        localId: null,
        createdAt: Date.now() - 60000,
        kind: 'tool-call',
        tool: createToolCall('Grep', 'running', {
            pattern: 'TODO|FIXME',
            include_pattern: '*.ts,*.tsx',
            output_mode: 'lines',
            '-n': true
        }),
        children: []
    },

    // Grep tool - completed with results
    {
        id: 'grep-completed',
        localId: null,
        createdAt: Date.now() - 50000,
        kind: 'tool-call',
        tool: createToolCall('Grep', 'completed', {
            pattern: 'TODO|FIXME',
            include_pattern: '*.ts,*.tsx',
            output_mode: 'lines',
            '-n': true
        }, {
            mode: 'lines',
            numFiles: 3,
            filenames: ['/src/App.tsx', '/src/utils/helpers.ts', '/src/components/Button.tsx'],
            content: `/src/App.tsx:15:  // TODO: Add error boundary
/src/App.tsx:23:  // FIXME: Handle loading state properly
/src/utils/helpers.ts:8:  // TODO: Add input validation
/src/components/Button.tsx:12:  // TODO: Add disabled state styling`,
            numLines: 4
        }),
        children: []
    },

    // Grep tool - completed with no results
    {
        id: 'grep-empty',
        localId: null,
        createdAt: Date.now() - 40000,
        kind: 'tool-call',
        tool: createToolCall('Grep', 'completed', {
            pattern: 'DEPRECATED',
            include_pattern: '*.ts,*.tsx',
            output_mode: 'lines',
            '-n': true
        }, {
            mode: 'lines',
            numFiles: 0,
            filenames: [],
            content: 'No matches found',
            numLines: 0
        }),
        children: []
    },

    // TodoWrite tool
    {
        id: 'todo-write',
        localId: null,
        createdAt: Date.now() - 30000,
        kind: 'tool-call',
        tool: createToolCall('TodoWrite', 'completed', {
            todos: [
                { id: '1', content: 'Fix TypeScript errors in Button component', status: 'completed', priority: 'high' },
                { id: '2', content: 'Add error boundary to App component', status: 'in_progress', priority: 'medium' },
                { id: '3', content: 'Implement loading state', status: 'pending', priority: 'medium' },
                { id: '4', content: 'Add input validation to helpers', status: 'pending', priority: 'low' }
            ]
        }, undefined),
        children: []
    },

    // Glob tool
    {
        id: 'glob-completed',
        localId: null,
        createdAt: Date.now() - 20000,
        kind: 'tool-call',
        tool: createToolCall('Glob', 'completed', {
            pattern: '**/*.test.{ts,tsx}'
        }, [
            '/src/App.test.tsx',
            '/src/components/Button.test.tsx',
            '/src/utils/helpers.test.ts',
            '/src/utils/validators.test.ts'
        ]),
        children: []
    },

    // LS tool
    {
        id: 'ls-completed',
        localId: null,
        createdAt: Date.now() - 10000,
        kind: 'tool-call',
        tool: createToolCall('LS', 'completed', {
            path: '/src/components'
        }, `- Button.tsx
- Button.test.tsx
- Button.css
- Header.tsx
- Header.test.tsx
- Header.css
- Footer.tsx
- Footer.test.tsx
- Footer.css
- index.ts`),
        children: []
    },

    // Complex nested example - Task with children
    {
        id: 'task-with-children',
        localId: null,
        createdAt: Date.now() - 5000,
        kind: 'tool-call',
        tool: createToolCall('Task', 'completed', {
            description: 'Analyze codebase',
            prompt: 'Please analyze the codebase for potential improvements'
        }, undefined, 'Analyze codebase'),
        children: [
            {
                id: 'task-child-1',
                localId: null,
                createdAt: Date.now() - 4000,
                kind: 'tool-call',
                tool: createToolCall('Grep', 'completed', {
                    pattern: 'TODO',
                    output_mode: 'count'
                }, { count: 15 }),
                children: []
            },
            {
                id: 'task-child-2',
                localId: null,
                createdAt: Date.now() - 3000,
                kind: 'tool-call',
                tool: createToolCall('Read', 'completed', {
                    file_path: '/package.json'
                }, '{\n  "name": "my-app",\n  "version": "1.0.0"\n}'),
                children: []
            }
        ]
    }
];