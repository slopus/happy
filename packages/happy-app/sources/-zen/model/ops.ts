import { AuthCredentials } from '@/auth/tokenStorage';
import { sync } from '../../sync/sync';
import { storage } from '../../sync/storage';
import {
    kvGet,
    kvBulkGet,
    kvList,
    kvMutate,
    kvSet,
    kvDelete,
    KvItem,
    KvMutation
} from '../../sync/apiKv';
import { randomUUID } from 'expo-crypto';
import { AsyncLock } from '@/utils/lock';

//
// Lock Instance
//

const todoLock = new AsyncLock();

//
// Types
//

export interface TodoItem {
    id: string;
    title: string;
    done: boolean;
    createdAt: number;
    updatedAt: number;
    completedAt?: number;  // Timestamp when marked as done
    linkedSessions?: {
        [sessionId: string]: {
            title: string;      // Display title (e.g., "Clarify: Task Name")
            linkedAt: number;   // Unix timestamp when linked
        }
    };
}

export interface TodoIndex {
    undoneOrder: string[];
    completedOrder: string[];  // Ordered by completion time (newest first)
}

export interface TodoState {
    todos: Record<string, TodoItem>;
    undoneOrder: string[];
    doneOrder: string[];  // Keep storage compatible, but we'll order by completion time
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
        doneOrder: [],  // Will be mapped from completedOrder
        versions: {}
    };

    // Process each item
    for (const item of response.items) {
        state.versions[item.key] = item.version;

        try {
            const decrypted = await decryptTodoData(item.value);

            if (item.key === TODO_INDEX_KEY) {
                // Handle index - map completedOrder to doneOrder for storage
                const index = decrypted as TodoIndex;
                state.undoneOrder = index.undoneOrder || [];
                state.doneOrder = index.completedOrder || [];  // Map completedOrder to doneOrder
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
        updatedAt: now,
        linkedSessions: {}  // Initialize with empty map
    };

    // Get current state
    const currentState = storage.getState();
    const { todos, undoneOrder, doneOrder, versions } = currentState.todoState || {
        todos: {},
        undoneOrder: [],
        doneOrder: [],
        versions: {}
    };

    // Apply optimistic update immediately
    const optimisticUndoneOrder = [...undoneOrder, id];
    storage.getState().applyTodos({
        todos: { ...todos, [id]: newTodo },
        undoneOrder: optimisticUndoneOrder,
        doneOrder,
        versions
    });

    // Sync to server inside lock
    await todoLock.inLock(async () => {
        try {
            // Fetch current index from backend
            const indexResponse = await kvGet(credentials, TODO_INDEX_KEY);
            let currentIndex: TodoIndex = { undoneOrder: [], completedOrder: [] };
            let indexVersion = -1;

            if (indexResponse) {
                indexVersion = indexResponse.version;
                try {
                    currentIndex = await decryptTodoData(indexResponse.value) as TodoIndex;
                } catch (err) {
                    console.error('Failed to decrypt server index', err);
                }
            }

            // Merge our new todo into the server's index
            const mergedIndex: TodoIndex = {
                undoneOrder: (currentIndex.undoneOrder || []).includes(id)
                    ? (currentIndex.undoneOrder || [])
                    : [...(currentIndex.undoneOrder || []), id],
                completedOrder: (currentIndex.completedOrder || []).filter(tid => tid !== id)
            };

            // Write both todo and updated index
            const mutations: KvMutation[] = [
                {
                    key: getTodoKey(id),
                    value: await encryptTodoData(newTodo),
                    version: -1  // New key
                },
                {
                    key: TODO_INDEX_KEY,
                    value: await encryptTodoData(mergedIndex),
                    version: indexVersion
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
                    undoneOrder: mergedIndex.undoneOrder,
                    doneOrder: mergedIndex.completedOrder,  // Map completedOrder to doneOrder
                    versions: newVersions
                });
            } else {
                // On failure, refetch everything as last resort
                console.error('Todo add failed, refetching all todos...');
                await initializeTodoSync(credentials);
            }
        } catch (error) {
            console.error('Failed to sync new todo:', error);
            // Keep optimistic update even on error
        }
    });

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

    // Apply optimistic update immediately
    storage.getState().applyTodos({
        todos: { ...todos, [id]: updatedTodo },
        undoneOrder,
        doneOrder,
        versions
    });

    // Sync to server inside lock
    await todoLock.inLock(async () => {
        try {
            // Fetch current todo from backend with version
            const todoKey = getTodoKey(id);
            const todoResponse = await kvGet(credentials, todoKey);

            if (!todoResponse) {
                // Todo doesn't exist on backend, create it
                const encrypted = await encryptTodoData(updatedTodo);
                const newVersion = await kvSet(credentials, todoKey, encrypted, -1);

                // Update version
                const newVersions = { ...versions };
                newVersions[todoKey] = newVersion;

                storage.getState().applyTodos({
                    todos: { ...todos, [id]: updatedTodo },
                    undoneOrder,
                    doneOrder,
                    versions: newVersions
                });
            } else {
                // Merge with server version - only update if title actually changed
                let serverTodo: TodoItem;
                try {
                    serverTodo = await decryptTodoData(todoResponse.value) as TodoItem;
                } catch (err) {
                    console.error('Failed to decrypt server todo', err);
                    serverTodo = updatedTodo; // Use our version as fallback
                }

                // Merge: keep server data but update title and timestamp
                const mergedTodo: TodoItem = {
                    ...serverTodo,
                    title,
                    updatedAt: Date.now()
                };

                // Only write if something changed
                if (serverTodo.title !== title) {
                    const encrypted = await encryptTodoData(mergedTodo);
                    const newVersion = await kvSet(credentials, todoKey, encrypted, todoResponse.version);

                    // Update version
                    const newVersions = { ...versions };
                    newVersions[todoKey] = newVersion;

                    storage.getState().applyTodos({
                        todos: { ...todos, [id]: mergedTodo },
                        undoneOrder,
                        doneOrder,
                        versions: newVersions
                    });
                } else {
                    // No change needed, just update version
                    const newVersions = { ...versions };
                    newVersions[todoKey] = todoResponse.version;

                    storage.getState().applyTodos({
                        todos: { ...todos, [id]: serverTodo },
                        undoneOrder,
                        doneOrder,
                        versions: newVersions
                    });
                }
            }
        } catch (error) {
            console.error('Failed to update todo title:', error);
            // Keep optimistic update even on error
        }
    });
}

