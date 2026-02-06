/**
 * TypeScript tmux utilities adapted from Python reference
 *
 * Copyright 2025 Andrew Hundt <ATHundt@gmail.com>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Centralized tmux utilities with control sequence support and session management
 * Ensures consistent tmux handling across happy-cli with proper session naming
 */

import { spawn, SpawnOptions } from 'child_process';
import { promisify } from 'util';
import { logger } from '@/ui/logger';

export enum TmuxControlState {
    /** Normal text processing mode */
    NORMAL = "normal",
    /** Escape to tmux control mode */
    ESCAPE = "escape",
    /** Literal character mode */
    LITERAL = "literal"
}

/** Union type of valid tmux control sequences for better type safety */
export type TmuxControlSequence =
    | 'C-m' | 'C-c' | 'C-l' | 'C-u' | 'C-w' | 'C-a' | 'C-b' | 'C-d' | 'C-e' | 'C-f'
    | 'C-g' | 'C-h' | 'C-i' | 'C-j' | 'C-k' | 'C-n' | 'C-o' | 'C-p' | 'C-q' | 'C-r'
    | 'C-s' | 'C-t' | 'C-v' | 'C-x' | 'C-y' | 'C-z' | 'C-\\' | 'C-]' | 'C-[' | 'C-]';

/** Union type of valid tmux window operations for better type safety */
export type TmuxWindowOperation =
    // Navigation and window management
    | 'new-window' | 'new' | 'nw'
    | 'select-window' | 'sw' | 'window' | 'w'
    | 'next-window' | 'n' | 'prev-window' | 'p' | 'pw'
    // Pane management
    | 'split-window' | 'split' | 'sp' | 'vsplit' | 'vsp'
    | 'select-pane' | 'pane'
    | 'next-pane' | 'np' | 'prev-pane' | 'pp'
    // Session management
    | 'new-session' | 'ns' | 'new-sess'
    | 'attach-session' | 'attach' | 'as'
    | 'detach-client' | 'detach' | 'dc'
    // Layout and display
    | 'select-layout' | 'layout' | 'sl'
    | 'clock-mode' | 'clock'
    | 'copy-mode' | 'copy'
    | 'search-forward' | 'search-backward'
    // Misc operations
    | 'list-windows' | 'lw' | 'list-sessions' | 'ls' | 'list-panes' | 'lp'
    | 'rename-window' | 'rename' | 'kill-window' | 'kw'
    | 'kill-pane' | 'kp' | 'kill-session' | 'ks'
    // Display and info
    | 'display-message' | 'display' | 'dm'
    | 'show-options' | 'show' | 'so'
    // Control and scripting
    | 'send-keys' | 'send' | 'sk'
    | 'capture-pane' | 'capture' | 'cp'
    | 'pipe-pane' | 'pipe'
    // Buffer operations
    | 'list-buffers' | 'lb' | 'save-buffer' | 'sb'
    | 'delete-buffer' | 'db'
    // Advanced operations
    | 'resize-pane' | 'resize' | 'rp'
    | 'swap-pane' | 'swap'
    | 'join-pane' | 'join' | 'break-pane' | 'break';

export interface TmuxEnvironment {
    session: string;
    window: string;
    pane: string;
    socket_path?: string;
}

export interface TmuxCommandResult {
    returncode: number;
    stdout: string;
    stderr: string;
    command: string[];
}

export interface TmuxSessionInfo {
    target_session: string;
    session: string;
    window: string;
    pane: string;
    socket_path?: string;
    tmux_active: boolean;
    current_session?: string;
    env_session?: string;
    env_window?: string;
    env_pane?: string;
    available_sessions: string[];
}

// Strongly typed tmux session identifier with validation
export interface TmuxSessionIdentifier {
    session: string;
    window?: string;
    pane?: string;
}

/** Validation error for tmux session identifiers */
export class TmuxSessionIdentifierError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TmuxSessionIdentifierError';
    }
}

