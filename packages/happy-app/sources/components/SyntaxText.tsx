import * as React from 'react';
import { Platform, Text, type StyleProp, type TextStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { SpanKind } from './diff/engine/types';
import { codeSyntaxSpans, planCodeSyntax } from './diff/syntax/code';
import { useSyntaxRequests } from './diff/syntax/useSyntaxRequests';

interface SyntaxTextProps {
    code: string;
    language: string;
    style?: StyleProp<TextStyle>;
    colors?: Record<SpanKind, string>;
}

const whitespace: (TextStyle & { whiteSpace: 'pre-wrap' }) | undefined = Platform.OS === 'web'
    ? { whiteSpace: 'pre-wrap' } : undefined;

/** Opt-in detail text, using the very same worker, LRU and reveal gate as files. */
export const SyntaxText = React.memo(function SyntaxText({ code, language, style, colors }: SyntaxTextProps) {
    const { theme } = useUnistyles();
    const palette = colors ?? theme.colors.diff.syntax;
    const plan = React.useMemo(() => planCodeSyntax(code, language), [code, language]);
    const { outcomes, pending } = useSyntaxRequests(plan, 2);
    const spans = React.useMemo(() => {
        if (!plan.length) return null;
        const start = performance.now();
        const result = codeSyntaxSpans(plan[0].input, outcomes.get(plan[0].key));
        const elapsed = performance.now() - start;
        if (elapsed > 2 || (typeof __DEV__ !== 'undefined' && __DEV__)) {
            console.log(`[perf] terminal syntax apply=${elapsed.toFixed(1)}ms chars=${code.length} spans=${result?.length ?? 0}`);
        }
        return result;
    }, [plan, outcomes]);

    return (
        <Text
            style={[style, whitespace, pending && { opacity: 0 }]}
            selectable={!pending}
            accessibilityElementsHidden={pending}
            importantForAccessibility={pending ? 'no-hide-descendants' : 'auto'}
            testID={pending ? 'terminal-syntax-pending' : 'terminal-syntax-ready'}
        >
            {spans ? spans.map((span, index) => span.k === 'plain' ? span.t : (
                <Text key={index} style={{ color: palette[span.k] }}>{span.t}</Text>
            )) : code}
        </Text>
    );
});