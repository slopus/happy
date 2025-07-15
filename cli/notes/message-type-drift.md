# Message Type Drift Documentation

## Overview

This document describes the message format differences between interactive mode (PTY-based Claude sessions) and remote mode (SDK-based Claude sessions), and the transformation logic implemented to bridge these differences.

## The Problem

The handy-cli operates in two modes:
1. **Interactive Mode**: Uses PTY to spawn Claude Code process, watches session files
2. **Remote Mode**: Uses Claude SDK directly, controlled by mobile app

These modes produce different message formats, but both need to communicate with the handy-server which expects a unified format.


## The real solution - 

We need to carefuly review our types across all apps & ideally factor them out into a shared package.
No need to make monorepo happen for this - we can create a different repo for this, or let these types live in one of the existing repos, on which all others will depend. Probably server makes the most sense to hold these.

Some of these types the server will never see - so might be a good idea to deliniate them. Simply different folder?

## Message Formats

### Interactive Mode Messages (from file watcher)

User messages from interactive mode come from the Claude session file format:

```json
{
  "sessionId": "60ff328c-6c58-4239-8c22-ae3f41cc6ddb",
  "type": "user",
  "rawMessage": {
    "parentUuid": null,
    "isSidechain": false,
    "userType": "external",
    "cwd": "/Users/kirilldubovitskiy/projects/handy-cli",
    "sessionId": "60ff328c-6c58-4239-8c22-ae3f41cc6ddb",
    "version": "1.0.51",
    "type": "user",
    "message": {
      "role": "user",
      "content": "say lol"
    },
    "uuid": "33b5dec2-204e-4ef9-a2dd-b5d13d33b316",
    "timestamp": "2025-07-15T07:58:51.996Z",
    "session_id": "60ff328c-6c58-4239-8c22-ae3f41cc6ddb"
  }
}
```

### Remote Mode Messages (from mobile client)

User messages from the mobile client use a simpler format:

```json
{
  "role": "user",
  "localKey": "3893b84c-f730-4019-b9d6-2925ddb9a6d6",
  "content": {
    "type": "text",
    "text": "Say 'second message'"
  }
}
```

### Server Expectation

The server's socket handler expects all messages to be encrypted and in the MessageContent format:

```typescript
type MessageContent = UserMessage | AgentMessage

type UserMessage = {
  role: 'user',
  content: {
    type: 'text',
    text: string
  }
}

type AgentMessage = {
  role: 'agent',
  content: any
}
```

## The Solution

### 1. Modified apiSession.sendMessage()

The `sendMessage` method was updated to handle both formats:

```typescript
sendMessage(body: any) {
    let content: MessageContent;
    
    // Check if body is already a MessageContent (has role property)
    if (body.role === 'user' || body.role === 'agent') {
        content = body;
    } else {
        // Legacy behavior: wrap as agent message
        content = {
            role: 'agent',
            content: body
        };
    }
    
    // ... encryption and sending logic
}
```

### 2. Transform Interactive Messages in loop.ts

Interactive mode messages are transformed to match the mobile format:

```typescript
if (event.type === 'user' && event.rawMessage.message) {
    // Extract just the essential fields
    const userMessage: UserMessage = {
        role: 'user',
        content: {
            type: 'text',
            text: event.rawMessage.message.content
        }
    };
    session.sendMessage(userMessage);
}
```

## The Echo Problem

When the CLI sends a user message to the server, the server broadcasts it to all connected clients (including the CLI itself). This created a feedback loop where:

1. Interactive mode sends user message
2. Server echoes it back
3. CLI receives its own message and thinks it's from mobile
4. CLI switches to remote mode unexpectedly

### Solution

We track the `localKey` values of messages we send in a Set (`sentLocalKeys`). When receiving updates, we check if the `localKey` is in our sent set and ignore those messages to prevent the echo loop. 

Implementation details:
- `ApiSession` maintains a `sentLocalKeys` Set
- When sending a user message with a `localKey`, we add it to the set
- When receiving updates, we check if the `localKey` exists in our set
- If it does, we log and ignore it as an echo
- The `sentFrom: 'cli'` field is kept for debugging purposes but not used for filtering

## Why This is a Hack

1. **Loss of Information**: The transformation discards metadata like:
   - Parent UUID (conversation threading)
   - Timestamps
   - Session versioning
   - User type information

2. **Format Inconsistency**: Assistant messages are still sent in the old wrapped format:
   ```json
   {
     "data": { /* full rawMessage */ },
     "type": "output"
   }
   ```

3. **Session ID Mismatch**: Interactive and SDK sessions have different IDs and can't be resumed across modes

## Future Improvements

1. **Unified Message Format**: Define a common message format that preserves all necessary information from both modes

2. **Session Continuity**: Implement a session translation layer that allows continuing conversations across mode switches

3. **Complete Transformation**: Transform all message types (not just user messages) to a consistent format

4. **Server-Side Support**: Update the server to handle richer message formats that preserve the full context

## Related Files

- `/src/api/apiSession.ts` - Socket message sending logic
- `/src/claude/loop.ts` - Message transformation logic
- `/src/api/types.ts` - TypeScript type definitions
- `/Users/kirilldubovitskiy/projects/handy-server/sources/app/api.ts` - Server socket handlers