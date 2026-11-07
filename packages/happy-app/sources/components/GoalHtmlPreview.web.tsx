import * as React from 'react';
import { goalHtmlHostDocument } from '@/utils/goalHtmlDocument';

export const GoalHtmlPreview = React.memo(function GoalHtmlPreview({ content, title }: { content: string; title: string }) {
    const document = React.useMemo(() => goalHtmlHostDocument(content, title), [content, title]);
    return <iframe title={title} data-testid="goal-html-preview" sandbox="allow-scripts"
        referrerPolicy="no-referrer" srcDoc={document}
        style={{ flex: 1, border: 0, width: '100%', height: '100%', background: 'transparent' }} />;
});
