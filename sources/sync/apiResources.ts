/**
 * Resource Exposure API Client
 * Provides access to host machine resources (commands, skills, MCPs) via daemon
 */

import { apiSocket } from './apiSocket';

export interface Command {
  name: string;
  description: string;
  usage?: string;
  examples?: string[];
  subcommands?: Command[];
}

export interface Skill {
  name: string;
  description: string;
  license?: string;
}

export interface MCPServer {
  name: string;
  config: {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    type?: 'stdio' | 'http';
  };
  status: 'configured' | 'unknown';
}

export interface CommandExecutionResult {
  success: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  error?: string;
}

export interface SkillContent {
  success: boolean;
  skillMd?: string;
  templates?: Record<string, string>;
  metadata?: Skill;
  error?: string;
}

/**
 * List available CLI commands from host machine
 */
export async function listCommands(machineId: string): Promise<Command[]> {
  try {
    const response = await apiSocket.machineRPC<{ commands: Command[] }, {}>(
      machineId,
      'resource:list-commands',
      {}
    );
    return response.commands || [];
  } catch (error) {
    console.error('[apiResources] listCommands error:', error);
    return [];
  }
}

/**
 * List installed Claude Skills from host machine
 */
export async function listSkills(machineId: string): Promise<Skill[]> {
  try {
    const response = await apiSocket.machineRPC<{ skills: Skill[] }, {}>(
      machineId,
      'resource:list-skills',
      {}
    );
    return response.skills || [];
  } catch (error) {
    console.error('[apiResources] listSkills error:', error);
    return [];
  }
}

/**
 * List configured MCP servers from host machine
 */
export async function listMCPServers(machineId: string): Promise<MCPServer[]> {
  try {
    const response = await apiSocket.machineRPC<{ servers: MCPServer[] }, {}>(
      machineId,
      'resource:list-mcp-servers',
      {}
    );
    return response.servers || [];
  } catch (error) {
    console.error('[apiResources] listMCPServers error:', error);
    return [];
  }
}

/**
 * Execute a command on host machine
 */
export async function executeCommand(
  machineId: string,
  command: string,
  args?: string[],
  cwd?: string,
  timeoutMs?: number
): Promise<CommandExecutionResult> {
  try {
    const response = await apiSocket.machineRPC<CommandExecutionResult, {
      command: string;
      args?: string[];
      cwd?: string;
      timeoutMs?: number;
    }>(
      machineId,
      'resource:execute-command',
      { command, args, cwd, timeoutMs }
    );
    return response;
  } catch (error) {
    console.error('[apiResources] executeCommand error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Get skill content and metadata from host machine
 */
export async function getSkill(
  machineId: string,
  skillName: string,
  context?: Record<string, any>,
  parameters?: Record<string, any>
): Promise<SkillContent> {
  try {
    const response = await apiSocket.machineRPC<SkillContent, {
      skillName: string;
      context?: Record<string, any>;
      parameters?: Record<string, any>;
    }>(
      machineId,
      'resource:invoke-skill',
      { skillName, context, parameters }
    );
    return response;
  } catch (error) {
    console.error('[apiResources] getSkill error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}
