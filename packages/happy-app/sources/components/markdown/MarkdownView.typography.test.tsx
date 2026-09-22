import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

vi.mock('react-native', () => ({
    Image: 'Image',
    Platform: { OS: 'web' },
    Pressable: 'Pressable',
    TextInput: 'TextInput',
    View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('../HorizontalScrollView', () => ({ HorizontalScrollView: 'HorizontalScrollView' }));
vi.mock('react-native-gesture-handler', () => ({
    Gesture: {
        LongPress: () => {
            const gesture = {
                minDuration: () => gesture,
                onStart: () => gesture,
                runOnJS: () => gesture,
            };
            return gesture;
        },
    },
    GestureDetector: 'GestureDetector',
}));
vi.mock('react-native-unistyles', () => {
    const nestedTheme = new Proxy({}, {
        get: (_target, property) => property === 'toString' ? () => '#000000' : nestedTheme,
    });
    return {
        StyleSheet: {
            create: (factory: (theme: object) => object) => factory({ colors: nestedTheme }),
        },
        useUnistyles: () => ({ theme: { colors: nestedTheme } }),
    };
});
vi.mock('../StyledText', () => ({ Text: 'Text' }));
vi.mock('../SimpleSyntaxHighlighter', () => ({ SimpleSyntaxHighlighter: 'SimpleSyntaxHighlighter' }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/sync/storage', () => ({ useLocalSetting: () => false }));
vi.mock('@/sync/persistence', () => ({ storeTempText: vi.fn() }));
vi.mock('@/sync/imageViewer', () => ({ imageViewer: { open: vi.fn() } }));
vi.mock('@/components/OtaPreviewCard', () => ({ OtaPreviewCard: 'OtaPreviewCard' }));
vi.mock('@/components/FinanceChartCard', () => ({ FinanceChartCard: 'FinanceChartCard' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('expo-web-browser', () => ({}));
vi.mock('./MermaidRenderer', () => ({ MermaidRenderer: 'MermaidRenderer' }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('./linkUtils', () => ({ isHttpMarkdownLink: (url: string) => url.startsWith('http') }));
vi.mock('@/utils/openExternalUrl', () => ({ openExternalUrl: vi.fn() }));
vi.mock('../haptics', () => ({ hapticsLight: vi.fn() }));
vi.mock('@/components/agents/imageStyleOptions', () => ({
    MAX_IMAGE_STYLE_OPTION_COUNT: 3,
    buildImageStyleContinuationPrompt: vi.fn(),
    parseImageStyleOptions: () => [],
}));
vi.mock('@/components/agents/imageAgentPrompt', () => ({ MAX_IMAGE_AGENT_VARIANTS_PER_STYLE: 4 }));
vi.mock('./CodeBlockCopyButton', () => ({ CodeBlockCopyButton: 'CodeBlockCopyButton' }));

import { WEB_DEFAULT_FONT_FAMILY } from '@/constants/Typography';
import { MarkdownView } from './MarkdownView';

const MARKDOWN = [
    '# Heading',
    '',
    'Body [link](https://example.com) with **bold**, *italic*, and `code`.',
    '',
    '- Item',
    '',
    '```typescript',
    'const answer = 1',
    '```',
    '',
    '```mermaid',
    'flowchart LR',
    'A --> B',
    '```',
    '',
    '<options>',
    '<option>Choice</option>',
    '</options>',
    '',
    '| Column |',
    '|---|',
    '| Value |',
].join('\n');

const CJK_TABLE_MARKDOWN = [
    '| 你想表达的内容 | 图类型 |',
    '| --- | --- |',
    '| 数据从哪来、怎么处理、去哪 | architecture 架构图 |',
].join('\n');

function flattenStyle(style: unknown): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const visit = (value: unknown) => {
        if (Array.isArray(value)) {
            value.forEach(visit);
        } else if (value && typeof value === 'object') {
            Object.assign(result, value);
        }
    };
    visit(style);
    return result;
}

function textNode(renderer: any, text: string) {
    return renderer.root.findAllByType('Text')
        .find((node: any) => node.props.children === text);
}

describe('MarkdownView typography scope', () => {
    let renderer: any;

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(() => {
        act(() => renderer?.unmount());
        renderer = undefined;
    });

    it('applies Maple Mono across chat prose, emphasis, links, lists, and code paths', () => {
        act(() => {
            renderer = TestRenderer.create(<MarkdownView markdown={MARKDOWN} typography="chatMono" />);
        });

        expect(flattenStyle(textNode(renderer, 'Heading')!.props.style)).toMatchObject({
            fontFamily: 'MapleMonoNL-SemiBold',
            fontWeight: 'normal',
        });
        expect(flattenStyle(textNode(renderer, 'Body ')!.props.style).fontFamily).toBe('MapleMonoNL-Regular');
        expect(flattenStyle(textNode(renderer, 'link')!.props.style).fontFamily).toBe('MapleMonoNL-Regular');
        expect(flattenStyle(textNode(renderer, 'bold')!.props.style).fontFamily).toBe('MapleMonoNL-SemiBold');
        expect(flattenStyle(textNode(renderer, 'italic')!.props.style).fontFamily).toBe('MapleMonoNL-Italic');
        expect(flattenStyle(textNode(renderer, 'italic')!.props.style).fontStyle).toBe('normal');
        expect(flattenStyle(textNode(renderer, 'code')!.props.style).fontFamily).toBe('MapleMonoNL-Regular');
        expect(flattenStyle(textNode(renderer, 'Item')!.props.style).fontFamily).toBe('MapleMonoNL-Regular');
        expect(flattenStyle(textNode(renderer, 'Choice')!.props.style).fontFamily).toBe('MapleMonoNL-Regular');
        expect(flattenStyle(textNode(renderer, 'Column')!.props.style).fontFamily).toBe('MapleMonoNL-SemiBold');
        expect(flattenStyle(textNode(renderer, 'Value')!.props.style).fontFamily).toBe('MapleMonoNL-Regular');
        expect(renderer.root.findByType('SimpleSyntaxHighlighter').props.typography).toBe('chatMono');
        expect(renderer.root.findByType('CodeBlockCopyButton').props.typography).toBe('chatMono');
        expect(renderer.root.findByType('MermaidRenderer').props.typography).toBe('chatMono');
    });

    it('preserves the existing sans-serif prose outside chat', () => {
        act(() => {
            renderer = TestRenderer.create(<MarkdownView markdown="Body with `code`." />);
        });

        expect(flattenStyle(textNode(renderer, 'Body with ')!.props.style).fontFamily).toBe(WEB_DEFAULT_FONT_FAMILY);
        expect(flattenStyle(textNode(renderer, 'code')!.props.style).fontFamily).toBe('MapleMonoNL-Regular');
    });

    it('uses the measured message width for a fitting CJK table', () => {
        act(() => {
            renderer = TestRenderer.create(<MarkdownView markdown={CJK_TABLE_MARKDOWN} />);
        });

        const scroll = renderer.root.findByProps({ testID: 'markdown-table-scroll' });
        act(() => {
            scroll.props.onLayout({ nativeEvent: { layout: { width: 600 } } });
        });

        expect(scroll.children[0].props.style).toMatchObject({ width: 600 });
    });
});
