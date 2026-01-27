export async function handleTodoKvBatchUpdate(params: {
    kvUpdate: { changes?: unknown };
    applyTodoSocketUpdates: (changes: any[]) => Promise<void>;
    invalidateTodosSync: () => void;
    log: { log: (message: string) => void };
}): Promise<void> {
    const { kvUpdate, applyTodoSocketUpdates, invalidateTodosSync, log } = params;

    // Process KV changes for todos
    if (kvUpdate.changes && Array.isArray(kvUpdate.changes)) {
        const todoChanges = kvUpdate.changes.filter(
            (change: any) => change.key && typeof change.key === 'string' && change.key.startsWith('todo.'),
        );

        if (todoChanges.length > 0) {
            log.log(`📝 Processing ${todoChanges.length} todo KV changes from socket`);

            // Apply the changes directly to avoid unnecessary refetch
            try {
                await applyTodoSocketUpdates(todoChanges);
            } catch (error) {
                console.error('Failed to apply todo socket updates:', error);
                // Fallback to refetch on error
                invalidateTodosSync();
            }
        }
    }
}

