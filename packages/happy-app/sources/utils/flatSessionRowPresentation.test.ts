import { describe, expect, it } from 'vitest';

import {
    resolveFlatSessionRowPresentation,
    SESSION_BLOCKED_DOT_COLOR,
    SESSION_READY_DOT_COLOR,
} from './flatSessionRowPresentation';

describe('resolveFlatSessionRowPresentation', () => {
    it('shimmers active work and keeps its timestamp', () => {
        expect(resolveFlatSessionRowPresentation({
            state: 'thinking',
            hasUnread: false,
            faded: false,
        })).toEqual({
            shimmerTitle: true,
            topRight: { type: 'timestamp' },
        });
    });

    it('shows a blue dot once an unread result is ready', () => {
        expect(resolveFlatSessionRowPresentation({
            state: 'waiting',
            hasUnread: true,
            faded: false,
        })).toEqual({
            shimmerTitle: false,
            topRight: { type: 'dot', color: SESSION_READY_DOT_COLOR },
        });
    });

    it.each(['permission_required', 'input_required'] as const)(
        'shows the same dot in orange for %s',
        (state) => {
            expect(resolveFlatSessionRowPresentation({
                state,
                hasUnread: true,
                faded: false,
            })).toEqual({
                shimmerTitle: false,
                topRight: { type: 'dot', color: SESSION_BLOCKED_DOT_COLOR },
            });
        },
    );

    it('uses the timestamp for ordinary and faded rows', () => {
        expect(resolveFlatSessionRowPresentation({
            state: 'waiting',
            hasUnread: false,
            faded: false,
        }).topRight).toEqual({ type: 'timestamp' });

        expect(resolveFlatSessionRowPresentation({
            state: 'permission_required',
            hasUnread: true,
            faded: true,
        })).toEqual({
            shimmerTitle: false,
            topRight: { type: 'timestamp' },
        });
    });
});