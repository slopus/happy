import chalk from 'chalk';
import { readCredentials } from '@/persistence';
import { ApiClient } from '@/api/api';
import { decodeJwtPayload } from '@/cloud/jwt/decodeJwtPayload';
import type { CloudConnectTarget } from '@/cloud/connect/types';
import { AGENTS } from '@/backends/catalog';

/**
 * Handle connect subcommand
 * 
 * Implements connect subcommands for storing AI vendor API keys:
 * - connect codex: Store OpenAI API key in Happy cloud
 * - connect claude: Store Anthropic API key in Happy cloud
 * - connect gemini: Store Gemini API key in Happy cloud
 * - connect help: Show help for connect command
 */
export async function handleConnectCommand(args: string[]): Promise<void> {
    const subcommand = args[0];
    const targets: CloudConnectTarget[] = [];
    for (const entry of Object.values(AGENTS)) {
      if (!entry.getCloudConnectTarget) continue;
      targets.push(await entry.getCloudConnectTarget());
    }
    targets.sort((a, b) => a.id.localeCompare(b.id));
    const targetById = new Map(targets.map((t) => [t.id, t] as const));

    if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
        showConnectHelp(targets);
        return;
    }

    const normalized = subcommand.toLowerCase();
    if (normalized === 'status') {
      await handleConnectStatus(targets);
      return;
    }

    const target = targetById.get(normalized as any);
    if (!target) {
      console.error(chalk.red(`Unknown connect target: ${subcommand}`));
      showConnectHelp(targets);
      process.exit(1);
    }

    await handleConnectVendor(target);
}

function showConnectHelp(targets: ReadonlyArray<CloudConnectTarget>): void {
    const targetLines = targets.length > 0
      ? targets.map((t) => `  happy connect ${t.id.padEnd(12)} ${t.vendorDisplayName}`).join('\n')
      : '  (no connect targets registered)';
    console.log(`
${chalk.bold('happy connect')} - Connect AI vendor API keys to Happy cloud

${chalk.bold('Usage:')}
${targetLines}
  happy connect status       Show connection status for all vendors
  happy connect help         Show this help message

${chalk.bold('Description:')}
  The connect command allows you to securely store your AI vendor API keys
  in Happy cloud. This enables you to use these services through Happy
  without exposing your API keys locally.

${chalk.bold('Examples:')}
  happy connect ${targets[0]?.id ?? 'gemini'}
  happy connect status

${chalk.bold('Notes:')} 
  • You must be authenticated with Happy first (run 'happy auth login')
  • API keys are encrypted and stored securely in Happy cloud
  • You can manage your stored keys at app.happy.engineering
`);
}

async function handleConnectVendor(target: CloudConnectTarget): Promise<void> {
    console.log(chalk.bold(`\n🔌 Connecting ${target.vendorDisplayName} to Happy cloud\n`));

    // Check if authenticated
    const credentials = await readCredentials();
    if (!credentials) {
        console.log(chalk.yellow('⚠️  Not authenticated with Happy'));
        console.log(chalk.gray('  Please run "happy auth login" first'));
        process.exit(1);
    }

    // Create API client
    const api = await ApiClient.create(credentials);

    console.log(`🚀 Registering ${target.displayName} token with server`);
    const oauth = await target.authenticate();
    await api.registerVendorToken(target.vendorKey, { oauth });
    console.log(`✅ ${target.displayName} token registered with server`);
    target.postConnect?.(oauth);
    process.exit(0);
}

/**
 * Show connection status for all vendors
 */
async function handleConnectStatus(targets: ReadonlyArray<CloudConnectTarget>): Promise<void> {
    console.log(chalk.bold('\n🔌 Connection Status\n'));

    // Check if authenticated
    const credentials = await readCredentials();
    if (!credentials) {
        console.log(chalk.yellow('⚠️  Not authenticated with Happy'));
        console.log(chalk.gray('  Please run "happy auth login" first'));
        process.exit(1);
    }

    // Create API client
    const api = await ApiClient.create(credentials);

    for (const target of targets) {
        try {
            const token = await api.getVendorToken(target.vendorKey);
            
            if (token?.oauth) {
                // Try to extract user info from id_token (JWT)
                let userInfo = '';
                
                const idToken = (token.oauth as any)?.id_token;
                if (typeof idToken === 'string') {
                    const payload = decodeJwtPayload(idToken);
                    if (payload?.email) {
                        userInfo = chalk.gray(` (${payload.email})`);
                    }
                }
                
                // Check if token might be expired
                const expiresAt = token.oauth.expires_at || (token.oauth.expires_in ? Date.now() + token.oauth.expires_in * 1000 : null);
                const isExpired = expiresAt && expiresAt < Date.now();
                
                if (isExpired) {
                    console.log(`  ${chalk.yellow('⚠️')}  ${target.vendorDisplayName}: ${chalk.yellow('expired')}${userInfo}`);
                } else {
                    console.log(`  ${chalk.green('✓')}  ${target.vendorDisplayName}: ${chalk.green('connected')}${userInfo}`);
                }
            } else {
                console.log(`  ${chalk.gray('○')}  ${target.vendorDisplayName}: ${chalk.gray('not connected')}`);
            }
        } catch {
            console.log(`  ${chalk.gray('○')}  ${target.vendorDisplayName}: ${chalk.gray('not connected')}`);
        }
    }

    console.log('');
    console.log(chalk.gray('To connect a vendor, run: happy connect <vendor>'));
    console.log(chalk.gray('Example: happy connect gemini'));
    console.log('');
}
