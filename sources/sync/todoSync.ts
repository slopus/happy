import { AuthCredentials } from '@/auth/tokenStorage';
import { sync } from './sync';
import { storage } from './storage';
import {
    kvGet,
    kvBulkGet,
    kvList,
    kvMutate,
    kvSet,
    kvDelete,
    KvItem,
    KvMutation
} from './apiKv';
import { randomUUID } from 'expo-crypto';

//
// Types
//

export interface TodoItem {
    id: string;
    title: string;
    done: boolean;
    createdAt: number;
    updatedAt: number;
}

export interface TodoIndex {
    undoneOrder: string[];
    doneOrder: string[];
}

export interface TodoState {
    todos: Record<string, TodoItem>;
    undoneOrder: string[];
    doneOrder: string[];
    versions: Record<string, number>;  // Track KV versions for each key
}

//
// Constants
//

const TODO_PREFIX = 'todo.';
const TODO_INDEX_KEY = 'todo.index';

//
// Helper Functions
//

function getTodoKey(id: string): string {
    return `${TODO_PREFIX}${id}`;
}

async function encryptTodoData(data: any): Promise<string> {
    return await sync.encryption.encryptRaw(data);
}

async function decryptTodoData(encrypted: string): Promise<any> {
    return await sync.encryption.decryptRaw(encrypted);
}

//
// Fetch Functions
//

/**
 * Fetch all todos from the server and decrypt them
 */
export async function fetchTodos(credentials: AuthCredentials): Promise<TodoState> {
    // Fetch all KV items with todo prefix
    const response = await kvList(credentials, {
        prefix: TODO_PREFIX,
        limit: 1000  // Should be enough for todos
    });

    const state: TodoState = {
        todos: {},
        undoneOrder: [],
        doneOrder: [],
        versions: {}
    };

    // Process each item
    for (const item of response.items) {
        state.versions[item.key] = item.version;

        try {
            const decrypted = await decryptTodoData(item.value);

            if (item.key === TODO_INDEX_KEY) {
                // Handle index
                const index = decrypted as TodoIndex;
                state.undoneOrder = index.undoneOrder || [];
                state.doneOrder = index.doneOrder || [];
            } else if (item.key.startsWith(TODO_PREFIX)) {
                // Handle todo item
                const todoId = item.key.substring(TODO_PREFIX.length);
                if (todoId && todoId !== 'index') {
                    state.todos[todoId] = decrypted as TodoItem;
                }
            }
        } catch (error) {
            console.error(`Failed to decrypt todo item ${item.key}:`, error);
        }
    }

    // Clean up orders - remove IDs that don't exist in todos
    state.undoneOrder = state.undoneOrder.filter(id => id in state.todos);
    state.doneOrder = state.doneOrder.filter(id => id in state.todos);

    // Add any todos that exist but aren't in any order list
    const allOrderedIds = new Set([...state.undoneOrder, ...state.doneOrder]);
    for (const todoId in state.todos) {
        if (!allOrderedIds.has(todoId)) {
            const todo = state.todos[todoId];
            if (todo.done) {
                state.doneOrder.push(todoId);
            } else {
                state.undoneOrder.push(todoId);
            }
        }
    }

    return state;
}

/**
 * Initialize todo sync and load initial data
 */
export async function initializeTodoSync(credentials: AuthCredentials): Promise<void> {
    try {
        const todoState = await fetchTodos(credentials);
        storage.getState().applyTodos(todoState);
    } catch (error) {
        console.error('Failed to initialize todo sync:', error);
        // Initialize with empty state on error
        storage.getState().applyTodos({
            todos: {},
            undoneOrder: [],
            doneOrder: [],
            versions: {}
        });
    }
}

//
// Mutation Functions
//

/**
 * Add a new todo
 */
