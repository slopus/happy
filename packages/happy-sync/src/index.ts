// Transport-level types (server wire format)
export * from './messages';

// acpx session types (replaces v3 protocol)
export * from './acpx-types';

// v3 compat (internal — will be removed when SyncNode is rewritten)
export * as v3 from './v3-compat';

// Encryption
export * from './encryption';

// SyncNode
export {
    SyncNode,
    type SyncNodeToken,
    type SyncNodeTokenClaims,
    SyncNodeTokenClaimsSchema,
    type SyncState,
    type SessionState,
    type SessionStatus,
    type PermissionRequest,
    type QuestionRequest,
    type CreateSessionOpts,
    type ApproveOpts,
    type DenyOpts,
    type UsageReport,
    type RpcHandler,
    type ResolveSessionKeyMaterialContext,
    type ResolveSessionKeyMaterial,
    type SyncNodeOpts,
} from './sync-node';
