/**
 * Auggie Permission Handler
 *
 * Handles tool permission requests and responses for Auggie ACP sessions.
 * Uses the same mobile permission RPC flow as Codex/Gemini/OpenCode.
 */

import { logger } from '@/ui/logger';
import type { ApiSessionClient } from '@/api/apiSession';
import type { PermissionMode } from '@/api/types';
import {
  BasePermissionHandler,
  type PermissionResult,
  type PendingRequest,
} from '@/agent/permissions/BasePermissionHandler';

export type { PermissionResult, PendingRequest };

function isAuggieWriteLikeToolName(toolName: string): boolean {
  const lower = toolName.toLowerCase();
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

export class AuggiePermissionHandler extends BasePermissionHandler {
  private currentPermissionMode: PermissionMode = 'default';

  protected getLogPrefix(): string {
    return '[Auggie]';
  }

  setPermissionMode(mode: PermissionMode): void {
    this.currentPermissionMode = mode;
    logger.debug(`${this.getLogPrefix()} Permission mode set to: ${mode}`);
  }

  private shouldAutoApprove(toolName: string, toolCallId: string): boolean {
    // Conservative always-auto-approve list.
    const alwaysAutoApproveNames = ['change_title', 'save_memory', 'think'];
    if (alwaysAutoApproveNames.some((n) => toolName.toLowerCase().includes(n))) return true;
    if (alwaysAutoApproveNames.some((n) => toolCallId.toLowerCase().includes(n))) return true;

    switch (this.currentPermissionMode) {
      case 'yolo':
        return true;
      case 'safe-yolo':
        return !isAuggieWriteLikeToolName(toolName);
      case 'read-only':
        return !isAuggieWriteLikeToolName(toolName);
      case 'default':
      case 'acceptEdits':
      case 'bypassPermissions':
      case 'plan':
      default:
        return false;
    }
  }

  async handleToolCall(toolCallId: string, toolName: string, input: unknown): Promise<PermissionResult> {
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

