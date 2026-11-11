const IMAGE_BATCH_MARKERS = [
    /\$gpt-image-2/,
    /GPT Image 2/i,
    /图片编辑\s*\/\s*生成批处理/,
    /mcp__happy__send_image/,
    /生成锁/,
];

export function isGeneratedImageBatchPromptText(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) {
        return false;
    }
    const markerSearchText = trimmed.slice(0, 1800);
    return IMAGE_BATCH_MARKERS.every((marker) => marker.test(markerSearchText));
}

