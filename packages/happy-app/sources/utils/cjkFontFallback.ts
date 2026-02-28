import { Platform } from 'react-native';

/**
 * Regular expression to detect CJK (Chinese, Japanese, Korean) characters.
 * Includes:
 * - CJK Unified Ideographs: U+4E00-U+9FFF
 * - CJK Unified Ideographs Extension A: U+3400-U+4DBF
 * - CJK Compatibility Ideographs: U+F900-U+FAFF
 * - CJK Radicals Supplement: U+2E80-U+2EFF
 * - Kangxi Radicals: U+2F00-U+2FDF
 * - Hiragana: U+3040-U+309F
 * - Katakana: U+30A0-U+30FF
 * - Hangul Syllables: U+AC00-U+D7AF
 * - Hangul Jamo: U+1100-U+11FF
 * - Bopomofo: U+3100-U+312F
 * - Extended range via surrogate pairs for Extension B-F
 */
const CJK_PATTERN = /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF\u2E80-\u2EFF\u2F00-\u2FDF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF\u1100-\u11FF\u3100-\u312F]|[\uD840-\uD87F][\uDC00-\uDFFF]/;

/**
 * Check if a string contains CJK characters
 */
export function containsCJK(text: string): boolean {
    return CJK_PATTERN.test(text);
}

/**
 * Get the appropriate font family for text content.
 * On iOS, if the text contains CJK characters and we're using a custom font
 * that doesn't support CJK, we fall back to the system font to ensure
 * proper rendering.
 * 
 * @param customFontFamily - The custom font family to use (e.g., 'IBMPlexSans-Regular')
 * @param text - The text content to check for CJK characters
 * @returns The font family to use
 */
export function getFontFamilyWithCJKFallback(
    customFontFamily: string | undefined,
    text: string
): string | undefined {
    // Only apply fallback on iOS native
    if (Platform.OS !== 'ios') {
        return customFontFamily;
    }
    
    // If no custom font is specified, let the system handle it
    if (!customFontFamily) {
        return undefined;
    }
    
    // Check if text contains CJK characters
    if (containsCJK(text)) {
        // Return undefined to use system font (which properly supports CJK)
        return undefined;
    }
    
    return customFontFamily;
}

/**
 * Check if a font family should be overridden for CJK content on iOS.
 * This is useful when you need to conditionally apply styles.
 */
export function shouldUseSystemFontForCJK(text: string): boolean {
    return Platform.OS === 'ios' && containsCJK(text);
}
