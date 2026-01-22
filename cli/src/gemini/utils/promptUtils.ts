/**
 * Prompt Utilities
 * 
 * Utilities for working with prompts, including change_title instruction detection.
 */

/**
 * Check if a prompt contains change_title instruction
 * 
 * @param prompt - The prompt text to check
 * @returns true if the prompt contains change_title or happy__change_title
 */
export function hasChangeTitleInstruction(prompt: string): boolean {
  return prompt.toLowerCase().includes('change_title') || 
         prompt.toLowerCase().includes('happy__change_title');
}

