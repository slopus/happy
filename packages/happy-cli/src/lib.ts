/**
 * Library exports for slopus package
 * 
 * This file provides the main API classes and types for external consumption
 * without the CLI-specific functionality.
 */

// These exports allow me to use this package a library in dev-environment cli helper programs
export { ApiClient } from '@/api/api'
export { SyncBridge } from '@/api/syncBridge'
export { resolveSessionScopedSyncNodeToken } from '@/api/syncNodeToken'

export { logger } from '@/ui/logger'
export { configuration } from '@/configuration'

export { RawJSONLinesSchema, type RawJSONLines } from '@/claude/types'
