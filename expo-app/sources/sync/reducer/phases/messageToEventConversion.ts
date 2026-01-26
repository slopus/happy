import type { AgentEvent, NormalizedMessage } from '../../typesRaw';
import type { ReducerState } from '../reducer';
import { parseMessageAsEvent } from '../messageToEvent';

export function runMessageToEventConversion({
  state,
  nonSidechainMessages,
  changed,
  allocateId,
  enableLogging,
}: {
  state: ReducerState;
  nonSidechainMessages: NormalizedMessage[];
  changed: Set<string>;
  allocateId: () => string;
  enableLogging: boolean;
}): {
  nonSidechainMessages: NormalizedMessage[];
  incomingToolIds: Set<string>;
  hasReadyEvent: boolean;
} {
  //
  // Phase 0.5: Message-to-Event Conversion
  // Convert certain messages to events before normal processing
  //

  if (enableLogging) {
    console.log(`[REDUCER] Phase 0.5: Message-to-Event Conversion`);
  }

  const messagesToProcess: NormalizedMessage[] = [];
  const convertedEvents: { message: NormalizedMessage; event: AgentEvent }[] = [];
  let hasReadyEvent = false;

  for (const msg of nonSidechainMessages) {
    // Check if we've already processed this message
    if (msg.role === 'user' && msg.localId && state.localIds.has(msg.localId)) {
      continue;
    }
    if (state.messageIds.has(msg.id)) {
      continue;
    }

    // Filter out ready events completely - they should not create any message
    if (msg.role === 'event' && msg.content.type === 'ready') {
      // Mark as processed to prevent duplication but don't add to messages
      state.messageIds.set(msg.id, msg.id);
      hasReadyEvent = true;
      continue;
    }

    // Handle context reset events - reset state and let the message be shown
    if (
      msg.role === 'event' &&
      msg.content.type === 'message' &&
      msg.content.message === 'Context was reset'
    ) {
      // Reset todos to empty array and reset usage to zero
      state.latestTodos = {
        todos: [],
        timestamp: msg.createdAt, // Use message timestamp, not current time
      };
      state.latestUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreation: 0,
        cacheRead: 0,
        contextSize: 0,
        timestamp: msg.createdAt, // Use message timestamp to avoid blocking older usage data
      };
      // Don't continue - let the event be processed normally to create a message
    }

    // Handle compaction completed events - reset context but keep todos
    if (
      msg.role === 'event' &&
      msg.content.type === 'message' &&
      msg.content.message === 'Compaction completed'
    ) {
      // Reset usage/context to zero but keep todos unchanged
      state.latestUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreation: 0,
        cacheRead: 0,
        contextSize: 0,
        timestamp: msg.createdAt, // Use message timestamp to avoid blocking older usage data
      };
      // Don't continue - let the event be processed normally to create a message
    }

    // Try to parse message as event
    const event = parseMessageAsEvent(msg);
    if (event) {
      if (enableLogging) {
        console.log(`[REDUCER] Converting message ${msg.id} to event:`, event);
      }
      convertedEvents.push({ message: msg, event });
      // Mark as processed to prevent duplication
      state.messageIds.set(msg.id, msg.id);
      if (msg.role === 'user' && msg.localId) {
        state.localIds.set(msg.localId, msg.id);
      }
    } else {
      messagesToProcess.push(msg);
    }
  }

  // Process converted events immediately
  for (const { message, event } of convertedEvents) {
    const mid = allocateId();
    state.messages.set(mid, {
      id: mid,
      realID: message.id,
      role: 'agent',
      createdAt: message.createdAt,
      event: event,
      tool: null,
      text: null,
      meta: message.meta,
    });
    changed.add(mid);
  }

  // Update nonSidechainMessages to only include messages that weren't converted
  nonSidechainMessages = messagesToProcess;

  // Build a set of incoming tool IDs for quick lookup
  const incomingToolIds = new Set<string>();
  for (const msg of nonSidechainMessages) {
    if (msg.role === 'agent') {
      for (const c of msg.content) {
        if (c.type === 'tool-call') {
          incomingToolIds.add(c.id);
        }
      }
    }
  }

  return { nonSidechainMessages, incomingToolIds, hasReadyEvent };
}

