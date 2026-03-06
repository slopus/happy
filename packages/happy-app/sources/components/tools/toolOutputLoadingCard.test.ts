import { describe, expect, it } from 'vitest';
import { createToolOutputLoadingCardStyles, formatToolOutputSummaryValue } from './toolOutputLoadingCard';

describe('createToolOutputLoadingCardStyles', () => {
    it('matches the output card surface while keeping the spinner left-aligned', () => {
        const styles = createToolOutputLoadingCardStyles({
            colors: {
                surfaceHigh: '#222222',
                modal: {
                    border: '#333333',
                },
                text: '#ffffff',
                textSecondary: '#999999',
            },
        });

        expect(styles.loadingCard).toMatchObject({
            backgroundColor: '#222222',
            borderRadius: 6,
            padding: 12,
            minHeight: 42,
            justifyContent: 'center',
            alignItems: 'flex-start',
        });
        expect(styles.summarySection).toMatchObject({
            borderTopColor: '#333333',
            paddingTop: 12,
            marginTop: 12,
        });
        expect(styles.summaryKey).toMatchObject({
            color: '#999999',
            fontSize: 12,
        });
        expect(styles.summaryValue).toMatchObject({
            color: '#ffffff',
            fontSize: 13,
        });
    });

    it('formats summary values for inline error details', () => {
        expect(formatToolOutputSummaryValue('demo')).toBe('demo');
        expect(formatToolOutputSummaryValue(3)).toBe('3');
        expect(formatToolOutputSummaryValue({ query: 'happy' })).toBe('{\n  "query": "happy"\n}');
    });
});
