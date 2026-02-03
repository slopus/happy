/**
 * Conversation History
 * 
 * Tracks user messages and agent responses to preserve context
 * when switching Gemini models. This allows seamless model changes
 * without losing conversation context.
 */

import { logger } from '@/ui/logger';

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  model?: string; // Track which model generated this response
}

export interface ConversationHistoryOptions {
  /** Maximum number of messages to keep (default: 20) */
  maxMessages?: number;
  /** Maximum total characters to keep (default: 50000) */
  maxCharacters?: number;
}

/**
 * Manages conversation history for context preservation across model changes.
 * 
 * When the user switches models, this class provides the previous conversation
 * as context for the new model, ensuring continuity.
 */
export class ConversationHistory {
  private messages: ConversationMessage[] = [];
  private readonly maxMessages: number;
  private readonly maxCharacters: number;
  private currentModel: string | undefined;

  constructor(options: ConversationHistoryOptions = {}) {
    this.maxMessages = options.maxMessages ?? 20;
    this.maxCharacters = options.maxCharacters ?? 50000;
  }

  /**
   * Set the current model being used
   */
  setCurrentModel(model: string | undefined): void {
    this.currentModel = model;
  }

  /**
   * Check if content is a duplicate of the last message with the same role.
   * Deduplication prevents inflating history when the same message is sent multiple times.
   */
  private isDuplicate(role: 'user' | 'assistant', content: string): boolean {
    if (this.messages.length === 0) return false;

    // Find the last message with the same role
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg.role === role) {
        // Check if content matches (normalize whitespace for comparison)
        const normalizedNew = content.trim().replace(/\s+/g, ' ');
        const normalizedExisting = msg.content.replace(/\s+/g, ' ');
        return normalizedNew === normalizedExisting;
      }
    }

    return false;
  }

  /**
   * Add a user message to history
   * Skips duplicate messages to prevent history inflation
   */
  addUserMessage(content: string): void {
    if (!content.trim()) return;

    const trimmedContent = content.trim();

    // Skip duplicate messages
    if (this.isDuplicate('user', trimmedContent)) {
      logger.debug(`[ConversationHistory] Skipping duplicate user message (${trimmedContent.length} chars)`);
      return;
    }

    this.messages.push({
      role: 'user',
      content: trimmedContent,
      timestamp: Date.now(),
    });

    this.trimHistory();
    logger.debug(`[ConversationHistory] Added user message (${trimmedContent.length} chars), total: ${this.messages.length}`);
  }

  /**
   * Add an assistant response to history
   * Skips duplicate messages to prevent history inflation
   */
  addAssistantMessage(content: string): void {
    if (!content.trim()) return;

    const trimmedContent = content.trim();

    // Skip duplicate messages
    if (this.isDuplicate('assistant', trimmedContent)) {
      logger.debug(`[ConversationHistory] Skipping duplicate assistant message (${trimmedContent.length} chars)`);
      return;
    }

    this.messages.push({
      role: 'assistant',
      content: trimmedContent,
      timestamp: Date.now(),
      model: this.currentModel,
    });

    this.trimHistory();
    logger.debug(`[ConversationHistory] Added assistant message (${trimmedContent.length} chars), total: ${this.messages.length}`);
  }

  /**
   * Get the number of messages in history
   */
  size(): number {
    return this.messages.length;
  }

  /**
   * Check if there's any history to preserve
   */
  hasHistory(): boolean {
    return this.messages.length > 0;
  }

  /**
   * Clear all history
   */
  clear(): void {
    this.messages = [];
    logger.debug('[ConversationHistory] History cleared');
  }

  /**
   * Get formatted context for injecting into a new session.
   * This is used when the model changes to preserve conversation context.
   * 
   * @returns Formatted string with previous conversation context, or empty string if no history
   */
  getContextForNewSession(): string {
    if (this.messages.length === 0) {
      return '';
    }

    const formattedMessages = this.messages.map(msg => {
      const role = msg.role === 'user' ? 'User' : 'Assistant';
      // Truncate very long messages to avoid token limits
      const content = msg.content.length > 2000 
        ? msg.content.substring(0, 2000) + '... [truncated]'
        : msg.content;
      return `${role}: ${content}`;
    }).join('\n\n');

    return `[PREVIOUS CONVERSATION CONTEXT]
The following is our previous conversation. Continue from where we left off:

${formattedMessages}

[END OF PREVIOUS CONTEXT]

`;
  }

  /**
   * Trim history to stay within limits
   */
  private trimHistory(): void {
    // Trim by message count
    while (this.messages.length > this.maxMessages) {
      this.messages.shift();
    }

    // Trim by total character count
    let totalChars = this.messages.reduce((sum, msg) => sum + msg.content.length, 0);
    while (totalChars > this.maxCharacters && this.messages.length > 1) {
      const removed = this.messages.shift();
      if (removed) {
        totalChars -= removed.content.length;
      }
    }
  }

  /**
   * Get a summary of the conversation for logging/debugging
   */
  getSummary(): string {
    const totalChars = this.messages.reduce((sum, msg) => sum + msg.content.length, 0);
    const userCount = this.messages.filter(m => m.role === 'user').length;
    const assistantCount = this.messages.filter(m => m.role === 'assistant').length;
    return `${this.messages.length} messages (${userCount} user, ${assistantCount} assistant), ${totalChars} chars`;
  }
}