export async function addTodo(
    credentials: AuthCredentials,
    title: string
): Promise<string> {
    const id = randomUUID();
    const now = Date.now();

    const newTodo: TodoItem = {
        id,
        title,
        done: false,
        createdAt: now,
        updatedAt: now
    };

    // Get current state
    const currentState = storage.getState();
    const { todos, undoneOrder, doneOrder, versions } = currentState.todoState || {
        todos: {},
        undoneOrder: [],
        doneOrder: [],
        versions: {}
    };

    // Update local state optimistically
    const newUndoneOrder = [...undoneOrder, id];
    const newIndex: TodoIndex = {
        undoneOrder: newUndoneOrder,
        doneOrder
    };

    storage.getState().applyTodos({
        todos: { ...todos, [id]: newTodo },
        undoneOrder: newUndoneOrder,
        doneOrder,
        versions
    });

    // Sync to server
    try {
        const mutations: KvMutation[] = [
            {
                key: getTodoKey(id),
                value: await encryptTodoData(newTodo),
                version: -1  // New key
            },
            {
                key: TODO_INDEX_KEY,
                value: await encryptTodoData(newIndex),
                version: versions[TODO_INDEX_KEY] || -1
            }
        ];

        const result = await kvMutate(credentials, mutations);

        if (result.success) {
            // Update versions
            const newVersions = { ...versions };
            for (const res of result.results) {
                newVersions[res.key] = res.version;
            }

            storage.getState().applyTodos({
                todos: { ...todos, [id]: newTodo },
                undoneOrder: newUndoneOrder,
                doneOrder,
                versions: newVersions
            });
        } else {
            // Handle conflict - retry with current version from server
            console.warn('Todo add conflict, retrying with current version...');

            // Find the index error to get current version
            const indexError = result.errors.find(e => e.key === TODO_INDEX_KEY);
            if (indexError) {
                // If index exists on server but we don't have it locally, we need to merge
                let mergedIndex = newIndex;
                if (indexError.value) {
                    try {
                        const serverIndex = await decryptTodoData(indexError.value) as TodoIndex;
                        // Merge: add our new todo to server's index if not already there
                        mergedIndex = {
                            undoneOrder: serverIndex.undoneOrder.includes(id)
                                ? serverIndex.undoneOrder
                                : [...serverIndex.undoneOrder, id],
                            doneOrder: serverIndex.doneOrder.filter(tid => tid !== id)
                        };
                    } catch (err) {
                        console.error('Failed to decrypt server index, using local version', err);
                    }
                }

                // Retry with the current version
                const retryMutations: KvMutation[] = [
                    {
                        key: getTodoKey(id),
                        value: await encryptTodoData(newTodo),
                        version: -1  // New key
                    },
                    {
                        key: TODO_INDEX_KEY,
                        value: await encryptTodoData(mergedIndex),
                        version: indexError.version  // Use current version from server
                    }
                ];

                const retryResult = await kvMutate(credentials, retryMutations);

                if (retryResult.success) {
                    // Update versions
                    const newVersions = { ...versions };
                    for (const res of retryResult.results) {
                        newVersions[res.key] = res.version;
                    }

                    storage.getState().applyTodos({
                        todos: { ...todos, [id]: newTodo },
                        undoneOrder: mergedIndex.undoneOrder,
                        doneOrder: mergedIndex.doneOrder,
                        versions: newVersions
                    });
                } else {
                    // If still failing, refetch everything
                    console.error('Todo add retry failed, refetching all todos...');
                    await initializeTodoSync(credentials);
                }
            } else {
                // If no index error, just refetch
                await initializeTodoSync(credentials);
            }
        }
    } catch (error) {
        console.error('Failed to sync new todo:', error);
    }

    return id;
}

/**
 * Update a todo's title
 */
