/**
 * Static voice context configuration
 */
export const VOICE_CONFIG = {
    /** Disable all tool call information from being sent to voice context */
    DISABLE_TOOL_CALLS: false,
    
    /** Send only tool names and descriptions, exclude arguments */
    LIMITED_TOOL_CALLS: true,
    
    /** Disable permission request forwarding */
    DISABLE_PERMISSION_REQUESTS: false,
    
    /** Disable session online/offline notifications */
    DISABLE_SESSION_STATUS: true,
    
    /** Disable message forwarding */
    DISABLE_MESSAGES: false,
    
    /** Disable session focus notifications */
    DISABLE_SESSION_FOCUS: false,
    
    /** Maximum number of messages to include in session history */
    MAX_HISTORY_MESSAGES: 50,
    
    /** Enable debug logging for voice context updates */
    ENABLE_DEBUG_LOGGING: true,
} as const;