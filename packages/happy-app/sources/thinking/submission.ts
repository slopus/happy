/** Hidden method instructions always need a nonempty visible label, including image-only sends. */
export function thinkingDisplayText(draft: string, annotationDisplay: string, filePath: string | undefined, attachmentsLabel: string) {
    return annotationDisplay || draft || (filePath ? '@ ' + filePath.split('/').pop() : attachmentsLabel);
}
