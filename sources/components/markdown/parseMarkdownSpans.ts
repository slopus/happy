import type { MarkdownSpan } from './parseMarkdown';

// Pattern to handle nested markdown, asterisks, and URLs
// Updated URL pattern to be more robust and prevent edge cases
const pattern = /(\*\*(.*?)(?:\*\*|$))|(\*(.*?)(?:\*|$))|(\[([^\]]+)\](?:\(([^)]+)\))?)|(`(.*?)(?:`|$))|(https?:\/\/[^\s]{1,2000})/g;

export function parseMarkdownSpans(markdown: string, header: boolean) {
  const spans: MarkdownSpan[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let iterationCount = 0;
  const maxIterations = 10000; // Safety limit to prevent infinite loops

  // Reset regex state to ensure clean start
  pattern.lastIndex = 0;

  while ((match = pattern.exec(markdown)) !== null) {
    iterationCount++;

    // Safety check for infinite loops
    if (iterationCount > maxIterations) {
      console.error('parseMarkdownSpans: Maximum iterations exceeded, breaking to prevent infinite loop');
      break;
    }

    // Additional safety check for zero-length matches at same position
    if (match.index === lastIndex && match[0].length === 0) {
      console.error('parseMarkdownSpans: Zero-length match detected, breaking to prevent infinite loop');
      pattern.lastIndex = lastIndex + 1; // Move forward by 1 to prevent getting stuck
      continue;
    }

    // Capture the text between the end of the last match and the start of this match as plain text
    const plainText = markdown.slice(lastIndex, match.index);
    if (plainText) {
      spans.push({ styles: [], text: plainText, url: null });
    }

    if (match[1]) {
      // Bold
      if (header) {
        spans.push({ styles: [], text: match[2], url: null });
      } else {
        spans.push({ styles: ['bold'], text: match[2], url: null });
      }
    } else if (match[3]) {
      // Italic
      if (header) {
        spans.push({ styles: [], text: match[4], url: null });
      } else {
        spans.push({ styles: ['italic'], text: match[4], url: null });
      }
    } else if (match[5]) {
      // Link - handle incomplete links (no URL part)
      if (match[7]) {
        spans.push({ styles: [], text: match[6], url: match[7] });
      } else {
        // If no URL part, treat as plain text with brackets
        spans.push({ styles: [], text: `[${match[6]}]`, url: null });
      }
    } else if (match[8]) {
      // Inline code
      spans.push({ styles: ['code'], text: match[9], url: null });
    } else if (match[10]) {
      // Plain URL (https:// or http://)
      const url = match[10];
      spans.push({ styles: [], text: url, url: url });
    }

    lastIndex = pattern.lastIndex;
  }

  // If there's any text remaining after the last match, treat it as plain
  if (lastIndex < markdown.length) {
    spans.push({ styles: [], text: markdown.slice(lastIndex), url: null });
  }

  // Reset regex state to prevent issues with subsequent calls
  pattern.lastIndex = 0;

  return spans;
}