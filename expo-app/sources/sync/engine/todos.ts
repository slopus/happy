import type { AuthCredentials } from '@/auth/tokenStorage';
import { log } from '@/log';
import { initializeTodoSync } from '../../-zen/model/ops';
import { storage } from '../storage';

type RawEncryption = {
    decryptRaw: (value: string) => Promise<any>;
};

export async function fetchTodos(params: { credentials: AuthCredentials }): Promise<void> {
    const { credentials } = params;

    try {
        log.log('📝 Fetching todos...');
        await initializeTodoSync(credentials);
        log.log('📝 Todos loaded');
    } catch (error) {
        log.log('📝 Failed to fetch todos:');
    }
}

export async function applyTodoSocketUpdates(params: {
    changes: any[];
    encryption: RawEncryption;
    invalidateTodosSync: () => void;
}): Promise<void> {
    const { changes, encryption, invalidateTodosSync } = params;

    const currentState = storage.getState();
    const todoState = currentState.todoState;
    if (!todoState) {
        // No todo state yet, just refetch
        invalidateTodosSync();
        return;
    }

    const { todos, undoneOrder, doneOrder, versions } = todoState;
    const updatedTodos = { ...todos };
    const updatedVersions = { ...versions };
    let newUndoneOrder = undoneOrder;
    let newDoneOrder = doneOrder;

    // Process each change
    for (const change of changes) {
        try {
            const key = change.key;
            const version = change.version;

            // Update version tracking
            updatedVersions[key] = version;

            if (change.value === null) {
                // Item was deleted
                if (key.startsWith('todo.') && key !== 'todo.index') {
                    const todoId = key.substring(5); // Remove 'todo.' prefix
                    delete updatedTodos[todoId];
                    newUndoneOrder = newUndoneOrder.filter((id) => id !== todoId);
                    newDoneOrder = newDoneOrder.filter((id) => id !== todoId);
                }
            } else {
                // Item was added or updated
                const decrypted = await encryption.decryptRaw(change.value);

                if (key === 'todo.index') {
                    // Update the index
                    const index = decrypted as any;
                    newUndoneOrder = index.undoneOrder || [];
                    newDoneOrder = index.completedOrder || []; // Map completedOrder to doneOrder
                } else if (key.startsWith('todo.')) {
                    // Update a todo item
                    const todoId = key.substring(5);
                    if (todoId && todoId !== 'index') {
                        updatedTodos[todoId] = decrypted as any;
                    }
                }
            }
        } catch (error) {
            console.error(`Failed to process todo change for key ${change.key}:`, error);
        }
    }

    // Apply the updated state
    storage.getState().applyTodos({
        todos: updatedTodos,
        undoneOrder: newUndoneOrder,
        doneOrder: newDoneOrder,
        versions: updatedVersions,
    });

    log.log('📝 Applied todo socket updates successfully');
}
