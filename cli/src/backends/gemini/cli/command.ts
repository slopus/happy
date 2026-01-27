import chalk from 'chalk';

import { CODEX_GEMINI_PERMISSION_MODES, isCodexGeminiPermissionMode } from '@/api/types';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { isDaemonRunningCurrentlyInstalledHappyVersion } from '@/daemon/controlClient';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { parseSessionStartArgs } from '@/cli/sessionStartArgs';
import { DEFAULT_GEMINI_MODEL, GEMINI_MODEL_ENV } from '@/backends/gemini/constants';

import type { CommandContext } from '@/cli/commandRegistry';

export async function handleGeminiCliCommand(context: CommandContext): Promise<void> {
  const args = context.args;
  const geminiSubcommand = args[1];

  if (geminiSubcommand === 'model' && args[2] === 'set' && args[3]) {
    const modelName = args[3];
    const validModels = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];

    if (!validModels.includes(modelName)) {
      console.error(`Invalid model: ${modelName}`);
      console.error(`Available models: ${validModels.join(', ')}`);
      process.exit(1);
    }

    try {
      const { saveGeminiModelToConfig } = await import('@/backends/gemini/utils/config');
      saveGeminiModelToConfig(modelName);
      const { join } = await import('node:path');
      const { homedir } = await import('node:os');
      const configPath = join(homedir(), '.gemini', 'config.json');
      console.log(`✓ Model set to: ${modelName}`);
      console.log(`  Config saved to: ${configPath}`);
      console.log('  This model will be used in future sessions.');
      process.exit(0);
    } catch (error) {
      console.error('Failed to save model configuration:', error);
      process.exit(1);
    }
  }

  if (geminiSubcommand === 'model' && args[2] === 'get') {
    try {
      const { readGeminiLocalConfig } = await import('@/backends/gemini/utils/config');
      const local = readGeminiLocalConfig();
      if (local.model) {
        console.log(`Current model: ${local.model}`);
      } else if (process.env[GEMINI_MODEL_ENV]) {
        console.log(`Current model: ${process.env[GEMINI_MODEL_ENV]} (from ${GEMINI_MODEL_ENV} env var)`);
      } else {
        console.log(`Current model: ${DEFAULT_GEMINI_MODEL} (default)`);
      }
      process.exit(0);
    } catch (error) {
      console.error('Failed to read model configuration:', error);
      process.exit(1);
    }
  }

  if (geminiSubcommand === 'project' && args[2] === 'set' && args[3]) {
    const projectId = args[3];

    try {
      const { saveGoogleCloudProjectToConfig } = await import('@/backends/gemini/utils/config');

      let userEmail: string | undefined = undefined;
      try {
        const { readCredentials } = await import('@/persistence');
        const credentials = await readCredentials();
        if (credentials) {
          const api = await ApiClient.create(credentials);
          const vendorToken = await api.getVendorToken('gemini');
          if (vendorToken?.oauth?.id_token) {
            const parts = vendorToken.oauth.id_token.split('.');
            if (parts.length === 3) {
              const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
              userEmail = payload.email;
            }
          }
        }
      } catch {
        // If we can't get email, project will be saved globally
      }

      saveGoogleCloudProjectToConfig(projectId, userEmail);
      console.log(`✓ Google Cloud Project set to: ${projectId}`);
      if (userEmail) {
        console.log(`  Linked to account: ${userEmail}`);
      }
      console.log('  This project will be used for Google Workspace accounts.');
      process.exit(0);
    } catch (error) {
      console.error('Failed to save project configuration:', error);
      process.exit(1);
    }
  }

  if (geminiSubcommand === 'project' && args[2] === 'get') {
    try {
      const { readGeminiLocalConfig } = await import('@/backends/gemini/utils/config');
      const config = readGeminiLocalConfig();

      if (config.googleCloudProject) {
        console.log(`Current Google Cloud Project: ${config.googleCloudProject}`);
        if (config.googleCloudProjectEmail) {
          console.log(`  Linked to account: ${config.googleCloudProjectEmail}`);
        } else {
          console.log('  Applies to: all accounts (global)');
        }
      } else if (process.env.GOOGLE_CLOUD_PROJECT) {
        console.log(`Current Google Cloud Project: ${process.env.GOOGLE_CLOUD_PROJECT} (from env var)`);
      } else {
        console.log('No Google Cloud Project configured.');
        console.log('');
        console.log('If you see "Authentication required" error, you may need to set a project:');
        console.log('  happy gemini project set <your-project-id>');
        console.log('');
        console.log('This is required for Google Workspace accounts.');
        console.log('Guide: https://goo.gle/gemini-cli-auth-docs#workspace-gca');
      }
      process.exit(0);
    } catch (error) {
      console.error('Failed to read project configuration:', error);
      process.exit(1);
    }
  }

  if (geminiSubcommand === 'project' && !args[2]) {
    console.log('Usage: happy gemini project <command>');
    console.log('');
    console.log('Commands:');
    console.log('  set <project-id>   Set Google Cloud Project ID');
    console.log('  get                Show current Google Cloud Project ID');
    console.log('');
    console.log('Google Workspace accounts require a Google Cloud Project.');
    console.log('If you see "Authentication required" error, set your project ID.');
    console.log('');
    console.log('Guide: https://goo.gle/gemini-cli-auth-docs#workspace-gca');
    process.exit(0);
  }

  try {
    const { runGemini } = await import('@/backends/gemini/runGemini');

    const { startedBy, permissionMode, permissionModeUpdatedAt } = parseSessionStartArgs(args);
    if (permissionMode && !isCodexGeminiPermissionMode(permissionMode)) {
      console.error(
        chalk.red(
          `Invalid --permission-mode for gemini: ${permissionMode}. Valid values: ${CODEX_GEMINI_PERMISSION_MODES.join(', ')}`,
        ),
      );
      console.error(chalk.gray('Tip: use --yolo for full bypass-like behavior.'));
      process.exit(1);
    }

    const readFlagValue = (flag: string): string | undefined => {
      const idx = args.indexOf(flag);
      if (idx === -1) return undefined;
      const value = args[idx + 1];
      if (!value || value.startsWith('-')) return undefined;
      return value;
    };

    const existingSessionId = readFlagValue('--existing-session');
    const resume = readFlagValue('--resume');

    const { credentials } = await authAndSetupMachineIfNeeded();

    logger.debug('Ensuring Happy background service is running & matches our version...');
    if (!(await isDaemonRunningCurrentlyInstalledHappyVersion())) {
      logger.debug('Starting Happy background service...');
      const daemonProcess = spawnHappyCLI(['daemon', 'start-sync'], {
        detached: true,
        stdio: 'ignore',
        env: process.env,
      });
      daemonProcess.unref();
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    await runGemini({
      credentials,
      startedBy,
      terminalRuntime: context.terminalRuntime,
      permissionMode,
      permissionModeUpdatedAt,
      existingSessionId,
      resume,
    });
  } catch (error) {
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
    if (process.env.DEBUG) {
      console.error(error);
    }
    process.exit(1);
  }
}
