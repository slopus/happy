/**
 * Options Parser Utilities
 *
 * Utilities for parsing and formatting XML options blocks from agent responses.
 * Used for extracting and formatting <options><option>...</option></options> blocks.
 */

export interface ParsedOption {
  title: string;
  destructive?: boolean;
}

/**
 * Check if text has an incomplete options block (opening tag but no closing tag)
 *
 * @param text - The text to check
 * @returns true if there's an opening <options> tag without a closing </options> tag
 */
export function hasIncompleteOptions(text: string): boolean {
  const hasOpeningTag = /<options>/i.test(text);
  const hasClosingTag = /<\/options>/i.test(text);
  return hasOpeningTag && !hasClosingTag;
}

/**
 * Parse XML options from text
 * Extracts <options><option>...</option></options> blocks and returns
 * the text without options and the parsed options array
 *
 * @param text - The text containing options XML
 * @returns Object with text (without options) and options array
 */
export function parseOptionsFromText(text: string): { text: string; options: string[]; rawOptionsXml: string } {
  // Match <options>...</options> block (multiline, non-greedy)
  const optionsRegex = /<options>\s*([\s\S]*?)\s*<\/options>/i;
  const match = text.match(optionsRegex);

  if (!match) {
    return { text: text.trim(), options: [], rawOptionsXml: '' };
  }

  // Extract options block content
  const optionsBlock = match[1];

  // Parse individual <option> tags (with optional attributes)
  const optionRegex = /<option(\s[^>]*)?>(.+?)<\/option>/gi;
  const options: string[] = [];
  let optionMatch;

  while ((optionMatch = optionRegex.exec(optionsBlock)) !== null) {
    const optionText = optionMatch[2].trim();
    if (optionText) {
      options.push(optionText);
    }
  }

  // Remove options block from text
  const textWithoutOptions = text.replace(optionsRegex, '').trim();

  // Preserve original XML block (including attributes) for passthrough
  const rawOptionsXml = '\n' + match[0];

  return { text: textWithoutOptions, options, rawOptionsXml };
}


