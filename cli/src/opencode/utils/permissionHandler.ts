/**
 * OpenCode Permission Handler
 *
 * Handles tool permission requests and responses for OpenCode ACP sessions.
 * Uses the same mobile permission RPC flow as Codex/Gemini.
 */

import { logger } from '@/ui/logger';
import type { ApiSessionClient } from '@/api/apiSession';
import type { PermissionMode } from '@/api/types';
import {
  BasePermissionHandler,
  type PermissionResult,
  type PendingRequest,
} from '@/agent/permissions/BasePermissionHandler';

// Re-export types for backwards compatibility
export type { PermissionResult, PendingRequest };

export function isOpenCodeWriteLikeToolName(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  // Safety: when OpenCode reports an unknown tool name (often "other"),
  // treat it as write-like so safe modes do not silently auto-approve it.
  if (lower === 'other' || lower === 'unknown tool' || lower === 'unknown') return true;

  const writeish = [
    'edit',
    'write',
    'patch',
    'delete',
    'remove',
    'create',
    'mkdir',
    'rename',
    'move',
    'copy',
    'exec',
    'bash',
    'shell',
    'run',
    'terminal',
  ];
  return writeish.some((k) => lower === k || lower.includes(k));
}

export class OpenCodePermissionHandler extends BasePermissionHandler {
  private currentPermissionMode: PermissionMode = 'default';

  constructor(
    session: ApiSessionClient,
    opts?: { onAbortRequested?: (() => void | Promise<void>) | null },
  ) {
    super(session, opts);
  }

  protected getLogPrefix(): string {
    return '[OpenCode]';
  }

  updateSession(newSession: ApiSessionClient): void {
    super.updateSession(newSession);
  }

  setPermissionMode(mode: PermissionMode): void {
    this.currentPermissionMode = mode;
    logger.debug(`${this.getLogPrefix()} Permission mode set to: ${mode}`);
  }

  private shouldAutoApprove(toolName: string, toolCallId: string): boolean {
    // Always-auto-approve lightweight internal tools if any appear.
    // (Conservative: keep this list minimal.)
    const alwaysAutoApproveNames = ['change_title', 'save_memory', 'think'];
    if (alwaysAutoApproveNames.some((n) => toolName.toLowerCase().includes(n))) return true;

    switch (this.currentPermissionMode) {
      case 'yolo':
        return true;
      case 'safe-yolo':
        return !isOpenCodeWriteLikeToolName(toolName);
      case 'read-only':
        return !isOpenCodeWriteLikeToolName(toolName);
      case 'default':
      case 'acceptEdits':
      case 'bypassPermissions':
      case 'plan':
      default:
        return false;
    }
  }

  async handleToolCall(toolCallId: string, toolName: string, input: unknown): Promise<PermissionResult> {
    // Respect user "don't ask again for session" choices captured via our permission UI.
    if (this.isAllowedForSession(toolName, input)) {
      logger.debug(`${this.getLogPrefix()} Auto-approving (allowed for session) tool ${toolName} (${toolCallId})`);
      this.recordAutoDecision(toolCallId, toolName, input, 'approved_for_session');
      return { decision: 'approved_for_session' };
    }

    if (this.shouldAutoApprove(toolName, toolCallId)) {
      const decision: PermissionResult['decision'] =
        this.currentPermissionMode === 'yolo' ? 'approved_for_session' : 'approved';

      logger.debug(`${this.getLogPrefix()} Auto-approving tool ${toolName} (${toolCallId}) in ${this.currentPermissionMode} mode`);
      this.recordAutoDecision(toolCallId, toolName, input, decision);

      return { decision };
    }

    return new Promise<PermissionResult>((resolve, reject) => {
      this.pendingRequests.set(toolCallId, { resolve, reject, toolName, input });
      this.addPendingRequestToState(toolCallId, toolName, input);
      logger.debug(`${this.getLogPrefix()} Permission request sent for tool: ${toolName} (${toolCallId}) in ${this.currentPermissionMode} mode`);
    });
  }
}