// Helper to parse tmux session identifier from string with validation
export function parseTmuxSessionIdentifier(identifier: string): TmuxSessionIdentifier {
    if (!identifier || typeof identifier !== 'string') {
        throw new TmuxSessionIdentifierError('Session identifier must be a non-empty string');
    }

    // Format: session:window or session:window.pane or just session
    const parts = identifier.split(':');
    if (parts.length === 0 || !parts[0]) {
        throw new TmuxSessionIdentifierError('Invalid session identifier: missing session name');
    }

    const result: TmuxSessionIdentifier = {
        session: parts[0].trim()
    };

    // Validate session name (tmux has restrictions on session names)
    if (!/^[a-zA-Z0-9._-]+$/.test(result.session)) {
        throw new TmuxSessionIdentifierError(`Invalid session name: "${result.session}". Only alphanumeric characters, dots, hyphens, and underscores are allowed.`);
    }

    if (parts.length > 1) {
        const windowAndPane = parts[1].split('.');
        result.window = windowAndPane[0]?.trim();

        if (result.window && !/^[a-zA-Z0-9._-]+$/.test(result.window)) {
            throw new TmuxSessionIdentifierError(`Invalid window name: "${result.window}". Only alphanumeric characters, dots, hyphens, and underscores are allowed.`);
        }

        if (windowAndPane.length > 1) {
            result.pane = windowAndPane[1]?.trim();
            if (result.pane && !/^[0-9]+$/.test(result.pane)) {
                throw new TmuxSessionIdentifierError(`Invalid pane identifier: "${result.pane}". Only numeric values are allowed.`);
            }
        }
    }

    return result;
}

// Helper to format tmux session identifier to string
export function formatTmuxSessionIdentifier(identifier: TmuxSessionIdentifier): string {
    if (!identifier.session) {
        throw new TmuxSessionIdentifierError('Session identifier must have a session name');
    }

    let result = identifier.session;
    if (identifier.window) {
        result += `:${identifier.window}`;
        if (identifier.pane) {
            result += `.${identifier.pane}`;
        }
    }
    return result;
}

// Helper to extract session and window from tmux output with improved validation
export function extractSessionAndWindow(tmuxOutput: string): { session: string; window: string } | null {
    if (!tmuxOutput || typeof tmuxOutput !== 'string') {
        return null;
    }

    // Look for session:window patterns in tmux output
    const lines = tmuxOutput.split('\n');

    for (const line of lines) {
        const match = line.match(/^([a-zA-Z0-9._-]+):([a-zA-Z0-9._-]+)(?:\.([0-9]+))?/);
        if (match) {
            return {
                session: match[1],
                window: match[2]
            };
        }
    }

    return null;
}

export interface TmuxSpawnOptions extends Omit<SpawnOptions, 'env'> {
    /** Target tmux session name */
    sessionName?: string;
    /** Custom tmux socket path */
    socketPath?: string;
    /** Create new window in existing session */
    createWindow?: boolean;
    /** Window name for new windows */
    windowName?: string;
    // Note: env is intentionally excluded from this interface.
    // It's passed as a separate parameter to spawnInTmux() for clarity
    // and efficiency - only variables that differ from the tmux server
    // environment need to be passed via -e flags.
}

/**
 * Complete WIN_OPS dispatch dictionary for tmux operations
 * Maps operation names to tmux commands with proper typing
 */
const WIN_OPS: Record<TmuxWindowOperation, string> = {
    // Navigation and window management
    'new-window': 'new-window',
    'new': 'new-window',
    'nw': 'new-window',

    'select-window': 'select-window -t',
    'sw': 'select-window -t',
    'window': 'select-window -t',
    'w': 'select-window -t',

    'next-window': 'next-window',
    'n': 'next-window',
    'prev-window': 'previous-window',
    'p': 'previous-window',
    'pw': 'previous-window',

    // Pane management
    'split-window': 'split-window',
    'split': 'split-window',
    'sp': 'split-window',
    'vsplit': 'split-window -h',
    'vsp': 'split-window -h',

    'select-pane': 'select-pane -t',
    'pane': 'select-pane -t',

    'next-pane': 'select-pane -t :.+',
    'np': 'select-pane -t :.+',
    'prev-pane': 'select-pane -t :.-',
    'pp': 'select-pane -t :.-',

    // Session management
    'new-session': 'new-session',
    'ns': 'new-session',
    'new-sess': 'new-session',

    'attach-session': 'attach-session -t',
    'attach': 'attach-session -t',
    'as': 'attach-session -t',

    'detach-client': 'detach-client',
    'detach': 'detach-client',
    'dc': 'detach-client',

    // Layout and display
    'select-layout': 'select-layout',
    'layout': 'select-layout',
    'sl': 'select-layout',

    'clock-mode': 'clock-mode',
    'clock': 'clock-mode',

    // Copy mode
    'copy-mode': 'copy-mode',
    'copy': 'copy-mode',

    // Search and navigation in copy mode
    'search-forward': 'search-forward',
    'search-backward': 'search-backward',

    // Misc operations
    'list-windows': 'list-windows',
    'lw': 'list-windows',
    'list-sessions': 'list-sessions',
    'ls': 'list-sessions',
    'list-panes': 'list-panes',
    'lp': 'list-panes',

    'rename-window': 'rename-window',
    'rename': 'rename-window',

    'kill-window': 'kill-window',
    'kw': 'kill-window',
    'kill-pane': 'kill-pane',
    'kp': 'kill-pane',
    'kill-session': 'kill-session',
    'ks': 'kill-session',

    // Display and info
    'display-message': 'display-message',
    'display': 'display-message',
    'dm': 'display-message',

    'show-options': 'show-options',
    'show': 'show-options',
    'so': 'show-options',

    // Control and scripting
    'send-keys': 'send-keys',
    'send': 'send-keys',
    'sk': 'send-keys',

    'capture-pane': 'capture-pane',
    'capture': 'capture-pane',
    'cp': 'capture-pane',

    'pipe-pane': 'pipe-pane',
    'pipe': 'pipe-pane',

    // Buffer operations
    'list-buffers': 'list-buffers',
    'lb': 'list-buffers',
    'save-buffer': 'save-buffer',
    'sb': 'save-buffer',
    'delete-buffer': 'delete-buffer',
    'db': 'delete-buffer',

    // Advanced operations
    'resize-pane': 'resize-pane',
    'resize': 'resize-pane',
    'rp': 'resize-pane',

    'swap-pane': 'swap-pane',
    'swap': 'swap-pane',

    'join-pane': 'join-pane',
    'join': 'join-pane',
    'break-pane': 'break-pane',
    'break': 'break-pane',
};

