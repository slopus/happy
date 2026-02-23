/**
 * Mock data for previewing all DooTask chat message types.
 * Navigate to dialogId="mock" to see these in the chat screen.
 */
import type { DooTaskDialogMsg } from '@/sync/dootask/types';

const OTHER_USER_ID = 100;
const MOCK_TIMESTAMP_BASE = '2026-02-23';

function ts(hour: number, min: number): string {
    const h = String(hour).padStart(2, '0');
    const m = String(min).padStart(2, '0');
    return `${MOCK_TIMESTAMP_BASE} ${h}:${m}:00`;
}

function msg(
    id: number,
    userid: number,
    type: DooTaskDialogMsg['type'],
    msgData: any,
    overrides?: Partial<DooTaskDialogMsg>,
): DooTaskDialogMsg {
    return {
        id,
        dialog_id: 0,
        userid,
        type,
        msg: msgData,
        reply_id: null,
        reply_num: 0,
        created_at: ts(10, id - 9000),
        emoji: [],
        bot: 0,
        modify: 0,
        forward_id: null,
        forward_num: 0,
        ...overrides,
    };
}

/**
 * Generate mock messages covering every supported message type/state.
 * Returns newest-first order (matching what the inverted FlatList expects).
 */
export function generateMockMessages(selfUserId: number): DooTaskDialogMsg[] {
    const o = OTHER_USER_ID; // other user
    const s = selfUserId;    // self

    // Build oldest-first, then reverse at the end
    const list: DooTaskDialogMsg[] = [
        // --- Notice ---
        msg(9001, 0, 'notice', { text: 'Alice joined the group' }),

        // --- Other user: plain text ---
        msg(9002, o, 'text', { text: 'Hey! How is the project going?', type: 'html' }),

        // --- Self: plain text ---
        msg(9003, s, 'text', { text: 'Going well, just finished the chat features!', type: 'html' }),

        // --- Other: 1 large emoji ---
        msg(9004, o, 'text', '\ud83d\udc4d'),

        // --- Self: 2 large emoji ---
        msg(9005, s, 'text', '\ud83c\udf89\ud83d\udd25'),

        // --- Other: 3 large emoji ---
        msg(9006, o, 'text', '\ud83d\ude00\u2764\ufe0f\ud83d\udc4b'),

        // --- Self: markdown text ---
        msg(9007, s, 'text', {
            text: '**Task complete!** Here is a summary:\n\n- Large emoji display\n- File sub-types\n- *Voice messages*\n\n> All phases done',
            type: 'md',
        }),

        // --- Other: image (file upload) ---
        msg(9008, o, 'image', {
            path: 'https://picsum.photos/seed/mock1/800/600',
            thumb: 'https://picsum.photos/seed/mock1/260/180',
        }),

        // --- Self: image ---
        msg(9009, s, 'image', {
            path: 'https://picsum.photos/seed/mock2/800/600',
            thumb: 'https://picsum.photos/seed/mock2/260/180',
        }),

        // --- Other: generic file ---
        msg(9010, o, 'file', {
            name: 'Q4-report-2025-final.pdf',
            size: 2456789,
            path: 'https://example.com/report.pdf',
        }),

        // --- Self: generic file ---
        msg(9011, s, 'file', {
            name: 'meeting-notes.docx',
            size: 87654,
            path: 'https://example.com/notes.docx',
        }),

        // --- Other: file image sub-type ---
        msg(9012, o, 'file', {
            name: 'screenshot.jpg',
            type: 'img',
            width: 800,
            height: 600,
            thumb: 'https://picsum.photos/seed/mock3/260/195',
            path: 'https://picsum.photos/seed/mock3/800/600',
            size: 345678,
        }),

        // --- Self: file image sub-type ---
        msg(9013, s, 'file', {
            name: 'design-mockup.png',
            type: 'img',
            width: 1200,
            height: 900,
            thumb: 'https://picsum.photos/seed/mock4/260/195',
            path: 'https://picsum.photos/seed/mock4/1200/900',
            size: 567890,
        }),

        // --- Other: file video sub-type ---
        msg(9014, o, 'file', {
            name: 'demo-recording.mp4',
            ext: 'mp4',
            width: 1280,
            height: 720,
            thumb: 'https://picsum.photos/seed/mock5/260/146',
            path: 'https://example.com/demo.mp4',
            size: 15678901,
        }),

        // --- Self: file video sub-type ---
        msg(9015, s, 'file', {
            name: 'bug-repro.mp4',
            ext: 'mp4',
            width: 720,
            height: 1280,
            thumb: 'https://picsum.photos/seed/mock6/146/260',
            path: 'https://example.com/bug.mp4',
            size: 8765432,
        }),

        // --- Other: longtext ---
        msg(9016, o, 'longtext', {
            text: 'This is a long message preview that would normally be truncated. It contains detailed discussion about the implementation approach and technical decisions that were made during the development process...',
            type: 'html',
            file: { url: 'https://example.com/longtext-full.html' },
        }),

        // --- Self: longtext ---
        msg(9017, s, 'longtext', {
            text: 'Here are my detailed thoughts on the architecture. The system uses a layered approach with clear separation of concerns between the data layer, business logic, and presentation components...',
            type: 'html',
            file: { url: 'https://example.com/longtext-full2.html' },
        }),

        // --- Other: voice message (short, no transcript) ---
        msg(9018, o, 'record', {
            duration: 3000,
            path: 'https://example.com/voice1.ogg',
        }),

        // --- Self: voice message (longer, with transcript) ---
        msg(9019, s, 'record', {
            duration: 15000,
            path: 'https://example.com/voice2.ogg',
            text: 'I think we should focus on the UI polish next, the core features are all working now.',
        }),

        // --- Other: voice message (medium, with transcript) ---
        msg(9020, o, 'record', {
            duration: 8000,
            path: 'https://example.com/voice3.ogg',
            text: 'Sounds good, I will review the PR tonight.',
        }),

        // --- Text with emoji reactions ---
        msg(9021, o, 'text', { text: 'Should we deploy today?', type: 'html' }, {
            emoji: [
                { symbol: '\ud83d\udc4d', userids: [o, s] },
                { symbol: '\ud83c\udf89', userids: [s] },
                { symbol: '\u2764\ufe0f', userids: [o] },
            ],
        }),

        // --- Self text with emoji reactions ---
        msg(9022, s, 'text', { text: 'Yes, let\'s ship it!', type: 'html' }, {
            emoji: [
                { symbol: '\ud83d\ude80', userids: [o, s] },
                { symbol: '\ud83d\udd25', userids: [o] },
            ],
        }),

        // --- Other: edited message ---
        msg(9023, o, 'text', { text: 'Updated: The meeting is at 3pm (was 2pm)', type: 'html' }, {
            modify: 1,
        }),

        // --- Self: edited message ---
        msg(9024, s, 'text', { text: 'Actually, I meant the second approach is better.', type: 'html' }, {
            modify: 1,
        }),

        // --- Other: message with reply ---
        msg(9025, o, 'text', { text: 'Agreed, that approach makes more sense!', type: 'html' }, {
            reply_id: 9024, // replies to self's edited message
        }),

        // --- Self: message with reply ---
        msg(9026, s, 'text', { text: 'Great, I will start on it tomorrow morning.', type: 'html' }, {
            reply_id: 9021, // replies to other's "Should we deploy" message
        }),

        // --- Another notice to close ---
        msg(9027, 0, 'notice', { text: 'Bob joined the group' }),

        // --- Self: large emoji with reactions (combined features) ---
        msg(9028, s, 'text', '\ud83c\udf89', {
            emoji: [
                { symbol: '\ud83d\ude02', userids: [o] },
            ],
        }),
    ];

    // Return newest-first (reverse chronological)
    return list.reverse();
}

/** Mock user names for the preview */
export const MOCK_USER_NAMES: Record<number, string> = {
    [OTHER_USER_ID]: 'Alice Chen',
};

/** Mock user avatars (null = use initial placeholder) */
export const MOCK_USER_AVATARS: Record<number, string | null> = {
    [OTHER_USER_ID]: null, // uses initial "A" with color
};
