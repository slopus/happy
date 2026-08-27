import type { ToolCall } from '@/sync/typesMessage';

type FileEditToolFixture = {
    id: string;
    label: string;
    provider: 'claude' | 'codex';
    sourceName: 'Edit' | 'apply_patch' | 'Write' | 'MultiEdit';
    sourceArguments: Record<string, unknown>;
    tool: ToolCall;
};

const createdAt = 1_750_000_000_000;

const oldComposer = `export function Composer() {
    const placeholder = 'Ask anything';
    return <MessageInput placeholder={placeholder} />;
}`;

const newComposer = `export function Composer() {
    const placeholder = 'Ask Happy anything';
    return <MessageInput placeholder={placeholder} autoFocus />;
}`;

const claudeEditArguments = {
    file_path: 'sources/components/Composer.tsx',
    old_string: oldComposer,
    new_string: newComposer,
    replace_all: false,
};

const codexPatch = `*** Begin Patch
*** Update File: sources/components/Composer.tsx
@@
-export function Composer() {
-    const placeholder = 'Ask anything';
-    return <MessageInput placeholder={placeholder} />;
-}
+export function Composer() {
+    const placeholder = 'Ask Happy anything';
+    return <MessageInput placeholder={placeholder} autoFocus />;
+}
*** End Patch`;

const writeArguments = {
    file_path: 'sources/components/composerGreeting.ts',
    content: [
        "export function composerGreeting(hour: number): string {",
        "    if (hour < 12) return 'Good morning';",
        "    if (hour < 18) return 'Good afternoon';",
        "    return 'Good evening';",
        '}',
    ].join('\n'),
};

const multiEditArguments = {
    file_path: 'sources/components/Composer.tsx',
    edits: [
        {
            old_string: "const placeholder = 'Ask anything';",
            new_string: "const placeholder = 'Ask Happy anything';",
        },
        {
            old_string: 'return <MessageInput placeholder={placeholder} />;',
            new_string: 'return <MessageInput placeholder={placeholder} autoFocus />;',
        },
    ],
};

const largeEditArguments = {
    file_path: 'sources/text/translations.ts',
    old_string: Array.from({ length: 60 }, (_, i) => `    key${i}: 'old value ${i}',`).join('\n'),
    new_string: Array.from({ length: 60 }, (_, i) => `    key${i}: 'new value ${i}',`).join('\n'),
    replace_all: false,
};

export const fileEditToolFixtures: readonly FileEditToolFixture[] = [
    {
        id: 'claude-opus-edit',
        label: 'Claude / Opus',
        provider: 'claude',
        sourceName: 'Edit',
        sourceArguments: claudeEditArguments,
        tool: {
            name: 'Edit',
            state: 'completed',
            input: claudeEditArguments,
            createdAt,
            startedAt: createdAt + 80,
            completedAt: createdAt + 620,
            description: 'Editing Composer.tsx',
            result: 'The file was updated successfully.',
        },
    },
    {
        id: 'happy-agent-codex-patch',
        label: 'Happy Agent / Codex',
        provider: 'codex',
        sourceName: 'apply_patch',
        sourceArguments: { patch: codexPatch },
        tool: {
            name: 'CodexPatch',
            state: 'completed',
            input: {
                changes: {
                    'sources/components/Composer.tsx': {
                        kind: { move_path: null, type: 'update' },
                        modify: {
                            old_content: oldComposer,
                            new_content: newComposer,
                        },
                    },
                },
            },
            createdAt: createdAt + 1_000,
            startedAt: createdAt + 1_080,
            completedAt: createdAt + 1_640,
            description: 'Applying patch to 1 file',
            result: 'Done!',
        },
    },
    {
        id: 'claude-write',
        label: 'Claude / Write',
        provider: 'claude',
        sourceName: 'Write',
        sourceArguments: writeArguments,
        tool: {
            name: 'Write',
            state: 'completed',
            input: writeArguments,
            createdAt: createdAt + 2_000,
            startedAt: createdAt + 2_080,
            completedAt: createdAt + 2_500,
            description: 'Writing composerGreeting.ts',
            result: 'File created successfully.',
        },
    },
    {
        id: 'claude-multiedit',
        label: 'Claude / MultiEdit',
        provider: 'claude',
        sourceName: 'MultiEdit',
        sourceArguments: multiEditArguments,
        tool: {
            name: 'MultiEdit',
            state: 'completed',
            input: multiEditArguments,
            createdAt: createdAt + 3_000,
            startedAt: createdAt + 3_080,
            completedAt: createdAt + 3_700,
            description: 'Editing Composer.tsx (2 edits)',
            result: 'Applied 2 edits.',
        },
    },
    {
        id: 'claude-large-edit',
        label: 'Claude / large Edit (collapses)',
        provider: 'claude',
        sourceName: 'Edit',
        sourceArguments: largeEditArguments,
        tool: {
            name: 'Edit',
            state: 'completed',
            input: largeEditArguments,
            createdAt: createdAt + 4_000,
            startedAt: createdAt + 4_080,
            completedAt: createdAt + 4_900,
            description: 'Editing translations.ts',
            result: 'The file was updated successfully.',
        },
    },
];