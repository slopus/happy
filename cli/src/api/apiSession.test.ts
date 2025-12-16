import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiSessionClient } from './apiSession';

describe('ApiSessionClient connection handling', () => {
    let mockSocket: any;
    let consoleSpy: any;

    beforeEach(() => {
        consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        // Mock socket.io client
        mockSocket = {
            connect: vi.fn(),
            on: vi.fn(),
            off: vi.fn(),
            disconnect: vi.fn()
        };

        // Mock the io function
        vi.mock('socket.io-client', () => ({
            io: vi.fn(() => mockSocket)
        }));
    });

    it('should handle socket connection failure gracefully', async () => {
        // Mock socket.connect() to throw
        mockSocket.connect.mockImplementation(() => {
            throw new Error('ECONNREFUSED');
        });

        // Should not throw during client creation
        expect(() => {
            new ApiSessionClient('fake-token', { id: 'test' } as any);
        }).not.toThrow();
    });

    it('should emit correct events on socket connection', () => {
        const client = new ApiSessionClient('fake-token', { id: 'test' } as any);

        // Should have set up event listeners
        expect(mockSocket.on).toHaveBeenCalledWith('connect', expect.any(Function));
        expect(mockSocket.on).toHaveBeenCalledWith('disconnect', expect.any(Function));
        expect(mockSocket.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    afterEach(() => {
        consoleSpy.mockRestore();
        vi.restoreAllMocks();
    });
});