/**
 * Toggle a todo's done status (dedicated mutation for done/undone)
 * When marking as done, adds to the beginning of completedOrder
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

    const now = Date.now();
    const updatedTodo: TodoItem = {
        ...todo,
        done: !todo.done,
        updatedAt: now,
        completedAt: !todo.done ? now : undefined  // Set completedAt when marking as done
    };

    // Calculate new orders optimistically
    let optimisticUndoneOrder = [...undoneOrder];
    let optimisticDoneOrder = [...doneOrder];

    if (updatedTodo.done) {
        // Moving to done - remove from undone, add to beginning of done
        optimisticUndoneOrder = optimisticUndoneOrder.filter(tid => tid !== id);
        optimisticDoneOrder = [id, ...optimisticDoneOrder.filter(tid => tid !== id)];
    } else {
        // Moving to undone - remove from done, add to end of undone
        optimisticDoneOrder = optimisticDoneOrder.filter(tid => tid !== id);
        optimisticUndoneOrder = [...optimisticUndoneOrder.filter(tid => tid !== id), id];
    }

    // Apply optimistic update immediately
    storage.getState().applyTodos({
        todos: { ...todos, [id]: updatedTodo },
        undoneOrder: optimisticUndoneOrder,
        doneOrder: optimisticDoneOrder,
        versions
    });

    // Sync to server inside lock
    await todoLock.inLock(async () => {
        try {
            // Fetch current todo and index from backend
            const todoKey = getTodoKey(id);
            const [todoResponse, indexResponse] = await Promise.all([
                kvGet(credentials, todoKey),
                kvGet(credentials, TODO_INDEX_KEY)
            ]);

            // Prepare todo for backend
            let serverTodo = updatedTodo;
            let todoVersion = -1;

            if (todoResponse) {
                todoVersion = todoResponse.version;
                try {
                    const existingTodo = await decryptTodoData(todoResponse.value) as TodoItem;
                    // Merge: keep server data but update done status and timestamps
                    serverTodo = {
                        ...existingTodo,
                        done: updatedTodo.done,
                        updatedAt: now,
                        completedAt: updatedTodo.done ? now : undefined
                    };
                } catch (err) {
                    console.error('Failed to decrypt server todo', err);
                }
            }

            // Prepare index for backend
            let currentIndex: TodoIndex = { undoneOrder: [], completedOrder: [] };
            let indexVersion = -1;

            if (indexResponse) {
                indexVersion = indexResponse.version;
                try {
                    currentIndex = await decryptTodoData(indexResponse.value) as TodoIndex;
                } catch (err) {
                    console.error('Failed to decrypt server index', err);
                }
            }

            // Update index based on new done status
            let newUndoneOrder = (currentIndex.undoneOrder || []).filter(tid => tid !== id);
            let newCompletedOrder = (currentIndex.completedOrder || []).filter(tid => tid !== id);

            if (serverTodo.done) {
                // When marking as done, add to beginning of completed list
                newCompletedOrder = [id, ...newCompletedOrder];
            } else {
                // When marking as undone, add to end of undone list
                newUndoneOrder = [...newUndoneOrder, id];
            }

            const mergedIndex: TodoIndex = {
                undoneOrder: newUndoneOrder,
                completedOrder: newCompletedOrder
            };

            // Write both todo and index
            const mutations: KvMutation[] = [
                {
                    key: todoKey,
                    value: await encryptTodoData(serverTodo),
                    version: todoVersion
                },
                {
                    key: TODO_INDEX_KEY,
                    value: await encryptTodoData(mergedIndex),
                    version: indexVersion
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
                    todos: { ...todos, [id]: serverTodo },
                    undoneOrder: mergedIndex.undoneOrder,
                    doneOrder: mergedIndex.completedOrder,  // Map completedOrder to doneOrder
                    versions: newVersions
                });
            } else {
                // On failure, refetch everything as last resort
                console.error('Todo toggle failed, refetching all todos...');
                await initializeTodoSync(credentials);
            }
        } catch (error) {
            console.error('Failed to toggle todo:', error);
            // Keep optimistic update even on error
        }
    });
}

/**
 * Update a todo's linked sessions
 */
