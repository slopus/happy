import remend from 'remend';

export function prepareRelationshipAdvisorStreamingMarkdown(markdown: string): string {
    return remend(markdown, { linkMode: 'text-only' });
}
