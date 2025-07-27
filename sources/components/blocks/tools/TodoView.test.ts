import { describe, it, expect } from 'vitest';
import { calculateTodoChanges, Todo } from './TodoView';

describe('calculateTodoChanges', () => {
    it('should identify newly added todos with pending status', () => {
        const oldTodos: Todo[] = [];
        const newTodos: Todo[] = [
            { id: '1', content: 'New task', status: 'pending', priority: 'medium' }
        ];

        const changes = calculateTodoChanges(oldTodos, newTodos);

        expect(changes.added).toEqual([
            { id: '1', content: 'New task' }
        ]);
        expect(changes.started).toEqual([]);
        expect(changes.finished).toEqual([]);
    });

    it('should identify newly added todos that start as in_progress', () => {
        const oldTodos: Todo[] = [];
        const newTodos: Todo[] = [
            { id: '1', content: 'Urgent task', status: 'in_progress', priority: 'high' }
        ];

        const changes = calculateTodoChanges(oldTodos, newTodos);

        expect(changes.added).toEqual([]);
        expect(changes.started).toEqual([
            { id: '1', content: 'Urgent task' }
        ]);
        expect(changes.finished).toEqual([]);
    });

    it('should identify newly added todos that are already completed', () => {
        const oldTodos: Todo[] = [];
        const newTodos: Todo[] = [
            { id: '1', content: 'Already done', status: 'completed', priority: 'low' }
        ];

        const changes = calculateTodoChanges(oldTodos, newTodos);

        expect(changes.added).toEqual([]);
        expect(changes.started).toEqual([]);
        expect(changes.finished).toEqual([
            { id: '1', content: 'Already done' }
        ]);
    });

    it('should identify todos that changed from pending to in_progress', () => {
        const oldTodos: Todo[] = [
            { id: '1', content: 'Task A', status: 'pending', priority: 'medium' }
        ];
        const newTodos: Todo[] = [
            { id: '1', content: 'Task A', status: 'in_progress', priority: 'medium' }
        ];

        const changes = calculateTodoChanges(oldTodos, newTodos);

        expect(changes.added).toEqual([]);
        expect(changes.started).toEqual([
            { id: '1', content: 'Task A' }
        ]);
        expect(changes.finished).toEqual([]);
    });

    it('should identify todos that changed from pending to completed', () => {
        const oldTodos: Todo[] = [
            { id: '1', content: 'Task B', status: 'pending', priority: 'high' }
        ];
        const newTodos: Todo[] = [
            { id: '1', content: 'Task B', status: 'completed', priority: 'high' }
        ];

        const changes = calculateTodoChanges(oldTodos, newTodos);

        expect(changes.added).toEqual([]);
        expect(changes.started).toEqual([]);
        expect(changes.finished).toEqual([
            { id: '1', content: 'Task B' }
        ]);
    });

    it('should identify todos that changed from in_progress to completed', () => {
        const oldTodos: Todo[] = [
            { id: '1', content: 'Task C', status: 'in_progress', priority: 'medium' }
        ];
        const newTodos: Todo[] = [
            { id: '1', content: 'Task C', status: 'completed', priority: 'medium' }
        ];

        const changes = calculateTodoChanges(oldTodos, newTodos);

        expect(changes.added).toEqual([]);
        expect(changes.started).toEqual([]);
        expect(changes.finished).toEqual([
            { id: '1', content: 'Task C' }
        ]);
    });

    it('should handle multiple changes at once', () => {
        const oldTodos: Todo[] = [
            { id: '1', content: 'Task 1', status: 'pending', priority: 'high' },
            { id: '2', content: 'Task 2', status: 'in_progress', priority: 'medium' },
            { id: '3', content: 'Task 3', status: 'pending', priority: 'low' }
        ];
        const newTodos: Todo[] = [
            { id: '1', content: 'Task 1', status: 'in_progress', priority: 'high' },
            { id: '2', content: 'Task 2', status: 'completed', priority: 'medium' },
            { id: '3', content: 'Task 3', status: 'pending', priority: 'low' },
            { id: '4', content: 'Task 4', status: 'pending', priority: 'medium' },
            { id: '5', content: 'Task 5', status: 'completed', priority: 'high' }
        ];

        const changes = calculateTodoChanges(oldTodos, newTodos);

        expect(changes.added).toEqual([
            { id: '4', content: 'Task 4' }
        ]);
        expect(changes.started).toEqual([
            { id: '1', content: 'Task 1' }
        ]);
        expect(changes.finished).toEqual([
            { id: '2', content: 'Task 2' },
            { id: '5', content: 'Task 5' }
        ]);
    });

    it('should handle empty lists', () => {
        const changes = calculateTodoChanges([], []);

        expect(changes.added).toEqual([]);
        expect(changes.started).toEqual([]);
        expect(changes.finished).toEqual([]);
    });

    it('should ignore todos that did not change status', () => {
        const oldTodos: Todo[] = [
            { id: '1', content: 'Task 1', status: 'pending', priority: 'high' },
            { id: '2', content: 'Task 2', status: 'in_progress', priority: 'medium' },
            { id: '3', content: 'Task 3', status: 'completed', priority: 'low' }
        ];
        const newTodos: Todo[] = [
            { id: '1', content: 'Task 1 updated', status: 'pending', priority: 'medium' },
            { id: '2', content: 'Task 2', status: 'in_progress', priority: 'medium' },
            { id: '3', content: 'Task 3', status: 'completed', priority: 'low' }
        ];

        const changes = calculateTodoChanges(oldTodos, newTodos);

        expect(changes.added).toEqual([]);
        expect(changes.started).toEqual([]);
        expect(changes.finished).toEqual([]);
    });

    it('should not track removed todos', () => {
        const oldTodos: Todo[] = [
            { id: '1', content: 'Task 1', status: 'pending', priority: 'high' },
            { id: '2', content: 'Task 2', status: 'in_progress', priority: 'medium' }
        ];
        const newTodos: Todo[] = [
            { id: '1', content: 'Task 1', status: 'pending', priority: 'high' }
        ];

        const changes = calculateTodoChanges(oldTodos, newTodos);

        expect(changes.added).toEqual([]);
        expect(changes.started).toEqual([]);
        expect(changes.finished).toEqual([]);
    });
});