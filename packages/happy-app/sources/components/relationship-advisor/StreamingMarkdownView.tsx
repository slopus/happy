import * as React from 'react';
import { View } from 'react-native';

import { MarkdownView } from '@/components/markdown/MarkdownView';
import { prepareRelationshipAdvisorStreamingMarkdown } from './streamingMarkdown';

const STREAM_RENDER_INTERVAL_MS = 40;

export const StreamingMarkdownView = React.memo((props: { markdown: string }) => {
    const [renderedMarkdown, setRenderedMarkdown] = React.useState(props.markdown);
    const latestMarkdownRef = React.useRef(props.markdown);
    const lastRenderAtRef = React.useRef(Date.now());
    const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    React.useEffect(() => {
        latestMarkdownRef.current = props.markdown;

        if (timerRef.current) return;

        const elapsed = Date.now() - lastRenderAtRef.current;
        const delay = Math.max(0, STREAM_RENDER_INTERVAL_MS - elapsed);
        timerRef.current = setTimeout(() => {
            timerRef.current = null;
            lastRenderAtRef.current = Date.now();
            setRenderedMarkdown(latestMarkdownRef.current);
        }, delay);
    }, [props.markdown]);

    React.useEffect(() => () => {
        if (timerRef.current) clearTimeout(timerRef.current);
    }, []);

    const displayMarkdown = React.useMemo(
        () => prepareRelationshipAdvisorStreamingMarkdown(renderedMarkdown),
        [renderedMarkdown],
    );

    return (
        <View
            testID="relationship-advisor-streaming-text"
            accessibilityLiveRegion="polite"
        >
            <MarkdownView markdown={displayMarkdown} />
        </View>
    );
});