// Commands that support session targeting
const COMMANDS_SUPPORTING_TARGET = new Set([
    'send-keys', 'capture-pane', 'new-window', 'kill-window',
    'select-window', 'split-window', 'select-pane', 'kill-pane',
    'select-layout', 'display-message', 'attach-session', 'detach-client',
    'new-session', 'kill-session', 'list-windows', 'list-panes'
]);

// Control sequences that must be separate arguments with proper typing
const CONTROL_SEQUENCES: Set<TmuxControlSequence> = new Set([
    'C-m', 'C-c', 'C-l', 'C-u', 'C-w', 'C-a', 'C-b', 'C-d', 'C-e', 'C-f',
    'C-g', 'C-h', 'C-i', 'C-j', 'C-k', 'C-n', 'C-o', 'C-p', 'C-q', 'C-r',
    'C-s', 'C-t', 'C-v', 'C-x', 'C-y', 'C-z', 'C-\\', 'C-]', 'C-[', 'C-]'
]);

export class TmuxUtilities {
    /** Default session name to prevent interference */
    public static readonly DEFAULT_SESSION_NAME = "happy";

    private controlState: TmuxControlState = TmuxControlState.NORMAL;
    public readonly sessionName: string;

    constructor(sessionName?: string) {
        this.sessionName = sessionName || TmuxUtilities.DEFAULT_SESSION_NAME;
    }

    /**
     * Detect tmux environment from TMUX environment variable
     */
    detectTmuxEnvironment(): TmuxEnvironment | null {
        const tmuxEnv = process.env.TMUX;
        if (!tmuxEnv) {
            return null;
        }

        // Parse TMUX environment: /tmp/tmux-1000/default,4219,0
        try {
            const parts = tmuxEnv.split(',');
            if (parts.length >= 3) {
                const socketPath = parts[0];
                // Extract last component from path (JavaScript doesn't support negative array indexing)
                const pathParts = parts[1].split('/');
                const sessionAndWindow = pathParts[pathParts.length - 1] || parts[1];
                const pane = parts[2];

                // Extract session name from session.window format
                let session: string;
                let window: string;
                if (sessionAndWindow.includes('.')) {
                    const parts = sessionAndWindow.split('.', 2);
                    session = parts[0];
                    window = parts[1] || "0";
                } else {
                    session = sessionAndWindow;
                    window = "0";
                }

                return {
                    session,
                    window,
                    pane,
                    socket_path: socketPath
                };
            }
        } catch (error) {
            logger.debug('[TMUX] Failed to parse TMUX environment variable:', error);
        }

        return null;
    }

