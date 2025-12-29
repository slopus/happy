/**
 * AgentRegistry - Registry for agent backend factories
 * 
 * This module provides a central registry for creating agent backends.
 * It allows registering factory functions for different agent types
 * and creating instances of those backends.
 */

import type { AgentBackend, AgentId } from './AgentBackend';

/** Options passed to agent factory functions */
export interface AgentFactoryOptions {
  /** Working directory for the agent */
  cwd: string;
  
  /** Environment variables to pass to the agent */
  env?: Record<string, string>;
}

/** Factory function type for creating agent backends */
export type AgentFactory = (opts: AgentFactoryOptions) => AgentBackend;

/**
 * Registry for agent backend factories.
 * 
 * Use this to register and create agent backends by their identifier.
 * 
 * @example
 * ```ts
 * const registry = new AgentRegistry();
 * registry.register('gemini', createGeminiBackend);
 * 
 * const backend = registry.create('gemini', { cwd: process.cwd() });
 * await backend.startSession('Hello!');
 * ```
 */
export class AgentRegistry {
  private factories = new Map<AgentId, AgentFactory>();

  /**
   * Register a factory function for an agent type.
   * 
   * @param id - The agent identifier
   * @param factory - Factory function to create the backend
   */
  register(id: AgentId, factory: AgentFactory): void {
    this.factories.set(id, factory);
  }

  /**
   * Check if an agent type is registered.
   * 
   * @param id - The agent identifier to check
   * @returns true if the agent is registered
   */
  has(id: AgentId): boolean {
    return this.factories.has(id);
  }

  /**
   * Get the list of registered agent identifiers.
   * 
   * @returns Array of registered agent IDs
   */
  list(): AgentId[] {
    return Array.from(this.factories.keys());
  }

  /**
   * Create an agent backend instance.
   * 
   * @param id - The agent identifier
   * @param opts - Options for creating the backend
   * @returns The created agent backend
   * @throws Error if the agent type is not registered
   */
  create(id: AgentId, opts: AgentFactoryOptions): AgentBackend {
    const factory = this.factories.get(id);
    if (!factory) {
      const available = this.list().join(', ') || 'none';
      throw new Error(`Unknown agent: ${id}. Available agents: ${available}`);
    }
    return factory(opts);
  }
}

/** Global agent registry instance */
export const agentRegistry = new AgentRegistry();

