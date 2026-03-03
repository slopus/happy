/**
 * AutoRefreshManager — debounces tool-call-end events and triggers a
 * Preview Panel reload after a quiet period.
 *
 * Responsibilities:
 *  - Accumulate file-change signals from Claude Code tool calls (Edit, Write, Bash)
 *  - Distinguish CSS-only changes (lightweight style injection) from full reloads
 *  - Debounce rapid sequences of tool calls into a single callback invocation
 */

import { detectCssOnlyChange, shouldTriggerReload } from './devServerDetector';

type RefreshType = 'css' | 'full';
type RefreshCallback = (type: RefreshType) => void;

export class AutoRefreshManager {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingType: RefreshType = 'css';
  private debounceMs: number;

  constructor(private onRefresh: RefreshCallback, debounceMs = 500) {
    this.debounceMs = debounceMs;
  }

  /**
   * Call this when a tool-call-end event is received from the Claude stream.
   *
   * @param toolName - The name of the tool that finished (e.g. 'Edit', 'Write', 'Bash').
   * @param toolArgs - The command string passed to a Bash tool, if applicable.
   * @param filePath - The file path that was modified, if known (used for CSS detection).
   */
  handleToolCallEnd(toolName: string, toolArgs?: string, filePath?: string): void {
    if (!shouldTriggerReload(toolName, toolArgs)) {
      return;
    }

    const isCssOnly = detectCssOnlyChange(toolName, filePath);

    // Escalate to 'full' if this change cannot be handled with CSS-only injection.
    // Once escalated within a debounce window, never downgrade back to 'css'.
    if (!isCssOnly) {
      this.pendingType = 'full';
    }

    this.scheduleRefresh();
  }

  /**
   * Release all resources held by this instance. Safe to call multiple times.
   */
  destroy(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private scheduleRefresh(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      const type = this.pendingType;
      // Reset for the next debounce window before firing so callers can
      // immediately enqueue new events inside the callback without data loss.
      this.pendingType = 'css';
      this.onRefresh(type);
    }, this.debounceMs);
  }
}
