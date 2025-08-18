# Machine Sync Architecture - Separated Metadata & Daemon State

## Data Structure (Similar to Session's metadata + agentState)

```typescript
// Static machine information (rarely changes)
interface MachineMetadata {
  host: string;              // hostname
  platform: string;          // darwin, linux, win32
  happyCliVersion: string;   
  homeDir: string;           
  happyHomeDir: string;
}

// Dynamic daemon state (frequently updated)
interface DaemonState {
  status: 'running' | 'shutting-down' | 'offline';
  pid?: number;
  httpPort?: number;
  startedAt?: number;
  shutdownRequestedAt?: number;
  shutdownSource?: 'mobile-app' | 'cli' | 'os-signal' | 'unknown';
}
```

## 1. CLI Startup Phase

Checks if machine ID exists in settings:
- If not: creates ID locally only (so sessions can reference it)
- Does NOT create machine on server - that's daemon's job
- CLI doesn't manage machine details - all API & schema live in daemon subpackage

## 2. Daemon Startup - Initial Registration

### REST Request: `POST /v1/machines`
```json
{
  "id": "machine-uuid-123",
  "metadata": "base64(encrypted({
    'host': 'MacBook-Pro.local',
    'platform': 'darwin',
    'happyCliVersion': '1.0.0',
    'homeDir': '/Users/john',
    'happyHomeDir': '/Users/john/.happy'
  }))",
  "daemonState": "base64(encrypted({
    'status': 'running',
    'pid': 12345,
    'httpPort': 8080,
    'startedAt': 1703001234567
  }))"
}
```

### Server Response:
```json
{
  "machine": {
    "id": "machine-uuid-123",
    "metadata": "base64(encrypted(...))",  // echoed back
    "metadataVersion": 1,
    "daemonState": "base64(encrypted(...))",  // echoed back
    "daemonStateVersion": 1,
    "active": true,
    "lastActiveAt": 1703001234567,
    "createdAt": 1703001234567,
    "updatedAt": 1703001234567
  }
}
```

## 3. WebSocket Connection & Real-time Updates

### Connection Handshake:
```javascript
io(serverUrl, {
  auth: {
    token: "auth-token",
    clientType: "machine-scoped",
    machineId: "machine-uuid-123"
  }
})
```

### Heartbeat (every 20s):
```json
// Client -> Server
socket.emit('machine-alive', {
  "machineId": "machine-uuid-123",
  "time": 1703001234567
})
```

## 4. Daemon State Updates (via WebSocket)

### When daemon status changes:
```json
// Client -> Server
socket.emit('machine-update-state', {
  "machineId": "machine-uuid-123",
  "daemonState": "base64(encrypted({
    'status': 'shutting-down',
    'pid': 12345,
    'httpPort': 8080,
    'startedAt': 1703001234567,
    'shutdownRequestedAt': 1703001244567,
    'shutdownSource': 'mobile-app'
  }))",
  "expectedVersion": 1
}, callback)

// Server -> Client (callback)
// Success:
{
  "result": "success",
  "version": 2,
  "daemonState": "base64(encrypted(...))"
}

// Version mismatch:
{
  "result": "version-mismatch",
  "version": 3,
  "daemonState": "base64(encrypted(current_state))"
}
```

### Machine metadata update (rare):
```json
// Client -> Server
socket.emit('machine-update-metadata', {
  "machineId": "machine-uuid-123",
  "metadata": "base64(encrypted({
    'host': 'MacBook-Pro.local',
    'platform': 'darwin',
    'happyCliVersion': '1.0.1',  // version updated
    'homeDir': '/Users/john',
    'happyHomeDir': '/Users/john/.happy'
  }))",
  "expectedVersion": 1
}, callback)
```

## 5. Mobile App RPC Calls

### Stop Daemon Request:
```json
// Mobile -> Server
socket.emit('rpc-call', {
  "method": "machine-uuid-123:stop-daemon",
  "params": "base64(encrypted({
    'reason': 'user-requested',
    'force': false
  }))"
}, callback)

// Server forwards to Daemon
// Daemon -> Server (response)
callback("base64(encrypted({
  'message': 'Daemon shutdown initiated',
  'shutdownAt': 1703001244567
}))")
```

### Flow when daemon receives stop request:
1. Daemon receives RPC `stop-daemon`
2. Updates daemon state immediately:
```json
socket.emit('machine-update-state', {
  "machineId": "machine-uuid-123",
  "daemonState": "base64(encrypted({
    'status': 'shutting-down',
    'shutdownRequestedAt': 1703001244567,
    'shutdownSource': 'mobile-app'
  }))",
  "expectedVersion": 2
})
```
3. Sends acknowledgment back via RPC callback
4. Performs cleanup
5. Final state update before exit:
```json
socket.emit('machine-update-state', {
  "machineId": "machine-uuid-123", 
  "daemonState": "base64(encrypted({
    'status': 'offline'
  }))",
  "expectedVersion": 3
})
```

## 6. Server Broadcasts to Clients

### When daemon state changes:
```json
// Server -> Mobile/Web clients
socket.emit('update', {
  "id": "update-id-xyz",
  "seq": 456,
  "body": {
    "t": "update-machine",
    "id": "machine-uuid-123",
    "daemonState": {
      "value": "base64(encrypted(...))",
      "version": 2
    }
  },
  "createdAt": 1703001244567
})
```

### When metadata changes:
```json
socket.emit('update', {
  "id": "update-id-abc",
  "seq": 457,
  "body": {
    "t": "update-machine",
    "id": "machine-uuid-123",
    "metadata": {
      "value": "base64(encrypted(...))",
      "version": 2
    }
  },
  "createdAt": 1703001244567
})
```

## 7. GET Machine Status (REST)

### Request: `GET /v1/machines/machine-uuid-123`
```http
Authorization: Bearer <token>
```

### Response:
```json
{
  "machine": {
    "id": "machine-uuid-123",
    "metadata": "base64(encrypted(...))",
    "metadataVersion": 2,
    "daemonState": "base64(encrypted(...))",
    "daemonStateVersion": 3,
    "active": true,
    "lastActiveAt": 1703001244567,
    "createdAt": 1703001234567,
    "updatedAt": 1703001244567
  }
}
```

## Key Design Decisions

1. **Separation of Concerns**: 
   - `metadata`: Static machine info (host, platform, versions)
   - `daemonState`: Dynamic runtime state (status, pid, ports)

2. **Independent Versioning**:
   - `metadataVersion`: For machine metadata updates
   - `daemonStateVersion`: For daemon state updates
   - Allows concurrent updates without conflicts

3. **Encryption**: Both metadata and daemonState are encrypted separately

4. **Update Events**: Server broadcasts use same pattern as sessions:
   - `t: 'update-machine'` with optional metadata and/or daemonState fields
   - Clients only receive updates for fields that changed

5. **RPC Pattern**: Machine-scoped RPC methods prefixed with machineId (like sessions)




