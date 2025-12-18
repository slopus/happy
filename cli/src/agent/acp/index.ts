/**
 * ACP Module - Agent Client Protocol implementations
 * 
 * This module exports all ACP-related functionality including
 * the base AcpSdkBackend and agent-specific implementations.
 * 
 * Uses the official @agentclientprotocol/sdk from Zed Industries.
 */

export { AcpSdkBackend, type AcpSdkBackendOptions } from './AcpSdkBackend';
export { createGeminiBackend, registerGeminiAgent, type GeminiBackendOptions } from './gemini';

