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

export interface TmuxSpawnOptions extends SpawnOptions {
    /** Target tmux session name */
    sessionName?: string;
    /** Custom tmux socket path */
    socketPath?: string;
    /** Create new window in existing session */
    createWindow?: boolean;
    /** Window name for new windows */
    windowName?: string;
}

/**
 * Complete WIN_OPS dispatch dictionary for tmux operations
 * Maps operation names to tmux commands
 */
const WIN_OPS: Record<string, string> = {
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

// Control sequences that must be separate arguments
const CONTROL_SEQUENCES = new Set([
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
                const sessionAndWindow = parts[1].split('/')[-1] || parts[1];
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

            // Add target specification for commands that support it
            if (cmd.length > 0 && COMMANDS_SUPPORTING_TARGET.has(cmd[0])) {
                let target = targetSession;
                if (window) target += `:${window}`;
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
     * Execute window operation using WIN_OPS dispatch
     */
    async executeWinOp(
        operation: string,
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
     * Send keys to tmux pane with proper control sequence handling
     */
    async sendKeys(
        keys: string,
        session?: string,
        window?: string,
        pane?: string
    ): Promise<boolean> {
        // Handle control sequences that must be separate arguments
        if (CONTROL_SEQUENCES.has(keys)) {
            const result = await this.executeTmuxCommand(['send-keys', keys], session, window, pane);
            return result !== null && result.returncode === 0;
        } else {
            // Regular text
            const result = await this.executeTmuxCommand(['send-keys', keys], session, window, pane);
            return result !== null && result.returncode === 0;
        }
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
     * Spawn process in tmux session or fallback to regular spawning
     */
    async spawnInTmux(
        args: string[],
        options: TmuxSpawnOptions = {},
        env?: Record<string, string>
    ): Promise<{ success: boolean; sessionId?: string; error?: string }> {
        try {
            // Check if tmux is available
            const tmuxCheck = await this.executeTmuxCommand(['list-sessions']);
            if (!tmuxCheck) {
                throw new Error('tmux not available');
            }

            const sessionName = options.sessionName || this.sessionName;
            const windowName = options.windowName || `happy-${Date.now()}`;

            // Ensure session exists
            await this.ensureSessionExists(sessionName);

            // Create new window in session
            const createResult = await this.executeTmuxCommand([
                'new-window',
                '-n', windowName,
                '-t', sessionName
            ]);

            if (!createResult || createResult.returncode !== 0) {
                throw new Error(`Failed to create tmux window: ${createResult?.stderr}`);
            }

            // Build command to execute in the new window
            const fullCommand = args.join(' ');

            // Send command to the new window
            const sendResult = await this.executeTmuxCommand([
                'send-keys',
                fullCommand,
                'C-m'  // Execute the command
            ], sessionName, windowName);

            if (!sendResult || sendResult.returncode !== 0) {
                throw new Error(`Failed to send command to tmux: ${sendResult?.stderr}`);
            }

            logger.debug(`[TMUX] Spawned command in tmux session ${sessionName}, window ${windowName}`);

            return {
                success: true,
                sessionId: `${sessionName}:${windowName}`
            };
        } catch (error) {
            logger.debug('[TMUX] Failed to spawn in tmux:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
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