export async function updateTodoTitle(
    credentials: AuthCredentials,
    id: string,
    title: string
): Promise<void> {
    const currentState = storage.getState();
    const { todos, undoneOrder, doneOrder, versions } = currentState.todoState || {
        todos: {},
        undoneOrder: [],
        doneOrder: [],
        versions: {}
    };

    const todo = todos[id];
    if (!todo) {
        console.error(`Todo ${id} not found`);
        return;
    }

    const updatedTodo: TodoItem = {
        ...todo,
        title,
        updatedAt: Date.now()
    };

    // Update local state optimistically
    storage.getState().applyTodos({
        todos: { ...todos, [id]: updatedTodo },
        undoneOrder,
        doneOrder,
        versions
    });

    // Sync to server
    try {
        const encrypted = await encryptTodoData(updatedTodo);
        const newVersion = await kvSet(
            credentials,
            getTodoKey(id),
            encrypted,
            versions[getTodoKey(id)] || -1
        );

        // Update version
        const newVersions = { ...versions };
        newVersions[getTodoKey(id)] = newVersion;

        storage.getState().applyTodos({
            todos: { ...todos, [id]: updatedTodo },
            undoneOrder,
            doneOrder,
            versions: newVersions
        });
    } catch (error) {
        console.error('Failed to update todo title:', error);
        // Refetch on conflict
        await initializeTodoSync(credentials);
    }
}

/**
 * Toggle a todo's done status
 */
export async function toggleTodo(
    credentials: AuthCredentials,
    id: string
): Promise<void> {
    const currentState = storage.getState();
    const { todos, undoneOrder, doneOrder, versions } = currentState.todoState || {
        todos: {},
        undoneOrder: [],
        doneOrder: [],
        versions: {}
    };

    const todo = todos[id];
    if (!todo) {
        console.error(`Todo ${id} not found`);
        return;
    }

    const updatedTodo: TodoItem = {
        ...todo,
        done: !todo.done,
        updatedAt: Date.now()
    };

    // Update orders
    let newUndoneOrder = [...undoneOrder];
    let newDoneOrder = [...doneOrder];

    if (updatedTodo.done) {
        // Moving to done
        newUndoneOrder = newUndoneOrder.filter(tid => tid !== id);
        newDoneOrder = [id, ...newDoneOrder];
    } else {
        // Moving to undone
        newDoneOrder = newDoneOrder.filter(tid => tid !== id);
        newUndoneOrder = [...newUndoneOrder, id];
    }

    const newIndex: TodoIndex = {
        undoneOrder: newUndoneOrder,
        doneOrder: newDoneOrder
    };

    // Update local state optimistically
    storage.getState().applyTodos({
        todos: { ...todos, [id]: updatedTodo },
        undoneOrder: newUndoneOrder,
        doneOrder: newDoneOrder,
        versions
    });

    // Sync to server
    try {
        const mutations: KvMutation[] = [
            {
                key: getTodoKey(id),
                value: await encryptTodoData(updatedTodo),
                version: versions[getTodoKey(id)] || -1
            },
            {
                key: TODO_INDEX_KEY,
                value: await encryptTodoData(newIndex),
                version: versions[TODO_INDEX_KEY] || -1
            }
        ];

        const result = await kvMutate(credentials, mutations);

        if (result.success) {
            // Update versions
            const newVersions = { ...versions };
            for (const res of result.results) {
                newVersions[res.key] = res.version;
            }

            storage.getState().applyTodos({
                todos: { ...todos, [id]: updatedTodo },
                undoneOrder: newUndoneOrder,
                doneOrder: newDoneOrder,
                versions: newVersions
            });
        } else {
            // Handle conflict
            console.error('Todo toggle conflict, refetching...');
            await initializeTodoSync(credentials);
        }
    } catch (error) {
        console.error('Failed to toggle todo:', error);
    }
}

/**
 * Delete a todo
 */