    /**
     * Execute tmux command with proper session targeting and socket handling
     */
    async executeTmuxCommand(
        cmd: string[],
        session?: string,
        window?: string,
        pane?: string,
        socketPath?: string
    ): Promise<TmuxCommandResult | null> {
        const targetSession = session || this.sessionName;

        // Build command array
        let baseCmd = ['tmux'];

        // Add socket specification if provided
        if (socketPath) {
            baseCmd = ['tmux', '-S', socketPath];
        }

        // Handle send-keys with proper target specification
        if (cmd.length > 0 && cmd[0] === 'send-keys') {
            const fullCmd = [...baseCmd, cmd[0]];

            // Add target specification immediately after send-keys
            let target = targetSession;
            if (window) target += `:${window}`;
            if (pane) target += `.${pane}`;
            fullCmd.push('-t', target);

            // Add keys and control sequences
            fullCmd.push(...cmd.slice(1));

            return this.executeCommand(fullCmd);
        } else {
            // Non-send-keys commands
            const fullCmd = [...baseCmd, ...cmd];

            // Add target specification for commands that support it.
            // If caller already provided -t/--target, don't append another one.
            const alreadyHasTarget = cmd.includes('-t') || cmd.includes('--target');
            if (cmd.length > 0 && COMMANDS_SUPPORTING_TARGET.has(cmd[0]) && !alreadyHasTarget) {
                let target = targetSession;
                // For new-window, targeting bare "session" can fail with
                // "index X in use" on some tmux configurations. Use "session:"
                // to explicitly target the session namespace.
                if (window) {
                    target += `:${window}`;
                } else if (cmd[0] === 'new-window') {
                    target += ':';
                }
                if (pane) target += `.${pane}`;
                fullCmd.push('-t', target);
            }

            return this.executeCommand(fullCmd);
        }
    }

    /**
     * Execute command with subprocess and return result
     */
    private async executeCommand(cmd: string[]): Promise<TmuxCommandResult | null> {
        try {
            const result = await this.runCommand(cmd);
            return {
                returncode: result.exitCode,
                stdout: result.stdout || '',
                stderr: result.stderr || '',
                command: cmd
            };
        } catch (error) {
            logger.debug('[TMUX] Command execution failed:', error);
            return null;
        }
    }

    /**
     * Run command using Node.js child_process.spawn
     */
    private runCommand(args: string[], options: SpawnOptions = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
        return new Promise((resolve, reject) => {
            const child = spawn(args[0], args.slice(1), {
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: 5000,
                shell: false,
                ...options
            });

            let stdout = '';
            let stderr = '';

            child.stdout?.on('data', (data) => {
                stdout += data.toString();
            });

            child.stderr?.on('data', (data) => {
                stderr += data.toString();
            });

            child.on('close', (code) => {
                resolve({
                    exitCode: code || 0,
                    stdout,
                    stderr
                });
            });

            child.on('error', (error) => {
                reject(error);
            });
        });
    }

    /**
     * Parse control sequences in text (^ for escape, ^^ for literal ^)
     */
    parseControlSequences(text: string): [string, TmuxControlState] {
        const result: string[] = [];
        let i = 0;
        let localState = this.controlState;

        while (i < text.length) {
            const char = text[i];

            if (localState === TmuxControlState.NORMAL) {
                if (char === '^') {
                    if (i + 1 < text.length && text[i + 1] === '^') {
                        // Literal ^
                        result.push('^');
                        i += 2;
                    } else {
                        // Escape to normal tmux
                        localState = TmuxControlState.ESCAPE;
                        i += 1;
                    }
                } else {
                    result.push(char);
                    i += 1;
                }
            } else if (localState === TmuxControlState.ESCAPE) {
                // In escape mode - pass through to tmux directly
                result.push(char);
                i += 1;
                localState = TmuxControlState.NORMAL;
            } else {
                result.push(char);
                i += 1;
            }
        }

        this.controlState = localState;
        return [result.join(''), localState];
    }

    /**
     * Execute window operation using WIN_OPS dispatch with type safety
     */
    async executeWinOp(
        operation: TmuxWindowOperation,
        args: string[] = [],
        session?: string,
        window?: string,
        pane?: string
    ): Promise<boolean> {
        const tmuxCmd = WIN_OPS[operation];
        if (!tmuxCmd) {
            logger.debug(`[TMUX] Unknown operation: ${operation}`);
            return false;
        }

        const cmdParts = tmuxCmd.split(' ');
        cmdParts.push(...args);

        const result = await this.executeTmuxCommand(cmdParts, session, window, pane);
        return result !== null && result.returncode === 0;
    }

