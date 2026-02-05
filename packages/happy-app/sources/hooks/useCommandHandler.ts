/**
 * Command Handler Hook
 * Handles app navigation commands for both web app and Telegram Mini App
 */

import { useCallback } from 'react';
import { useRouter } from 'expo-router';
import { useTelegram } from './useTelegram';
import type { CommandItem } from '@/sync/suggestionCommands';
import { APP_COMMAND_NAMES, BUILTIN_COMMAND_NAMES } from '@/sync/suggestionCommands';

export interface CommandHandlerOptions {
    onCommandExecuted?: (command: string) => void;
    onUnknownCommand?: (command: string) => void;
    onSdkCommand?: (command: string) => void;  // Callback for SDK commands that should be sent to CLI
}

/**
 * Hook to handle slash command execution
 * Supports both navigation commands and Claude commands
 */
export function useCommandHandler(options: CommandHandlerOptions = {}) {
    const router = useRouter();
    const telegram = useTelegram();

    // Destructure callbacks to avoid dependency on options object
    const { onCommandExecuted, onUnknownCommand, onSdkCommand } = options;

    /**
     * Execute a command by name
     * @param commandName - Command name without slash (e.g., "sessions")
     * @param source - Command source ('app', 'sdk', 'builtin')
     */
    const executeCommand = useCallback((commandName: string, source?: string) => {
        // Notify about command execution
        if (onCommandExecuted) {
            onCommandExecuted(commandName);
        }

        // Handle app navigation commands
        if (source === 'app' || isAppCommand(commandName)) {
            handleAppCommand(commandName);
            return;
        }

        // Handle builtin commands (these are sent to CLI)
        if (source === 'builtin' || isBuiltinCommand(commandName)) {
            handleBuiltinCommand(commandName);
            return;
        }

        // SDK commands are passed through to Claude
        if (source === 'sdk') {
            // Notify caller to send this command to CLI/Claude
            if (onSdkCommand) {
                onSdkCommand(commandName);
            }
            return;
        }

        // Unknown command
        if (onUnknownCommand) {
            onUnknownCommand(commandName);
        }
    }, [onCommandExecuted, onUnknownCommand, onSdkCommand, isAppCommand, isBuiltinCommand, handleAppCommand, handleBuiltinCommand]);

    /**
     * Handle app navigation commands
     */
    const handleAppCommand = useCallback((commandName: string) => {
        switch (commandName) {
            case 'home':
                router.push('/(app)/(tabs)/');
                break;

            case 'sessions':
                router.push('/(app)/(tabs)/');
                break;

            case 'profiles':
                router.push('/(app)/settings/profiles');
                break;

            case 'settings':
                router.push('/(app)/settings');
                break;

            case 'help':
                // Show help modal or navigate to help screen
                if (telegram.isTelegramWebApp && telegram.webApp) {
                    telegram.webApp.showAlert(
                        'Happy Commands:\n\n' +
                        '/home - Navigate to home\n' +
                        '/sessions - View all sessions\n' +
                        '/profiles - Manage profiles\n' +
                        '/settings - Open settings\n' +
                        '/compact - Compact conversation\n' +
                        '/clear - Clear conversation'
                    );
                } else {
                    // Web app: navigate to help page or show modal
                    router.push('/(app)/help');
                }
                break;

            default:
                console.warn(`Unknown app command: ${commandName}`);
        }

        // Haptic feedback for Telegram
        if (telegram.isTelegramWebApp && telegram.webApp) {
            telegram.webApp.HapticFeedback?.impactOccurred('light');
        }
    }, [router, telegram]);

    /**
     * Handle builtin commands
     * These are sent to the CLI but may have client-side side effects
     */
    const handleBuiltinCommand = useCallback((commandName: string) => {
        switch (commandName) {
            case 'clear':
                // CLI will handle the actual clearing
                // Client can show confirmation or feedback
                if (telegram.isTelegramWebApp && telegram.webApp) {
                    telegram.webApp.HapticFeedback?.notificationOccurred('success');
                }
                break;

            case 'compact':
                // CLI will handle the actual compaction
                if (telegram.isTelegramWebApp && telegram.webApp) {
                    telegram.webApp.HapticFeedback?.notificationOccurred('success');
                }
                break;

            default:
                // Other builtin commands are passed through to CLI
                break;
        }
    }, [telegram]);

    /**
     * Check if a command is an app navigation command
     */
    const isAppCommand = useCallback((commandName: string): boolean => {
        return APP_COMMAND_NAMES.includes(commandName as any);
    }, []);

    /**
     * Check if a command is a builtin command
     */
    const isBuiltinCommand = useCallback((commandName: string): boolean => {
        return BUILTIN_COMMAND_NAMES.includes(commandName as any);
    }, []);

    /**
     * Execute a command from a CommandItem
     */
    const executeCommandItem = useCallback((command: CommandItem) => {
        executeCommand(command.command, command.source);
    }, [executeCommand]);

    return {
        executeCommand,
        executeCommandItem,
        isAppCommand,
        isBuiltinCommand,
        isTelegramWebApp: telegram.isTelegramWebApp
    };
}
