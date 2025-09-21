import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { v4 as uuidv4 } from 'uuid';
import { TodoData, TodosState, loadTodos, saveTodos } from './todoStorage';

interface TodoStore extends TodosState {
    // Actions
    addTodo: (title: string) => string; // Returns the ID of the new todo
    toggleTodo: (id: string) => void;
    updateTodoTitle: (id: string, title: string) => void;
    deleteTodo: (id: string) => void;
    reorderTodos: (todoId: string, targetIndex: number, targetList: 'done' | 'undone') => void;
    
    // Computed getters
    getOrderedUndoneTodos: () => TodoData[];
    getOrderedDoneTodos: () => TodoData[];
    getTodo: (id: string) => TodoData | undefined;
}

export const useTodoStore = create<TodoStore>()(
    subscribeWithSelector((set, get) => {
        // Load initial state from storage
        const initialState = loadTodos();
        
        return {
            ...initialState,
            
            addTodo: (title: string) => {
                const id = uuidv4();
                const newTodo: TodoData = {
                    id,
                    title,
                    done: false
                };
                
                set((state) => {
                    const newState = {
                        todos: {
                            ...state.todos,
                            [id]: newTodo
                        },
                        // Add to bottom of undone list
                        undoneOrder: [...state.undoneOrder, id],
                        doneOrder: state.doneOrder
                    };
                    
                    // Save to storage
                    saveTodos(newState);
                    
                    return newState;
                });
                
                return id;
            },
            
            toggleTodo: (id: string) => {
                set((state) => {
                    const todo = state.todos[id];
                    if (!todo) return state;
                    
                    const newTodo = {
                        ...todo,
                        done: !todo.done
                    };
                    
                    let newUndoneOrder = [...state.undoneOrder];
                    let newDoneOrder = [...state.doneOrder];
                    
                    if (newTodo.done) {
                        // Moving from undone to done
                        // Remove from undone list
                        newUndoneOrder = newUndoneOrder.filter(taskId => taskId !== id);
                        // Add to top of done list
                        newDoneOrder = [id, ...newDoneOrder];
                    } else {
                        // Moving from done to undone
                        // Remove from done list
                        newDoneOrder = newDoneOrder.filter(taskId => taskId !== id);
                        // Add to bottom of undone list
                        newUndoneOrder = [...newUndoneOrder, id];
                    }
                    
                    const newState = {
                        todos: {
                            ...state.todos,
                            [id]: newTodo
                        },
                        undoneOrder: newUndoneOrder,
                        doneOrder: newDoneOrder
                    };
                    
                    // Save to storage
                    saveTodos(newState);
                    
                    return newState;
                });
            },
            
            updateTodoTitle: (id: string, title: string) => {
                set((state) => {
                    const todo = state.todos[id];
                    if (!todo) return state;
                    
                    const newState = {
                        ...state,
                        todos: {
                            ...state.todos,
                            [id]: {
                                ...todo,
                                title
                            }
                        }
                    };
                    
                    // Save to storage
                    saveTodos(newState);
                    
                    return newState;
                });
            },
            
            deleteTodo: (id: string) => {
                set((state) => {
                    const { [id]: deletedTodo, ...remainingTodos } = state.todos;
                    
                    const newState = {
                        todos: remainingTodos,
                        undoneOrder: state.undoneOrder.filter(taskId => taskId !== id),
                        doneOrder: state.doneOrder.filter(taskId => taskId !== id)
                    };
                    
                    // Save to storage
                    saveTodos(newState);
                    
                    return newState;
                });
            },
            
            reorderTodos: (todoId: string, targetIndex: number, targetList: 'done' | 'undone') => {
                set((state) => {
                    const todo = state.todos[todoId];
                    if (!todo) return state;
                    
                    let newUndoneOrder = [...state.undoneOrder];
                    let newDoneOrder = [...state.doneOrder];
                    let updatedTodo = todo;
                    
                    // Remove from current list
                    newUndoneOrder = newUndoneOrder.filter(id => id !== todoId);
                    newDoneOrder = newDoneOrder.filter(id => id !== todoId);
                    
                    // Add to target list at specified index
                    if (targetList === 'done') {
                        // Update todo status if moving to done list
                        if (!todo.done) {
                            updatedTodo = { ...todo, done: true };
                        }
                        // Insert at target index
                        newDoneOrder.splice(targetIndex, 0, todoId);
                    } else {
                        // Update todo status if moving to undone list
                        if (todo.done) {
                            updatedTodo = { ...todo, done: false };
                        }
                        // Insert at target index
                        newUndoneOrder.splice(targetIndex, 0, todoId);
                    }
                    
                    const newState = {
                        todos: {
                            ...state.todos,
                            [todoId]: updatedTodo
                        },
                        undoneOrder: newUndoneOrder,
                        doneOrder: newDoneOrder
                    };
                    
                    // Save to storage
                    saveTodos(newState);
                    
                    return newState;
                });
            },
            
            getOrderedUndoneTodos: () => {
                const state = get();
                return state.undoneOrder
                    .map(id => state.todos[id])
                    .filter(Boolean); // Filter out any undefined todos
            },
            
            getOrderedDoneTodos: () => {
                const state = get();
                return state.doneOrder
                    .map(id => state.todos[id])
                    .filter(Boolean); // Filter out any undefined todos
            },
            
            getTodo: (id: string) => {
                const state = get();
                return state.todos[id];
            }
        };
    })
);

// Export hooks for convenience
export function useUndoneTodos() {
    return useTodoStore((state) => state.getOrderedUndoneTodos());
}

export function useDoneTodos() {
    return useTodoStore((state) => state.getOrderedDoneTodos());
}

export function useTodo(id: string) {
    return useTodoStore((state) => state.todos[id]);
}

export function useTodoActions() {
    return useTodoStore((state) => ({
        addTodo: state.addTodo,
        toggleTodo: state.toggleTodo,
        updateTodoTitle: state.updateTodoTitle,
        deleteTodo: state.deleteTodo,
        reorderTodos: state.reorderTodos
    }));
}