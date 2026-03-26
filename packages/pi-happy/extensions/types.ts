export enum ConnectionState {
  Disconnected = 'disconnected',
  Connecting = 'connecting',
  Connected = 'connected',
  Offline = 'offline',
}

export interface PiHappyConfig {
  serverUrl: string;
  happyHomeDir: string;
  privateKeyFile: string;
  settingsFile: string;
  daemonStateFile: string;
}

export interface PiHappyThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface PiHappyUiLike {
  setStatus?: (key: string, value: string | undefined) => void;
  setWidget?: (key: string, lines: string[] | undefined) => void;
  notify?: (message: string, level: 'info' | 'warning' | 'error') => void;
  theme?: PiHappyThemeLike;
}

export interface PiHappyModelLike {
  name: string;
}

export interface PiHappyExtensionContext {
  hasUI: boolean;
  ui: PiHappyUiLike;
  cwd: string;
  model?: PiHappyModelLike;
  isIdle(): boolean;
  abort(): void;
  shutdown(): void;
}

export interface PiHappySessionStartEvent {
  type?: 'session_start';
}

export interface PiHappySessionShutdownEvent {
  type?: 'session_shutdown';
}

export interface PiHappySessionSwitchEvent {
  type?: 'session_switch';
}

export interface PiHappyAgentStartEvent {
  type?: 'agent_start';
}

export interface PiHappyAgentEndEvent {
  type?: 'agent_end';
}

export interface PiHappyTurnStartEvent {
  type?: 'turn_start';
  turnIndex?: number;
  timestamp?: number;
}

export interface PiHappyTurnEndEvent {
  type?: 'turn_end';
  turnIndex?: number;
  message: unknown;
  toolResults: unknown[];
}

export type PiHappyAssistantMessageEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: string; [key: string]: unknown };

export interface PiHappyMessageUpdateEvent {
  type?: 'message_update';
  message?: unknown;
  assistantMessageEvent: PiHappyAssistantMessageEvent;
}

export interface PiHappyToolExecutionStartEvent {
  type?: 'tool_execution_start';
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface PiHappyToolExecutionEndEvent {
  type?: 'tool_execution_end';
  toolCallId: string;
  toolName?: string;
  result?: unknown;
  isError?: boolean;
}

export interface PiHappyModelSelectEvent {
  type?: 'model_select';
  model: PiHappyModelLike;
}

export interface PiHappyToolInfo {
  name: string;
}

export interface PiHappyCommandInfo {
  name: string;
}

export interface PiHappyEventMap {
  session_start: PiHappySessionStartEvent;
  session_shutdown: PiHappySessionShutdownEvent;
  session_switch: PiHappySessionSwitchEvent;
  agent_start: PiHappyAgentStartEvent;
  agent_end: PiHappyAgentEndEvent;
  turn_start: PiHappyTurnStartEvent;
  turn_end: PiHappyTurnEndEvent;
  message_update: PiHappyMessageUpdateEvent;
  tool_execution_start: PiHappyToolExecutionStartEvent;
  tool_execution_end: PiHappyToolExecutionEndEvent;
  model_select: PiHappyModelSelectEvent;
}

export interface PiHappyFlagOptions {
  description: string;
  type: 'boolean' | 'string';
  default?: unknown;
}

export interface PiHappyCommandOptions {
  description: string;
  handler: (args: string, ctx: PiHappyExtensionContext) => void | Promise<void>;
}

export interface PiExtensionApiLike {
  on<K extends keyof PiHappyEventMap>(
    eventName: K,
    handler: (event: PiHappyEventMap[K], ctx: PiHappyExtensionContext) => void | Promise<void>,
  ): void;
  sendUserMessage(content: string, options?: { deliverAs?: 'steer' | 'followUp' }): void;
  getAllTools(): PiHappyToolInfo[];
  getCommands(): PiHappyCommandInfo[];
  registerFlag(name: string, options: PiHappyFlagOptions): void;
  getFlag(name: string): unknown;
  registerCommand(name: string, options: PiHappyCommandOptions): void;
}
