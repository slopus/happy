import { MMKV } from 'react-native-mmkv';

const mmkv = new MMKV();

export interface TodoData {
    id: string;
    title: string;
    done: boolean;
}

export interface TodosState {
    todos: Record<string, TodoData>;
    undoneOrder: string[];
    doneOrder: string[];
}

const TODOS_STORAGE_KEY = 'todos-data';

export function loadTodos(): TodosState {
    const todosJson = mmkv.getString(TODOS_STORAGE_KEY);
    if (todosJson) {
        try {
            const parsed = JSON.parse(todosJson) as TodosState;
            // Validate the structure
            if (parsed.todos && parsed.undoneOrder && parsed.doneOrder) {
                return parsed;
            }
        } catch (e) {
            console.error('Failed to parse todos data', e);
        }
    }
    
    // Return default empty state
    return {
        todos: {},
        undoneOrder: [],
        doneOrder: []
    };
}

export function saveTodos(state: TodosState): void {
    try {
        mmkv.set(TODOS_STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
        console.error('Failed to save todos data', e);
    }
}

export function clearTodos(): void {
    mmkv.delete(TODOS_STORAGE_KEY);
}