    /**
     * Ensure session exists, create if needed
     */
    async ensureSessionExists(sessionName?: string): Promise<boolean> {
        const targetSession = sessionName || this.sessionName;

        // Check if session exists
        const result = await this.executeTmuxCommand(['has-session', '-t', targetSession]);
        if (result && result.returncode === 0) {
            return true;
        }

        // Create session if it doesn't exist
        const createResult = await this.executeTmuxCommand(['new-session', '-d', '-s', targetSession]);
        return createResult !== null && createResult.returncode === 0;
    }

    /**
     * Capture current input from tmux pane
     */
    async captureCurrentInput(
        session?: string,
        window?: string,
        pane?: string
    ): Promise<string> {
        const result = await this.executeTmuxCommand(['capture-pane', '-p'], session, window, pane);
        if (result && result.returncode === 0) {
            const lines = result.stdout.trim().split('\n');
            return lines[lines.length - 1] || '';
        }
        return '';
    }

    /**
     * Check if user is actively typing
     */
    async isUserTyping(
        checkInterval: number = 500,
        maxChecks: number = 3,
        session?: string,
        window?: string,
        pane?: string
    ): Promise<boolean> {
        const initialInput = await this.captureCurrentInput(session, window, pane);

        for (let i = 0; i < maxChecks - 1; i++) {
            await new Promise(resolve => setTimeout(resolve, checkInterval));
            const currentInput = await this.captureCurrentInput(session, window, pane);
            if (currentInput !== initialInput) {
                return true;
            }
        }

        return false;
    }

    /**
     * Send keys to tmux pane with proper control sequence handling and type safety
     */
    async sendKeys(
        keys: string | TmuxControlSequence,
        session?: string,
        window?: string,
        pane?: string
    ): Promise<boolean> {
        // Validate input
        if (!keys || typeof keys !== 'string') {
            logger.debug('[TMUX] Invalid keys provided to sendKeys');
            return false;
        }

        // Handle control sequences that must be separate arguments
        if (CONTROL_SEQUENCES.has(keys as TmuxControlSequence)) {
            const result = await this.executeTmuxCommand(['send-keys', keys], session, window, pane);
            return result !== null && result.returncode === 0;
        } else {
            // Regular text
            const result = await this.executeTmuxCommand(['send-keys', keys], session, window, pane);
            return result !== null && result.returncode === 0;
        }
    }

    /**
     * Send multiple keys to tmux pane with proper control sequence handling
     */
    async sendMultipleKeys(
        keys: Array<string | TmuxControlSequence>,
        session?: string,
        window?: string,
        pane?: string
    ): Promise<boolean> {
        if (!Array.isArray(keys) || keys.length === 0) {
            logger.debug('[TMUX] Invalid keys array provided to sendMultipleKeys');
            return false;
        }

        for (const key of keys) {
            const success = await this.sendKeys(key, session, window, pane);
            if (!success) {
                return false;
            }
        }

        return true;
    }

    /**
     * Get comprehensive session information
     */
    async getSessionInfo(sessionName?: string): Promise<TmuxSessionInfo> {
        const targetSession = sessionName || this.sessionName;
        const envInfo = this.detectTmuxEnvironment();

        const info: TmuxSessionInfo = {
            target_session: targetSession,
            session: targetSession,
            window: "unknown",
            pane: "unknown",
            socket_path: undefined,
            tmux_active: envInfo !== null,
            current_session: envInfo?.session,
            available_sessions: []
        };

        // Update with environment info if it matches our target session
        if (envInfo && envInfo.session === targetSession) {
            info.window = envInfo.window;
            info.pane = envInfo.pane;
            info.socket_path = envInfo.socket_path;
        } else if (envInfo) {
            // Add environment info as separate fields
            info.env_session = envInfo.session;
            info.env_window = envInfo.window;
            info.env_pane = envInfo.pane;
        }

        // Get available sessions
        const result = await this.executeTmuxCommand(['list-sessions']);
        if (result && result.returncode === 0) {
            info.available_sessions = result.stdout
                .trim()
                .split('\n')
                .filter(line => line.trim())
                .map(line => line.split(':')[0]);
        }

        return info;
    }

    /**
     * Read current value of a session-scoped environment variable.
     * If unset, tmux returns "-KEY" or a non-zero status depending on version.
     */
    private async getSessionEnvironmentSnapshot(
        sessionName: string,
        key: string
    ): Promise<{ exists: boolean; value?: string }> {
        const result = await this.executeTmuxCommand(['show-environment', '-t', sessionName, key], sessionName);
        if (!result || result.returncode !== 0) {
            return { exists: false };
        }

        const lines = result.stdout.trim().split('\n');
        const matched = lines.find((line) => line.startsWith(`${key}=`) || line === `-${key}`);
        if (!matched || matched === `-${key}`) {
            return { exists: false };
        }

        return {
            exists: true,
            value: matched.slice(key.length + 1)
        };
    }

