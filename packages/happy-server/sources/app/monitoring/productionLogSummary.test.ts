import { describe, expect, it } from 'vitest';
import { isTransactionTimeout, ProductionLogWindow } from './productionLogSummary';

describe('ProductionLogWindow', () => {
    it('summarizes the last window and resets it', () => {
        const window = new ProductionLogWindow(0);
        window.recordRequest({ method: 'GET', route: '/v1/sessions', statusCode: 200, durationMs: 20 });
        window.recordRequest({ method: 'POST', route: '/v3/sessions/:sessionId/messages', statusCode: 500, durationMs: 1_500 });
        window.recordError({ code: 'P2028', message: 'Transaction already closed' });

        const message = window.flush(30_000);

        expect(message).toContain('window=30s requests=2');
        expect(message).toContain('2xx=1 4xx=0 5xx=1');
        expect(message).toContain('errors=1 txTimeouts=1 slow1s=1');
        expect(message).toContain('p95=1500ms max=1500ms');
        expect(message).toContain('POST /v3/sessions/:sessionId/messages:1req/1err/1500ms');
        expect(window.flush(60_000)).toBeNull();
    });

    it('excludes health checks from summaries', () => {
        const window = new ProductionLogWindow(0);
        window.recordRequest({ method: 'GET', route: '/health', statusCode: 200, durationMs: 5 });
        expect(window.flush(30_000)).toBeNull();
    });

    it('includes failed health checks in summaries', () => {
        const window = new ProductionLogWindow(0);
        window.recordRequest({ method: 'GET', route: '/health', statusCode: 503, durationMs: 50 });
        expect(window.flush(30_000)).toContain('requests=1 2xx=0 4xx=0 5xx=1');
    });
});

describe('isTransactionTimeout', () => {
    it('detects Prisma P2028 and expired interactive transactions', () => {
        expect(isTransactionTimeout({ code: 'P2028' })).toBe(true);
        expect(isTransactionTimeout({ message: 'A query cannot be executed on an expired transaction' })).toBe(true);
        expect(isTransactionTimeout(new Error('connection refused'))).toBe(false);
    });
});