export async function updateTodoLinkedSessions(
    taskId: string,
    linkedSessions: TodoItem['linkedSessions']
): Promise<void> {
    const auth = (await import('@/auth/AuthContext')).getCurrentAuth();
    if (!auth?.credentials) {
        console.error('No auth credentials available');
        return;
    }

    const currentState = storage.getState();
    const { todos, undoneOrder, doneOrder, versions } = currentState.todoState || {
        todos: {},
        undoneOrder: [],
        doneOrder: [],
        versions: {}
    };

    const todo = todos[taskId];
    if (!todo) {
        console.error(`Todo ${taskId} not found`);
        return;
    }

    const updatedTodo: TodoItem = {
        ...todo,
        linkedSessions,
        updatedAt: Date.now()
    };

    // Apply optimistic update immediately
    storage.getState().applyTodos({
        todos: { ...todos, [taskId]: updatedTodo },
        undoneOrder,
        doneOrder,
        versions
    });

    // Sync to server inside lock
    await todoLock.inLock(async () => {
        try {
            if (!auth.credentials) {
                console.error('No credentials available for sync');
                return;
            }

            const todoKey = getTodoKey(taskId);
            const todoResponse = await kvGet(auth.credentials, todoKey);

            if (todoResponse) {
                // Update existing todo
                const encrypted = await encryptTodoData(updatedTodo);
                const newVersion = await kvSet(auth.credentials, todoKey, encrypted, todoResponse.version);

                // Update version
                const newVersions = { ...versions };
                newVersions[todoKey] = newVersion;

                storage.getState().applyTodos({
                    todos: { ...todos, [taskId]: updatedTodo },
                    undoneOrder,
                    doneOrder,
                    versions: newVersions
                });
            } else {
                // Todo doesn't exist on backend, create it
                const encrypted = await encryptTodoData(updatedTodo);
                const newVersion = await kvSet(auth.credentials, todoKey, encrypted, -1);

                // Update version
                const newVersions = { ...versions };
                newVersions[todoKey] = newVersion;

                storage.getState().applyTodos({
                    todos: { ...todos, [taskId]: updatedTodo },
                    undoneOrder,
                    doneOrder,
                    versions: newVersions
                });
            }
        } catch (error) {
            console.error('Failed to sync linked sessions update:', error);
            // Keep optimistic update even on error
        }
    });
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

    // Remove from state optimistically
    const { [id]: deletedTodo, ...remainingTodos } = todos;
    const optimisticUndoneOrder = undoneOrder.filter(tid => tid !== id);
    const optimisticDoneOrder = doneOrder.filter(tid => tid !== id);

    // Apply optimistic update immediately
    storage.getState().applyTodos({
        todos: remainingTodos,
        undoneOrder: optimisticUndoneOrder,
        doneOrder: optimisticDoneOrder,
        versions
    });

    // Sync to server inside lock
    await todoLock.inLock(async () => {
        try {
            // Fetch current index from backend
            const indexResponse = await kvGet(credentials, TODO_INDEX_KEY);
            let currentIndex: TodoIndex = { undoneOrder: [], completedOrder: [] };
            let indexVersion = -1;

            if (indexResponse) {
                indexVersion = indexResponse.version;
                try {
                    currentIndex = await decryptTodoData(indexResponse.value) as TodoIndex;
                } catch (err) {
                    console.error('Failed to decrypt server index', err);
                }
            }

            // Remove todo from server's index
            const mergedIndex: TodoIndex = {
                undoneOrder: (currentIndex.undoneOrder || []).filter((tid: string) => tid !== id),
                completedOrder: (currentIndex.completedOrder || []).filter((tid: string) => tid !== id)
            };

            // Get todo version for deletion
            const todoKey = getTodoKey(id);
            const todoVersion = versions[todoKey] || 0;

            // Delete todo and update index
            const mutations: KvMutation[] = [
                {
                    key: todoKey,
                    value: null,  // Delete
                    version: todoVersion
                },
                {
                    key: TODO_INDEX_KEY,
                    value: await encryptTodoData(mergedIndex),
                    version: indexVersion
                }
            ];

            const result = await kvMutate(credentials, mutations);

            if (result.success) {
                // Update versions
                const newVersions = { ...versions };
                delete newVersions[todoKey];  // Remove deleted key version
                for (const res of result.results) {
                    if (res.key === TODO_INDEX_KEY) {
                        newVersions[res.key] = res.version;
                    }
                }

                storage.getState().applyTodos({
                    todos: remainingTodos,
                    undoneOrder: mergedIndex.undoneOrder,
                    doneOrder: mergedIndex.completedOrder,  // Map completedOrder to doneOrder
                    versions: newVersions
                });
            } else {
                // On failure, refetch everything as last resort
                console.error('Todo delete failed, refetching all todos...');
                await initializeTodoSync(credentials);
            }
        } catch (error) {
            console.error('Failed to delete todo:', error);
            // Keep optimistic update even on error
        }
    });
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
    let optimisticUndoneOrder = [...undoneOrder];
    let optimisticDoneOrder = [...doneOrder];

    // Remove from current position
    optimisticUndoneOrder = optimisticUndoneOrder.filter(id => id !== todoId);
    optimisticDoneOrder = optimisticDoneOrder.filter(id => id !== todoId);

    // Add to new position
    if (targetList === 'done') {
        if (!todo.done) {
            updatedTodo = { ...todo, done: true, updatedAt: Date.now() };
        }
        optimisticDoneOrder.splice(targetIndex, 0, todoId);
    } else {
        if (todo.done) {
            updatedTodo = { ...todo, done: false, updatedAt: Date.now() };
        }
        optimisticUndoneOrder.splice(targetIndex, 0, todoId);
    }

    // Apply optimistic update immediately
    storage.getState().applyTodos({
        todos: { ...todos, [todoId]: updatedTodo },
        undoneOrder: optimisticUndoneOrder,
        doneOrder: optimisticDoneOrder,
        versions
    });

    // Sync to server inside lock
    await todoLock.inLock(async () => {
        try {
            // Fetch current index from backend
            const indexResponse = await kvGet(credentials, TODO_INDEX_KEY);
            let currentIndex: TodoIndex = { undoneOrder: [], completedOrder: [] };
            let indexVersion = -1;

            if (indexResponse) {
                indexVersion = indexResponse.version;
                try {
                    currentIndex = await decryptTodoData(indexResponse.value) as TodoIndex;
                } catch (err) {
                    console.error('Failed to decrypt server index', err);
                }
            }

            // Apply reordering to server's index
            let newUndoneOrder = (currentIndex.undoneOrder || []).filter((id: string) => id !== todoId);
            let newCompletedOrder = (currentIndex.completedOrder || []).filter((id: string) => id !== todoId);

            // Insert at target position
            if (targetList === 'done') {
                // Ensure targetIndex is valid for the server's list
                const validIndex = Math.min(targetIndex, newCompletedOrder.length);
                newCompletedOrder.splice(validIndex, 0, todoId);
            } else {
                // Ensure targetIndex is valid for the server's list
                const validIndex = Math.min(targetIndex, newUndoneOrder.length);
                newUndoneOrder.splice(validIndex, 0, todoId);
            }

            const mergedIndex: TodoIndex = {
                undoneOrder: newUndoneOrder,
                completedOrder: newCompletedOrder
            };

            const mutations: KvMutation[] = [];

            // If todo status changed, fetch and update it
            if (updatedTodo.done !== todo.done) {
                const todoKey = getTodoKey(todoId);
                const todoResponse = await kvGet(credentials, todoKey);
                let todoVersion = -1;
                let serverTodo = updatedTodo;

                if (todoResponse) {
                    todoVersion = todoResponse.version;
                    try {
                        const existingTodo = await decryptTodoData(todoResponse.value) as TodoItem;
                        // Merge: keep server data but update done status
                        serverTodo = {
                            ...existingTodo,
                            done: updatedTodo.done,
                            updatedAt: Date.now()
                        };
                    } catch (err) {
                        console.error('Failed to decrypt server todo', err);
                    }
                }

                mutations.push({
                    key: todoKey,
                    value: await encryptTodoData(serverTodo),
                    version: todoVersion
                });

                // Update local reference for final storage update
                updatedTodo = serverTodo;
            }

            // Always update index
            mutations.push({
                key: TODO_INDEX_KEY,
                value: await encryptTodoData(mergedIndex),
                version: indexVersion
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
                    undoneOrder: mergedIndex.undoneOrder,
                    doneOrder: mergedIndex.completedOrder,  // Map completedOrder to doneOrder
                    versions: newVersions
                });
            } else {
                // On failure, refetch everything as last resort
                console.error('Todo reorder failed, refetching all todos...');
                await initializeTodoSync(credentials);
            }
        } catch (error) {
            console.error('Failed to reorder todos:', error);
            // Keep optimistic update even on error
        }
    });
}