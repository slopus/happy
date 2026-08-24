import type { ToolCall } from '@/sync/typesMessage';

type FileEditToolFixture = {
    id: string;
    label: string;
    provider: 'claude' | 'codex';
    sourceName: 'Edit' | 'apply_patch';
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
];