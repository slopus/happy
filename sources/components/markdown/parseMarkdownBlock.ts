import type { MarkdownBlock } from "./parseMarkdown";
import { parseMarkdownSpans } from "./parseMarkdownSpans";

export function parseMarkdownBlock(markdown: string) {
    const blocks: MarkdownBlock[] = [];
    const lines = markdown.split('\n');
    let index = 0;
    outer: while (index < lines.length) {
        const line = lines[index];
        index++;

        // Headers
        for (let i = 1; i <= 6; i++) {
            if (line.startsWith(`${'#'.repeat(i)} `)) {
                blocks.push({ type: 'header', level: i as 1 | 2 | 3 | 4 | 5 | 6, content: parseMarkdownSpans(line.slice(i + 1).trim(), true) });
                continue outer;
            }
        }

        // Trim
        let trimmed = line.trim();

        // Code block
        if (trimmed.startsWith('```')) {
            const language = trimmed.slice(3).trim() || null;
            let content = [];
            while (index < lines.length) {
                const nextLine = lines[index];
                if (nextLine.trim() === '```') {
                    index++;
                    break;
                }
                content.push(nextLine);
                index++;
            }
            blocks.push({ type: 'code-block', language, content: content.join('\n') });
            continue;
        }

        // Horizontal rule
        if (trimmed === '---') {
            blocks.push({ type: 'horizontal-rule' });
            continue;
        }

        // XML block detection (excluding self-closing tags)
        // This parser looks generic but is specifically designed to handle <local-command-stdout> tags.
        // The goal is to render XML contents as normal text, but provide special handling for local-command-stdout
        // by extracting the inner content without reparsing. All XML is preserved verbatim for reproduction.
        const xmlMatch = trimmed.match(/^<([a-zA-Z][\w-]*)[^>]*>(?!.*\/>)/);
        if (xmlMatch) {
            const tagName = xmlMatch[1];
            const closingTag = `</${tagName}>`;
            let content = [line];
            
            // Look for closing tag
            let foundClosing = false;
            while (index < lines.length) {
                const nextLine = lines[index];
                content.push(nextLine);
                const trimmedLine = nextLine.trim();
                if (trimmedLine.endsWith(closingTag)) {
                    foundClosing = true;
                    index++;
                    break;
                }
                index++;
            }
            
            if (foundClosing) {
                const fullContent = content.join('\n');
                
                // Calculate inner content indices
                // Use the full opening tag match to handle attributes correctly
                const openingTagMatch = fullContent.match(/^<[^>]*>/);
                const openingTagEnd = openingTagMatch ? openingTagMatch[0].length : 0;
                const closingTagStart = fullContent.lastIndexOf(`</${tagName}>`);
                
                blocks.push({ 
                    type: 'xml-block', 
                    tagName, 
                    content: fullContent,
                    innerStart: openingTagEnd,
                    innerEnd: closingTagStart
                });
                continue;
            } else {
                // If no closing tag found, treat as regular text
                // Reset index to process this line as text
                index -= content.length - 1;
            }
        }

        // Options block
        if (trimmed.startsWith('<options>')) {
            let items: string[] = [];
            while (index < lines.length) {
                const nextLine = lines[index];
                if (nextLine.trim() === '</options>') {
                    index++;
                    break;
                }
                // Extract content from <option> tags
                const optionMatch = nextLine.match(/<option>(.*?)<\/option>/);
                if (optionMatch) {
                    items.push(optionMatch[1]);
                }
                index++;
            }
            if (items.length > 0) {
                blocks.push({ type: 'options', items });
            }
            continue;
        }

        // If it is a numbered list
        const numberedListMatch = trimmed.match(/^(\d+)\.\s/);
        if (numberedListMatch) {
            let allLines = [{ number: parseInt(numberedListMatch[1]), content: trimmed.slice(numberedListMatch[0].length) }];
            while (index < lines.length) {
                const nextLine = lines[index].trim();
                const nextMatch = nextLine.match(/^(\d+)\.\s/);
                if (!nextMatch) break;
                allLines.push({ number: parseInt(nextMatch[1]), content: nextLine.slice(nextMatch[0].length) });
                index++;
            }
            blocks.push({ type: 'numbered-list', items: allLines.map((l) => ({ number: l.number, spans: parseMarkdownSpans(l.content, false) })) });
            continue;
        }

        // If it is a list
        if (trimmed.startsWith('- ')) {
            let allLines = [trimmed.slice(2)];
            while (index < lines.length && lines[index].trim().startsWith('- ')) {
                allLines.push(lines[index].trim().slice(2));
                index++;
            }
            blocks.push({ type: 'list', items: allLines.map((l) => parseMarkdownSpans(l, false)) });
            continue;
        }

        // Fallback
        if (trimmed.length > 0) {
            blocks.push({ type: 'text', content: parseMarkdownSpans(trimmed, false) });
        }
    }
    return blocks;
}