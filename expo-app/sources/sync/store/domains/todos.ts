import type { TodoState } from '../../../-zen/model/ops';

import type { StoreGet, StoreSet } from './_shared';

export type TodosDomain = {
    todoState: TodoState | null;
    todosLoaded: boolean;
    applyTodos: (todoState: TodoState) => void;
};

export function createTodosDomain<S extends TodosDomain>({
    set,
}: {
    set: StoreSet<S>;
    get: StoreGet<S>;
}): TodosDomain {
    return {
        todoState: null,
        todosLoaded: false,
        applyTodos: (todoState) =>
            set((state) => ({
                ...state,
                todoState,
                todosLoaded: true,
            })),
    };
}