export async function deleteTodo(
    credentials: AuthCredentials,
    id: string
): Promise<void> {
    const currentState = storage.getState();
    const { todos, undoneOrder, doneOrder, versions } = currentState.todoState || {
        todos: {},
        undoneOrder: [],
        doneOrder: [],
        versions: {}
    };

    if (!(id in todos)) {
        console.error(`Todo ${id} not found`);
        return;
    }

    // Remove from state
    const { [id]: deletedTodo, ...remainingTodos } = todos;
    const newUndoneOrder = undoneOrder.filter(tid => tid !== id);
    const newDoneOrder = doneOrder.filter(tid => tid !== id);

    const newIndex: TodoIndex = {
        undoneOrder: newUndoneOrder,
        doneOrder: newDoneOrder
    };

    // Update local state optimistically
    storage.getState().applyTodos({
        todos: remainingTodos,
        undoneOrder: newUndoneOrder,
        doneOrder: newDoneOrder,
        versions
    });

    // Sync to server
    try {
        const mutations: KvMutation[] = [
            {
                key: getTodoKey(id),
                value: null,  // Delete
                version: versions[getTodoKey(id)] || 0
            },
            {
                key: TODO_INDEX_KEY,
                value: await encryptTodoData(newIndex),
                version: versions[TODO_INDEX_KEY] || -1
            }
        ];

        const result = await kvMutate(credentials, mutations);

        if (result.success) {
            // Update versions
            const newVersions = { ...versions };
            delete newVersions[getTodoKey(id)];  // Remove deleted key version
            for (const res of result.results) {
                if (res.key === TODO_INDEX_KEY) {
                    newVersions[res.key] = res.version;
                }
            }

            storage.getState().applyTodos({
                todos: remainingTodos,
                undoneOrder: newUndoneOrder,
                doneOrder: newDoneOrder,
                versions: newVersions
            });
        } else {
            // Handle conflict
            console.error('Todo delete conflict, refetching...');
            await initializeTodoSync(credentials);
        }
    } catch (error) {
        console.error('Failed to delete todo:', error);
    }
}

/**
 * Reorder todos
 */
export async function reorderTodos(
    credentials: AuthCredentials,
    todoId: string,
    targetIndex: number,
    targetList: 'done' | 'undone'
): Promise<void> {
    const currentState = storage.getState();
    const { todos, undoneOrder, doneOrder, versions } = currentState.todoState || {
        todos: {},
        undoneOrder: [],
        doneOrder: [],
        versions: {}
    };

    const todo = todos[todoId];
    if (!todo) {
        console.error(`Todo ${todoId} not found`);
        return;
    }

    let updatedTodo = todo;
    let newUndoneOrder = [...undoneOrder];
    let newDoneOrder = [...doneOrder];

    // Remove from current position
    newUndoneOrder = newUndoneOrder.filter(id => id !== todoId);
    newDoneOrder = newDoneOrder.filter(id => id !== todoId);

    // Add to new position
    if (targetList === 'done') {
        if (!todo.done) {
            updatedTodo = { ...todo, done: true, updatedAt: Date.now() };
        }
        newDoneOrder.splice(targetIndex, 0, todoId);
    } else {
        if (todo.done) {
            updatedTodo = { ...todo, done: false, updatedAt: Date.now() };
        }
        newUndoneOrder.splice(targetIndex, 0, todoId);
    }

    const newIndex: TodoIndex = {
        undoneOrder: newUndoneOrder,
        doneOrder: newDoneOrder
    };

    // Update local state optimistically
    storage.getState().applyTodos({
        todos: { ...todos, [todoId]: updatedTodo },
        undoneOrder: newUndoneOrder,
        doneOrder: newDoneOrder,
        versions
    });

    // Sync to server
    try {
        const mutations: KvMutation[] = [];

        // Add todo update if status changed
        if (updatedTodo !== todo) {
            mutations.push({
                key: getTodoKey(todoId),
                value: await encryptTodoData(updatedTodo),
                version: versions[getTodoKey(todoId)] || -1
            });
        }

        // Always update index
        mutations.push({
            key: TODO_INDEX_KEY,
            value: await encryptTodoData(newIndex),
            version: versions[TODO_INDEX_KEY] || -1
        });

        const result = await kvMutate(credentials, mutations);

        if (result.success) {
            // Update versions
            const newVersions = { ...versions };
            for (const res of result.results) {
                newVersions[res.key] = res.version;
            }

            storage.getState().applyTodos({
                todos: { ...todos, [todoId]: updatedTodo },
                undoneOrder: newUndoneOrder,
                doneOrder: newDoneOrder,
                versions: newVersions
            });
        } else {
            // Handle conflict
            console.error('Todo reorder conflict, refetching...');
            await initializeTodoSync(credentials);
        }
    } catch (error) {
        console.error('Failed to reorder todos:', error);
    }
}