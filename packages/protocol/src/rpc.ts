export const RPC_METHODS = {
  SPAWN_HAPPY_SESSION: 'spawn-happy-session',
  STOP_SESSION: 'stop-session',
  STOP_DAEMON: 'stop-daemon',
  BASH: 'bash',
  PREVIEW_ENV: 'preview-env',
  READ_FILE: 'readFile',
  WRITE_FILE: 'writeFile',
  LIST_DIRECTORY: 'listDirectory',
  GET_DIRECTORY_TREE: 'getDirectoryTree',
  RIPGREP: 'ripgrep',
  DIFFTASTIC: 'difftastic',
  KILL_SESSION: 'killSession',
  CAPABILITIES_DESCRIBE: 'capabilities.describe',
  CAPABILITIES_DETECT: 'capabilities.detect',
  CAPABILITIES_INVOKE: 'capabilities.invoke',
} as const;

export type RpcMethod = (typeof RPC_METHODS)[keyof typeof RPC_METHODS];

export const RPC_ERROR_CODES = {
  METHOD_NOT_AVAILABLE: 'RPC_METHOD_NOT_AVAILABLE',
} as const;

export type RpcErrorCode = (typeof RPC_ERROR_CODES)[keyof typeof RPC_ERROR_CODES];