    /**
     * Temporarily set session environment variables for older tmux versions
     * that don't support new-window -e. Values are restored after operation.
     */
    private async withTemporarySessionEnvironment(
        sessionName: string,
        envEntries: Array<[string, string]>,
        operation: () => Promise<TmuxCommandResult | null>
    ): Promise<TmuxCommandResult | null> {
        const snapshots = new Map<string, { exists: boolean; value?: string }>();

        try {
            for (const [key, value] of envEntries) {
                snapshots.set(key, await this.getSessionEnvironmentSnapshot(sessionName, key));
                await this.executeTmuxCommand(['set-environment', '-t', sessionName, key, value], sessionName);
            }

            return await operation();
        } finally {
            for (const [key, snapshot] of snapshots.entries()) {
                if (snapshot.exists) {
                    await this.executeTmuxCommand(
                        ['set-environment', '-t', sessionName, key, snapshot.value ?? ''],
                        sessionName
                    );
                } else {
                    await this.executeTmuxCommand(['set-environment', '-t', sessionName, '-u', key], sessionName);
                }
            }
        }
    }

    /**
     * Spawn process in tmux session with environment variables.
     *
     * IMPORTANT: Unlike Node.js spawn(), env is a separate parameter.
     * This is intentional because:
     * - Tmux windows inherit environment from the tmux server
     * - Only NEW or DIFFERENT variables need to be set via -e flag
     * - Passing all of process.env would create 50+ unnecessary -e flags
     *
     * @param args - Command and arguments to execute (as array, will be joined)
     * @param options - Spawn options (tmux-specific, excludes env)
     * @param env - Environment variables to set in window (only pass what's different!)
     * @returns Result with success status and session identifier
     */
    async spawnInTmux(
        args: string[],
        options: TmuxSpawnOptions = {},
        env?: Record<string, string>
    ): Promise<{ success: boolean; sessionId?: string; pid?: number; error?: string }> {
        try {
            // Check if tmux is available
            const tmuxCheck = await this.executeTmuxCommand(['list-sessions']);
            if (!tmuxCheck) {
                throw new Error('tmux not available');
            }

            // Handle session name resolution
            // - undefined: Use first existing session or create "happy"
            // - empty string: Use first existing session or create "happy"
            // - specific name: Use that session (create if doesn't exist)
            let sessionName = options.sessionName !== undefined && options.sessionName !== ''
                ? options.sessionName
                : null;

            // If no specific session name, try to use first existing session
            if (!sessionName) {
                const listResult = await this.executeTmuxCommand(['list-sessions', '-F', '#{session_name}']);
                if (listResult && listResult.returncode === 0 && listResult.stdout.trim()) {
                    // Use first session from list
                    const firstSession = listResult.stdout.trim().split('\n')[0];
                    sessionName = firstSession;
                    logger.debug(`[TMUX] Using first existing session: ${sessionName}`);
                } else {
                    // No sessions exist, create "happy"
                    sessionName = 'happy';
                    logger.debug(`[TMUX] No existing sessions, using default: ${sessionName}`);
                }
            }

            const windowName = options.windowName || `happy-${Date.now()}`;

            // Ensure session exists
            await this.ensureSessionExists(sessionName);

            // Build command to execute in the new window
            const fullCommand = args.join(' ');

            // Normalize and validate env vars once; reused across compatibility attempts.
            const envEntries: Array<[string, string]> = [];
            if (env && Object.keys(env).length > 0) {
                for (const [key, value] of Object.entries(env)) {
                    if (value === undefined || value === null) {
                        logger.warn(`[TMUX] Skipping undefined/null environment variable: ${key}`);
                        continue;
                    }
                    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) {
                        logger.warn(`[TMUX] Skipping invalid environment variable name: ${key}`);
                        continue;
                    }
                    // tmux -e expects KEY=value, and argv is passed directly (no shell interpolation).
                    const normalizedValue = String(value).replace(/\0/g, '');
                    envEntries.push([key, normalizedValue]);
                }
            }

            const buildCreateWindowArgs = (includePidFlags: boolean, includeEnvFlags: boolean): string[] => {
                const args = ['new-window', '-t', `${sessionName}:`, '-n', windowName];

                if (includePidFlags) {
                    args.push('-P', '-F', '#{pane_pid}');
                }

                if (options.cwd) {
                    const cwdPath = typeof options.cwd === 'string' ? options.cwd : options.cwd.pathname;
                    args.push('-c', cwdPath);
                }

                if (includeEnvFlags && envEntries.length > 0) {
                    for (const [key, value] of envEntries) {
                        args.push('-e', `${key}=${value}`);
                    }
                }

                // Command must be the final argument for new-window.
                args.push(fullCommand);
                return args;
            };

            const createAttemptPlans = [
                { name: 'modern', includePidFlags: true, includeEnvFlags: true, useSessionEnvFallback: false },
                { name: 'no-pid-flags', includePidFlags: false, includeEnvFlags: true, useSessionEnvFallback: false },
                { name: 'session-env-fallback', includePidFlags: true, includeEnvFlags: false, useSessionEnvFallback: true },
                { name: 'legacy', includePidFlags: false, includeEnvFlags: false, useSessionEnvFallback: true }
            ];

            let createResult: TmuxCommandResult | null = null;
            let createAttemptName = '';
            const attemptErrors: string[] = [];

            for (const plan of createAttemptPlans) {
                // If no env vars are provided, session-env fallback attempts are redundant.
                if (plan.useSessionEnvFallback && envEntries.length === 0) {
                    continue;
                }

                const createWindowArgs = buildCreateWindowArgs(plan.includePidFlags, plan.includeEnvFlags);
                logger.debug(`[TMUX] Create window attempt: ${plan.name}`);
                if (plan.includeEnvFlags && envEntries.length > 0) {
                    logger.debug(`[TMUX] Setting ${envEntries.length} environment variables in tmux window`);
                }

                if (plan.useSessionEnvFallback && envEntries.length > 0) {
                    createResult = await this.withTemporarySessionEnvironment(
                        sessionName,
                        envEntries,
                        async () => this.executeTmuxCommand(createWindowArgs, sessionName)
                    );
                } else {
                    createResult = await this.executeTmuxCommand(createWindowArgs, sessionName);
                }

                if (createResult && createResult.returncode === 0) {
                    createAttemptName = plan.name;
                    break;
                }

                const stderr = createResult?.stderr?.trim() || '';
                const stdout = createResult?.stdout?.trim() || '';
                attemptErrors.push(`${plan.name}: ${stderr || stdout || 'unknown error'}`);
            }

            if (!createResult || createResult.returncode !== 0) {
                throw new Error(`Failed to create tmux window: ${attemptErrors.join(' | ')}`);
            }

            // Extract the PID from the output.
            // Some tmux combinations don't print PID even on success.
            // Fall back to list-panes for compatibility.
            let panePid = parseInt(createResult.stdout.trim(), 10);
            if (isNaN(panePid)) {
                const pidLookup = await this.executeTmuxCommand(['list-panes', '-t', `${sessionName}:${windowName}`, '-F', '#{pane_pid}']);
                if (pidLookup && pidLookup.returncode === 0) {
                    const firstLine = pidLookup.stdout.trim().split('\n')[0] || '';
                    panePid = parseInt(firstLine, 10);
                }
            }
            if (isNaN(panePid)) {
                throw new Error(`Failed to extract PID from tmux output: ${createResult.stdout}`);
            }

            logger.debug(
                `[TMUX] Spawned command in tmux session ${sessionName}, window ${windowName}, PID ${panePid}, mode=${createAttemptName || 'unknown'}`
            );

            // Return tmux session info and PID
            const sessionIdentifier: TmuxSessionIdentifier = {
                session: sessionName,
                window: windowName
            };

            return {
                success: true,
                sessionId: formatTmuxSessionIdentifier(sessionIdentifier),
                pid: panePid
            };
        } catch (error) {
            logger.debug('[TMUX] Failed to spawn in tmux:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    /**
     * Get session info for a given session identifier string
     */
    async getSessionInfoFromString(sessionIdentifier: string): Promise<TmuxSessionInfo | null> {
        try {
            const parsed = parseTmuxSessionIdentifier(sessionIdentifier);
            const info = await this.getSessionInfo(parsed.session);
            return info;
        } catch (error) {
            if (error instanceof TmuxSessionIdentifierError) {
                logger.debug(`[TMUX] Invalid session identifier: ${error.message}`);
            } else {
                logger.debug('[TMUX] Error getting session info:', error);
            }
            return null;
        }
    }

    /**
     * Kill a tmux window safely with proper error handling
     */
    async killWindow(sessionIdentifier: string): Promise<boolean> {
        try {
            const parsed = parseTmuxSessionIdentifier(sessionIdentifier);
            if (!parsed.window) {
                throw new TmuxSessionIdentifierError(`Window identifier required: ${sessionIdentifier}`);
            }

            const result = await this.executeWinOp('kill-window', [parsed.window], parsed.session);
            return result;
        } catch (error) {
            if (error instanceof TmuxSessionIdentifierError) {
                logger.debug(`[TMUX] Invalid window identifier: ${error.message}`);
            } else {
                logger.debug('[TMUX] Error killing window:', error);
            }
            return false;
        }
    }

    /**
     * List windows in a session
     */
    async listWindows(sessionName?: string): Promise<string[]> {
        const targetSession = sessionName || this.sessionName;
        const result = await this.executeTmuxCommand(['list-windows', '-t', targetSession]);

        if (!result || result.returncode !== 0) {
            return [];
        }

        // Parse window names from tmux output
        const windows: string[] = [];
        const lines = result.stdout.trim().split('\n');

        for (const line of lines) {
            const match = line.match(/^\d+:\s+(\w+)/);
            if (match) {
                windows.push(match[1]);
            }
        }

        return windows;
    }
}

// Global instance for consistent usage
let _tmuxUtils: TmuxUtilities | null = null;

export function getTmuxUtilities(sessionName?: string): TmuxUtilities {
    if (!_tmuxUtils || (sessionName && sessionName !== _tmuxUtils.sessionName)) {
        _tmuxUtils = new TmuxUtilities(sessionName);
    }
    return _tmuxUtils;
}

export async function isTmuxAvailable(): Promise<boolean> {
    try {
        const utils = new TmuxUtilities();
        const result = await utils.executeTmuxCommand(['list-sessions']);
        return result !== null;
    } catch {
        return false;
    }
}

/**
 * Create a new tmux session with proper typing and validation
 */
export async function createTmuxSession(
    sessionName: string,
    options?: {
        windowName?: string;
        detached?: boolean;
        attach?: boolean;
    }
): Promise<{ success: boolean; sessionIdentifier?: string; error?: string }> {
    try {
        if (!sessionName || !/^[a-zA-Z0-9._-]+$/.test(sessionName)) {
            throw new TmuxSessionIdentifierError(`Invalid session name: "${sessionName}"`);
        }

        const utils = new TmuxUtilities(sessionName);
        const windowName = options?.windowName || 'main';

        const cmd = ['new-session'];
        if (options?.detached !== false) {
            cmd.push('-d');
        }
        cmd.push('-s', sessionName);
        cmd.push('-n', windowName);

        const result = await utils.executeTmuxCommand(cmd);
        if (result && result.returncode === 0) {
            const sessionIdentifier: TmuxSessionIdentifier = {
                session: sessionName,
                window: windowName
            };
            return {
                success: true,
                sessionIdentifier: formatTmuxSessionIdentifier(sessionIdentifier)
            };
        } else {
            return {
                success: false,
                error: result?.stderr || 'Failed to create tmux session'
            };
        }
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

/**
 * Validate a tmux session identifier without throwing
 */
export function validateTmuxSessionIdentifier(identifier: string): { valid: boolean; error?: string } {
    try {
        parseTmuxSessionIdentifier(identifier);
        return { valid: true };
    } catch (error) {
        return {
            valid: false,
            error: error instanceof Error ? error.message : 'Unknown validation error'
        };
    }
}

/**
 * Build a tmux session identifier with validation
 */
export function buildTmuxSessionIdentifier(params: {
    session: string;
    window?: string;
    pane?: string;
}): { success: boolean; identifier?: string; error?: string } {
    try {
        if (!params.session || !/^[a-zA-Z0-9._-]+$/.test(params.session)) {
            throw new TmuxSessionIdentifierError(`Invalid session name: "${params.session}"`);
        }

        if (params.window && !/^[a-zA-Z0-9._-]+$/.test(params.window)) {
            throw new TmuxSessionIdentifierError(`Invalid window name: "${params.window}"`);
        }

        if (params.pane && !/^[0-9]+$/.test(params.pane)) {
            throw new TmuxSessionIdentifierError(`Invalid pane identifier: "${params.pane}"`);
        }

        const identifier: TmuxSessionIdentifier = params;
        return {
            success: true,
            identifier: formatTmuxSessionIdentifier(identifier)
        };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}
