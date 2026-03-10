import { describe, expect, it } from 'vitest';
import { filterBufferedResumeMessages, normalizeResumeUserText } from '../runCodex';

describe('resume replay filtering', () => {
    it('normalizes resume user text', () => {
        expect(normalizeResumeUserText('  hello\r\nworld  ')).toBe('hello\nworld');
    });

    it('drops buffered messages already present in the saved transcript', () => {
        const recentResumeUserTexts = new Set([
            normalizeResumeUserText('记忆测试: 大象在冰箱里\n只回复 ACK1'),
            normalizeResumeUserText('测试: 大象在哪里?\n只回复 ACK2:冰箱里'),
        ]);

        const buffered = [
            { text: '  记忆测试: 大象在冰箱里\r\n只回复 ACK1  ', mode: 'same' },
            { text: '测试: 大象在哪里?\n只回复 ACK2:冰箱里', mode: 'same' },
            { text: '测试: 小兔子在哪里?\n只回复 NEW', mode: 'same' },
        ];

        expect(filterBufferedResumeMessages(buffered, recentResumeUserTexts)).toEqual([
            { text: '测试: 小兔子在哪里?\n只回复 NEW', mode: 'same' },
        ]);
    });
});
