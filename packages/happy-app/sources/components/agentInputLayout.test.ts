import { describe, expect, it } from 'vitest';
import * as agentInputLayout from './agentInputLayout';

const { resolveAgentInputLayout, resolveMobileCollapsedComposerGeometry } = agentInputLayout;

describe('agent input compact mobile layout', () => {
    it('aligns composer text start with the left edge of the add glyph', () => {
        const layout = resolveAgentInputLayout({
            shellInset: 10,
            actionSize: 42,
            addIconSize: 26,
        });

        expect(layout.textInset).toBe(18);
        expect(layout.inputContainerPaddingLeft).toBe(8);
        expect(layout.inputContainerPaddingRight).toBe(8);
        expect(layout.textInset).toBe(layout.shellInset + (42 - 26) / 2);
    });

    it('publishes one visual metric contract for Home and Chat composers', () => {
        expect((agentInputLayout as Record<string, unknown>).MOBILE_COMPOSER_METRICS).toEqual({
            shellRadius: 30,
            shellInset: 10,
            shellPaddingTop: 8,
            shellPaddingBottom: 8,
            inputMinHeight: 44,
            inputMaxHeight: 120,
            inputFontSize: 16,
            inputLineHeight: 22,
            inputPaddingTop: 4,
            inputPaddingBottom: 4,
            actionRowHeight: 42,
            actionSize: 42,
            addIconSize: 26,
            secondaryActionHeight: 40,
            effortWidth: 64,
            primaryActionSize: 42,
            primaryActionMarginLeft: 8,
            attachmentExtraHeight: 72,
        });
        expect((agentInputLayout as Record<string, unknown>).MOBILE_COMPOSER_BASE_HEIGHT).toBe(102);
        expect((agentInputLayout as Record<string, unknown>).MOBILE_COMPOSER_CHROME_HEIGHT).toBe(58);
    });

    it('starts collapsed composer text where the capsule becomes straight', () => {
        const geometry = resolveMobileCollapsedComposerGeometry();

        expect(geometry).toEqual({
            shellHeight: 56,
            shellRadius: 28,
            contentPaddingLeft: 7,
            contentPaddingRight: 7,
            inputPaddingLeft: 21,
            inputPaddingRight: 4,
            textInset: 28,
        });
        expect(geometry.textInset).toBe(geometry.shellRadius);
    });

    it('matches the chat shell height while the input grows and attachments appear', () => {
        const resolveHeight = (agentInputLayout as Record<string, unknown>)
            .resolveMobileComposerHeight as undefined | ((inputHeight: number, hasAttachments?: boolean) => number);

        expect(resolveHeight?.(30)).toBe(102);
        expect(resolveHeight?.(52)).toBe(118);
        expect(resolveHeight?.(120)).toBe(186);
        expect(resolveHeight?.(30, true)).toBe(174);
    });

    it.each([
        ['icon',
            { width: 42, height: 42, flexShrink: 0 },
            { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' }],
        // The pair is right-aligned, so each chip keeps its slack on the outside
        // of the separator. Only the model shrinks; the effort reserves the
        // widest label's width so changing level cannot reflow or clip the row.
        // The effort's outer padding is deliberately small: that slack is what
        // the model name spends before it has to be cut, and send must not move.
        ['model',
            { flexShrink: 1, minWidth: 0, height: 40 },
            {
                minWidth: 0, height: 40, borderRadius: 20,
                flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end',
                paddingLeft: 12, paddingRight: 4, gap: 7,
            }],
        ['effort',
            { flexShrink: 0, minWidth: 64, height: 40 },
            {
                minWidth: 0, height: 40, borderRadius: 20,
                flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start',
                paddingLeft: 4, paddingRight: 6, gap: 4,
            }],
    ])('keeps %s native-menu frame geometry separate from label padding', (variant, expectedFrame, expectedContent) => {
        const resolveGeometry = (agentInputLayout as Record<string, unknown>)
            .resolveMobileComposerMenuGeometry as undefined | ((kind: string) => {
                frame: Record<string, unknown>;
                content: Record<string, unknown>;
            });

        const geometry = resolveGeometry?.(variant);
        expect(geometry?.frame).toEqual(expectedFrame);
        expect(geometry?.content).toEqual(expectedContent);
        expect(geometry?.frame).not.toHaveProperty('paddingLeft');
        expect(geometry?.frame).not.toHaveProperty('paddingRight');
        expect(geometry?.frame).not.toHaveProperty('gap');
    });

    it('uses identical row and circular-button geometry in both composers', () => {
        const exports = agentInputLayout as Record<string, unknown>;
        const resolveRow = exports.resolveMobileComposerActionRowGeometry as undefined | (() => Record<string, unknown>);
        const resolveAction = exports.resolveMobileComposerActionGeometry as undefined | ((kind: string) => Record<string, unknown>);

        expect(resolveRow?.()).toEqual({
            height: 42,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'flex-start',
            gap: 2,
            paddingHorizontal: 0,
        });
        expect(resolveAction?.('icon')).toEqual({
            width: 42,
            height: 42,
            borderRadius: 21,
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
        });
        expect(resolveAction?.('primary')).toEqual({
            width: 42,
            height: 42,
            borderRadius: 21,
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            marginLeft: 8,
        });
    });

    // [+] [ permission ... model · effort ] [send]: the row's only flexible
    // child is the box in the middle, so it takes exactly what the two fixed
    // buttons leave, and anything inside that will not fit is cut at its edge
    // instead of pushing send off its corner.
    it('bounds every chip in one middle box beside the fixed buttons', () => {
        const middle = agentInputLayout.resolveMobileComposerMiddleGeometry();
        const add = agentInputLayout.resolveMobileComposerActionGeometry('icon');
        const send = agentInputLayout.resolveMobileComposerActionGeometry('primary');

        expect(middle).toEqual({
            flex: 1,
            minWidth: 0,
            height: 42,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'flex-start',
            overflow: 'hidden',
            gap: 2,
        });
        // The buttons on either side hold their size no matter what the box
        // holds, which is what leaves the box a fixed remainder to fill.
        expect(add.flexShrink).toBe(0);
        expect(send.flexShrink).toBe(0);
        expect(add.width).toBe(42);
        expect(send.width).toBe(42);
        // Inside the box only the model name gives way.
        expect(agentInputLayout.resolveMobileComposerMenuGeometry('permission').frame.flexShrink).toBe(0);
        expect(agentInputLayout.resolveMobileComposerMenuGeometry('effort').frame.flexShrink).toBe(0);
        expect(agentInputLayout.resolveMobileComposerMenuGeometry('model').frame).toMatchObject({ flexShrink: 1, minWidth: 0 });
    });
});
