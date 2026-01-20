/**
 * Converts free-form text to snake_case format that is safe for file paths
 * on any operating system and git, while preserving Unicode letters.
 * 
 * @param text - The free-form text to convert (e.g., "Hello World!", "Café", "北京")
 * @returns The text converted to snake_case (e.g., "hello_world", "café", "北京")
 * 
 * @example
 * toSnakeCase("Hello World!") // "hello_world"
 * toSnakeCase("This is a test sentence.") // "this_is_a_test_sentence"
 * toSnakeCase("Café au lait") // "café_au_lait"
 * toSnakeCase("北京 Beijing") // "北京_beijing"
 * toSnakeCase("folder/file:name*test") // "folder_file_name_test"
 */
export function toSnakeCase(text: string): string {
    if (!text) {
        return '';
    }
    
    // Convert to lowercase first
    let result = text.toLowerCase();
    
    // First, replace file-system unsafe characters with underscores
    // These are characters that are problematic on Windows/Unix/macOS
    // : < > " / \ | ? * and control characters
    result = result.replace(/[:<>"\/\\|?*\x00-\x1f]/g, '_');
    
    // Replace other non-letter, non-digit characters with underscores
    // \p{L} matches any Unicode letter, \p{N} matches any Unicode digit
    // This preserves letters from any language (Latin, Cyrillic, Chinese, Arabic, etc.)
    result = result.replace(/[^\p{L}\p{N}]+/gu, '_');
    
    // Remove leading and trailing underscores
    result = result.replace(/^_+|_+$/g, '');
    
    // Collapse multiple consecutive underscores into one
    result = result.replace(/_+/g, '_');
    
    return result;
}