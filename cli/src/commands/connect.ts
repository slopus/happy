import chalk from 'chalk';
import { readCredentials } from '@/persistence';
import { ApiClient } from '@/api/api';
import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';
import type { CloudConnectTarget, CloudConnectTargetStatus } from '@/cloud/connectTypes';
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
    const { includeExperimental, subcommand } = parseConnectArgs(args);

    const allTargets = await loadConnectTargets({ includeExperimental: true });
    const visibleTargets = includeExperimental ? allTargets : allTargets.filter((t) => t.status === 'wired');

    const targetById = new Map(allTargets.map((t) => [t.id, t] as const));
    const visibleTargetById = new Map(visibleTargets.map((t) => [t.id, t] as const));

    if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
        showConnectHelp(visibleTargets, { includeExperimental });
        return;
    }

    const normalized = subcommand.toLowerCase();
    if (normalized === 'status') {
      await handleConnectStatus(visibleTargets);
      return;
    }

    const visibleTarget = visibleTargetById.get(normalized as any);
    if (!visibleTarget) {
      const hiddenTarget = targetById.get(normalized as any);
      if (hiddenTarget && hiddenTarget.status === 'experimental' && !includeExperimental) {
        console.error(chalk.yellow(`Connect target '${hiddenTarget.id}' is experimental and not enabled by default.`));
        console.error(chalk.gray(`Run: happy connect --all ${hiddenTarget.id}`));
        process.exit(1);
      }
      console.error(chalk.red(`Unknown connect target: ${subcommand}`));
      showConnectHelp(visibleTargets, { includeExperimental });
      process.exit(1);
    }

    await handleConnectVendor(visibleTarget);
}

function parseConnectArgs(args: ReadonlyArray<string>): Readonly<{ includeExperimental: boolean; subcommand: string | null }> {
  const includeExperimental = args.includes('--all') || args.includes('--experimental');
  const rest = args.filter((a) => a !== '--all' && a !== '--experimental');
  const subcommand = rest[0] ?? null;
  return { includeExperimental, subcommand };
}

async function loadConnectTargets(params: Readonly<{ includeExperimental: boolean }>): Promise<CloudConnectTarget[]> {
  const targets: CloudConnectTarget[] = [];
  for (const entry of Object.values(AGENTS)) {
    if (!entry.getCloudConnectTarget) continue;
    targets.push(await entry.getCloudConnectTarget());
  }
  targets.sort((a, b) => a.id.localeCompare(b.id));
  return params.includeExperimental ? targets : targets.filter((t) => t.status === 'wired');
}

function showConnectHelp(targets: ReadonlyArray<CloudConnectTarget>, opts: Readonly<{ includeExperimental: boolean }>): void {
    const targetLines = targets.length > 0
      ? targets.map((t) => formatTargetLine(t)).join('\n')
      : '  (no connect targets registered)';
    console.log(`
${chalk.bold('happy connect')} - Connect AI vendor API keys to Happy cloud

${chalk.bold('Usage:')}
${targetLines}
  happy connect status       Show connection status for all vendors
  happy connect help         Show this help message
  happy connect --all ...    Include experimental providers

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
  ${opts.includeExperimental ? '' : '• Some providers are experimental; use --all to show them'}
`);
}

function formatTargetLine(target: CloudConnectTarget): string {
  const statusSuffix = target.status === 'wired' ? '' : chalk.gray(' (experimental)');
  return `  happy connect ${target.id.padEnd(12)} ${target.vendorDisplayName}${statusSuffix}`;
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
